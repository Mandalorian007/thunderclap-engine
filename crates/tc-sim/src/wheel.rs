//! A hierarchical timing wheel: the scheduler's queue.
//!
//! Same semantics as a `BTreeMap<EventKey, T>` used as a priority queue:
//! entries pop in `(time, seq)` order. Near entries cost O(1) to insert and
//! pop; far entries wait in coarser levels and move down (cascade) as the
//! cursor approaches, at most once per level.
//!
//! Layout: [`LEVELS`] levels of 64 slots each. Level `l` slots are
//! `64^l` steps wide, so eleven levels cover every `u64` time and nothing
//! overflows. An entry at time `t >= cursor` lives at the level of the
//! highest bit where `t` and the cursor differ (level 0 if equal), in the
//! slot given by `t`'s six bits at that level. This placement is kept as an
//! invariant: the cursor only moves to the start of the lowest occupied
//! slot, and that slot is cascaded when it does, so every entry's location
//! is computable from its key and the cursor alone.
//!
//! A level 0 slot holds a single time, kept sorted by key. Slots above are
//! unsorted; cascading sorts them into level 0. Entries inserted before the
//! cursor go to a small ordered map, `past`, which always pops first.

use std::collections::{BTreeMap, VecDeque};
use std::fmt;

use crate::scheduler::EventKey;

/// Bits of time per level.
const BITS: u32 = 6;
/// Slots per level.
const SLOTS: usize = 1 << BITS;
/// Levels: `6 * 11 = 66` bits cover any `u64` time.
const LEVELS: usize = 11;

/// A priority queue of values keyed by [`EventKey`], popping in key order.
pub struct TimingWheel<T> {
    /// Every entry in `slots` has `time >= cursor`. Only moves forward.
    cursor: u64,
    /// `LEVELS * SLOTS` slots; slot `s` of level `l` is at `l * SLOTS + s`.
    slots: Vec<VecDeque<(EventKey, T)>>,
    /// Per level, bit `s` set iff slot `s` is non-empty.
    occupied: [u64; LEVELS],
    /// Entries inserted with `time < cursor`.
    past: BTreeMap<EventKey, T>,
    len: usize,
}

impl<T> Default for TimingWheel<T> {
    fn default() -> Self {
        TimingWheel::new()
    }
}

impl<T: Clone> Clone for TimingWheel<T> {
    fn clone(&self) -> Self {
        TimingWheel {
            cursor: self.cursor,
            slots: self.slots.clone(),
            occupied: self.occupied,
            past: self.past.clone(),
            len: self.len,
        }
    }
}

impl<T: fmt::Debug> fmt::Debug for TimingWheel<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl<T> TimingWheel<T> {
    /// An empty wheel with its cursor at time zero.
    pub fn new() -> TimingWheel<T> {
        TimingWheel {
            cursor: 0,
            slots: (0..LEVELS * SLOTS).map(|_| VecDeque::new()).collect(),
            occupied: [0; LEVELS],
            past: BTreeMap::new(),
            len: 0,
        }
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.len
    }

    /// True if there are no entries.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Adds an entry. Keys must be unique; any time is allowed, including
    /// times before entries already popped.
    pub fn insert(&mut self, key: EventKey, value: T) {
        self.len += 1;
        if key.time < self.cursor {
            self.past.insert(key, value);
        } else {
            self.place(key, value);
        }
    }

    /// Removes the entry with `key`, if present.
    pub fn remove(&mut self, key: &EventKey) -> Option<T> {
        let t = key.time;
        let value = if t < self.cursor {
            self.past.remove(key)
        } else {
            let (level, slot) = locate(self.cursor, t);
            let deque = &mut self.slots[level * SLOTS + slot];
            let removed = if level == 0 {
                match deque.binary_search_by(|(k, _)| k.cmp(key)) {
                    Ok(i) => deque.remove(i),
                    Err(_) => None,
                }
            } else {
                match deque.iter().position(|(k, _)| k == key) {
                    Some(i) => deque.swap_remove_back(i),
                    None => None,
                }
            };
            if deque.is_empty() {
                self.occupied[level] &= !(1 << slot);
            }
            removed.map(|(_, v)| v)
        };
        if value.is_some() {
            self.len -= 1;
        }
        value
    }

    /// Removes and returns the smallest entry if its time is at or before
    /// `now`.
    pub fn pop_due(&mut self, now: u64) -> Option<(EventKey, T)> {
        if let Some((key, _)) = self.past.first_key_value() {
            if key.time > now {
                return None;
            }
            self.len -= 1;
            return self.past.pop_first();
        }
        loop {
            let level = self.lowest_level()?;
            let slot = self.occupied[level].trailing_zeros() as usize;
            let start = block_start(self.cursor, level) | ((slot as u64) << (BITS * level as u32));
            if start > now {
                return None;
            }
            self.cursor = start;
            if level == 0 {
                let deque = &mut self.slots[slot];
                let entry = deque.pop_front();
                if deque.is_empty() {
                    self.occupied[0] &= !(1 << slot);
                }
                self.len -= 1;
                return entry;
            }
            self.cascade(level, slot);
        }
    }

    /// The smallest key. O(1) when it is near; otherwise a scan of one
    /// coarse slot.
    pub fn first_key(&self) -> Option<EventKey> {
        if let Some((key, _)) = self.past.first_key_value() {
            return Some(*key);
        }
        let level = self.lowest_level()?;
        let slot = self.occupied[level].trailing_zeros() as usize;
        let deque = &self.slots[level * SLOTS + slot];
        if level == 0 {
            deque.front().map(|(k, _)| *k)
        } else {
            deque.iter().map(|(k, _)| *k).min()
        }
    }

    /// Every entry in key order. O(n log n); for hashing and debugging.
    pub fn iter(&self) -> impl Iterator<Item = (&EventKey, &T)> {
        let mut entries: Vec<(&EventKey, &T)> = self.past.iter().collect();
        entries.extend(self.slots.iter().flatten().map(|(k, v)| (k, v)));
        entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
        entries.into_iter()
    }

    fn lowest_level(&self) -> Option<usize> {
        self.occupied.iter().position(|&bits| bits != 0)
    }

    /// Puts an entry with `time >= cursor` where the invariant says.
    fn place(&mut self, key: EventKey, value: T) {
        let (level, slot) = locate(self.cursor, key.time);
        let deque = &mut self.slots[level * SLOTS + slot];
        if level == 0 && deque.back().is_some_and(|(k, _)| *k > key) {
            let i = deque.partition_point(|(k, _)| *k < key);
            deque.insert(i, (key, value));
        } else {
            deque.push_back((key, value));
        }
        self.occupied[level] |= 1 << slot;
    }

    /// Moves a slot's entries down after the cursor reached its start.
    fn cascade(&mut self, level: usize, slot: usize) {
        let index = level * SLOTS + slot;
        let mut entries = std::mem::take(&mut self.slots[index]);
        self.occupied[level] &= !(1 << slot);
        for (key, value) in entries.drain(..) {
            self.place(key, value);
        }
        // Keep the allocation for the slot's next use.
        self.slots[index] = entries;
    }
}

/// The level and slot for time `t >= cursor`.
fn locate(cursor: u64, t: u64) -> (usize, usize) {
    let diff = cursor ^ t;
    let level = if diff == 0 {
        0
    } else {
        ((63 - diff.leading_zeros()) / BITS) as usize
    };
    let slot = ((t >> (BITS * level as u32)) as usize) & (SLOTS - 1);
    (level, slot)
}

/// `cursor` with the bits of `level` and all levels below cleared: the
/// first time of the level's current rotation.
fn block_start(cursor: u64, level: usize) -> u64 {
    let shift = BITS * (level as u32 + 1);
    if shift >= u64::BITS {
        0
    } else {
        cursor >> shift << shift
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use tc_wire::hash::{GOLDEN_GAMMA, mix64};

    use crate::MAX_TIME;

    use super::*;

    fn key(time: u64, seq: u64) -> EventKey {
        EventKey { time, seq }
    }

    fn drain(w: &mut TimingWheel<u64>, now: u64) -> Vec<(u64, u64)> {
        let mut out = Vec::new();
        while let Some((k, _)) = w.pop_due(now) {
            out.push((k.time, k.seq));
        }
        out
    }

    /// SplitMix64 over a counter: deterministic test randomness.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(GOLDEN_GAMMA);
            mix64(self.0)
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    #[test]
    fn empty_wheel() {
        let mut w = TimingWheel::<u64>::new();
        assert!(w.is_empty());
        assert_eq!(w.first_key(), None);
        assert_eq!(w.pop_due(MAX_TIME), None);
        assert_eq!(w.remove(&key(5, 0)), None);
        assert_eq!(w.iter().count(), 0);
    }

    #[test]
    fn same_time_pops_in_seq_order_even_if_inserted_out_of_order() {
        let mut w = TimingWheel::new();
        for (t, s) in [(3, 5), (3, 1), (3, 9), (3, 2), (100, 7), (100, 3), (70, 4)] {
            w.insert(key(t, s), s);
        }
        assert_eq!(
            drain(&mut w, 1000),
            [(3, 1), (3, 2), (3, 5), (3, 9), (70, 4), (100, 3), (100, 7)]
        );
    }

    #[test]
    fn insert_at_cursor_while_firing_pops_before_later_events() {
        let mut w = TimingWheel::new();
        w.insert(key(500, 0), 0);
        w.insert(key(900, 1), 1);
        assert_eq!(w.pop_due(1000).map(|(k, _)| k), Some(key(500, 0)));
        // A game schedules follow-ups at the current time and just after.
        w.insert(key(500, 2), 2);
        w.insert(key(501, 3), 3);
        assert_eq!(drain(&mut w, 1000), [(500, 2), (501, 3), (900, 1)]);
    }

    #[test]
    fn insert_before_cursor_pops_first() {
        let mut w = TimingWheel::new();
        w.insert(key(10_000, 0), 0);
        w.insert(key(20_000, 1), 1);
        assert_eq!(w.pop_due(15_000).map(|(k, _)| k), Some(key(10_000, 0)));
        w.insert(key(5, 3), 3);
        w.insert(key(2, 4), 4);
        assert_eq!(w.first_key(), Some(key(2, 4)));
        assert_eq!(w.pop_due(1), None);
        assert_eq!(w.remove(&key(5, 3)), Some(3));
        w.insert(key(12_000, 5), 5);
        assert_eq!(drain(&mut w, 30_000), [(2, 4), (12_000, 5), (20_000, 1)]);
    }

    #[test]
    fn smaller_now_returns_nothing_then_later_pops() {
        let mut w = TimingWheel::new();
        w.insert(key(1 << 20, 0), 0);
        w.insert(key((1 << 20) + 1, 1), 1);
        assert_eq!(w.pop_due((1 << 20) - 1), None);
        assert_eq!(w.pop_due(1 << 20).map(|(k, _)| k.seq), Some(0));
        assert_eq!(w.pop_due(3), None);
        assert_eq!(w.pop_due(1 << 20), None);
        assert_eq!(w.len(), 1);
        assert_eq!(drain(&mut w, u64::MAX), [((1 << 20) + 1, 1)]);
    }

    #[test]
    fn extreme_times() {
        let max = MAX_TIME;
        let mut w = TimingWheel::new();
        w.insert(key(u64::MAX, 0), 0);
        w.insert(key(max, 1), 1);
        w.insert(key(max - 1, 2), 2);
        w.insert(key(0, 3), 3);
        w.insert(key(1 << 52, 4), 4);
        assert_eq!(w.first_key(), Some(key(0, 3)));
        assert_eq!(drain(&mut w, max - 1), [(0, 3), (1 << 52, 4), (max - 1, 2)]);
        assert_eq!(w.first_key(), Some(key(max, 1)));
        assert_eq!(drain(&mut w, max), [(max, 1)]);
        w.insert(key(max, 5), 5);
        assert_eq!(drain(&mut w, u64::MAX), [(max, 5), (u64::MAX, 0)]);
        w.insert(key(u64::MAX, 6), 6);
        w.insert(key(3, 7), 7);
        assert_eq!(drain(&mut w, u64::MAX), [(3, 7), (u64::MAX, 6)]);
        assert!(w.is_empty());
    }

    #[test]
    fn cancel_at_every_level_before_and_after_cascades() {
        let mut w = TimingWheel::new();
        let times: Vec<u64> = (0..54).map(|b| (1u64 << b) + b).collect();
        for (seq, &t) in times.iter().enumerate() {
            w.insert(key(t, seq as u64), seq as u64);
            w.insert(key(t, 100 + seq as u64), 100 + seq as u64);
        }
        // Cancel half before anything moves.
        for (seq, &t) in times.iter().enumerate().filter(|(s, _)| s % 2 == 0) {
            assert_eq!(w.remove(&key(t, seq as u64)), Some(seq as u64));
            assert_eq!(w.remove(&key(t, seq as u64)), None);
        }
        // Advance partway (cascading the near levels), then cancel more.
        let mid = times[30];
        let fired = drain(&mut w, mid);
        assert!(fired.iter().all(|&(t, _)| t <= mid));
        for (seq, &t) in times.iter().enumerate().skip(31) {
            assert_eq!(w.remove(&key(t, 100 + seq as u64)), Some(100 + seq as u64));
        }
        let rest = drain(&mut w, u64::MAX);
        let expected: Vec<(u64, u64)> = times
            .iter()
            .enumerate()
            .skip(31)
            .filter(|(s, _)| s % 2 == 1)
            .map(|(s, &t)| (t, s as u64))
            .collect();
        assert_eq!(rest, expected);
        assert!(w.is_empty());
    }

    #[test]
    fn iter_is_in_key_order_across_levels_and_past() {
        let mut w = TimingWheel::new();
        w.insert(key(5000, 0), 0);
        w.insert(key(6000, 9), 9);
        assert!(w.pop_due(5000).is_some());
        for (t, s) in [
            (1 << 40, 1),
            (5001, 2),
            (5000, 3),
            (4, 4),
            (5000, 1),
            (70_000, 5),
        ] {
            w.insert(key(t, s), s);
        }
        let keys: Vec<(u64, u64)> = w.iter().map(|(k, _)| (k.time, k.seq)).collect();
        assert_eq!(
            keys,
            [
                (4, 4),
                (5000, 1),
                (5000, 3),
                (5001, 2),
                (6000, 9),
                (70_000, 5),
                (1 << 40, 1)
            ]
        );
    }

    #[test]
    fn clones_are_independent() {
        let mut a = TimingWheel::new();
        a.insert(key(7, 0), 0);
        a.insert(key(1 << 30, 1), 1);
        let mut b = a.clone();
        assert_eq!(drain(&mut a, u64::MAX), [(7, 0), (1 << 30, 1)]);
        assert_eq!(b.len(), 2);
        assert_eq!(b.remove(&key(1 << 30, 1)), Some(1));
        assert_eq!(drain(&mut b, u64::MAX), [(7, 0)]);
    }

    /// Mirrors every operation on a `BTreeMap` and checks they agree.
    fn differential(seed: u64, start: u64, ops: usize) {
        let (mut pops, mut removes, mut past, mut same_time) = (0, 0, 0, 0);
        let mut rng = Rng(seed);
        let mut w = TimingWheel::new();
        let mut m: BTreeMap<EventKey, u64> = BTreeMap::new();
        let mut keys: Vec<EventKey> = Vec::new();
        let mut now = start;
        let mut next_seq = 0u64;
        for op in 0..ops {
            match rng.below(100) {
                0..=44 => {
                    let time = match rng.below(20) {
                        0..=7 => now.saturating_add(rng.below(64)),
                        8..=11 => now.saturating_add(rng.below(5_000)),
                        12 => now.saturating_add(rng.below(1 << 40)),
                        13 => MAX_TIME - rng.below(1 << 12),
                        14 => now.saturating_sub(rng.below(100)),
                        15 => u64::MAX - rng.below(4),
                        16..=17 if !keys.is_empty() => {
                            keys[rng.below(keys.len() as u64) as usize].time
                        }
                        _ => now,
                    };
                    let seq = if rng.below(10) == 0 {
                        rng.below(1 << 20) + (1 << 40)
                    } else {
                        next_seq += 1;
                        next_seq
                    };
                    let k = EventKey { time, seq };
                    if m.contains_key(&k) {
                        continue;
                    }
                    let v = rng.next();
                    past += usize::from(time < w.cursor);
                    same_time +=
                        usize::from(m.range(key(time, 0)..=key(time, u64::MAX)).next().is_some());
                    m.insert(k, v);
                    w.insert(k, v);
                    keys.push(k);
                }
                45..=59 => {
                    if keys.is_empty() {
                        continue;
                    }
                    let i = rng.below(keys.len() as u64) as usize;
                    let k = keys.swap_remove(i);
                    let removed = m.remove(&k);
                    removes += usize::from(removed.is_some());
                    assert_eq!(w.remove(&k), removed, "remove {k:?} at op {op}");
                }
                60..=89 => {
                    let target = match rng.below(10) {
                        0 => now.saturating_sub(rng.below(1000)),
                        1 => now.saturating_add(rng.below(1 << 30)),
                        2 => m.keys().next().map_or(now, |k| k.time).min(now + (1 << 20)),
                        _ => now.saturating_add(rng.below(40)),
                    };
                    for _ in 0..=rng.below(4) {
                        let expected = match m.first_key_value() {
                            Some((k, _)) if k.time <= target => m.pop_first(),
                            _ => None,
                        };
                        assert_eq!(w.pop_due(target), expected, "pop at op {op}");
                        if expected.is_none() {
                            break;
                        }
                        pops += 1;
                    }
                    now = now.max(target);
                }
                _ => {
                    assert_eq!(w.first_key(), m.keys().next().copied(), "first at op {op}");
                }
            }
            assert_eq!(w.len(), m.len());
            if op % 4096 == 0 {
                assert!(
                    w.iter()
                        .map(|(k, v)| (*k, *v))
                        .eq(m.iter().map(|(k, v)| (*k, *v)))
                );
                keys.retain(|k| m.contains_key(k));
            }
        }
        assert!(
            w.iter()
                .map(|(k, v)| (*k, *v))
                .eq(m.iter().map(|(k, v)| (*k, *v)))
        );
        let mut rest = Vec::new();
        while let Some(e) = w.pop_due(u64::MAX) {
            rest.push(e);
        }
        assert!(rest.into_iter().eq(m));
        assert!(w.is_empty());
        println!("pops {pops} removes {removes} past {past} same_time {same_time} now {now}");
        assert!(pops > ops / 10 && removes > ops / 50 && past > ops / 500 && same_time > ops / 50);
    }

    #[test]
    fn matches_btreemap_from_zero() {
        differential(1, 0, 120_000);
    }

    #[test]
    fn matches_btreemap_mid_range() {
        differential(2, 0x0000_1234_5678_9abc, 60_000);
    }

    #[test]
    fn matches_btreemap_near_max_time() {
        differential(3, MAX_TIME - 50_000, 60_000);
    }

    /// `cargo test -p tc-sim --release wheel_benchmark -- --ignored --nocapture`
    #[test]
    #[ignore = "benchmark: prints throughput, asserts nothing; run with --release -- --ignored --nocapture"]
    fn wheel_benchmark() {
        use std::time::Instant;
        const N: u64 = 1_000_000;

        fn report(name: &str, ops: u64, start: Instant) {
            let nanos = start.elapsed().as_nanos().max(1);
            let per_sec = u128::from(ops) * 1_000_000_000 / nanos;
            println!("{name:<40} {per_sec:>12} ops/s ({} ms)", nanos / 1_000_000);
        }

        // Bulk: insert 1M events spread over 1M steps, then pop them all.
        let mut rng = Rng(9);
        let times: Vec<u64> = (0..N).map(|_| rng.below(N)).collect();
        let start = Instant::now();
        let mut w = TimingWheel::new();
        for (seq, &t) in times.iter().enumerate() {
            w.insert(key(t, seq as u64), ());
        }
        let mut popped = 0;
        while w.pop_due(N).is_some() {
            popped += 1;
        }
        assert_eq!(popped, N);
        report("wheel bulk insert+pop", 2 * N, start);

        let start = Instant::now();
        let mut m = BTreeMap::new();
        for (seq, &t) in times.iter().enumerate() {
            m.insert(key(t, seq as u64), ());
        }
        while m.pop_first().is_some() {}
        report("btreemap bulk insert+pop", 2 * N, start);

        // Hold model: 100k pending; pop the next, schedule one 1..=1000 later.
        let initial: Vec<u64> = (0..100_000).map(|_| rng.below(1000)).collect();
        let deltas: Vec<u64> = (0..N).map(|_| 1 + rng.below(1000)).collect();
        let start = Instant::now();
        let mut w = TimingWheel::new();
        for (seq, &t) in initial.iter().enumerate() {
            w.insert(key(t, seq as u64), ());
        }
        for (seq, &d) in (100_000..).zip(&deltas) {
            let first = w.first_key().unwrap();
            let (k, ()) = w.pop_due(first.time).unwrap();
            w.insert(key(k.time + d, seq), ());
        }
        report("wheel hold (first+pop+insert)", 3 * N, start);

        let start = Instant::now();
        let mut m = BTreeMap::new();
        for (seq, &t) in initial.iter().enumerate() {
            m.insert(key(t, seq as u64), ());
        }
        for (seq, &d) in (100_000..).zip(&deltas) {
            let first = *m.keys().next().unwrap();
            let (k, ()) = m.pop_first().unwrap();
            assert_eq!(k, first);
            m.insert(key(k.time + d, seq), ());
        }
        report("btreemap hold (first+pop+insert)", 3 * N, start);
    }
}
