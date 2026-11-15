//! Input queues: what each player's driving connection sent
//! (`ClientMsg::Input { seq, input }`), applied at a fixed wall-clock rate.
//!
//! Clients send one input per input tick. Each player keeps a short queue
//! of them: an input whose `seq` is not above the newest one taken is
//! stale and ignored, and past [`InputConfig::buffer`] waiting inputs the
//! oldest is dropped. The input tick runs on wall-clock time, independent
//! of the game clock (a paused game still takes inputs), while any input
//! waits.
//!
//! **Credit.** A player earns input credit with wall-clock time, one input
//! per tick, saved up to [`InputConfig::max_credit`]; each tick it applies
//! its waiting inputs, oldest first, while it has credit (at most
//! [`InputConfig::max_per_tick`]). So no client moves faster by sending
//! faster (over any stretch of time a player takes at most a tick's input
//! per tick, plus what it saved), but inputs that queued while the server
//! was busy, or while a client's ticks and the server's drifted apart, are
//! worked off instead of waiting forever. A new player starts with its
//! credit full, as if it had stood still before it joined: credit only
//! keeps pace with a client sending at the tick rate, so whatever slack it
//! has when it starts is all it ever has.

use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

use crate::game::PlayerId;

/// How inputs are taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputConfig {
    /// The input tick: one input's worth of credit.
    pub tick: Duration,
    /// Inputs kept waiting per player; past this the oldest is dropped.
    pub buffer: usize,
    /// The most credit a player saves up.
    pub max_credit: Duration,
    /// The most inputs a player applies in one tick.
    pub max_per_tick: u32,
}

impl Default for InputConfig {
    /// 20 ticks a second, 10 waiting, a second's credit, 4 a tick.
    fn default() -> Self {
        InputConfig {
            tick: Duration::from_millis(50),
            buffer: 10,
            max_credit: Duration::from_secs(1),
            max_per_tick: 4,
        }
    }
}

/// What became of an input offered to [`InputQueue::push`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Taken {
    /// Queued.
    Queued,
    /// Queued, and the oldest waiting one dropped to make room.
    DroppedOldest,
    /// Its `seq` isn't above the newest taken: ignored.
    Stale,
    /// The player has no queue (not joined).
    NoQueue,
}

#[derive(Debug)]
struct Queue<I> {
    /// The last input applied (0 before any).
    seq: u32,
    /// Inputs waiting, oldest first, with when each arrived.
    inputs: VecDeque<(u32, I, Instant)>,
    /// Credit as of `credited`.
    credit: Duration,
    credited: Option<Instant>,
}

impl<I> Queue<I> {
    fn newest(&self) -> u32 {
        self.inputs.back().map_or(self.seq, |(seq, _, _)| *seq)
    }
}

/// Every player's waiting inputs of type `I`. See the [crate docs](crate).
#[derive(Debug)]
pub struct InputQueue<I> {
    config: InputConfig,
    queues: BTreeMap<PlayerId, Queue<I>>,
}

impl<I> InputQueue<I> {
    /// No players.
    pub fn new(config: InputConfig) -> InputQueue<I> {
        InputQueue {
            config,
            queues: BTreeMap::new(),
        }
    }

    /// The config.
    pub fn config(&self) -> InputConfig {
        self.config
    }

    /// Starts a queue for `player` (its credit full), if it has none.
    pub fn join(&mut self, player: PlayerId) {
        let full = self.config.max_credit;
        self.queues.entry(player).or_insert_with(|| Queue {
            seq: 0,
            inputs: VecDeque::new(),
            credit: full,
            credited: None,
        });
    }

    /// Forgets `player`'s queue.
    pub fn leave(&mut self, player: PlayerId) {
        self.queues.remove(&player);
    }

    /// Drops the inputs waiting for `player` (control moved to another
    /// connection): the next one taken is the one after the last applied.
    pub fn drop_inputs(&mut self, player: PlayerId) {
        if let Some(q) = self.queues.get_mut(&player) {
            q.inputs.clear();
        }
    }

    /// The last input applied for `player` (0 before any), if it has a
    /// queue.
    pub fn last_applied(&self, player: PlayerId) -> Option<u32> {
        self.queues.get(&player).map(|q| q.seq)
    }

    /// Queues an input from `player`, arrived at `now`.
    pub fn push(&mut self, player: PlayerId, seq: u32, input: I, now: Instant) -> Taken {
        let Some(q) = self.queues.get_mut(&player) else {
            return Taken::NoQueue;
        };
        if seq <= q.newest() {
            return Taken::Stale;
        }
        let dropped = q.inputs.len() >= self.config.buffer.max(1);
        if dropped {
            q.inputs.pop_front();
        }
        q.inputs.push_back((seq, input, now));
        if dropped {
            Taken::DroppedOldest
        } else {
            Taken::Queued
        }
    }

    /// True if any input is waiting.
    pub fn has_inputs(&self) -> bool {
        self.queues.values().any(|q| !q.inputs.is_empty())
    }

    /// Spends `player`'s saved credit, as a client sending faster than the
    /// ticks would: from now on it takes one input a tick.
    pub fn spend_credit(&mut self, player: PlayerId) {
        if let Some(q) = self.queues.get_mut(&player) {
            q.credit = Duration::ZERO;
        }
    }

    /// One input tick at `now`: credits every player the time since its
    /// last tick (a tick's worth the first time) and hands `apply` its
    /// waiting inputs, oldest first, while it has a tick's credit, with
    /// each one's `seq` and how long it waited. Players in id order.
    /// Returns the players whose inputs were applied, each once, with the
    /// last `seq` applied.
    pub fn tick(
        &mut self,
        now: Instant,
        apply: impl FnMut(PlayerId, u32, I, Duration),
    ) -> Vec<(PlayerId, u32)> {
        let mut applied = Vec::new();
        self.tick_into(now, &mut applied, apply);
        applied
    }

    /// [`InputQueue::tick`], pushing to `applied` (a buffer the caller
    /// keeps) instead of returning a new one.
    pub fn tick_into(
        &mut self,
        now: Instant,
        applied: &mut Vec<(PlayerId, u32)>,
        mut apply: impl FnMut(PlayerId, u32, I, Duration),
    ) {
        let tick = self.config.tick;
        for (&player, q) in &mut self.queues {
            let earned = q
                .credited
                .map_or(tick, |t| now.saturating_duration_since(t));
            q.credit = (q.credit + earned).min(self.config.max_credit);
            q.credited = Some(now);
            let mut taken = 0;
            while q.credit >= tick && taken < self.config.max_per_tick {
                let Some((seq, input, arrived)) = q.inputs.pop_front() else {
                    break;
                };
                q.credit -= tick;
                q.seq = seq;
                taken += 1;
                apply(player, seq, input, now.saturating_duration_since(arrived));
            }
            if taken > 0 {
                applied.push((player, q.seq));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_millis(50);

    fn queue() -> InputQueue<char> {
        let mut q = InputQueue::new(InputConfig::default());
        q.join(1);
        q
    }

    fn tick(q: &mut InputQueue<char>, now: Instant) -> Vec<(u32, char)> {
        let mut got = Vec::new();
        q.tick(now, |_, seq, i, _| got.push((seq, i)));
        got
    }

    #[test]
    fn stale_and_unknown_inputs_are_ignored_and_the_oldest_dropped() {
        let mut q = queue();
        let now = Instant::now();
        assert_eq!(q.push(2, 1, 'x', now), Taken::NoQueue);
        assert_eq!(q.push(1, 3, 'a', now), Taken::Queued);
        assert_eq!(q.push(1, 3, 'b', now), Taken::Stale);
        assert_eq!(q.push(1, 2, 'b', now), Taken::Stale);
        for seq in 4..=12 {
            assert_eq!(q.push(1, seq, 'c', now), Taken::Queued);
        }
        assert_eq!(q.push(1, 13, 'd', now), Taken::DroppedOldest);
        let got = tick(&mut q, now);
        assert_eq!(got.first(), Some(&(4, 'c')), "3 was dropped");
        assert_eq!(got.len(), 4, "at most four a tick");
        assert_eq!(q.last_applied(1), Some(7));
    }

    #[test]
    fn credit_works_off_a_backlog_but_never_runs_ahead() {
        let mut q = queue();
        let start = Instant::now();
        for seq in 1..=10 {
            q.push(1, seq, 'a', start);
        }
        // Full credit (a second's worth): four a tick until the backlog is
        // gone.
        assert_eq!(tick(&mut q, start).len(), 4);
        assert_eq!(tick(&mut q, start + TICK).len(), 4);
        assert_eq!(tick(&mut q, start + 2 * TICK).len(), 2);
        // Spent: one a tick from now on, however fast it sends.
        q.spend_credit(1);
        let at = start + 3 * TICK;
        for seq in 11..=14 {
            q.push(1, seq, 'b', at);
        }
        assert_eq!(tick(&mut q, at).len(), 1);
        assert_eq!(tick(&mut q, at + TICK).len(), 1);
        assert_eq!(tick(&mut q, at + TICK).len(), 0, "no time, no credit");
        assert!(q.has_inputs());
    }

    #[test]
    fn dropping_inputs_restarts_after_the_last_applied() {
        let mut q = queue();
        let now = Instant::now();
        q.push(1, 1, 'a', now);
        tick(&mut q, now);
        q.push(1, 5, 'b', now);
        q.drop_inputs(1);
        assert!(!q.has_inputs());
        assert_eq!(q.push(1, 2, 'c', now), Taken::Queued, "seq counts from 1");
        q.leave(1);
        assert_eq!(q.push(1, 3, 'd', now), Taken::NoQueue);
    }
}
