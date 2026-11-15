//! Live play: what a game does on the wall clock between its logged
//! events, through a [`LiveCx`] (whose docs say how it runs).

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use tc_net::{ConnId, ViewCache};
use tc_wire::Wire;
use tc_wire::hash::StableHasher;
use tracing::warn;

use crate::MAX_TIME;
use crate::changes::Changes;
use crate::counters::micros;
use crate::entities::Stream;
use crate::game::{EventOf, Game, InterestOf, Outbox, PlayerId};
use crate::idle::Conns;
use crate::query::{Key, QueryCtx, Reads, ViewCx};
use crate::sim::Sim;

/// What a live hook ([`Game::live_step`], [`Game::wake`], [`Game::act`])
/// may touch besides the game: the times, the present players' bodies,
/// the events to log, messages to send and the next wake.
///
/// **Live fields.** A game's live side (creatures thinking, projectiles
/// flying, cooldowns, a channel under way) is state outside the log and
/// outside [`Game::hash_state`]: a replay, a reload and a restart start
/// with none, and the game rebuilds what it needs from the logged state.
/// What should last is pushed as events (outcomes), logged and applied
/// like any other, so a replay applies the outcome instead of recomputing
/// it. With [`SimConfig::verify_live`](crate::SimConfig::verify_live) the
/// loop hashes the game's state around every live hook and counts a hook
/// that changed it ([`SimCounters::live_misses`](crate::SimCounters)).
///
/// **Stepping.** While [`Game::live`] holds, the loop moves the clock one
/// step at a time and calls [`Game::live_step`] after each; otherwise it
/// jumps between scheduled events, as before. A dev jump
/// ([`Sim::advance`]) runs no live steps: the next one sees the gap in
/// [`LiveCx::since`].
///
/// **Wakes.** [`LiveCx::wake_at`] arms a wall-clock wake (the earliest
/// asked for wins); [`Game::wake`] runs when it is due, even while the
/// game clock is paused, and re-arms for another.
///
/// **Timers.** [`LiveCx::set_timer`] arms a wall-clock timer of a kind
/// (one per kind; setting it again replaces it): [`Game::timer`] runs for
/// each kind when it is due, also while paused. A game's periodic ticks
/// (a movement tick, a recall, a flush of its own), each with its own
/// deadline, the loop sleeps until the earliest of.
///
/// None of these run once the store failed: nothing more changes the game.
pub struct LiveCx<'a, G: Game> {
    pub(crate) time: u64,
    pub(crate) since: u64,
    pub(crate) version: u64,
    pub(crate) now: Instant,
    pub(crate) bodies: &'a mut BTreeMap<PlayerId, G::Body>,
    pub(crate) moved: &'a mut BTreeSet<PlayerId>,
    pub(crate) events: &'a mut Vec<EventOf<G>>,
    pub(crate) out: &'a mut Outbox<G::Protocol>,
    pub(crate) wake: &'a mut Option<Instant>,
    pub(crate) changes: &'a mut Changes<G::Change>,
    pub(crate) timers: &'a mut BTreeMap<u32, Instant>,
    pub(crate) conns: Conns<'a>,
}

impl<'a, G: Game> LiveCx<'a, G> {
    /// The game's time, in steps.
    pub fn time(&self) -> u64 {
        self.time
    }

    /// The time of the last live step (the loop's start, before the
    /// first): `time() - since()` steps passed since, more than one after
    /// a jump.
    pub fn since(&self) -> u64 {
        self.since
    }

    /// The steps between the last live step and this one that ran none.
    pub fn skipped(&self) -> u64 {
        self.time.saturating_sub(self.since).saturating_sub(1)
    }

    /// The last log entry applied.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The wall clock, as the loop read it for this tick (a test
    /// driver's own clock): for cooldowns, credits and wakes, never for
    /// what is logged.
    pub fn now(&self) -> Instant {
        self.now
    }

    /// `player`'s body, if it is present.
    pub fn body(&self, player: PlayerId) -> Option<&G::Body> {
        self.bodies.get(&player)
    }

    /// `player`'s body to change (a teleport, a knockback), if it is
    /// present: it counts as moved, so queries and entity streams that
    /// read it rerun.
    pub fn body_mut(&mut self, player: PlayerId) -> Option<&mut G::Body> {
        let body = self.bodies.get_mut(&player)?;
        self.moved.insert(player);
        Some(body)
    }

    /// Every present body, by player id.
    pub fn bodies(&self) -> impl Iterator<Item = (PlayerId, &G::Body)> {
        self.bodies.iter().map(|(p, b)| (*p, b))
    }

    /// The events to log and apply, as one batch, after the hook.
    pub fn events(&mut self) -> &mut Vec<EventOf<G>> {
        self.events
    }

    /// Logs `event` after the hook (see [`LiveCx::events`]).
    pub fn push(&mut self, event: EventOf<G>) {
        self.events.push(event);
    }

    /// Messages to send once the hook's events are applied (dropped if
    /// they aren't); for a command, before its result.
    pub fn out(&mut self) -> &mut Outbox<G::Protocol> {
        self.out
    }

    /// Arms a wake at `at` (or keeps an earlier one): [`Game::wake`] runs
    /// then.
    pub fn wake_at(&mut self, at: Instant) {
        *self.wake = Some(self.wake.map_or(at, |w| w.min(at)));
    }

    /// The wake armed, if any.
    pub fn next_wake(&self) -> Option<Instant> {
        *self.wake
    }

    /// Arms timer `kind` at `at`, replacing the one armed:
    /// [`Game::timer`] runs with `kind` then.
    pub fn set_timer(&mut self, kind: u32, at: Instant) {
        self.timers.insert(kind, at);
    }

    /// Disarms timer `kind`.
    pub fn clear_timer(&mut self, kind: u32) {
        self.timers.remove(&kind);
    }

    /// When timer `kind` is due, if armed.
    pub fn timer(&self, kind: u32) -> Option<Instant> {
        self.timers.get(&kind).copied()
    }

    /// The connections, to send to directly
    /// ([`Conns`]): unlike [`LiveCx::out`], what is queued here goes out
    /// whether or not the hook's events apply.
    pub fn conns(&self) -> &Conns<'a> {
        &self.conns
    }

    /// Marks `key` as changed, so the queries and entity streams that read
    /// it rerun at the next flush (live state moved: a creature walked).
    /// The mark reaches [`Game::flush`] too.
    pub fn mark(&mut self, key: G::Change) {
        self.changes.mark(key);
    }
}

/// The game's own part of its state hash.
fn game_hash<G: Game>(game: &G) -> u64 {
    let mut h = StableHasher::new();
    game.hash_state(&mut h);
    h.finish()
}

impl<G: Game> Sim<G> {
    /// Runs one live hook with a [`LiveCx`] on the loop's scratch, then
    /// logs and applies what it pushed and sends what it queued (or drops
    /// the messages if the batch wasn't applied). Returns the hook's value
    /// and whether its events were applied (`Err` with why not).
    pub(crate) fn run_live<R>(
        &mut self,
        now: Instant,
        hook: impl FnOnce(&mut G, &mut LiveCx<'_, G>) -> R,
    ) -> (R, Result<(), String>) {
        let verify = self.verify_live;
        let before = verify.then(|| game_hash(self.core.game()));
        let time = self.core.time();
        let version = self.core.version();
        let mut events = std::mem::take(&mut self.live_events);
        let mut out = std::mem::take(&mut self.live_out);
        let r = {
            let (game, changes) = self.core.live_parts();
            let mut cx = LiveCx {
                time,
                since: self.live_time,
                version,
                now,
                bodies: &mut self.bodies,
                moved: &mut self.moved,
                events: &mut events,
                out: &mut out,
                wake: &mut self.next_wake,
                changes,
                timers: &mut self.timers,
                conns: Conns {
                    conns: &self.conns,
                    conns_of: &self.conns_of,
                    bulk_sent: &self.bulk_sent,
                },
            };
            hook(game, &mut cx)
        };
        if let Some(before) = before
            && game_hash(self.core.game()) != before
        {
            self.counters.live_misses += 1;
            if self.counters.live_misses == 1 {
                warn!(
                    "a live hook changed the hashed state (a game bug: \
                     live play must push events, see Game::live_step)"
                );
            }
        }
        let applied = self.commit_drain(&mut events);
        if applied.is_ok() {
            self.deliver_drain(&mut out);
        } else {
            out.msgs.clear();
        }
        self.live_events = events;
        self.live_out = out;
        self.poll_record_error();
        (r, applied)
    }

    /// Advances to `target`, one step at a time with a live step after
    /// each while the game is live, jumping otherwise.
    pub(crate) fn advance_live(&mut self, target: u64, now: Instant) {
        let target = target.min(MAX_TIME);
        let from = self.core.time();
        while self.core.time() < target {
            if self.store_error.is_none() && self.core.game().live() {
                let next = self.core.time() + 1;
                self.core.advance_to(next);
                let started = Instant::now();
                let _ = self.run_live(now, |game, cx| game.live_step(cx));
                self.live_time = next;
                self.counters.live_steps += 1;
                self.counters.live_us += micros(started);
            } else {
                self.core.advance_until_live(target);
            }
        }
        self.counters.steps += self.core.time() - from;
    }

    /// Runs [`Game::wake`] if its wake is due.
    pub(crate) fn wake_if_due(&mut self, now: Instant) {
        if self.store_error.is_some() || !self.next_wake.is_some_and(|w| now >= w) {
            return;
        }
        self.next_wake = None;
        let started = Instant::now();
        let _ = self.run_live(now, |game, cx| game.wake(cx));
        self.counters.wakes += 1;
        self.counters.live_us += micros(started);
    }

    /// Runs [`Game::timer`] once for each timer due, earliest first (one
    /// re-armed for now or earlier runs at the next tick).
    pub(crate) fn timers_if_due(&mut self, now: Instant) {
        if self.store_error.is_some() || !self.timers.values().any(|at| now >= *at) {
            return;
        }
        let mut due: Vec<(Instant, u32)> = self
            .timers
            .iter()
            .filter(|(_, at)| now >= **at)
            .map(|(kind, at)| (*at, *kind))
            .collect();
        due.sort_unstable();
        for (at, kind) in due {
            // An earlier timer may have re-armed or cleared this one.
            if self.store_error.is_some() || self.timers.get(&kind) != Some(&at) {
                continue;
            }
            self.timers.remove(&kind);
            let started = Instant::now();
            let _ = self.run_live(now, |game, cx| game.timer(cx, kind));
            self.counters.timers += 1;
            self.counters.live_us += micros(started);
        }
    }

    /// When the loop next has live work: the next step while the game is
    /// live, the wake and the timers.
    pub(crate) fn live_deadline(&self) -> Option<Instant> {
        if self.store_error.is_some() {
            return None;
        }
        let time = self.core.time();
        let step = (time < MAX_TIME && self.core.game().live())
            .then(|| self.clock.next_step_at(time))
            .flatten();
        let timer = self.timers.values().min().copied();
        [step, self.next_wake, timer].into_iter().flatten().min()
    }

    /// The wake armed, if any ([`LiveCx::wake_at`]).
    pub fn next_wake(&self) -> Option<Instant> {
        self.next_wake
    }

    /// What the loop did so far.
    pub fn counters(&self) -> crate::SimCounters {
        self.counters
    }

    /// The time of the last live step ([`LiveCx::since`]).
    pub fn live_time(&self) -> u64 {
        self.live_time
    }

    /// Runs live query `name` once, with its arguments' wire bytes, as
    /// `player` asks (`None`: as an observer): its result's wire bytes.
    /// Nothing is subscribed or sent; for tools, bots, admin and tests.
    pub fn query(
        &self,
        name: &str,
        args: &[u8],
        player: Option<PlayerId>,
    ) -> Result<Vec<u8>, String> {
        let query = self
            .sync
            .query(name)
            .ok_or_else(|| format!("no query {name:?}"))?;
        if query.player && player.is_none() {
            return Err(format!("{name} is per player: name the player"));
        }
        let interest = player
            .and_then(|p| self.conns_of.get(&p)?.first())
            .and_then(|conn| self.streams.get(conn))
            .map(|s| &s.interest);
        let view = query.view_of(
            &ViewCx {
                game: self.core.game(),
                player,
                interest,
            },
            args,
        );
        let player = if query.player { player } else { None };
        let cx = QueryCtx::new(
            self.core.game(),
            player,
            view,
            self.core.time(),
            &self.bodies,
        );
        (query.run)(&cx, args)
    }

    /// [`Sim::query`] with typed arguments and result.
    pub fn query_as<A: Wire, R: Wire>(
        &self,
        name: &str,
        args: &A,
        player: Option<PlayerId>,
    ) -> Result<R, String> {
        let bytes = self.query(name, &args.to_bytes(), player)?;
        R::from_bytes(&bytes).map_err(|e| format!("{name}'s result: {e:?}"))
    }

    /// Re-derives the followed interest of `player`'s connections
    /// ([`Game::follow`]) from its body, making their streams if they have
    /// none. True if any stream's interest changed.
    pub(crate) fn follow(&mut self, player: PlayerId) -> bool {
        let Some(body) = self.bodies.get(&player) else {
            return false;
        };
        let Some(interest) = self.core.game().follow(player, body) else {
            return false;
        };
        let n = self.conns_of.get(&player).map_or(0, Vec::len);
        let mut changed = false;
        for i in 0..n {
            let conn = self.conns_of[&player][i];
            if follow_stream(&mut self.streams, &self.views, conn, &interest) {
                changed = true;
                self.review_views(conn);
            }
        }
        changed
    }

    /// Re-derives the followed interests of the players that moved.
    pub(crate) fn follow_moved(&mut self, moved: &BTreeSet<PlayerId>) {
        for player in moved {
            self.follow(*player);
        }
    }

    /// After an input tick (with
    /// [`SimConfig::entities_on_input`](crate::SimConfig::entities_on_input)):
    /// the entity streams that read a body it moved send now, not at the
    /// next flush.
    pub(crate) fn entities_after_input(&mut self, moved: &[PlayerId]) {
        if moved.is_empty() || self.streams.is_empty() {
            return;
        }
        let mut changed = std::mem::take(&mut self.scratch_keys);
        changed.clear();
        for player in moved {
            self.follow(*player);
            changed.insert(Key::Body(*player));
        }
        self.flush_entities(&changed, false, None);
        self.scratch_keys = changed;
    }
}

/// Points `conn`'s stream at `interest`, making it followed (and making
/// the stream if there is none). True if its interest changed.
fn follow_stream<G: Game>(
    streams: &mut BTreeMap<ConnId, Stream<G>>,
    views: &Result<ViewCache<G::View>, String>,
    conn: ConnId,
    interest: &InterestOf<G>,
) -> bool {
    if let Some(s) = streams.get_mut(&conn) {
        s.followed = true;
        if s.interest != *interest {
            s.interest = interest.clone();
            s.set_due();
            return true;
        }
        return false;
    }
    match views {
        Ok(views) => {
            let encoder = views.encoder();
            streams.insert(
                conn,
                Stream {
                    interest: interest.clone(),
                    encoder,
                    reads: Reads::default(),
                    due: true,
                    followed: true,
                },
            );
            true
        }
        Err(e) => {
            warn!("no entity stream to follow: {e}");
            false
        }
    }
}
