//! Compact per-connection records keyed by position: [`RegionMap`] packs
//! the values of up to 64 positions (an 8 x 8 run of sections in x and y,
//! one deep in z) behind one bitmap, and [`HeldMap`] is what a connection
//! holds of the sections: a stamp each in a region map, and the queued
//! frame's ticket only while one is queued.
//!
//! A hash-map entry per section held cost about 246 bytes a section in
//! Forge Wilds' 16/8 view (the section's entry, two per-section layer
//! entries, the slack of three tables); packed, a full region costs its
//! values and one table entry.

use tc_net::BulkTicket;

use crate::hash::PosMap;
use crate::msg::SectionPos;

/// A region's position and a position's index in it.
fn split(p: SectionPos) -> (SectionPos, u32) {
    let key = SectionPos::new(p.x >> 3, p.y >> 3, p.z);
    let i = (p.x & 7) as u32 | ((p.y & 7) as u32) << 3;
    (key, i)
}

/// The position at index `i` of region `key`.
fn join(key: SectionPos, i: u32) -> SectionPos {
    SectionPos::new(
        (key.x << 3) | (i & 7) as i32,
        (key.y << 3) | ((i >> 3) & 7) as i32,
        key.z,
    )
}

/// The set bits of `bits`, lowest first.
fn ones(mut bits: u64) -> impl Iterator<Item = u32> {
    std::iter::from_fn(move || {
        (bits != 0).then(|| {
            let i = bits.trailing_zeros();
            bits &= bits - 1;
            i
        })
    })
}

/// Room for one more value, grown eight at a time (not doubled: a region
/// holds at most 64, and slack is most of what packing saves).
fn grow<V>(vals: &mut Vec<V>) {
    if vals.len() == vals.capacity() {
        vals.reserve_exact(8.min(64 - vals.len()).max(1));
    }
}

struct Region<V> {
    bits: u64,
    /// One per set bit, in bit order.
    vals: Vec<V>,
}

impl<V> Region<V> {
    fn rank(&self, i: u32) -> usize {
        (self.bits & ((1u64 << i) - 1)).count_ones() as usize
    }

    fn has(&self, i: u32) -> bool {
        self.bits & (1u64 << i) != 0
    }
}

/// A map from positions to `V`, packed by region: a table entry per
/// 8 x 8 x 1 run of positions and a value per position present.
pub(crate) struct RegionMap<V> {
    regions: PosMap<SectionPos, Region<V>>,
    len: usize,
}

impl<V> Default for RegionMap<V> {
    fn default() -> Self {
        RegionMap {
            regions: PosMap::default(),
            len: 0,
        }
    }
}

impl<V> RegionMap<V> {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn contains_key(&self, p: &SectionPos) -> bool {
        let (key, i) = split(*p);
        self.regions.get(&key).is_some_and(|r| r.has(i))
    }

    pub(crate) fn get(&self, p: &SectionPos) -> Option<&V> {
        let (key, i) = split(*p);
        let r = self.regions.get(&key)?;
        r.has(i).then(|| &r.vals[r.rank(i)])
    }

    pub(crate) fn get_mut(&mut self, p: &SectionPos) -> Option<&mut V> {
        let (key, i) = split(*p);
        let r = self.regions.get_mut(&key)?;
        if !r.has(i) {
            return None;
        }
        let at = r.rank(i);
        Some(&mut r.vals[at])
    }

    /// Sets `p`'s value; returns the one it had.
    pub(crate) fn insert(&mut self, p: SectionPos, v: V) -> Option<V> {
        let (key, i) = split(p);
        let r = self.regions.entry(key).or_insert_with(|| Region {
            bits: 0,
            vals: Vec::new(),
        });
        let at = r.rank(i);
        if r.has(i) {
            return Some(std::mem::replace(&mut r.vals[at], v));
        }
        r.bits |= 1u64 << i;
        grow(&mut r.vals);
        r.vals.insert(at, v);
        self.len += 1;
        None
    }

    /// `p`'s value, inserted with `f` if it has none.
    pub(crate) fn get_or_insert_with(&mut self, p: SectionPos, f: impl FnOnce() -> V) -> &mut V {
        let (key, i) = split(p);
        let r = self.regions.entry(key).or_insert_with(|| Region {
            bits: 0,
            vals: Vec::new(),
        });
        let at = r.rank(i);
        if !r.has(i) {
            r.bits |= 1u64 << i;
            grow(&mut r.vals);
            r.vals.insert(at, f());
            self.len += 1;
        }
        &mut r.vals[at]
    }

    pub(crate) fn remove(&mut self, p: &SectionPos) -> Option<V> {
        let (key, i) = split(*p);
        let r = self.regions.get_mut(&key)?;
        if !r.has(i) {
            return None;
        }
        let at = r.rank(i);
        r.bits &= !(1u64 << i);
        let v = r.vals.remove(at);
        self.len -= 1;
        if r.bits == 0 {
            self.regions.remove(&key);
        } else if r.vals.capacity() > 4 && r.vals.len() * 4 <= r.vals.capacity() {
            r.vals.shrink_to(r.vals.len() * 2);
        }
        Some(v)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (SectionPos, &V)> {
        self.regions.iter().flat_map(|(key, r)| {
            let key = *key;
            ones(r.bits)
                .zip(&r.vals)
                .map(move |(i, v)| (join(key, i), v))
        })
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = SectionPos> + '_ {
        self.iter().map(|(p, _)| p)
    }

    /// Takes every entry out.
    pub(crate) fn drain(&mut self) -> impl Iterator<Item = (SectionPos, V)> + use<V> {
        self.len = 0;
        std::mem::take(&mut self.regions)
            .into_iter()
            .flat_map(|(key, r)| {
                ones(r.bits)
                    .zip(r.vals)
                    .map(move |(i, v)| (join(key, i), v))
            })
    }

    /// Bytes it takes, roughly: the table by capacity, and the values.
    pub(crate) fn bytes(&self) -> usize {
        self.regions.capacity() * (size_of::<(SectionPos, Region<V>)>() + 1)
            + self
                .regions
                .values()
                .map(|r| r.vals.capacity() * size_of::<V>())
                .sum::<usize>()
    }
}

/// A section a connection holds, or will once its queued frame is
/// written.
pub(crate) struct Held {
    /// The stamp of the encoding it holds (or will; 0: an earlier copy,
    /// unknown).
    pub(crate) stamp: u64,
    /// The bulk frame that sends it, until written.
    pub(crate) ticket: Option<BulkTicket>,
    /// The length of `ticket`'s frame.
    pub(crate) bytes: u32,
    /// The client held an earlier copy when that frame was queued.
    pub(crate) replaces: bool,
}

impl Held {
    /// Held with nothing queued.
    pub(crate) fn kept(stamp: u64) -> Held {
        Held {
            stamp,
            ticket: None,
            bytes: 0,
            replaces: false,
        }
    }

    /// Withdraws its queued frame: its length, if it was withdrawn.
    pub(crate) fn take_back(&self) -> Option<u32> {
        self.ticket
            .as_ref()
            .is_some_and(BulkTicket::withdraw)
            .then_some(self.bytes)
    }
}

/// A held section's queued frame.
struct Queued {
    ticket: BulkTicket,
    bytes: u32,
    replaces: bool,
}

impl Queued {
    /// Still waiting in the lane: neither written nor withdrawn.
    fn waiting(&self) -> bool {
        !self.ticket.taken() && !self.ticket.withdrawn()
    }
}

/// What a connection holds: each section's stamp, packed by region, and
/// the frames still queued for them (a ticket is let go once written).
#[derive(Default)]
pub(crate) struct HeldMap {
    stamps: RegionMap<u64>,
    queued: PosMap<SectionPos, Queued>,
}

impl HeldMap {
    pub(crate) fn len(&self) -> usize {
        self.stamps.len()
    }

    pub(crate) fn contains_key(&self, p: &SectionPos) -> bool {
        self.stamps.contains_key(p)
    }

    /// The stamp held at `p`.
    pub(crate) fn stamp(&self, p: &SectionPos) -> Option<u64> {
        self.stamps.get(p).copied()
    }

    pub(crate) fn get(&self, p: &SectionPos) -> Option<Held> {
        let stamp = *self.stamps.get(p)?;
        Some(match self.queued.get(p) {
            Some(q) => Held {
                stamp,
                ticket: Some(q.ticket.clone()),
                bytes: q.bytes,
                replaces: q.replaces,
            },
            None => Held::kept(stamp),
        })
    }

    /// Holds `p` as `h`; returns the stamp it held before.
    pub(crate) fn insert(&mut self, p: SectionPos, h: Held) -> Option<u64> {
        match h.ticket {
            Some(ticket) => {
                self.queued.insert(
                    p,
                    Queued {
                        ticket,
                        bytes: h.bytes,
                        replaces: h.replaces,
                    },
                );
            }
            None => {
                self.queued.remove(&p);
            }
        }
        self.stamps.insert(p, h.stamp)
    }

    pub(crate) fn remove(&mut self, p: &SectionPos) -> Option<Held> {
        let stamp = self.stamps.remove(p)?;
        Some(match self.queued.remove(p) {
            Some(q) => Held {
                stamp,
                ticket: Some(q.ticket),
                bytes: q.bytes,
                replaces: q.replaces,
            },
            None => Held::kept(stamp),
        })
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = SectionPos> + '_ {
        self.stamps.keys()
    }

    /// Takes every section out.
    pub(crate) fn drain(&mut self) -> Vec<(SectionPos, Held)> {
        let mut queued = std::mem::take(&mut self.queued);
        self.stamps
            .drain()
            .map(|(p, stamp)| {
                let h = match queued.remove(&p) {
                    Some(q) => Held {
                        stamp,
                        ticket: Some(q.ticket),
                        bytes: q.bytes,
                        replaces: q.replaces,
                    },
                    None => Held::kept(stamp),
                };
                (p, h)
            })
            .collect()
    }

    /// Lets go of the tickets of frames written. (One withdrawn is kept:
    /// it says the client never got that frame.)
    pub(crate) fn prune(&mut self) {
        self.queued.retain(|_, q| !q.ticket.taken());
        if self.queued.capacity() > 64 && self.queued.len() * 4 <= self.queued.capacity() {
            self.queued.shrink_to(self.queued.len() * 2);
        }
    }

    /// Its section frames still waiting in the bulk lane.
    pub(crate) fn in_flight(&self) -> usize {
        self.queued.values().filter(|q| q.waiting()).count()
    }

    /// True if any of its section frames still waits in the bulk lane.
    pub(crate) fn any_in_flight(&self) -> bool {
        self.queued.values().any(Queued::waiting)
    }

    /// Bytes it takes, roughly.
    pub(crate) fn bytes(&self) -> usize {
        self.stamps.bytes() + self.queued.capacity() * (size_of::<(SectionPos, Queued)>() + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_and_finds_positions_on_both_sides_of_zero() {
        let mut m = RegionMap::default();
        let mut want = std::collections::BTreeMap::new();
        let mut n = 0u64;
        for x in -9..9 {
            for y in -9..9 {
                for z in -2..2 {
                    if (x * 7 + y * 3 + z) % 3 == 0 {
                        let p = SectionPos::new(x, y, z);
                        n += 1;
                        assert_eq!(m.insert(p, n), None);
                        want.insert(p, n);
                    }
                }
            }
        }
        assert_eq!(m.len(), want.len());
        for (p, v) in &want {
            assert_eq!(m.get(p), Some(v));
        }
        let got: std::collections::BTreeMap<SectionPos, u64> =
            m.iter().map(|(p, v)| (p, *v)).collect();
        assert_eq!(got, want);
        assert_eq!(
            m.insert(SectionPos::new(0, 0, 0), 99),
            Some(want[&SectionPos::new(0, 0, 0)])
        );
        for p in want.keys() {
            assert!(m.remove(p).is_some());
            assert!(!m.contains_key(p));
        }
        assert_eq!(m.len(), 0);
        assert_eq!(m.regions.len(), 0);
        let far = SectionPos::new(i32::MIN, i32::MAX, i32::MIN);
        m.insert(far, 1);
        assert_eq!(m.keys().collect::<Vec<_>>(), vec![far]);
        assert_eq!(m.drain().count(), 1);
        assert_eq!(m.len(), 0);
    }
}
