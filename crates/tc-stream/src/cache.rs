//! The section cache, shared by every connection: each section's current
//! encoding and stamp, and a few earlier encodings (to send holders an
//! `Edit` from what they hold), by position, the least recently used
//! dropped first once over its bytes or its count.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;

use crate::msg::SectionPos;

/// Bytes counted per cached section on top of its encodings.
pub const SLOT_OVERHEAD: usize = 256;
/// The most sections the cache holds, whatever their size.
pub const MAX_CACHED_SECTIONS: usize = 1 << 16;

/// One encoding of a section.
#[derive(Clone, Debug)]
pub(crate) struct Built {
    pub(crate) stamp: u64,
    pub(crate) bytes: Arc<Vec<u8>>,
}

struct Slot {
    current: Built,
    /// Earlier encodings, oldest first.
    history: VecDeque<Built>,
    used: u64,
    cost: usize,
}

impl Slot {
    fn cost(&self) -> usize {
        SLOT_OVERHEAD
            + self.current.bytes.len()
            + self.history.iter().map(|b| b.bytes.len()).sum::<usize>()
    }
}

/// See the [module docs](self).
pub(crate) struct Cache {
    slots: HashMap<SectionPos, Slot>,
    lru: BTreeMap<u64, SectionPos>,
    bytes: usize,
    tick: u64,
    budget: usize,
    history: usize,
}

impl Cache {
    /// A cache of at most `budget` bytes keeping `history` earlier
    /// encodings a section.
    pub(crate) fn new(budget: usize, history: usize) -> Cache {
        Cache {
            slots: HashMap::new(),
            lru: BTreeMap::new(),
            bytes: 0,
            tick: 0,
            budget,
            history,
        }
    }

    fn touch(&mut self, pos: SectionPos) {
        if let Some(slot) = self.slots.get_mut(&pos) {
            self.lru.remove(&slot.used);
            self.tick += 1;
            slot.used = self.tick;
            self.lru.insert(self.tick, pos);
        }
    }

    /// `pos`'s current encoding, marked used.
    pub(crate) fn get(&mut self, pos: SectionPos) -> Option<Built> {
        self.touch(pos);
        self.slots.get(&pos).map(|s| s.current.clone())
    }

    /// The earlier encoding of `pos` with `stamp`, if still kept.
    pub(crate) fn earlier(&self, pos: SectionPos, stamp: u64) -> Option<Arc<Vec<u8>>> {
        let slot = self.slots.get(&pos)?;
        slot.history
            .iter()
            .find(|b| b.stamp == stamp)
            .map(|b| b.bytes.clone())
    }

    /// Makes `bytes` `pos`'s current encoding (the one it replaces kept as
    /// history if it differs) and returns it. May drop other sections.
    pub(crate) fn put(&mut self, pos: SectionPos, bytes: Vec<u8>) -> Built {
        let built = Built {
            stamp: tc_wire::stamp::bytes_stamp(&bytes),
            bytes: Arc::new(bytes),
        };
        match self.slots.get_mut(&pos) {
            Some(slot) if slot.current.bytes == built.bytes => {}
            Some(slot) => {
                let old = std::mem::replace(&mut slot.current, built);
                slot.history.retain(|b| b.stamp != slot.current.stamp);
                slot.history.push_back(old);
                while slot.history.len() > self.history {
                    slot.history.pop_front();
                }
            }
            None => {
                self.slots.insert(
                    pos,
                    Slot {
                        current: built,
                        history: VecDeque::new(),
                        used: 0,
                        cost: 0,
                    },
                );
            }
        }
        let slot = self.slots.get_mut(&pos).expect("just put");
        let cost = slot.cost();
        self.bytes = self.bytes + cost - slot.cost;
        slot.cost = cost;
        let current = slot.current.clone();
        self.touch(pos);
        self.evict(pos);
        current
    }

    /// Drops the least recently used sections, never `keep`, until within
    /// the budget.
    fn evict(&mut self, keep: SectionPos) {
        while self.bytes > self.budget || self.slots.len() > MAX_CACHED_SECTIONS {
            let Some((&used, &pos)) = self.lru.iter().find(|(_, p)| **p != keep) else {
                return;
            };
            self.lru.remove(&used);
            if let Some(slot) = self.slots.remove(&pos) {
                self.bytes -= slot.cost;
            }
        }
    }

    /// Forgets `pos` (it changed and nobody holds it).
    pub(crate) fn remove(&mut self, pos: SectionPos) {
        if let Some(slot) = self.slots.remove(&pos) {
            self.lru.remove(&slot.used);
            self.bytes -= slot.cost;
        }
    }

    /// Forgets everything.
    pub(crate) fn clear(&mut self) {
        self.slots.clear();
        self.lru.clear();
        self.bytes = 0;
    }

    /// Sections and bytes held.
    pub(crate) fn usage(&self) -> (usize, usize) {
        (self.slots.len(), self.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_history_and_drops_the_least_recently_used() {
        let at = |x| SectionPos::new(x, 0, 0);
        let mut c = Cache::new(3 * (SLOT_OVERHEAD + 100), 2);
        let a = c.put(at(0), vec![1; 100]);
        let a2 = c.put(at(0), vec![2; 100]);
        assert_ne!(a.stamp, a2.stamp);
        assert_eq!(c.earlier(at(0), a.stamp).as_deref(), Some(&vec![1; 100]));
        assert_eq!(
            c.put(at(0), vec![2; 100]).stamp,
            a2.stamp,
            "the same: no history"
        );
        c.put(at(0), vec![3; 100]);
        c.put(at(0), vec![4; 100]);
        assert!(c.earlier(at(0), a.stamp).is_none(), "two kept");
        // Section 0 holds 300 bytes of encodings: one more section fits.
        c.put(at(1), vec![0; 100]);
        assert_eq!(c.usage().0, 2);
        c.get(at(0));
        c.put(at(2), vec![0; 100]);
        assert!(c.get(at(1)).is_none(), "the least recently used went");
        assert!(c.get(at(0)).is_some() && c.get(at(2)).is_some());
        c.remove(at(0));
        c.remove(at(2));
        assert_eq!(c.usage(), (0, 0));
    }
}
