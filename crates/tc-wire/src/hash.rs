//! Stable hashing: the same output on every platform and build, forever.
//!
//! Built on the SplitMix64 finalizer. Used for schema hashes, result
//! hashes ([`crate::diff::result_hash`]), stamps and seeded randomness. The
//! test vectors below must never change; if they do, every recorded hash
//! changes with them. The TypeScript twin is `src/net/hash.ts`.

use crate::fixed::Fixed;

/// SplitMix64's increment (the golden ratio in 64 bits).
pub const GOLDEN_GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;

/// The SplitMix64 output function: a bijective 64-bit mixer.
pub const fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// An order-sensitive hasher over a stream of values.
///
/// Every value is fed as one or more 64-bit words; strings and byte slices
/// are length-prefixed so adjacent values can't run together.
#[derive(Clone, Debug)]
pub struct StableHasher {
    state: u64,
}

impl Default for StableHasher {
    fn default() -> Self {
        StableHasher::new()
    }
}

impl StableHasher {
    /// A hasher with the default starting state.
    pub const fn new() -> StableHasher {
        StableHasher { state: 0 }
    }

    /// Feeds one 64-bit word.
    pub fn write_u64(&mut self, v: u64) {
        self.state = mix64(self.state.wrapping_add(GOLDEN_GAMMA) ^ v);
    }

    /// Feeds a `u32`.
    pub fn write_u32(&mut self, v: u32) {
        self.write_u64(u64::from(v));
    }

    /// Feeds an `i32` (as its two's-complement bits).
    pub fn write_i32(&mut self, v: i32) {
        self.write_u64(u64::from(v as u32));
    }

    /// Feeds an `i64` (as its two's-complement bits).
    pub fn write_i64(&mut self, v: i64) {
        self.write_u64(v as u64);
    }

    /// Feeds a `u16`.
    pub fn write_u16(&mut self, v: u16) {
        self.write_u64(u64::from(v));
    }

    /// Feeds a `u8`.
    pub fn write_u8(&mut self, v: u8) {
        self.write_u64(u64::from(v));
    }

    /// Feeds a `bool`.
    pub fn write_bool(&mut self, v: bool) {
        self.write_u64(u64::from(v));
    }

    /// Feeds a byte slice: its length, then the bytes in little-endian
    /// 8-byte words (the last one zero-padded).
    pub fn write_bytes(&mut self, bytes: &[u8]) {
        self.write_u64(bytes.len() as u64);
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.write_u64(u64::from_le_bytes(word));
        }
    }

    /// Feeds a string's UTF-8 bytes.
    pub fn write_str(&mut self, s: &str) {
        self.write_bytes(s.as_bytes());
    }

    /// The hash of everything fed so far.
    pub fn finish(&self) -> u64 {
        mix64(self.state ^ GOLDEN_GAMMA)
    }
}

/// A uniform value in `[−1, 1)` from a hash: its top 33 bits, less one.
pub fn unit_signed_of(h: u64) -> Fixed {
    Fixed::from_bits((h >> 31) as i64 - (1 << 32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mix64_matches_published_splitmix64() {
        // SplitMix64 seeded with 0: state += gamma, output = mix(state).
        let expected = [
            0xE220_A839_7B1D_CDAF,
            0x6E78_9E6A_A1B9_65F4,
            0x06C4_5D18_8009_454F,
            0xF88B_B8A8_724C_81EC,
            0x1B39_896A_51A8_749B,
        ];
        let mut state: u64 = 0;
        for want in expected {
            state = state.wrapping_add(GOLDEN_GAMMA);
            assert_eq!(mix64(state), want);
        }
    }

    #[test]
    fn stable_hasher_vectors() {
        assert_eq!(StableHasher::new().finish(), 0xe220_a839_7b1d_cdaf);
        let mut h = StableHasher::new();
        h.write_u64(1);
        assert_eq!(h.finish(), 0x42d3_0092_dcd0_6d20);
        let mut h = StableHasher::new();
        h.write_str("forge:oak_sapling"); // a fixed vector; the text is arbitrary
        assert_eq!(h.finish(), 0xf92e_397d_9ab0_616f);
        let mut h = StableHasher::new();
        h.write_i32(-1);
        h.write_u8(7);
        h.write_bytes(&[]);
        assert_eq!(h.finish(), 0xfd50_beaf_17ef_f973);
    }

    #[test]
    fn unit_signed_of_range() {
        for i in 0..2000u64 {
            let u = unit_signed_of(mix64(i));
            assert!(u >= Fixed::from_int(-1) && u < Fixed::ONE);
        }
        assert_eq!(unit_signed_of(0).to_bits(), -(1 << 32));
        assert_eq!(unit_signed_of(u64::MAX).to_bits(), (1 << 32) - 1);
    }

    #[test]
    fn hasher_is_order_and_boundary_sensitive() {
        let hash = |f: &dyn Fn(&mut StableHasher)| {
            let mut h = StableHasher::new();
            f(&mut h);
            h.finish()
        };
        assert_ne!(
            hash(&|h| {
                h.write_u64(1);
                h.write_u64(2)
            }),
            hash(&|h| {
                h.write_u64(2);
                h.write_u64(1)
            })
        );
        assert_ne!(
            hash(&|h| {
                h.write_str("ab");
                h.write_str("c")
            }),
            hash(&|h| {
                h.write_str("a");
                h.write_str("bc")
            })
        );
        assert_ne!(
            hash(&|h| h.write_bytes(&[0])),
            hash(&|h| h.write_bytes(&[]))
        );
    }
}
