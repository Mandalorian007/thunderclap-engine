//! The stream's hot maps' hasher: positions are keys a client cannot pick
//! to collide on purpose any better than it can pick its view, so the
//! maps take a fast deterministic multiply-rotate hash (FxHash's mix with
//! a folded 128-bit finish) over the standard library's SipHash, which
//! was the larger share of a load's map work. See the README's numbers.
//! Public, so a game's own maps of positions hash the same way.

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

/// Builds [`PosHasher`]s: the hasher of [`PosMap`] and [`PosSet`].
pub type PosBuildHasher = BuildHasherDefault<PosHasher>;

/// A map keyed by positions (or tuples of them and integers).
pub type PosMap<K, V> = HashMap<K, V, PosBuildHasher>;

/// A set of positions (or tuples of them and integers).
pub type PosSet<K> = HashSet<K, PosBuildHasher>;

const K: u64 = 0xf135_7aea_2e62_a9c5;

/// A multiply-rotate hasher over whole integer writes: fast and
/// deterministic (no random keys), for keys a client can't choose to
/// collide (positions, and tuples of them and integers). Not for keys an
/// attacker picks freely.
#[derive(Default, Clone, Copy, Debug)]
pub struct PosHasher(u64);

impl PosHasher {
    #[inline]
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(26) ^ word).wrapping_mul(K);
    }
}

impl Hasher for PosHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let (words, rest) = bytes.as_chunks::<8>();
        for w in words {
            self.add(u64::from_le_bytes(*w));
        }
        if !rest.is_empty() {
            let mut w = [0; 8];
            w[..rest.len()].copy_from_slice(rest);
            self.add(u64::from_le_bytes(w) ^ ((rest.len() as u64) << 59));
        }
    }

    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.add(u64::from(i));
    }

    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.add(u64::from(i));
    }

    #[inline]
    fn write_i32(&mut self, i: i32) {
        self.add(u64::from(i as u32));
    }

    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.add(i);
    }

    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.add(i as u64);
    }

    #[inline]
    fn finish(&self) -> u64 {
        // Fold the high bits down: the table indexes by the low ones.
        let m = u128::from(self.0).wrapping_mul(u128::from(K));
        (m as u64) ^ ((m >> 64) as u64)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::hash::{BuildHasher, BuildHasherDefault};

    use super::PosHasher;
    use crate::msg::SectionPos;

    #[test]
    fn spreads_a_view_of_positions_over_the_low_bits() {
        let b = BuildHasherDefault::<PosHasher>::default();
        let mut buckets = HashSet::new();
        let mut n = 0;
        for x in -16..16 {
            for y in -8..8 {
                for z in -16..16 {
                    buckets.insert(b.hash_one(SectionPos::new(x, y, z)) & 0xffff);
                    n += 1;
                }
            }
        }
        // 16384 positions into 65536 buckets: a good hash fills most.
        assert!(buckets.len() > n * 3 / 4, "{} of {n}", buckets.len());
        // And it is the same every run (no random keys).
        assert_eq!(
            b.hash_one(SectionPos::new(1, 2, 3)),
            BuildHasherDefault::<PosHasher>::default().hash_one(SectionPos::new(1, 2, 3))
        );
    }
}
