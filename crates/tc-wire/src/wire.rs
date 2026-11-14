//! The binary wire format: [`Writer`], [`Reader`], [`DecodeError`], and the
//! [`Wire`] trait with its primitive implementations.
//!
//! | Type | Encoding |
//! | ---- | -------- |
//! | `bool` | 1 byte, 0 or 1 |
//! | `u8` | 1 byte |
//! | `u16`, `u32`, `u64` | unsigned LEB128 varint |
//! | `i32`, `i64` | zigzag, then LEB128 varint |
//! | `Fixed` | its raw 32.32 `i64` bits, as `i64` |
//! | `String` | varint byte length, then UTF-8 |
//! | `Vec<T>` | varint count, then the items |
//! | `Option<T>` | 1 byte tag (0 none, 1 some), then the value |
//! | [`Bytes`] | varint byte length, then the bytes |
//! | `BTreeMap<K, V>` | varint count, then key and value of each entry in ascending key order |
//! | struct | fields in declaration order |
//! | enum | varint variant index (declaration order), then the variant's fields |
//!
//! Decoding is strict: non-canonical (overlong) varints, values out of range
//! for their type, invalid UTF-8, unknown variants, bad tags, map keys that
//! are not strictly ascending, and trailing bytes after a top-level message
//! are all errors. Every value encodes to at
//! least one byte, so a length prefix larger than the bytes left is rejected
//! before anything is allocated.

use std::collections::BTreeMap;
use std::fmt;

use crate::varint::{self as codec, Varint, WireError};

use crate::schema::{SchemaBuilder, TypeRef};

/// The most memory a `Vec` reserves up front from a decoded count. Larger
/// vectors grow as their elements actually decode.
const MAX_PREALLOC_BYTES: usize = 16 * 1024;

/// How many elements to reserve for a decoded count of `len`. The count is
/// at most the bytes left in the frame, but an element can be far larger in
/// memory than its one-byte minimum encoding, so a hostile count must not
/// size the allocation by itself.
fn initial_capacity<T>(len: usize) -> usize {
    len.min(MAX_PREALLOC_BYTES / size_of::<T>().max(1))
}

/// A type that can be written to and read from the wire, and can describe its
/// own shape for the schema hash and the TypeScript generator.
///
/// Implement it with `#[derive(Wire)]`.
pub trait Wire: Sized {
    /// Appends the encoding of `self`.
    fn encode(&self, w: &mut Writer);

    /// Reads one value. Does not check for trailing bytes.
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError>;

    /// Registers this type (and the types it uses) and returns a reference to it.
    fn describe(s: &mut SchemaBuilder) -> TypeRef;

    /// Encodes `self` as one complete message.
    fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::new();
        self.encode(&mut w);
        w.into_bytes()
    }

    /// Decodes one complete message; trailing bytes are an error.
    fn from_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(bytes);
        let value = Self::decode(&mut r)?;
        r.finish()?;
        Ok(value)
    }
}

impl From<Vec<u8>> for Writer {
    /// A writer appending to `buf` (its memory reused).
    fn from(buf: Vec<u8>) -> Self {
        Self { buf }
    }
}

/// An append-only byte buffer that values encode into.
#[derive(Debug, Default, Clone)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    /// An empty writer.
    pub fn new() -> Self {
        Self::default()
    }

    /// An empty writer with room for `bytes` before it grows.
    pub fn with_capacity(bytes: usize) -> Self {
        Self {
            buf: Vec::with_capacity(bytes),
        }
    }

    /// The bytes written so far.
    pub fn as_bytes(&self) -> &[u8] {
        &self.buf
    }

    /// Consumes the writer, returning its bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    /// Empties the writer, keeping its memory.
    pub fn clear(&mut self) {
        self.buf.clear();
    }

    /// Writes one raw byte.
    pub fn write_u8(&mut self, value: u8) {
        self.buf.push(value);
    }

    /// Writes a bool as one byte, 0 or 1.
    pub fn write_bool(&mut self, value: bool) {
        self.buf.push(u8::from(value));
    }

    /// Writes an unsigned LEB128 varint.
    pub fn write_varint(&mut self, value: u64) {
        codec::write_varint(&mut self.buf, value);
    }

    /// Writes a signed integer as a zigzag varint.
    pub fn write_zigzag(&mut self, value: i64) {
        codec::write_varint(&mut self.buf, codec::zigzag(value));
    }

    /// Writes a length or count prefix.
    pub fn write_len(&mut self, len: usize) {
        self.write_varint(len as u64);
    }

    /// Writes a string as its byte length followed by its UTF-8 bytes.
    pub fn write_str(&mut self, value: &str) {
        self.write_len(value.len());
        self.buf.extend_from_slice(value.as_bytes());
    }

    /// Appends already-encoded bytes as they are.
    pub fn write_raw(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }
}

/// A cursor over a received message.
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    /// A reader positioned at the start of `bytes`.
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    /// Offset of the next byte to read.
    pub fn position(&self) -> usize {
        self.pos
    }

    /// Number of bytes not yet read.
    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }

    /// Succeeds only if every byte has been read.
    pub fn finish(&self) -> Result<(), DecodeError> {
        match self.remaining() {
            0 => Ok(()),
            count => Err(DecodeError::new(
                self.pos,
                DecodeErrorKind::TrailingBytes { count },
            )),
        }
    }

    /// Reads one raw byte.
    pub fn read_u8(&mut self) -> Result<u8, DecodeError> {
        let byte = *self
            .bytes
            .get(self.pos)
            .ok_or(DecodeError::new(self.pos, DecodeErrorKind::UnexpectedEnd))?;
        self.pos += 1;
        Ok(byte)
    }

    /// Reads a bool; any byte other than 0 or 1 is an error.
    pub fn read_bool(&mut self) -> Result<bool, DecodeError> {
        let at = self.pos;
        match self.read_u8()? {
            0 => Ok(false),
            1 => Ok(true),
            byte => Err(DecodeError::new(at, DecodeErrorKind::InvalidBool(byte))),
        }
    }

    /// Reads an `Option` tag: `false` for none, `true` for some.
    pub fn read_option_tag(&mut self) -> Result<bool, DecodeError> {
        let at = self.pos;
        match self.read_u8()? {
            0 => Ok(false),
            1 => Ok(true),
            byte => Err(DecodeError::new(
                at,
                DecodeErrorKind::InvalidOptionTag(byte),
            )),
        }
    }

    /// Reads a canonical unsigned LEB128 varint of at most 64 bits.
    pub fn read_varint(&mut self) -> Result<u64, DecodeError> {
        let at = self.pos;
        codec::read_varint(self.bytes, &mut self.pos, Varint::CANONICAL)
            .map_err(|e| self.varint_error(at, e, ""))
    }

    /// Reads a varint and checks it fits in `max` (for `u16`/`u32`).
    pub fn read_varint_max(&mut self, ty: &'static str, max: u64) -> Result<u64, DecodeError> {
        let at = self.pos;
        codec::read_varint_max(self.bytes, &mut self.pos, Varint::CANONICAL, max)
            .map_err(|e| self.varint_error(at, e, ty))
    }

    /// A varint's error as this format reports it: a truncation where the
    /// bytes ran out, the rest at the varint's first byte (`at`).
    fn varint_error(&self, at: usize, e: WireError, ty: &'static str) -> DecodeError {
        match e {
            WireError::Truncated => DecodeError::new(self.pos, DecodeErrorKind::UnexpectedEnd),
            WireError::Overlong => DecodeError::new(at, DecodeErrorKind::OverlongVarint),
            WireError::Overflow => DecodeError::new(at, DecodeErrorKind::VarintOverflow),
            WireError::OverBound { value, .. } => {
                DecodeError::new(at, DecodeErrorKind::OutOfRange { ty, value })
            }
        }
    }

    /// Reads a zigzag varint.
    pub fn read_zigzag(&mut self) -> Result<i64, DecodeError> {
        Ok(codec::unzigzag(self.read_varint()?))
    }

    /// Reads a length or count prefix. Every encoded value takes at least one
    /// byte, so a prefix larger than the bytes left is rejected.
    pub fn read_len(&mut self) -> Result<usize, DecodeError> {
        let at = self.pos;
        let len = self.read_varint()?;
        let remaining = self.remaining();
        match usize::try_from(len) {
            Ok(n) if n <= remaining => Ok(n),
            _ => Err(DecodeError::new(
                at,
                DecodeErrorKind::LengthTooLarge { len, remaining },
            )),
        }
    }

    /// Reads a length-prefixed UTF-8 string.
    pub fn read_string(&mut self) -> Result<String, DecodeError> {
        let len = self.read_len()?;
        let at = self.pos;
        let bytes = &self.bytes[at..at + len];
        self.pos += len;
        match std::str::from_utf8(bytes) {
            Ok(s) => Ok(s.to_owned()),
            Err(e) => Err(DecodeError::new(
                at + e.valid_up_to(),
                DecodeErrorKind::InvalidUtf8,
            )),
        }
    }

    /// Reads an enum variant index.
    pub fn read_variant(&mut self) -> Result<u64, DecodeError> {
        self.read_varint()
    }

    /// Reads `len` raw bytes.
    pub fn read_raw(&mut self, len: usize) -> Result<&'a [u8], DecodeError> {
        if len > self.remaining() {
            return Err(DecodeError::new(self.pos, DecodeErrorKind::UnexpectedEnd));
        }
        let bytes = &self.bytes[self.pos..self.pos + len];
        self.pos += len;
        Ok(bytes)
    }

    /// The bytes from offset `start` up to the current position.
    pub fn since(&self, start: usize) -> &'a [u8] {
        &self.bytes[start..self.pos]
    }
}

/// Why a message failed to decode, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    /// Byte offset in the message where the bad value starts.
    pub offset: usize,
    /// What was wrong.
    pub kind: DecodeErrorKind,
}

/// The kinds of [`DecodeError`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeErrorKind {
    /// The message ended in the middle of a value.
    UnexpectedEnd,
    /// A varint used more bytes than needed.
    OverlongVarint,
    /// A varint exceeded 64 bits.
    VarintOverflow,
    /// An integer exceeded the range of its type.
    OutOfRange {
        /// The Rust type being read.
        ty: &'static str,
        /// The value found.
        value: u64,
    },
    /// A bool byte other than 0 or 1.
    InvalidBool(u8),
    /// An `Option` tag other than 0 or 1.
    InvalidOptionTag(u8),
    /// An enum variant index past the last variant.
    UnknownVariant {
        /// The enum being read.
        ty: &'static str,
        /// The index found.
        index: u64,
    },
    /// String bytes that are not valid UTF-8.
    InvalidUtf8,
    /// A length or count prefix larger than the bytes left.
    LengthTooLarge {
        /// The length found.
        len: u64,
        /// The bytes left after the prefix.
        remaining: usize,
    },
    /// A map key not strictly greater than the key before it (unsorted or
    /// duplicate).
    MapKeyOrder,
    /// Bytes left over after a complete top-level message.
    TrailingBytes {
        /// How many.
        count: usize,
    },
}

impl DecodeError {
    /// An error of `kind` at byte `offset`.
    pub fn new(offset: usize, kind: DecodeErrorKind) -> Self {
        Self { offset, kind }
    }

    /// An unknown variant `index` of enum `ty`, whose index starts at `offset`.
    pub fn unknown_variant(offset: usize, ty: &'static str, index: u64) -> Self {
        Self::new(offset, DecodeErrorKind::UnknownVariant { ty, index })
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "at byte {}: ", self.offset)?;
        match &self.kind {
            DecodeErrorKind::UnexpectedEnd => write!(f, "unexpected end of message"),
            DecodeErrorKind::OverlongVarint => write!(f, "overlong varint"),
            DecodeErrorKind::VarintOverflow => write!(f, "varint exceeds 64 bits"),
            DecodeErrorKind::OutOfRange { ty, value } => {
                write!(f, "value {value} out of range for {ty}")
            }
            DecodeErrorKind::InvalidBool(b) => write!(f, "invalid bool byte {b}"),
            DecodeErrorKind::InvalidOptionTag(b) => write!(f, "invalid option tag {b}"),
            DecodeErrorKind::UnknownVariant { ty, index } => {
                write!(f, "unknown variant {index} for {ty}")
            }
            DecodeErrorKind::InvalidUtf8 => write!(f, "invalid UTF-8"),
            DecodeErrorKind::LengthTooLarge { len, remaining } => {
                write!(f, "length {len} exceeds the {remaining} bytes left")
            }
            DecodeErrorKind::MapKeyOrder => {
                write!(f, "map key not greater than the key before it")
            }
            DecodeErrorKind::TrailingBytes { count } => {
                write!(f, "{count} trailing bytes after message")
            }
        }
    }
}

impl std::error::Error for DecodeError {}

impl Wire for bool {
    fn encode(&self, w: &mut Writer) {
        w.write_bool(*self);
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        r.read_bool()
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::Bool
    }
}

impl Wire for u8 {
    fn encode(&self, w: &mut Writer) {
        w.write_u8(*self);
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        r.read_u8()
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::U8
    }
}

impl Wire for u16 {
    fn encode(&self, w: &mut Writer) {
        w.write_varint(u64::from(*self));
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(r.read_varint_max("u16", u64::from(u16::MAX))? as u16)
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::U16
    }
}

impl Wire for u32 {
    fn encode(&self, w: &mut Writer) {
        w.write_varint(u64::from(*self));
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(r.read_varint_max("u32", u64::from(u32::MAX))? as u32)
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::U32
    }
}

impl Wire for u64 {
    fn encode(&self, w: &mut Writer) {
        w.write_varint(*self);
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        r.read_varint()
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::U64
    }
}

impl Wire for i32 {
    fn encode(&self, w: &mut Writer) {
        w.write_zigzag(i64::from(*self));
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        // A zigzag i32 is at most u32::MAX before unzigzagging; checking the
        // raw varint keeps the error message about the encoded value.
        let raw = r.read_varint_max("i32", u64::from(u32::MAX))?;
        Ok(codec::unzigzag(raw) as i32)
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::I32
    }
}

impl Wire for i64 {
    fn encode(&self, w: &mut Writer) {
        w.write_zigzag(*self);
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        r.read_zigzag()
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::I64
    }
}

impl Wire for crate::Fixed {
    fn encode(&self, w: &mut Writer) {
        w.write_zigzag(self.to_bits());
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(crate::Fixed::from_bits(r.read_zigzag()?))
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::Fixed
    }
}

impl Wire for String {
    fn encode(&self, w: &mut Writer) {
        w.write_str(self);
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        r.read_string()
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::String
    }
}

impl<T: Wire> Wire for Vec<T> {
    fn encode(&self, w: &mut Writer) {
        w.write_len(self.len());
        for item in self {
            item.encode(w);
        }
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let len = r.read_len()?;
        let mut items = Vec::with_capacity(initial_capacity::<T>(len));
        for _ in 0..len {
            items.push(T::decode(r)?);
        }
        Ok(items)
    }
    fn describe(s: &mut SchemaBuilder) -> TypeRef {
        TypeRef::Vec(Box::new(T::describe(s)))
    }
}

impl<T: Wire> Wire for Option<T> {
    fn encode(&self, w: &mut Writer) {
        match self {
            None => w.write_u8(0),
            Some(value) => {
                w.write_u8(1);
                value.encode(w);
            }
        }
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        if r.read_option_tag()? {
            Ok(Some(T::decode(r)?))
        } else {
            Ok(None)
        }
    }
    fn describe(s: &mut SchemaBuilder) -> TypeRef {
        TypeRef::Option(Box::new(T::describe(s)))
    }
}

/// Raw bytes: a varint length, then the bytes. Encoded exactly like
/// `Vec<u8>`, but TypeScript gets a `Uint8Array` instead of `number[]`.
/// Carries encoded values inside messages (query arguments and results,
/// patch values).
#[derive(Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Bytes(pub Vec<u8>);

impl fmt::Debug for Bytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Bytes(")?;
        for b in &self.0 {
            write!(f, "{b:02x}")?;
        }
        f.write_str(")")
    }
}

impl From<Vec<u8>> for Bytes {
    fn from(bytes: Vec<u8>) -> Bytes {
        Bytes(bytes)
    }
}

impl std::ops::Deref for Bytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl Wire for Bytes {
    fn encode(&self, w: &mut Writer) {
        w.write_len(self.0.len());
        w.write_raw(&self.0);
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let len = r.read_len()?;
        Ok(Bytes(r.read_raw(len)?.to_vec()))
    }
    fn describe(_: &mut SchemaBuilder) -> TypeRef {
        TypeRef::Bytes
    }
}

/// A keyed map. Keys must be integers, strings, or newtypes of them (the
/// schema checks), so their order is the same in every language: numeric
/// for integers, by code point for strings. Entries go out in ascending
/// key order, and decoding refuses keys that are not strictly ascending,
/// so every map has exactly one encoding.
impl<K: Wire + Ord, V: Wire> Wire for BTreeMap<K, V> {
    fn encode(&self, w: &mut Writer) {
        w.write_len(self.len());
        for (key, value) in self {
            key.encode(w);
            value.encode(w);
        }
    }
    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let len = r.read_len()?;
        let mut map = BTreeMap::new();
        for _ in 0..len {
            let at = r.position();
            let key = K::decode(r)?;
            if map.last_key_value().is_some_and(|(last, _)| *last >= key) {
                return Err(DecodeError::new(at, DecodeErrorKind::MapKeyOrder));
            }
            let value = V::decode(r)?;
            map.insert(key, value);
        }
        Ok(map)
    }
    fn describe(s: &mut SchemaBuilder) -> TypeRef {
        TypeRef::Map(Box::new(K::describe(s)), Box::new(V::describe(s)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn kind<T: Wire + fmt::Debug>(hex: &str) -> DecodeErrorKind {
        T::from_bytes(&bytes(hex)).unwrap_err().kind
    }

    /// The integers are crate::varint's varints and zigzags (its tests
    /// hold the vectors); `i32` and `u16`/`u32` add their range checks.
    #[test]
    fn integers_are_the_core_codec() {
        for value in [0u64, 127, 128, 300, u64::from(u32::MAX), u64::MAX] {
            let mut expected = Vec::new();
            codec::write_varint(&mut expected, value);
            assert_eq!(value.to_bytes(), expected, "{value}");
            assert_eq!(u64::from_bytes(&expected), Ok(value));
        }
        for value in [0i64, -1, 1, i64::MAX, i64::MIN] {
            let mut expected = Vec::new();
            codec::write_varint(&mut expected, codec::zigzag(value));
            assert_eq!(value.to_bytes(), expected, "{value}");
            assert_eq!(i64::from_bytes(&expected), Ok(value));
        }
        for (value, expected) in [(i32::MAX, "feffffff0f"), (i32::MIN, "ffffffff0f")] {
            assert_eq!(hex(&value.to_bytes()), expected, "{value}");
            assert_eq!(i32::from_bytes(&bytes(expected)), Ok(value));
        }
        assert_eq!(u16::from_bytes(&bytes("ffff03")), Ok(u16::MAX));
        assert_eq!(u32::from_bytes(&bytes("ffffffff0f")), Ok(u32::MAX));
    }

    #[test]
    fn fixed_is_its_bits_as_a_zigzag_varint() {
        use crate::Fixed;
        for (value, expected) in [
            (Fixed::ZERO, "00"),
            (Fixed::from_bits(-1), "01"),
            (Fixed::ONE, "8080808020"),
            (Fixed::from_int(-1), "ffffffff1f"),
            (Fixed::MAX, "feffffffffffffffff01"),
            (Fixed::MIN, "ffffffffffffffffff01"),
        ] {
            assert_eq!(hex(&value.to_bytes()), expected, "{value}");
            assert_eq!(Fixed::from_bytes(&bytes(expected)), Ok(value));
        }
    }

    #[test]
    fn rejects_overlong_varints() {
        assert_eq!(kind::<u64>("8000"), DecodeErrorKind::OverlongVarint);
        assert_eq!(kind::<u32>("ff8000"), DecodeErrorKind::OverlongVarint);
    }

    #[test]
    fn rejects_overflowing_varints() {
        assert_eq!(
            kind::<u64>("ffffffffffffffffff02"),
            DecodeErrorKind::VarintOverflow
        );
        assert_eq!(
            kind::<u64>("ffffffffffffffffff8001"),
            DecodeErrorKind::VarintOverflow
        );
        assert_eq!(
            kind::<u32>("8080808010"),
            DecodeErrorKind::OutOfRange {
                ty: "u32",
                value: 1 << 32
            }
        );
        assert_eq!(
            kind::<u16>("808004"),
            DecodeErrorKind::OutOfRange {
                ty: "u16",
                value: 1 << 16
            }
        );
        assert!(matches!(
            kind::<i32>("8080808010"),
            DecodeErrorKind::OutOfRange { ty: "i32", .. }
        ));
    }

    #[test]
    fn rejects_bad_tags() {
        assert_eq!(kind::<bool>("02"), DecodeErrorKind::InvalidBool(2));
        assert_eq!(
            kind::<Option<u8>>("02"),
            DecodeErrorKind::InvalidOptionTag(2)
        );
    }

    #[test]
    fn rejects_truncation_and_trailing_bytes() {
        assert_eq!(kind::<u8>(""), DecodeErrorKind::UnexpectedEnd);
        assert_eq!(kind::<u32>("80"), DecodeErrorKind::UnexpectedEnd);
        assert_eq!(
            kind::<u8>("0102"),
            DecodeErrorKind::TrailingBytes { count: 1 }
        );
    }

    #[test]
    fn strings() {
        assert_eq!(hex(&String::new().to_bytes()), "00");
        assert_eq!(hex(&"é".to_string().to_bytes()), "02c3a9");
        assert_eq!(
            String::from_bytes(&bytes("03efbbbf")).unwrap(),
            "\u{feff}",
            "a byte order mark is data, not stripped"
        );
        let err = String::from_bytes(&bytes("03 61ff62".replace(' ', "").as_str())).unwrap_err();
        assert_eq!(err.kind, DecodeErrorKind::InvalidUtf8);
        assert_eq!(err.offset, 2);
        assert_eq!(
            kind::<String>("0561"),
            DecodeErrorKind::LengthTooLarge {
                len: 5,
                remaining: 1
            }
        );
    }

    #[test]
    fn huge_counts_are_rejected_before_allocating() {
        assert_eq!(
            kind::<Vec<u8>>("ffffffffffffffff7f"),
            DecodeErrorKind::LengthTooLarge {
                len: u64::MAX >> 1,
                remaining: 0
            }
        );
    }

    #[test]
    fn a_count_does_not_size_the_allocation() {
        // Every count below fits in a frame of that many bytes, but the
        // elements are far larger in memory than their one-byte encoding.
        for len in [0, 1, 100, 1 << 20, usize::MAX] {
            let cap = initial_capacity::<Vec<u64>>(len);
            assert!(cap <= len);
            assert!(cap * size_of::<Vec<u64>>() <= MAX_PREALLOC_BYTES, "{len}");
        }
        assert_eq!(initial_capacity::<u8>(100), 100);
        assert_eq!(initial_capacity::<u8>(1 << 20), MAX_PREALLOC_BYTES);
        assert_eq!(initial_capacity::<()>(1 << 20), MAX_PREALLOC_BYTES);
        // A hostile count still decodes to an error, not an allocation.
        let mut frame = vec![0x80, 0x80, 0x40];
        frame.resize(3 + (1 << 20), 0xff);
        assert_eq!(
            Vec::<Vec<u64>>::from_bytes(&frame).unwrap_err().kind,
            DecodeErrorKind::VarintOverflow
        );
    }

    #[test]
    fn maps_encode_in_key_order_and_decode_strictly() {
        let map: BTreeMap<i32, u8> = [(5, 1), (-1, 2), (300, 3)].into();
        // Count, then (key, value) pairs in numeric key order.
        assert_eq!(hex(&map.to_bytes()), "030102 0a01 d80403".replace(' ', ""));
        assert_eq!(BTreeMap::from_bytes(&map.to_bytes()), Ok(map));
        assert_eq!(hex(&BTreeMap::<u8, u8>::new().to_bytes()), "00");
        // Unsorted and duplicate keys are refused at the offending key.
        let err = BTreeMap::<u8, u8>::from_bytes(&bytes("0205010401")).unwrap_err();
        assert_eq!(err, DecodeError::new(3, DecodeErrorKind::MapKeyOrder));
        let err = BTreeMap::<u8, u8>::from_bytes(&bytes("0205010501")).unwrap_err();
        assert_eq!(err.kind, DecodeErrorKind::MapKeyOrder);
        assert_eq!(
            err.to_string(),
            "at byte 3: map key not greater than the key before it"
        );
        // Strings order by code point (UTF-8 byte order), not UTF-16 units:
        // U+FF5E sorts before U+1F332 even though its UTF-16 unit is larger.
        let strings: BTreeMap<String, u8> = [("🌲".to_string(), 1), ("～".to_string(), 2)].into();
        let keys: Vec<_> = strings.keys().cloned().collect();
        assert_eq!(keys, ["～", "🌲"]);
        assert_eq!(BTreeMap::from_bytes(&strings.to_bytes()), Ok(strings));
    }

    #[test]
    fn bytes_encode_like_a_vec_of_u8() {
        let raw = vec![0u8, 255, 7];
        assert_eq!(Bytes(raw.clone()).to_bytes(), raw.to_bytes());
        assert_eq!(Bytes::from_bytes(&raw.to_bytes()), Ok(Bytes(raw)));
        assert_eq!(
            kind::<Bytes>("0300"),
            DecodeErrorKind::LengthTooLarge {
                len: 3,
                remaining: 1
            }
        );
    }

    #[test]
    fn error_display() {
        let err = DecodeError::unknown_variant(3, "Command", 9);
        assert_eq!(err.to_string(), "at byte 3: unknown variant 9 for Command");
    }
}
