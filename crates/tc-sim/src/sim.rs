//! [`Sim`]: a [`Core`] served to tc-net connections, its events logged
//! through tc-store, on the wall clock. The loop itself is in `run`,
//! connections in `conn`, reloads in `reload`.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::ops::ControlFlow;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use tc_net::transport::Frame;
use tc_net::{ConnId, Outbound, Protocol, ServerMsg, ViewCache, WallClock};
use tc_store::{ArchivePolicy, Log, LogEntry, StoreError};
use tc_wire::Wire;
use tracing::{error, warn};

use tc_wire::schema::Schema;

use crate::MAX_TIME;
use crate::bases::Bases;
use crate::core::{ApplyError, Core};
use crate::counters::SimCounters;
use crate::entities::Stream;
use crate::game::{Bodies, EventOf, Game, Outbox, PlayerId, To};
use crate::input::{InputConfig, InputQueue, Stop};
use crate::lanes::{Budgets, Lane};
use crate::query::Key;
use crate::record::RecordError;
use crate::reload::Reloads;
use crate::status::{MarkStatus, STATUS_PUBLISH, SimStatus, StatusHandle};
use crate::sync::{SyncConfig, SyncLayer, World};

/// The shortest time between two flushes of the game's changes.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// How often every connection is told the clock (`Clock`), so clients
/// correct their drift.
pub const CLOCK_PUSH_INTERVAL: Duration = Duration::from_secs(5);

/// How often the clock is marked in the log, so a restart resumes close to
/// where time was even when nothing was logged.
pub const CLOCK_MARK_INTERVAL: Duration = Duration::from_secs(10);

/// Bytes a connection may have queued before it counts as behind.
pub const OUTBOUND_BUDGET: usize = 1 << 20;

/// How long a connection may stay over [`OUTBOUND_BUDGET`] before it is
/// dropped as not reading.
pub const SLOW_CLIENT_GRACE: Duration = Duration::from_secs(30);

/// A long advance (a dev jump) runs in slices this long, between which the
/// loop flushes and checks for a stop.
pub const ADVANCE_SLICE: Duration = Duration::from_millis(50);

/// The longest an advance runs before it stops where it got to.
pub const ADVANCE_BUDGET: Duration = Duration::from_secs(5);

/// How the loop runs.
#[derive(Clone, Copy, Debug)]
pub struct SimConfig {
    /// One step's length.
    pub step: Duration,
    /// Start with the clock paused (a turn-based game, or a tool).
    pub paused: bool,
    /// How inputs are taken.
    pub input: InputConfig,
    /// How live queries are kept.
    pub sync: SyncConfig,
    /// Entries between two bases of a game that keeps them
    /// ([`Game::save`]); 0 writes none. The live log holds about twice
    /// this many entries: what's behind the older of the two bases kept
    /// goes to the archive.
    pub base_every: u64,
    /// How long the archive keeps what the bases left behind, and how big
    /// it may get.
    pub archive: ArchivePolicy,
    /// Hash the game's state around every live hook
    /// ([`Game::live_step`], [`Game::wake`], [`Game::act`]) and count one
    /// that changed it ([`SimCounters::live_misses`]): a determinism
    /// check, on by default in debug builds.
    pub verify_live: bool,
    /// Entity streams that read a body an input tick moved send right
    /// after the tick, not at the next flush (a game whose watchers
    /// should see movement at the input rate). Off by default.
    pub entities_on_input: bool,
    /// A command's sender over its byte budget ([`OUTBOUND_BUDGET`]) whose
    /// live queries have the command's effects to send is closed instead
    /// of answered: its result must not reach it before them (read your
    /// writes). The client reconnects, resumes, and finds out whether the
    /// command applied from its queries. Off by default: the result is
    /// sent and the effects follow once the client drains.
    pub close_slow_senders: bool,
    /// What [`Sim::run`](crate::Sim::run) keeps free before its next
    /// deadline when it gives the game idle time ([`Game::idle`]), so the
    /// tick isn't late. Default [`IDLE_MARGIN`].
    pub idle_margin: Duration,
}

/// [`SimConfig::idle_margin`]'s default.
pub const IDLE_MARGIN: Duration = Duration::from_millis(2);

/// [`SimConfig::base_every`]'s default.
pub const BASE_EVERY: u64 = 100_000;

impl Default for SimConfig {
    /// 50 ms steps, running, default inputs and queries, a base every
    /// [`BASE_EVERY`] entries, the default archive, live hooks verified in
    /// debug builds, entity frames at flushes.
    fn default() -> Self {
        SimConfig {
            step: Duration::from_millis(50),
            paused: false,
            input: InputConfig::default(),
            sync: SyncConfig::default(),
            base_every: BASE_EVERY,
            archive: ArchivePolicy::default(),
            verify_live: cfg!(debug_assertions),
            entities_on_input: false,
            close_slow_senders: false,
            idle_margin: IDLE_MARGIN,
        }
    }
}

/// One connection, joined as a player or an observer.
pub(crate) struct Conn {
    /// `None` for an observer.
    pub(crate) player: Option<PlayerId>,
    pub(crate) out: Outbound,
    /// Set when the outbound queue filled or the client stayed over its
    /// budget too long; the connection is then dropped.
    pub(crate) overflowed: Cell<bool>,
    /// Since when its queued bytes have been over [`OUTBOUND_BUDGET`].
    pub(crate) over_budget_since: Option<Instant>,
}

impl Conn {
    /// Queues a frame. Once one is dropped (the queue was full), the
    /// connection is closing and nothing later is queued either: a client
    /// never sees a message after a gap.
    pub(crate) fn send_frame(&self, frame: Frame) {
        if self.overflowed.get() {
            return;
        }
        match self.out.try_send(frame) {
            Ok(()) => {}
            Err(tokio_full) if is_full(&tokio_full) => self.overflowed.set(true),
            // The session is ending; its Disconnect follows.
            Err(_) => {}
        }
    }
}

fn is_full<T>(e: &tokio::sync::mpsc::error::TrySendError<T>) -> bool {
    matches!(e, tokio::sync::mpsc::error::TrySendError::Full(_))
}

/// A game served on the wall clock. See the [crate docs](crate).
pub struct Sim<G: Game> {
    pub(crate) core: Core<G>,
    pub(crate) log: Option<Log<G::Codec>>,
    /// Every entry, when there is no log (what a reload replays).
    pub(crate) history: Option<Vec<LogEntry<EventOf<G>>>>,
    pub(crate) clock: WallClock,
    pub(crate) conns: BTreeMap<ConnId, Conn>,
    /// Each present player's connections, in id order.
    pub(crate) conns_of: BTreeMap<PlayerId, Vec<ConnId>>,
    /// The connection that drives each present player.
    pub(crate) drivers: BTreeMap<PlayerId, ConnId>,
    pub(crate) inputs: InputQueue<<G::Protocol as Protocol>::Input>,
    pub(crate) next_input_tick: Option<Instant>,
    pub(crate) last_input_tick: Option<Instant>,
    /// How long the last input tick took, for `PlayerState.tick_us`.
    pub(crate) input_tick_us: u32,
    pub(crate) next_flush: Option<Instant>,
    pub(crate) next_clock_push: Option<Instant>,
    pub(crate) next_clock_mark: Option<Instant>,
    pub(crate) status: StatusHandle,
    pub(crate) next_status: Instant,
    pub(crate) last_mark: Option<MarkStatus>,
    /// Why the store stopped taking writes: the clock is paused and
    /// nothing more changes the game.
    pub(crate) store_error: Option<String>,
    /// Set by whoever stops the loop, so a long advance stops between
    /// slices.
    pub(crate) stopping: Arc<AtomicBool>,
    pub(crate) advance_budget: Duration,
    pub(crate) reloads: Reloads<G>,
    /// Batches refused because the log couldn't encode them.
    pub(crate) refused: u64,
    /// The reasons logged so far (each logged once).
    pub(crate) refused_kinds: BTreeSet<String>,
    /// The game's schema ([`Game::schema`]).
    pub(crate) schema: Arc<Schema>,
    pub(crate) sync: SyncLayer<G>,
    /// Entity views encoded once for every stream (or why the game's view
    /// can't be streamed).
    pub(crate) views: Result<ViewCache<G::View>, String>,
    /// Each watching connection's entity stream.
    pub(crate) streams: BTreeMap<ConnId, Stream<G>>,
    /// Each present player's body ([`Game::Body`]).
    pub(crate) bodies: BTreeMap<PlayerId, G::Body>,
    /// Bodies moved since the last flush.
    pub(crate) moved: BTreeSet<PlayerId>,
    /// The version at the last flush.
    pub(crate) flushed_version: u64,
    pub(crate) lanes: Vec<Lane>,
    pub(crate) budgets: Budgets,
    /// Game messages dropped over a lane's budget.
    pub(crate) limited: u64,
    pub(crate) bases: Bases<G>,
    /// The time of the last live step ([`LiveCx::since`]).
    pub(crate) live_time: u64,
    /// The wake armed ([`LiveCx::wake_at`]).
    pub(crate) next_wake: Option<Instant>,
    pub(crate) verify_live: bool,
    pub(crate) entities_on_input: bool,
    pub(crate) close_slow_senders: bool,
    pub(crate) counters: SimCounters,
    pub(crate) idle_margin: Duration,
    /// How late the loop last woke for a deadline ([`IdleCx::late`](crate::IdleCx::late)).
    pub(crate) late: Duration,
    /// Bulk frames were queued since the last wake pass
    /// ([`Sim::wake_outbound`]), or some linger.
    pub(crate) bulk_sent: Cell<bool>,
    /// When lingering bulk frames go out at the latest.
    pub(crate) next_linger: Option<Instant>,
    /// The game's wall-clock timers by kind ([`LiveCx::set_timer`](crate::LiveCx::set_timer)).
    pub(crate) timers: BTreeMap<u32, Instant>,
    /// Clock changes live hooks asked for, not yet done
    /// ([`LiveCx::clock`](crate::LiveCx::clock)).
    pub(crate) clock_ops: Vec<crate::live::ClockOp>,
    /// Scratch kept between ticks, so a steady loop doesn't allocate.
    pub(crate) live_events: Vec<EventOf<G>>,
    pub(crate) live_out: Outbox<G::Protocol>,
    pub(crate) scratch_keys: BTreeSet<Key<G::Change>>,
    pub(crate) scratch_players: Vec<PlayerId>,
    pub(crate) scratch_applied: Vec<(PlayerId, u32)>,
    pub(crate) scratch_moved: Vec<PlayerId>,
    pub(crate) scratch_things: Vec<(u64, G::View)>,
}

/// Distinct refusal reasons logged before the rest are only counted.
const REFUSED_KINDS: usize = 64;

impl<G: Game> Sim<G> {
    /// Serves `core` with its events going to `log` (`None`: kept in
    /// memory, for tests and tools). The clock starts at the core's time.
    pub fn new(core: Core<G>, log: Option<Log<G::Codec>>, config: SimConfig) -> Sim<G> {
        let now = Instant::now();
        // A game with its own record keeps its own history.
        let history = (log.is_none() && !core.owns_record()).then(Vec::new);
        let schema = Arc::new(G::schema());
        let sync = SyncLayer::new(config.sync, schema.clone(), crate::query::registry());
        let views = ViewCache::new(&schema).map_err(|e| e.to_string());
        let flushed_version = core.version();
        let mut sim = Sim {
            clock: WallClock::new(config.step, config.paused, now, core.time()),
            core,
            log,
            history,
            conns: BTreeMap::new(),
            conns_of: BTreeMap::new(),
            drivers: BTreeMap::new(),
            inputs: InputQueue::new(config.input),
            next_input_tick: None,
            last_input_tick: None,
            input_tick_us: 0,
            next_flush: None,
            next_clock_push: None,
            next_clock_mark: None,
            status: StatusHandle::default(),
            next_status: now,
            last_mark: None,
            store_error: None,
            stopping: Arc::new(AtomicBool::new(false)),
            advance_budget: ADVANCE_BUDGET,
            reloads: Reloads::default(),
            refused: 0,
            refused_kinds: BTreeSet::new(),
            flushed_version,
            schema,
            sync,
            views,
            streams: BTreeMap::new(),
            bodies: BTreeMap::new(),
            moved: BTreeSet::new(),
            lanes: G::lanes(),
            budgets: Budgets::default(),
            limited: 0,
            bases: Bases::new(config.base_every, config.archive, flushed_version),
            live_time: 0,
            next_wake: None,
            verify_live: config.verify_live,
            entities_on_input: config.entities_on_input,
            close_slow_senders: config.close_slow_senders,
            counters: SimCounters::default(),
            idle_margin: config.idle_margin,
            late: Duration::ZERO,
            bulk_sent: Cell::new(false),
            next_linger: None,
            timers: BTreeMap::new(),
            clock_ops: Vec::new(),
            live_events: Vec::new(),
            live_out: Outbox::new(),
            scratch_keys: BTreeSet::new(),
            scratch_players: Vec::new(),
            scratch_applied: Vec::new(),
            scratch_moved: Vec::new(),
            scratch_things: Vec::new(),
        };
        sim.live_time = sim.core.time();
        sim.schedule_timers(now);
        sim.publish_status(now);
        sim
    }

    /// Creates a store in `dir` (tc-store, with `meta` as the game's
    /// metadata) and serves `game` from its start.
    pub fn create(
        dir: &std::path::Path,
        game: G,
        meta: &[u8],
        config: SimConfig,
    ) -> Result<Sim<G>, StoreError> {
        let log = Log::create(dir, game.codec(), meta)?;
        Ok(Sim::new(Core::new(game), Some(log), config))
    }

    /// Opens the store in `dir`, replays its log into `game` (a new game,
    /// at its start; from its newest base, if it keeps them, see
    /// [`Game::save`]), and serves it from the later of its last entry's
    /// time and its last clock mark, after logging what
    /// [`Game::on_open`] pushed. Returns the store's metadata too.
    pub fn open(
        dir: &std::path::Path,
        game: G,
        config: SimConfig,
    ) -> Result<(Sim<G>, Vec<u8>), String> {
        if game.record().is_some() {
            return Err("the game keeps its own record: open it, then Sim::new".into());
        }
        let (log, opened, mut core, from) = crate::bases::open_log(dir, game)?;
        if !opened.report.is_clean() {
            warn!(report = ?opened.report, "the log was recovered");
        }
        let replayed = core.replay(&opened.entries)?;
        if replayed.skipped > 0 {
            warn!(skipped = replayed.skipped, "entries skipped on open");
        }
        // Time never goes back past a mark.
        core.advance_to(opened.clock);
        let mut sim = Sim::new(core, Some(log), config);
        sim.bases.opened_from = from;
        sim.tidy_after_open();
        // Whatever the last run left (it may have crashed): the game's
        // events that tidy it, logged like any other.
        let mut events = Vec::new();
        sim.core.game().on_open(sim.core.time(), &mut events);
        if let Err(e) = sim.commit(events) {
            warn!("the game's on_open events weren't applied: {e}");
        }
        Ok((sim, opened.meta))
    }

    /// The game and its time, version and schedule.
    pub fn core(&self) -> &Core<G> {
        &self.core
    }

    /// The clock.
    pub fn clock(&self) -> &WallClock {
        &self.clock
    }

    /// Where the loop publishes its status.
    pub fn status(&self) -> StatusHandle {
        self.status.clone()
    }

    /// The flag that stops a long advance between slices; set it before
    /// stopping the loop.
    pub fn stopping(&self) -> Arc<AtomicBool> {
        self.stopping.clone()
    }

    /// Sets how long one advance may run (default [`ADVANCE_BUDGET`]).
    pub fn set_advance_budget(&mut self, budget: Duration) {
        self.advance_budget = budget;
    }

    /// The game's schema.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// What the live queries cost so far.
    pub fn sync_stats(&self) -> crate::SyncStats {
        self.sync.stats()
    }

    /// `player`'s body, if it is present.
    pub fn body(&self, player: PlayerId) -> Option<&G::Body> {
        self.bodies.get(&player)
    }

    /// The players present, in order.
    pub fn present(&self) -> Vec<PlayerId> {
        self.conns_of.keys().copied().collect()
    }

    pub(crate) fn schedule_timers(&mut self, now: Instant) {
        self.next_clock_push = (!self.clock.paused()).then_some(now + CLOCK_PUSH_INTERVAL);
        self.next_clock_mark = Some(now + CLOCK_MARK_INTERVAL);
    }

    /// Logs `events` at the current time, as one batch (all or none), and
    /// applies them; then the game's rules judge what the batch changed
    /// ([`Game::after_batch`]), and the events they push join it. An event
    /// the codec can't encode (or too large to write) refuses the whole
    /// batch: nothing is logged or applied, the refusal is counted and the
    /// loop runs on. Only a store that can't write (I/O) fails the store.
    /// Returns why the batch wasn't applied.
    pub(crate) fn commit(&mut self, events: Vec<EventOf<G>>) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        let earlier = self.core.take_changes();
        let applied = self.log_apply(events);
        let batch = self.core.take_changes();
        let mut more = Vec::new();
        let mut out = Outbox::new();
        if applied.is_ok() {
            self.core.game().after_batch(&batch, &mut more, &mut out);
        }
        self.core.put_back_changes(earlier);
        self.core.put_back_changes(batch);
        if !more.is_empty() {
            self.counters.rule_batches += 1;
            if let Err(e) = self.log_apply(more) {
                warn!("the events a batch's rules pushed weren't applied: {e}");
            }
        }
        self.deliver_drain(&mut out);
        applied
    }

    /// Logs `events` at the current time, as one batch, and applies them.
    fn log_apply(&mut self, events: Vec<EventOf<G>>) -> Result<(), String> {
        self.counters.batches += 1;
        self.counters.events += events.len() as u64;
        if let Some(e) = &self.store_error {
            warn!(
                count = events.len(),
                "events dropped: the store failed ({e})"
            );
            return Err(format!("the server can't save: {e}"));
        }
        if self.core.owns_record() {
            return match self.core.commit(events) {
                Ok(()) => Ok(()),
                Err(RecordError::Refused(reason)) => Err(self.refuse(reason)),
                Err(RecordError::Store(e)) => {
                    self.store_failed(&e);
                    Err(format!("the server can't save: {e}"))
                }
            };
        }
        let time = self.core.time();
        let first = self.core.version() + 1;
        let entries: Vec<LogEntry<EventOf<G>>> = events
            .into_iter()
            .zip(first..)
            .map(|(event, seq)| LogEntry { seq, time, event })
            .collect();
        if let Some(log) = &mut self.log
            && let Err(e) = log.append_all(&entries)
        {
            return Err(match e {
                StoreError::Encode { reason, .. } => self.refuse(reason),
                StoreError::RecordTooLarge { len, max, .. } => {
                    self.refuse(format!("an event of {len} bytes (at most {max})"))
                }
                e => {
                    self.store_failed(&e.to_string());
                    format!("the server can't save: {e}")
                }
            });
        }
        for entry in &entries {
            match self.core.apply(entry) {
                Ok(()) => {}
                Err(ApplyError::Refused(e)) => {
                    warn!(seq = entry.seq, "the game refused its own event: {e}");
                }
                Err(ApplyError::Sequence(e)) => {
                    // Can't happen: the entries follow the version at the
                    // current time.
                    error!("an entry out of sequence: {e}");
                }
            }
        }
        self.reloads.written(&entries);
        if let Some(history) = &mut self.history {
            history.extend(entries);
        }
        Ok(())
    }

    /// Counts a batch the log refused, and logs the first of each kind.
    fn refuse(&mut self, reason: String) -> String {
        self.refused += 1;
        if self.refused_kinds.len() < REFUSED_KINDS && self.refused_kinds.insert(reason.clone()) {
            warn!("an event the log can't write was refused (a game bug): {reason}");
        }
        self.publish_status(Instant::now());
        format!("refused: {reason}")
    }

    /// Fails the store from outside the loop's own writes (the game's
    /// store, written elsewhere, failed): the clock pauses, everyone is
    /// told, and nothing more changes the game. A second failure is
    /// ignored; [`Sim::store_error`] keeps the first.
    pub fn fail_store(&mut self, reason: &str) {
        self.store_failed(reason);
    }

    /// Why the store stopped taking writes, if it did.
    pub fn store_error(&self) -> Option<&str> {
        self.store_error.as_deref()
    }

    /// Fails the store if the game's own record noticed a failure
    /// ([`Record::take_error`](crate::Record::take_error)).
    pub(crate) fn poll_record_error(&mut self) {
        if let Some(e) = self.core.take_record_error() {
            self.store_failed(&e);
        }
    }

    /// The store failed: the clock pauses, everyone is told, and nothing
    /// more changes the game (a restart reopens it as the log has it).
    pub(crate) fn store_failed(&mut self, e: &str) {
        if self.store_error.is_some() {
            return;
        }
        error!("the store failed; pausing: {e}");
        self.store_error = Some(e.to_string());
        self.clock.pause();
        self.next_clock_push = None;
        self.broadcast(&self.clock_msg());
        self.publish_status(Instant::now());
    }

    pub(crate) fn clock_msg(&self) -> ServerMsg<G::Protocol> {
        ServerMsg::Clock {
            time: self.core.time(),
            paused: self.clock.paused(),
        }
    }

    /// Sends `msg` to every connection.
    pub(crate) fn broadcast(&self, msg: &ServerMsg<G::Protocol>) {
        let frame = Frame::from(msg.to_bytes());
        for c in self.conns.values() {
            c.send_frame(frame.clone());
        }
    }

    /// [`Sim::commit`] of what `events` holds, leaving it empty (nothing
    /// is allocated when it was empty).
    pub(crate) fn commit_drain(&mut self, events: &mut Vec<EventOf<G>>) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        self.commit(std::mem::take(events))
    }

    /// [`Sim::deliver`] of what `out` holds, leaving it empty.
    pub(crate) fn deliver_drain(&mut self, out: &mut Outbox<G::Protocol>) {
        if out.msgs.is_empty() {
            return;
        }
        self.deliver(Outbox {
            msgs: std::mem::take(&mut out.msgs),
        });
    }

    /// Sends an outbox's messages, each encoded once.
    pub(crate) fn deliver(&self, out: Outbox<G::Protocol>) {
        for (to, msg) in out.msgs {
            let frame = Frame::from(msg.to_bytes());
            match to {
                To::All => {
                    for c in self.conns.values() {
                        c.send_frame(frame.clone());
                    }
                }
                To::Conn(conn) => {
                    if let Some(c) = self.conns.get(&conn) {
                        c.send_frame(frame);
                    }
                }
                To::Player(player) => {
                    for c in self.player_conns(player) {
                        c.send_frame(frame.clone());
                    }
                }
            }
        }
    }

    /// `player`'s connections, in id order.
    pub(crate) fn player_conns(&self, player: PlayerId) -> impl Iterator<Item = &Conn> {
        self.conns_of
            .get(&player)
            .into_iter()
            .flatten()
            .filter_map(|id| self.conns.get(id))
    }

    /// Flushes for everyone.
    pub(crate) fn flush_all(&mut self) {
        self.flush(None);
    }

    /// Hands the changes since the last flush to the game, which sends
    /// what they touch, then brings live queries and entity streams up to
    /// date: everyone's, or `only` that connection's (the others' wait for
    /// the next flush).
    pub(crate) fn flush(&mut self, only: Option<ConnId>) {
        if only.is_none() {
            self.next_flush = None;
        }
        let now = Instant::now();
        self.counters.flushes += 1;
        let changes = self.core.take_changes();
        if !changes.is_empty() {
            let mut out = Outbox::new();
            self.core.game().flush(&changes, &mut out);
            self.deliver(out);
        }
        let moved = std::mem::take(&mut self.moved);
        self.follow_moved(&moved);
        let version = self.core.version();
        let any = !changes.is_empty() || !moved.is_empty() || version != self.flushed_version;
        self.flushed_version = version;
        let changed: BTreeSet<Key<G::Change>> = changes
            .keys()
            .cloned()
            .map(Key::Game)
            .chain(moved.into_iter().map(Key::Body))
            .collect();
        let time = self.core.time();
        self.sync.changed(&changed, any);
        self.sync.expire(time);
        if self.sync.has_work() {
            let world = World {
                game: self.core.game(),
                time,
                version,
                bodies: &self.bodies,
            };
            let conns = &self.conns;
            let frames = self.sync.flush(&world, now, only, |conn| {
                conns
                    .get(&conn)
                    .is_none_or(|c| c.out.queued() > OUTBOUND_BUDGET)
            });
            for (conn, frame) in frames {
                if let Some(c) = self.conns.get(&conn) {
                    c.send_frame(Frame::from(frame));
                }
            }
        }
        self.flush_entities(&changed, any, only);
        self.counters.flush_us += crate::counters::micros(now);
    }

    /// The earliest time a query result or an entity frame runs out.
    pub(crate) fn next_expiry(&self) -> Option<u64> {
        [self.sync.next_expiry(), self.streams_expiry()]
            .into_iter()
            .flatten()
            .min()
    }

    /// A flush within [`FLUSH_INTERVAL`] if anything changed or waits.
    pub(crate) fn schedule_flush(&mut self, now: Instant) {
        if self.next_flush.is_some() {
            return;
        }
        let due = self.core.has_changes()
            || !self.moved.is_empty()
            || self.core.version() != self.flushed_version
            || self.sync.has_work()
            || self.streams_waiting()
            || self.next_expiry().is_some_and(|t| t <= self.core.time());
        if due {
            self.next_flush = Some(now + FLUSH_INTERVAL);
        }
    }

    /// Marks the clock in the log (it is written once what it covers is
    /// durable).
    pub(crate) fn mark_clock(&mut self) {
        self.mark_clock_waiting(false);
    }

    /// [`Sim::mark_clock`]; with `wait`, a game's own record makes the
    /// mark durable before it returns (the loop is stopping).
    pub(crate) fn mark_clock_waiting(&mut self, wait: bool) {
        if self.store_error.is_some() {
            return;
        }
        let time = self.core.time();
        let marked = match (self.core.mark_record(wait), &mut self.log) {
            (Some(marked), _) => marked,
            (None, Some(log)) => log.mark(time).map_err(|e| e.to_string()),
            (None, None) => return,
        };
        if let Err(e) = marked {
            self.store_failed(&e);
            return;
        }
        let wall = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        self.last_mark = Some(MarkStatus {
            time,
            version: self.core.version(),
            wall,
        });
    }

    /// Pauses the clock (dev, or a turn-based game between turns) and
    /// tells everyone.
    pub fn pause(&mut self) {
        if self.clock.paused() {
            return;
        }
        let now = Instant::now();
        self.tick(now);
        self.clock.pause();
        self.next_clock_push = None;
        self.mark_clock();
        self.broadcast(&self.clock_msg());
        self.publish_status(now);
    }

    /// Runs the clock from the current time and tells everyone. Refused
    /// (false) once the store failed.
    pub fn resume(&mut self) -> bool {
        if self.store_error.is_some() {
            return false;
        }
        if self.clock.paused() {
            let now = Instant::now();
            self.clock.run_from(now, self.core.time());
            self.next_clock_push = Some(now + CLOCK_PUSH_INTERVAL);
            self.broadcast(&self.clock_msg());
            self.publish_status(now);
        }
        true
    }

    /// Advances `steps` steps at once (a dev jump), in slices, stopping at
    /// the advance budget or a stop. Returns the time reached, or an
    /// error if it would pass [`MAX_TIME`].
    pub fn advance(&mut self, steps: u64) -> Result<u64, String> {
        let from = self.core.time();
        let target = from
            .checked_add(steps)
            .filter(|t| *t <= MAX_TIME)
            .ok_or_else(|| format!("{steps} steps from {from} pass the end of time"))?;
        let started = Instant::now();
        let budget_end = started + self.advance_budget;
        while self.core.time() < target {
            let now = Instant::now();
            if now >= budget_end || self.stopping.load(Ordering::Relaxed) {
                break;
            }
            let slice_end = (now + ADVANCE_SLICE).min(budget_end);
            let stopping = &self.stopping;
            let mut n = 0u32;
            self.core.advance_while(target, || {
                // The wall clock is read every 64 steps or events.
                n = n.wrapping_add(1);
                !n.is_multiple_of(64)
                    || (Instant::now() < slice_end && !stopping.load(Ordering::Relaxed))
            });
            self.flush_all();
            self.drop_overflowed();
        }
        if !self.clock.paused() {
            self.clock.run_from(Instant::now(), self.core.time());
        }
        self.mark_clock();
        self.broadcast(&self.clock_msg());
        self.publish_status(Instant::now());
        Ok(self.core.time())
    }

    /// Advances to `target` at once (a dev jump), as [`Sim::advance`]
    /// does. Returns the time reached; an error if `target` is in the
    /// past or past [`MAX_TIME`].
    pub fn advance_to(&mut self, target: u64) -> Result<u64, String> {
        let time = self.core.time();
        let steps = target
            .checked_sub(time)
            .ok_or_else(|| format!("{target} is before the time now ({time})"))?;
        self.advance(steps)
    }

    /// Publishes the status now.
    pub(crate) fn publish_status(&mut self, now: Instant) {
        self.status.set(SimStatus {
            players: self.present(),
            connections: self.conns.len(),
            version: self.core.version(),
            time: self.core.time(),
            paused: self.clock.paused(),
            last_mark: self.last_mark,
            reloading: self.reloads.running(),
            store_error: self.store_error.clone(),
            refused: self.refused,
            limited: self.limited,
            sync: self.sync.stats(),
            counters: self.counters,
        });
        self.next_status = now + STATUS_PUBLISH;
    }

    pub(crate) fn publish_status_if_due(&mut self, now: Instant) {
        if now >= self.next_status {
            self.publish_status(now);
        }
    }

    /// Catches up with the clock and does whatever periodic work is due:
    /// steps, input ticks, flushes, clock pushes and marks, slow clients,
    /// a finished reload, the status.
    pub fn tick(&mut self, now: Instant) {
        self.counters.ticks += 1;
        if let Some(target) = self.clock.target(now) {
            let target = target.min(MAX_TIME);
            if target > self.core.time() {
                self.advance_live(target, now);
            }
        }
        self.wake_if_due(now);
        self.timers_if_due(now);
        if self.next_input_tick.is_some_and(|t| now >= t) {
            self.input_tick(now);
        }
        self.schedule_flush(now);
        if self.next_flush.is_some_and(|t| now >= t) {
            self.flush_all();
        }
        if self.next_clock_push.is_some_and(|t| now >= t) {
            self.broadcast(&self.clock_msg());
            self.next_clock_push = Some(now + CLOCK_PUSH_INTERVAL);
        }
        if self.next_clock_mark.is_some_and(|t| now >= t) {
            self.mark_clock();
            self.publish_status(now);
            self.next_clock_mark = Some(now + CLOCK_MARK_INTERVAL);
        }
        self.poll_base();
        // A mark that failed on the I/O thread since: pause now, not at
        // the next mark.
        if let Some(e) = self.log.as_mut().and_then(Log::take_mark_error) {
            self.store_failed(&e.to_string());
        }
        self.poll_record_error();
        self.poll_reload(now);
        self.check_slow(now);
        self.drop_overflowed();
        self.run_clock_ops();
        self.publish_status_if_due(now);
    }

    /// When the loop next has work, if ever: the next step the game needs
    /// (every step for a stepping or live game, else its next scheduled
    /// event), a wake, the next input tick, flush, clock push or mark, or
    /// a reload's poll.
    pub fn deadline(&self) -> Option<Instant> {
        let time = self.core.time();
        let step = if time >= MAX_TIME {
            // At the end of time there is no next step to wait for.
            None
        } else if self.core.game().steps() {
            self.clock.next_step_at(time)
        } else {
            self.core
                .next_event_time()
                .and_then(|t| self.clock.next_step_at(t.max(time + 1) - 1))
        };
        // A query result or entity frame that runs out: flush at its time.
        let expiry = self
            .next_expiry()
            .filter(|t| *t > time)
            .and_then(|t| self.clock.next_step_at(t - 1));
        [
            step,
            self.live_deadline(),
            expiry,
            self.next_input_tick,
            self.next_flush,
            self.next_clock_push,
            self.next_clock_mark,
            self.reloads.poll_at(),
            self.next_linger,
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// One input tick: each player's waiting inputs, while it has credit,
    /// go to [`Game::input`]; its connections then get `PlayerState`.
    pub(crate) fn input_tick(&mut self, now: Instant) {
        let started = Instant::now();
        let due = self.next_input_tick.unwrap_or(now);
        let mut players = std::mem::take(&mut self.scratch_players);
        let mut applied = std::mem::take(&mut self.scratch_applied);
        let mut moved = std::mem::take(&mut self.scratch_moved);
        let mut events = std::mem::take(&mut self.live_events);
        players.clear();
        players.extend(self.inputs.players());
        self.inputs.start_tick(now);
        for &player in &players {
            // Each input's events are logged before the next, so a stop
            // (a knockout) sees what came before it.
            while let Some((_, input, _)) = self.inputs.take(player, now) {
                let Some(body) = self.bodies.get_mut(&player) else {
                    continue;
                };
                let flow = self
                    .core
                    .game()
                    .input_flow(player, body, input, &mut events);
                self.counters.inputs += 1;
                self.moved.insert(player);
                moved.push(player);
                let _ = self.commit_drain(&mut events);
                if let ControlFlow::Break(stop) = flow {
                    if stop == Stop::AckAll {
                        self.inputs.ack_all(player);
                    }
                    break;
                }
            }
            if self.inputs.taken(player) > 0
                && let Some(seq) = self.inputs.last_applied(player)
            {
                applied.push((player, seq));
            }
        }
        if !moved.is_empty() {
            self.counters.input_ticks += 1;
            moved.sort_unstable();
            moved.dedup();
            let bodies = Bodies {
                time: self.core.time(),
                bodies: &self.bodies,
                moved: &moved,
            };
            self.core.game().moved(&bodies, &mut events);
            let _ = self.commit_drain(&mut events);
        }
        self.input_tick_us = u32::try_from(started.elapsed().as_micros()).unwrap_or(u32::MAX);
        for (player, seq) in applied.drain(..) {
            let Some(body) = self.bodies.get(&player) else {
                continue;
            };
            if let Some(state) = self.core.game().player_state(player, body) {
                let frame = Frame::from(
                    ServerMsg::<G::Protocol>::PlayerState {
                        seq,
                        state,
                        tick_us: self.input_tick_us,
                    }
                    .to_bytes(),
                );
                for c in self.player_conns(player) {
                    c.send_frame(frame.clone());
                }
            }
        }
        if self.entities_on_input {
            self.entities_after_input(&moved);
        }
        moved.clear();
        self.scratch_players = players;
        self.scratch_applied = applied;
        self.scratch_moved = moved;
        self.live_events = events;
        self.counters.input_us += crate::counters::micros(started);
        let tick = self.inputs.config().tick;
        let next = due + tick;
        self.last_input_tick = Some(now);
        self.next_input_tick = self
            .inputs
            .has_inputs()
            .then(|| if next > now { next } else { now + tick / 2 });
    }

    /// Notes connections over their byte budget, and marks those over it
    /// longer than [`SLOW_CLIENT_GRACE`] to be dropped.
    pub(crate) fn check_slow(&mut self, now: Instant) {
        for c in self.conns.values_mut() {
            if c.out.queued() > OUTBOUND_BUDGET {
                let since = *c.over_budget_since.get_or_insert(now);
                if now.saturating_duration_since(since) > SLOW_CLIENT_GRACE {
                    c.overflowed.set(true);
                }
            } else {
                c.over_budget_since = None;
            }
        }
    }

    /// Stops: answers every reload still waiting with an error, records
    /// every present player leaving, tells every connection to come back
    /// later (`Closed`, not final), marks the clock and waits for the log.
    /// Returns the core.
    pub fn stop(mut self) -> Core<G> {
        self.reloads.cancel("the server is stopping");
        let now = Instant::now();
        self.tick(now);
        for player in self.present() {
            let body = self.bodies.remove(&player);
            let mut events = Vec::new();
            self.core
                .game()
                .presence(player, false, body.as_ref(), &mut events);
            let _ = self.commit(events);
        }
        self.flush_all();
        let closed = ServerMsg::<G::Protocol>::Closed {
            code: tc_net::close::GOING_AWAY,
            reason: "the server is stopping".into(),
        };
        self.broadcast(&closed);
        // Every connection closes with the loop: the game forgets each.
        let open: Vec<(ConnId, Option<PlayerId>)> =
            self.conns.iter().map(|(id, c)| (*id, c.player)).collect();
        for (conn, player) in open {
            self.conns.remove(&conn);
            self.disconnected(conn, player, now);
        }
        self.conns.clear();
        self.conns_of.clear();
        self.drivers.clear();
        self.mark_clock_waiting(true);
        if let Some(log) = &mut self.log
            && let Err(e) = log.wait()
        {
            error!("the last clock mark failed: {e}");
        }
        // A base under way is finished, so no job outlives the store's lock.
        self.finish_base();
        self.publish_status(Instant::now());
        tracing::info!(
            time = self.core.time(),
            version = self.core.version(),
            state_hash = %crate::hash_hex(self.core.state_hash()),
            "simulation stopped"
        );
        self.core
    }

    /// The waiting connections' queue: drop each connection that overflowed.
    pub(crate) fn drop_overflowed(&mut self) {
        let dropped: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, c)| c.overflowed.get())
            .map(|(conn, _)| *conn)
            .collect();
        for conn in dropped {
            tracing::info!(conn, "closing: the client is not reading its messages");
            self.disconnect(conn);
        }
    }

    /// Entries a reload replays: the log's on disk (made durable first),
    /// or the history kept in memory.
    pub(crate) fn replay_source(&mut self) -> Result<ReplaySource<G>, String> {
        if self.core.owns_record() {
            return Err("the game keeps its own record and reloads itself".into());
        }
        let through = self.core.version();
        match (&mut self.log, &self.history) {
            (Some(log), _) => {
                log.sync_all().map_err(|e| e.to_string())?;
                Ok(ReplaySource::Disk {
                    dir: log.dir().to_path_buf(),
                    codec: log.codec().clone(),
                    through,
                })
            }
            (None, Some(history)) => Ok(ReplaySource::Memory(history.clone())),
            (None, None) => Err("nothing to replay".into()),
        }
    }
}

/// Where a reload reads the entries it replays.
pub(crate) enum ReplaySource<G: Game> {
    Disk {
        dir: std::path::PathBuf,
        codec: G::Codec,
        through: u64,
    },
    Memory(Vec<LogEntry<EventOf<G>>>),
}

impl<G: Game> ReplaySource<G> {
    /// `game` (new, at its start) with the entries replayed into it: on
    /// disk, from the store's newest base if it has one (the base is the
    /// old game's state, restored into the new one; only the log after it
    /// is replayed).
    pub(crate) fn replayed(self, game: G) -> Result<(Core<G>, crate::Replayed), String> {
        match self {
            ReplaySource::Disk {
                dir,
                codec,
                through,
            } => {
                let err = |e: StoreError| e.to_string();
                // The newest base that reads back whole.
                let newest = tc_store::bases(&dir)
                    .map_err(err)?
                    .into_iter()
                    .find_map(|base| {
                        let bytes = std::fs::read(&base.path).ok()?;
                        crate::core::base_intact(&bytes).then_some((base, bytes))
                    });
                let (mut core, read) = match newest {
                    Some((base, bytes)) => {
                        let core = Core::from_base(game, &bytes, false)?;
                        let read = tc_store::read_from(&dir, &codec, base.generation, base.after)
                            .map_err(err)?;
                        (core, read)
                    }
                    None => (Core::new(game), tc_store::read(&dir, &codec).map_err(err)?),
                };
                let entries: Vec<_> = read
                    .entries
                    .into_iter()
                    .filter(|e| e.seq <= through)
                    .collect();
                let replayed = core.replay(&entries)?;
                Ok((core, replayed))
            }
            ReplaySource::Memory(entries) => {
                let entries: VecDeque<_> = entries.into();
                Core::replayed(game, &entries)
            }
        }
    }
}
