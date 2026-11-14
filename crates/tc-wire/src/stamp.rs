//! Stamps: what a client and the server both compute from the bytes that
//! crossed the wire, so a reconnecting client can say what it holds and the
//! server send only what changed.
//!
//! A stamp is the stable hash (SplitMix64, the one query results are
//! hashed with) of bytes as they crossed the wire, never 0 (0 is "no
//! stamp"). A game picks what it stamps: [`bytes_stamp`] for one encoding,
//! [`parts_stamp`] for several fields in order, and [`pairs_digest`] for
//! a group of stamps, each with its key (a column's sections by height).
//! On the wire a stamp is its 64 bits, or two `u32` halves ([`split`],
//! [`join`]) where 64-bit integers can't be exact.
//!
//! The hash is not keyed: whoever controls an encoding can steer its stamp,
//! so stamps only ever decide what *that* client is sent.

use crate::hash::StableHasher;

/// A hash as a stamp: never 0.
fn nonzero(h: u64) -> u64 {
    h.max(1)
}

/// The stamp of one encoding.
pub fn bytes_stamp(bytes: &[u8]) -> u64 {
    let mut h = StableHasher::new();
    h.write_bytes(bytes);
    nonzero(h.finish())
}

/// The stamp of several encodings in order, each length-prefixed.
pub fn parts_stamp<'a>(parts: impl IntoIterator<Item = &'a [u8]>) -> u64 {
    let mut h = StableHasher::new();
    for p in parts {
        h.write_bytes(p);
    }
    nonzero(h.finish())
}

/// The digest of `(key, stamp)` pairs, in the order given (keys
/// ascending).
pub fn pairs_digest(pairs: impl IntoIterator<Item = (i32, u64)>) -> u64 {
    let mut h = StableHasher::new();
    for (key, s) in pairs {
        h.write_i32(key);
        h.write_u64(s);
    }
    nonzero(h.finish())
}

/// A stamp as its high and low `u32` halves.
pub fn split(stamp: u64) -> (u32, u32) {
    ((stamp >> 32) as u32, stamp as u32)
}

/// The stamp [`split`] made `(hi, lo)` from.
pub fn join(hi: u32, lo: u32) -> u64 {
    u64::from(hi) << 32 | u64::from(lo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_split_and_join() {
        for v in [0, 1, u64::MAX, 0x0123_4567_89ab_cdef] {
            let (hi, lo) = split(v);
            assert_eq!(join(hi, lo), v);
        }
        assert_eq!(split(0x0123_4567_89ab_cdef), (0x0123_4567, 0x89ab_cdef));
    }

    #[test]
    fn a_bytes_stamp_is_the_result_hash_of_its_bytes() {
        let bytes = [1, 2, 3];
        assert_eq!(bytes_stamp(&bytes), crate::diff::result_hash(&bytes).max(1));
        assert_ne!(pairs_digest([(0, 5)]), pairs_digest([(1, 5)]));
        assert_ne!(
            parts_stamp([&[1u8][..], &[2u8][..]]),
            parts_stamp([&[1u8, 2][..], &[][..]])
        );
    }
}
