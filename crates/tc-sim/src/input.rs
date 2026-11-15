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
use std::ops::ControlFlow;
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

/// How an input tick's `apply` stops a player's tick partway
/// ([`InputQueue::tick_flow`], [`Game::input_flow`](crate::Game::input_flow)):
/// the rest of its inputs spend no credit this tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    /// The rest wait for the next tick.
    Wait,
    /// The rest are acknowledged and dropped ([`InputQueue::ack_all`]):
    /// the player was stopped (knocked out, teleported) and what it sent
    /// before it knew no longer applies.
    AckAll,
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
    /// Inputs taken this tick.
    taken: u32,
}

impl<I> Queue<I> {
    fn newest(&self) -> u32 {
        self.inputs.back().map_or(self.seq, |(seq, _, _)| *seq)
    }

    /// Credits the time since the last tick and starts a new one.
    fn credit(&mut self, now: Instant, config: &InputConfig) {
        let earned = self
            .credited
            .map_or(config.tick, |t| now.saturating_duration_since(t));
        self.credit = (self.credit + earned).min(config.max_credit);
        self.credited = Some(now);
        self.taken = 0;
    }

    /// The next input, if this tick has credit and room for it.
    fn take(&mut self, now: Instant, config: &InputConfig) -> Option<(u32, I, Duration)> {
        if self.credit < config.tick || self.taken >= config.max_per_tick {
            return None;
        }
        let (seq, input, arrived) = self.inputs.pop_front()?;
        self.credit -= config.tick;
        self.seq = seq;
        self.taken += 1;
        Some((seq, input, now.saturating_duration_since(arrived)))
    }

    fn ack_all(&mut self) -> u32 {
        self.seq = self.newest();
        self.inputs.clear();
        self.seq
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
            taken: 0,
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

    /// Acknowledges every input `player` sent: the newest waiting one
    /// counts as applied and the rest are dropped unapplied (the player
    /// was stopped; what it sent before it knew no longer applies). The
    /// next one taken is the one after. Returns the `seq` now applied.
    pub fn ack_all(&mut self, player: PlayerId) -> Option<u32> {
        self.queues.get_mut(&player).map(Queue::ack_all)
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
        self.tick_flow(now, applied, |player, seq, input, waited| {
            apply(player, seq, input, waited);
            ControlFlow::Continue(())
        });
    }

    /// [`InputQueue::tick_into`], where `apply` may stop a player's tick
    /// partway ([`Stop`]): its remaining inputs spend no credit, and wait
    /// ([`Stop::Wait`]) or are acknowledged and dropped
    /// ([`Stop::AckAll`], whose last `seq` goes to `applied`).
    pub fn tick_flow(
        &mut self,
        now: Instant,
        applied: &mut Vec<(PlayerId, u32)>,
        mut apply: impl FnMut(PlayerId, u32, I, Duration) -> ControlFlow<Stop>,
    ) {
        let config = self.config;
        for (&player, q) in &mut self.queues {
            q.credit(now, &config);
            while let Some((seq, input, waited)) = q.take(now, &config) {
                if let ControlFlow::Break(stop) = apply(player, seq, input, waited) {
                    if stop == Stop::AckAll {
                        q.ack_all();
                    }
                    break;
                }
            }
            if q.taken > 0 {
                applied.push((player, q.seq));
            }
        }
    }

    /// Starts an input tick at `now` by hand: credits every player. Then
    /// [`InputQueue::take`] each player's inputs, in id order, as the loop
    /// does between which it logs what each input pushed.
    pub(crate) fn start_tick(&mut self, now: Instant) {
        let config = self.config;
        for q in self.queues.values_mut() {
            q.credit(now, &config);
        }
    }

    /// `player`'s next input this tick ([`InputQueue::start_tick`]), if it
    /// has credit and room for it.
    pub(crate) fn take(&mut self, player: PlayerId, now: Instant) -> Option<(u32, I, Duration)> {
        let config = self.config;
        self.queues.get_mut(&player)?.take(now, &config)
    }

    /// Inputs `player` took this tick.
    pub(crate) fn taken(&self, player: PlayerId) -> u32 {
        self.queues.get(&player).map_or(0, |q| q.taken)
    }

    /// The players with a queue, in id order.
    pub(crate) fn players(&self) -> impl Iterator<Item = PlayerId> + '_ {
        self.queues.keys().copied()
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

    #[test]
    fn ack_all_skips_to_the_newest() {
        let mut q = queue();
        let now = Instant::now();
        for seq in 1..=5 {
            q.push(1, seq, 'a', now);
        }
        assert_eq!(q.ack_all(1), Some(5));
        assert!(!q.has_inputs());
        assert_eq!(q.last_applied(1), Some(5));
        assert_eq!(q.push(1, 5, 'b', now), Taken::Stale);
        assert_eq!(q.push(1, 6, 'b', now), Taken::Queued);
        assert_eq!(q.ack_all(2), None);
    }

    #[test]
    fn a_stopped_tick_spends_no_credit_on_the_rest() {
        // Two ticks' credit at most, so what is left is easy to see.
        let mut q = InputQueue::new(InputConfig {
            max_credit: 2 * TICK,
            ..InputConfig::default()
        });
        q.join(1);
        let start = Instant::now();
        for seq in 1..=4 {
            q.push(1, seq, 'a', start);
        }
        let mut applied = Vec::new();
        let mut got = Vec::new();
        q.tick_flow(start, &mut applied, |_, seq, _, _| {
            got.push(seq);
            ControlFlow::Break(Stop::Wait)
        });
        assert_eq!((&got[..], &applied[..]), (&[1][..], &[(1, 1)][..]));
        // The tick stopped with a tick's credit unspent: one more now.
        assert_eq!(tick(&mut q, start), [(2, 'a')]);
        // A knockout at the next: the rest are acknowledged, unapplied.
        q.push(1, 5, 'b', start);
        applied.clear();
        got.clear();
        q.tick_flow(start + 2 * TICK, &mut applied, |_, seq, _, _| {
            got.push(seq);
            ControlFlow::Break(Stop::AckAll)
        });
        assert_eq!((&got[..], &applied[..]), (&[3][..], &[(1, 5)][..]));
        assert!(!q.has_inputs());
        // The inputs it dropped spent nothing: a tick's credit is left.
        q.push(1, 6, 'c', start + 2 * TICK);
        q.push(1, 7, 'c', start + 2 * TICK);
        assert_eq!(tick(&mut q, start + 2 * TICK), [(6, 'c')]);
    }
}
