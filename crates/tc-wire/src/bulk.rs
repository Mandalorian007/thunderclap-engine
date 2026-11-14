//! Batched frames: many encoded messages carried as one message's last
//! `Bytes` field. [`pack`] writes such a message from frames, and
//! [`frames`] reads them back out of its data. A server that compresses
//! the data builds it with [`data`], compresses that, and wraps the result
//! with [`encode`]; the client decompresses the data before [`frames`].
//!
//! A browser spends about 24 µs of its main thread on every WebSocket
//! message before any of its own code runs (WebKit on an Apple M4), so a
//! world view sent as thousands of small messages costs a large share of a
//! second. Batched, the same view is a few dozen messages.
//!
//! The data is each frame's length as a varint, then the frame (a whole
//! encoded message), in order. The carrying message is given as its
//! [`head`]: its encoding up to its data, which must be its last field. So
//! [`pack`] writes exactly what the derived encoder would for the same
//! frames, copying each frame once.

use crate::varint::varint_len;
use crate::wire::{DecodeError, DecodeErrorKind, Reader, Wire, Writer};

/// The head of a carrying message: `empty` (the message with empty data in
/// its last field, a `Bytes`) encoded, without that field's zero length.
///
/// # Panics
///
/// If `empty` does not end in an empty `Bytes` field.
pub fn head<M: Wire>(empty: &M) -> Vec<u8> {
    let mut head = empty.to_bytes();
    assert_eq!(
        head.pop(),
        Some(0),
        "a bulk message ends with its data: an empty `Bytes` encodes as one 0 byte"
    );
    head
}

/// One encoded message (its [`head`], then the data) carrying `frames` in
/// order, uncompressed. Each frame must be a whole encoded message.
pub fn pack<F: AsRef<[u8]>>(head: &[u8], frames: &[F]) -> Vec<u8> {
    let data = data_len(frames);
    let mut w = Writer::with_capacity(head.len() + varint_len(data as u64) + data);
    w.write_raw(head);
    w.write_len(data);
    for f in frames {
        w.write_len(f.as_ref().len());
        w.write_raw(f.as_ref());
    }
    w.into_bytes()
}

/// The data carrying `frames` in order: what [`pack`] puts in its message.
pub fn data<F: AsRef<[u8]>>(frames: &[F]) -> Vec<u8> {
    let mut w = Writer::with_capacity(data_len(frames));
    for f in frames {
        w.write_len(f.as_ref().len());
        w.write_raw(f.as_ref());
    }
    w.into_bytes()
}

/// The bytes of the data carrying `frames`.
pub fn data_len<F: AsRef<[u8]>>(frames: &[F]) -> usize {
    frames
        .iter()
        .map(|f| varint_len(f.as_ref().len() as u64) + f.as_ref().len())
        .sum()
}

/// One encoded message (its [`head`], then `data` as it is, already
/// coded): what the derived encoder writes, copying `data` once.
pub fn encode(head: &[u8], data: &[u8]) -> Vec<u8> {
    let mut w = Writer::with_capacity(head.len() + varint_len(data.len() as u64) + data.len());
    w.write_raw(head);
    w.write_len(data.len());
    w.write_raw(data);
    w.into_bytes()
}

/// The frames in uncompressed data, in order, each the bytes of one
/// encoded message. Yields an error (and then nothing) at a length that
/// runs past the end or an empty frame.
pub fn frames(data: &[u8]) -> Frames<'_> {
    Frames {
        reader: Reader::new(data),
        failed: false,
    }
}

/// The iterator [`frames`] returns.
#[derive(Debug, Clone)]
pub struct Frames<'a> {
    reader: Reader<'a>,
    failed: bool,
}

impl<'a> Iterator for Frames<'a> {
    type Item = Result<&'a [u8], DecodeError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.reader.remaining() == 0 {
            return None;
        }
        let at = self.reader.position();
        let frame = self.reader.read_len().and_then(|len| {
            if len == 0 {
                // No message encodes to nothing.
                return Err(DecodeError::new(at, DecodeErrorKind::UnexpectedEnd));
            }
            self.reader.read_raw(len)
        });
        self.failed = frame.is_err();
        Some(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Bytes, Wire};

    #[derive(Wire, Debug, Clone, Copy, PartialEq, Eq)]
    enum Codec {
        None,
        Deflate,
    }

    #[derive(Wire, Debug, Clone, PartialEq, Eq)]
    struct Pos {
        x: i32,
        y: i32,
        z: i32,
    }

    #[derive(Wire, Debug, Clone, PartialEq, Eq)]
    enum Msg {
        Section { pos: Pos, version: u32, data: Bytes },
        Unload { positions: Vec<Pos> },
        Bulk { codec: Codec, data: Bytes },
    }

    fn bulk_head(codec: Codec) -> Vec<u8> {
        head(&Msg::Bulk {
            codec,
            data: Bytes(Vec::new()),
        })
    }

    fn section(x: i32, data: Vec<u8>) -> Vec<u8> {
        Msg::Section {
            pos: Pos { x, y: 0, z: -x },
            version: 7,
            data: Bytes(data),
        }
        .to_bytes()
    }

    #[test]
    fn pack_writes_what_the_derived_encoder_writes() {
        let big = vec![3; 300];
        let frames = vec![
            section(1, vec![2, 1, 0]),
            section(-2, big),
            Msg::Unload {
                positions: vec![Pos { x: 1, y: 2, z: 3 }],
            }
            .to_bytes(),
        ];
        let mut data = Writer::new();
        for f in &frames {
            data.write_len(f.len());
            data.write_raw(f);
        }
        let derived = Msg::Bulk {
            codec: Codec::None,
            data: Bytes(data.into_bytes()),
        };
        let none = bulk_head(Codec::None);
        let packed = pack(&none, &frames);
        assert_eq!(packed, derived.to_bytes());
        let Msg::Bulk { codec, data } = Msg::from_bytes(&packed).unwrap() else {
            panic!("not a Bulk");
        };
        assert_eq!(codec, Codec::None);
        let back: Vec<&[u8]> = super::frames(&data.0).map(Result::unwrap).collect();
        assert_eq!(back, frames.iter().map(Vec::as_slice).collect::<Vec<_>>());
        // Nothing to pack is an empty batch.
        let empty: [Vec<u8>; 0] = [];
        let Msg::Bulk { data, .. } = Msg::from_bytes(&pack(&none, &empty)).unwrap() else {
            panic!("not a Bulk");
        };
        assert!(data.0.is_empty());
        // `data` then `encode` is `pack`, and `encode` writes any head as
        // the derived encoder does.
        assert_eq!(encode(&none, &super::data(&frames)), packed);
        let deflated = Msg::Bulk {
            codec: Codec::Deflate,
            data: Bytes(vec![9; 200]),
        };
        assert_eq!(
            encode(&bulk_head(Codec::Deflate), &[9; 200]),
            deflated.to_bytes()
        );
    }

    #[test]
    #[should_panic(expected = "ends with its data")]
    fn head_needs_the_data_last() {
        head(&Pos { x: 1, y: 2, z: 3 });
    }

    #[test]
    fn bad_data_is_an_error_then_nothing() {
        // A length past the end.
        let mut it = frames(&[5, 1, 2]);
        assert!(it.next().unwrap().is_err());
        assert!(it.next().is_none());
        // An empty frame.
        let mut it = frames(&[1, 9, 0, 1, 9]);
        assert_eq!(it.next().unwrap().unwrap(), &[9]);
        assert!(it.next().unwrap().is_err());
        assert!(it.next().is_none());
        // An overlong length.
        assert!(frames(&[0x81, 0x00, 7]).next().unwrap().is_err());
    }
}
