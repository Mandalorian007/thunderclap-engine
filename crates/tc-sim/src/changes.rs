//! Change marks: what changed since the loop last asked.
//!
//! A game marks keys of its own choosing (an area, a player, a table) at
//! its few central mutation points, through
//! [`Cx::mark`](crate::Cx::mark); the loop takes them after each batch of
//! steps and commands and hands them to the game's flush
//! ([`Game::flush`](crate::Game::flush)), which sends only what they
//! touch. (E4b's live queries rerun only the queries whose recorded reads
//! intersect them.) Keys should be coarse, so tracking stays cheap and new
//! state is easy to cover.
//!
//! Marks are never state: they don't count toward the state hash, and a
//! replay mutes them ([`Changes::set_muted`]), since nobody can be
//! watching a game before it is rebuilt.

use std::collections::BTreeSet;

/// The keys of type `K` marked since the last take, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Changes<K: Ord> {
    keys: BTreeSet<K>,
    /// Marks nothing while set.
    muted: bool,
}

impl<K: Ord> Default for Changes<K> {
    fn default() -> Self {
        Changes {
            keys: BTreeSet::new(),
            muted: false,
        }
    }
}

impl<K: Ord> Changes<K> {
    /// No changes.
    pub fn new() -> Changes<K> {
        Changes::default()
    }

    /// True if nothing changed.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// How many distinct keys changed.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// The changed keys, in order.
    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.keys.iter()
    }

    /// The changed keys from `from` on, in order: for a game whose keys
    /// sort by kind, the marks of one kind.
    pub fn range<'a>(&'a self, from: &'a K) -> impl Iterator<Item = &'a K> + 'a {
        self.keys.range(from..)
    }

    /// True if `key` changed.
    pub fn contains(&self, key: &K) -> bool {
        self.keys.contains(key)
    }

    /// Marks `key` as changed (unless muted).
    pub fn mark(&mut self, key: K) {
        if !self.muted {
            self.keys.insert(key);
        }
    }

    /// True while marks are ignored.
    pub fn muted(&self) -> bool {
        self.muted
    }

    /// Stops (or resumes) marking: while muted, every mark is ignored.
    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }

    /// Everything marked so far, leaving none (and the mute as it was).
    pub fn take(&mut self) -> Changes<K> {
        Changes {
            keys: std::mem::take(&mut self.keys),
            muted: false,
        }
    }

    /// Adds everything in `other`.
    pub fn extend(&mut self, other: Changes<K>) {
        if !self.muted {
            self.keys.extend(other.keys);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
    enum Key {
        Area(i32, i32),
        Player(u64),
    }

    #[test]
    fn keys_are_deduplicated_and_taken() {
        let mut c = Changes::new();
        assert!(c.is_empty());
        c.mark(Key::Area(0, 0));
        c.mark(Key::Area(0, 0));
        c.mark(Key::Area(-1, 0));
        c.mark(Key::Player(2));
        assert_eq!(c.len(), 3, "the same area twice is one key");
        assert!(c.contains(&Key::Area(-1, 0)));
        let mut d = Changes::new();
        d.mark(Key::Player(2));
        d.mark(Key::Player(3));
        c.extend(d);
        assert_eq!(c.len(), 4);
        let players: Vec<_> = c.range(&Key::Player(0)).copied().collect();
        assert_eq!(players, [Key::Player(2), Key::Player(3)]);
        let taken = c.take();
        assert_eq!(taken.len(), 4);
        assert!(c.is_empty());
    }

    #[test]
    fn muted_marks_nothing_and_a_take_keeps_the_mute() {
        let mut c = Changes::new();
        c.set_muted(true);
        c.mark(Key::Player(1));
        assert!(c.is_empty());
        let taken = c.take();
        assert!(!taken.muted());
        assert!(c.muted());
        c.set_muted(false);
        c.mark(Key::Player(1));
        assert!(c.contains(&Key::Player(1)));
    }
}
