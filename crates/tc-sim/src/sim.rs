//! [`Sim`]: a [`Core`] served to tc-net connections, its events logged
//! through tc-store, on the wall clock. The loop itself is in `run`,
//! connections in `conn`, reloads in `reload`.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use tc_net::transport::Frame;
use tc_net::{ConnId, Outbound, Protocol, ServerMsg, WallClock};
use tc_store::{Log, LogEntry, StoreError};
use tc_wire::Wire;
use tracing::{error, warn};

use crate::MAX_TIME;
use crate::core::{ApplyError, Core};
use crate::game::{EventOf, Game, Outbox, PlayerId, To};
use crate::input::{InputConfig, InputQueue};
use crate::reload::Reloads;
use crate::status::{MarkStatus, STATUS_PUBLISH, SimStatus, StatusHandle};

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
}

impl Default for SimConfig {
    /// 50 ms steps, running, default inputs.
    fn default() -> Self {
        SimConfig {
            step: Duration::from_millis(50),
            paused: false,
            input: InputConfig::default(),
        }
    }
}

/// One connection, joined as a player.
pub(crate) struct Conn {
    pub(crate) player: PlayerId,
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
}

/// Distinct refusal reasons logged before the rest are only counted.
const REFUSED_KINDS: usize = 64;

impl<G: Game> Sim<G> {
    /// Serves `core` with its events going to `log` (`None`: kept in
    /// memory, for tests and tools). The clock starts at the core's time.
    pub fn new(core: Core<G>, log: Option<Log<G::Codec>>, config: SimConfig) -> Sim<G> {
        let now = Instant::now();
        let history = log.is_none().then(Vec::new);
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
        };
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
    /// at its start), and serves it from the later of its last entry's
    /// time and its last clock mark. Returns the store's metadata too.
    pub fn open(
        dir: &std::path::Path,
        game: G,
        config: SimConfig,
    ) -> Result<(Sim<G>, Vec<u8>), String> {
        let (log, opened) = Log::open(dir, game.codec()).map_err(|e| e.to_string())?;
        if !opened.report.is_clean() {
            warn!(report = ?opened.report, "the log was recovered");
        }
        let (mut core, replayed) = Core::replayed(game, &opened.entries)?;
        if replayed.skipped > 0 {
            warn!(skipped = replayed.skipped, "entries skipped on open");
        }
        // Time never goes back past a mark.
        core.advance_to(opened.clock);
        Ok((Sim::new(core, Some(log), config), opened.meta))
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

    /// The players present, in order.
    pub fn present(&self) -> Vec<PlayerId> {
        self.conns_of.keys().copied().collect()
    }

    pub(crate) fn schedule_timers(&mut self, now: Instant) {
        self.next_clock_push = (!self.clock.paused()).then_some(now + CLOCK_PUSH_INTERVAL);
        self.next_clock_mark = Some(now + CLOCK_MARK_INTERVAL);
    }

    /// Logs `events` at the current time, as one batch (all or none), and
    /// applies them. An event the codec can't encode (or too large to
    /// write) refuses the whole batch: nothing is logged or applied, the
    /// refusal is counted and the loop runs on. Only a store that can't
    /// write (I/O) fails the store. Returns why the batch wasn't applied.
    pub(crate) fn commit(&mut self, events: Vec<EventOf<G>>) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        if let Some(e) = &self.store_error {
            warn!(
                count = events.len(),
                "events dropped: the store failed ({e})"
            );
            return Err(format!("the server can't save: {e}"));
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

    /// Hands the changes since the last flush to the game, which sends
    /// what they touch.
    pub(crate) fn flush_all(&mut self) {
        self.next_flush = None;
        if !self.core.has_changes() {
            return;
        }
        let changes = self.core.take_changes();
        let mut out = Outbox::new();
        self.core.game().flush(&changes, &mut out);
        self.deliver(out);
    }

    /// A flush within [`FLUSH_INTERVAL`] if anything changed.
    pub(crate) fn schedule_flush(&mut self, now: Instant) {
        if self.next_flush.is_none() && self.core.has_changes() {
            self.next_flush = Some(now + FLUSH_INTERVAL);
        }
    }

    /// Marks the clock in the log (it is written once what it covers is
    /// durable).
    pub(crate) fn mark_clock(&mut self) {
        let Some(log) = &mut self.log else {
            return;
        };
        if self.store_error.is_some() {
            return;
        }
        let time = self.core.time();
        if let Err(e) = log.mark(time) {
            self.store_failed(&e.to_string());
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
        if let Some(target) = self.clock.target(now) {
            let target = target.min(MAX_TIME);
            if target > self.core.time() {
                self.core.advance_to(target);
            }
        }
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
        // A mark that failed on the I/O thread since: pause now, not at
        // the next mark.
        if let Some(e) = self.log.as_mut().and_then(Log::take_mark_error) {
            self.store_failed(&e.to_string());
        }
        self.poll_reload(now);
        self.check_slow(now);
        self.drop_overflowed();
        self.publish_status_if_due(now);
    }

    /// When the loop next has work, if ever: the next step the game needs
    /// (every step for a stepping game, else its next scheduled event),
    /// the next input tick, flush, clock push or mark, or a reload's poll.
    pub fn deadline(&self) -> Option<Instant> {
        let time = self.core.time();
        let step = if time >= MAX_TIME {
            // At the end of time there is no next step to wait for.
            None
        } else if self.core.game().steps() {
            self.clock.next_step_at(time)
        } else {
            self.core
                .scheduler()
                .next_time()
                .and_then(|t| self.clock.next_step_at(t.max(time + 1) - 1))
        };
        [
            step,
            self.next_input_tick,
            self.next_flush,
            self.next_clock_push,
            self.next_clock_mark,
            self.reloads.poll_at(),
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
        let mut taken = Vec::new();
        let applied = self
            .inputs
            .tick(now, |player, _, input, _| taken.push((player, input)));
        for (player, input) in taken {
            let mut events = Vec::new();
            self.core.game().input(player, input, &mut events);
            let _ = self.commit(events);
        }
        self.input_tick_us = u32::try_from(started.elapsed().as_micros()).unwrap_or(u32::MAX);
        for (player, seq) in applied {
            if let Some(state) = self.core.game().player_state(player) {
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
            let mut events = Vec::new();
            self.core.game().presence(player, false, &mut events);
            let _ = self.commit(events);
        }
        self.flush_all();
        let closed = ServerMsg::<G::Protocol>::Closed {
            code: tc_net::close::GOING_AWAY,
            reason: "the server is stopping".into(),
        };
        self.broadcast(&closed);
        self.conns.clear();
        self.conns_of.clear();
        self.drivers.clear();
        self.mark_clock();
        if let Some(log) = &mut self.log
            && let Err(e) = log.wait()
        {
            error!("the last clock mark failed: {e}");
        }
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
    pub(crate) fn entries(self) -> Result<VecDeque<LogEntry<EventOf<G>>>, String> {
        match self {
            ReplaySource::Disk {
                dir,
                codec,
                through,
            } => {
                let read = tc_store::read(&dir, &codec).map_err(|e| e.to_string())?;
                Ok(read
                    .entries
                    .into_iter()
                    .filter(|e| e.seq <= through)
                    .collect())
            }
            ReplaySource::Memory(entries) => Ok(entries.into()),
        }
    }
}
