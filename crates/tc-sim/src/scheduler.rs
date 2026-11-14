//! The event scheduler: a game's predicted events in one global order.
//!
//! Events are ordered by `(time, seq)`, where `seq` is the scheduler's own
//! counter, so same-time events fire in the order they were scheduled.
//! Scheduled events are predictions: they are never logged, and a replay
//! recomputes them from the logged events that caused them. The queue is a
//! [`TimingWheel`].
//!
//! Through [`Cx::schedule`](crate::Cx::schedule) every event is scheduled
//! strictly after the time it is scheduled at, so firing never loops
//! within one step.

use crate::wheel::TimingWheel;

/// A scheduled event's position in the global order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EventKey {
    /// When it fires, in steps.
    pub time: u64,
    /// Tie-break for events at the same time: the order they were
    /// scheduled in.
    pub seq: u64,
}

/// A deterministic queue of scheduled events of type `T`.
#[derive(Clone, Debug)]
pub struct Scheduler<T> {
    queue: TimingWheel<T>,
    next_seq: u64,
}

impl<T> Default for Scheduler<T> {
    fn default() -> Self {
        Scheduler {
            queue: TimingWheel::new(),
            next_seq: 0,
        }
    }
}

impl<T> Scheduler<T> {
    /// An empty scheduler.
    pub fn new() -> Scheduler<T> {
        Scheduler::default()
    }

    /// A scheduler holding `entries` (in key order, each `seq` below
    /// `next_seq`), as a snapshot stored them: the same queue, popping in
    /// the same order.
    pub fn restore(next_seq: u64, entries: Vec<(EventKey, T)>) -> Result<Scheduler<T>, String> {
        let mut queue = TimingWheel::new();
        let mut last: Option<EventKey> = None;
        for (key, event) in entries {
            if key.seq >= next_seq || last.is_some_and(|l| l >= key) {
                return Err(format!("scheduled event {key:?} is out of order"));
            }
            last = Some(key);
            queue.insert(key, event);
        }
        Ok(Scheduler { queue, next_seq })
    }

    /// Schedules `event` at `time`, returning its key for cancellation.
    pub fn schedule(&mut self, time: u64, event: T) -> EventKey {
        let key = EventKey {
            time,
            seq: self.next_seq,
        };
        self.next_seq += 1;
        self.queue.insert(key, event);
        key
    }

    /// Removes a scheduled event.
    pub fn cancel(&mut self, key: EventKey) -> Option<T> {
        self.queue.remove(&key)
    }

    /// Removes and returns the first event due at or before `now`.
    pub fn pop_due(&mut self, now: u64) -> Option<(EventKey, T)> {
        self.queue.pop_due(now)
    }

    /// When the next event fires.
    pub fn next_time(&self) -> Option<u64> {
        self.queue.first_key().map(|key| key.time)
    }

    /// The sequence number the next scheduled event will get.
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// Number of pending events.
    pub fn len(&self) -> usize {
        self.queue.len()
    }

    /// True if nothing is pending.
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// Pending events in firing order.
    pub fn iter(&self) -> impl Iterator<Item = (&EventKey, &T)> {
        self.queue.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_in_time_then_schedule_order() {
        let mut s = Scheduler::new();
        s.schedule(10, 1);
        s.schedule(5, 2);
        let cancelled = s.schedule(7, 3);
        s.schedule(10, 4);
        s.schedule(5, 5);
        assert_eq!(s.cancel(cancelled), Some(3));
        assert_eq!(s.next_time(), Some(5));
        assert_eq!(s.pop_due(4), None);

        let mut fired = Vec::new();
        while let Some((key, e)) = s.pop_due(10) {
            fired.push((key.time, e));
        }
        assert_eq!(fired, [(5, 2), (5, 5), (10, 1), (10, 4)]);
        assert!(s.is_empty());
        assert_eq!(s.next_seq(), 5);
    }

    #[test]
    fn restore_keeps_the_order_and_refuses_a_bad_one() {
        let mut s = Scheduler::new();
        for (t, e) in [(9, 'a'), (3, 'b'), (9, 'c'), (100, 'd')] {
            s.schedule(t, e);
        }
        let entries: Vec<(EventKey, char)> = s.iter().map(|(k, e)| (*k, *e)).collect();
        let mut r = Scheduler::restore(s.next_seq(), entries.clone()).unwrap();
        assert_eq!(r.next_seq(), 4);
        let mut fired = Vec::new();
        while let Some((_, e)) = r.pop_due(u64::MAX) {
            fired.push(e);
        }
        assert_eq!(fired, ['b', 'a', 'c', 'd']);
        assert!(
            Scheduler::restore(3, entries.clone()).is_err(),
            "a seq past next_seq"
        );
        let mut reversed = entries;
        reversed.reverse();
        assert!(Scheduler::restore(4, reversed).is_err(), "out of key order");
    }
}
