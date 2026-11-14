//! [`Core`]: a game with its time, version, schedule and change marks:
//! the deterministic part of the loop, which live play and a replay share.

use tc_store::LogEntry;
use tc_wire::hash::StableHasher;

use crate::MAX_TIME;
use crate::changes::Changes;
use crate::game::{Cx, EventOf, Game};
use crate::scheduler::Scheduler;

/// Bump when what [`Core::state_hash`] feeds the hasher (its own part)
/// changes.
pub const STATE_HASH_VERSION: &str = "tc-sim-state/1";

/// A game, the time it is at, the last log entry it applied, its schedule
/// and its change marks. See the [crate docs](crate).
pub struct Core<G: Game> {
    game: G,
    time: u64,
    version: u64,
    scheduler: Scheduler<G::Scheduled>,
    changes: Changes<G::Change>,
    fired: u64,
}

/// What [`Core::replay`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Replayed {
    /// Entries applied.
    pub applied: u64,
    /// Entries the game refused ([`Game::apply`] erred), skipped.
    pub skipped: u64,
}

impl<G: Game> Core<G> {
    /// `game` at time 0, version 0, nothing scheduled.
    pub fn new(game: G) -> Core<G> {
        Core {
            game,
            time: 0,
            version: 0,
            scheduler: Scheduler::new(),
            changes: Changes::new(),
            fired: 0,
        }
    }

    /// `game` with `entries` replayed into it (in order, from version 0),
    /// marks muted. See [`Core::replay`].
    pub fn replayed<'a>(
        game: G,
        entries: impl IntoIterator<Item = &'a tc_store::LogEntry<EventOf<G>>>,
    ) -> Result<(Core<G>, Replayed), String> {
        let mut core = Core::new(game);
        let replayed = core.replay(entries)?;
        Ok((core, replayed))
    }

    /// The game.
    pub fn game(&self) -> &G {
        &self.game
    }

    /// The game, mutably: for setup outside the log (tests, tools). What
    /// changes here is not logged, so a replay won't see it.
    pub fn game_mut(&mut self) -> &mut G {
        &mut self.game
    }

    /// Takes the game out.
    pub fn into_game(self) -> G {
        self.game
    }

    /// The time, in steps.
    pub fn time(&self) -> u64 {
        self.time
    }

    /// The last log entry applied (0 before any).
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The pending schedule.
    pub fn scheduler(&self) -> &Scheduler<G::Scheduled> {
        &self.scheduler
    }

    /// Scheduled events fired so far (not state).
    pub fn events_fired(&self) -> u64 {
        self.fired
    }

    /// Takes what was marked changed since the last take.
    pub fn take_changes(&mut self) -> Changes<G::Change> {
        self.changes.take()
    }

    /// True if anything was marked since the last take.
    pub fn has_changes(&self) -> bool {
        !self.changes.is_empty()
    }

    /// Stops (or resumes) change marks.
    pub fn mute_changes(&mut self, muted: bool) {
        self.changes.set_muted(muted);
    }

    fn cx(&mut self) -> (&mut G, Cx<'_, G>) {
        (
            &mut self.game,
            Cx {
                time: self.time,
                scheduler: &mut self.scheduler,
                changes: &mut self.changes,
            },
        )
    }

    /// Advances to `target` (at most [`MAX_TIME`]): every scheduled event
    /// due by then fires at its own time, in order, and a stepping game
    /// steps each step on the way. Never goes back. Returns the events
    /// fired.
    pub fn advance_to(&mut self, target: u64) -> u64 {
        self.advance_while(target, || true)
    }

    /// [`Core::advance_to`], stopping early (between steps, or between
    /// scheduled events) once `go_on` says no: for a long jump with a
    /// budget. Returns the events fired.
    pub fn advance_while(&mut self, target: u64, mut go_on: impl FnMut() -> bool) -> u64 {
        let target = target.min(MAX_TIME);
        let before = self.fired;
        if self.game.steps() {
            while self.time < target && go_on() {
                self.time += 1;
                self.fire_due(self.time);
                let (game, mut cx) = self.cx();
                game.step(&mut cx);
            }
        } else {
            while let Some(next) = self.scheduler.next_time() {
                if next > target || !go_on() {
                    break;
                }
                self.time = self.time.max(next);
                self.fire_due(next);
            }
            if self.scheduler.next_time().is_none_or(|t| t > target) {
                self.time = self.time.max(target);
            }
        }
        self.fired - before
    }

    fn fire_due(&mut self, now: u64) {
        while let Some((key, event)) = self.scheduler.pop_due(now) {
            self.fired += 1;
            let time = self.time;
            self.time = time.max(key.time);
            let (game, mut cx) = self.cx();
            game.fire(event, &mut cx);
        }
    }

    /// Applies one log entry: the next version, at or after the current
    /// time (time advances to it first). An entry the game refuses still
    /// counts as applied (the version moves) and its error is returned.
    pub fn apply(&mut self, entry: &LogEntry<EventOf<G>>) -> Result<(), ApplyError> {
        if entry.seq != self.version + 1 {
            return Err(ApplyError::Sequence(format!(
                "entry {} follows version {}",
                entry.seq, self.version
            )));
        }
        if entry.time < self.time {
            return Err(ApplyError::Sequence(format!(
                "entry {} at time {} is before time {}",
                entry.seq, entry.time, self.time
            )));
        }
        self.advance_to(entry.time);
        if self.time < entry.time {
            // A budgeted advance never runs here; only MAX_TIME stops it.
            return Err(ApplyError::Sequence(format!(
                "entry {} at time {} is past the end of time",
                entry.seq, entry.time
            )));
        }
        self.version = entry.seq;
        let (game, mut cx) = self.cx();
        game.apply(&entry.event, &mut cx)
            .map_err(ApplyError::Refused)
    }

    /// Applies `entries` in order with marks muted (a replay rebuilds the
    /// game before anyone watches it). An entry out of sequence stops it;
    /// one the game refuses is skipped and counted.
    pub fn replay<'a>(
        &mut self,
        entries: impl IntoIterator<Item = &'a LogEntry<EventOf<G>>>,
    ) -> Result<Replayed, String> {
        let muted = self.changes.muted();
        self.changes.set_muted(true);
        let mut done = Replayed::default();
        let mut result = Ok(());
        for entry in entries {
            match self.apply(entry) {
                Ok(()) => done.applied += 1,
                Err(ApplyError::Refused(e)) => {
                    tracing::warn!(seq = entry.seq, "replay skipped an entry: {e}");
                    done.skipped += 1;
                }
                Err(ApplyError::Sequence(e)) => {
                    result = Err(e);
                    break;
                }
            }
        }
        self.changes.set_muted(muted);
        result.map(|()| done)
    }

    /// The determinism hash: one number for the whole state. Live play and
    /// any replay of the same log reach the same hash at the same version.
    /// It covers the time, the version, the schedule (each event's key and
    /// wire bytes, and the next sequence number) and the game's own state
    /// ([`Game::hash_state`]); not the marks or counters.
    pub fn state_hash(&self) -> u64 {
        let mut h = StableHasher::new();
        h.write_str(STATE_HASH_VERSION);
        h.write_u64(self.time);
        h.write_u64(self.version);
        h.write_u64(self.scheduler.next_seq());
        h.write_u64(self.scheduler.len() as u64);
        for (key, event) in self.scheduler.iter() {
            h.write_u64(key.time);
            h.write_u64(key.seq);
            h.write_bytes(&tc_wire::Wire::to_bytes(event));
        }
        self.game.hash_state(&mut h);
        h.finish()
    }
}

/// Why [`Core::apply`] didn't apply an entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplyError {
    /// Out of sequence or time: nothing changed.
    Sequence(String),
    /// The game refused the event; the version moved past it.
    Refused(String),
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyError::Sequence(e) => write!(f, "out of sequence: {e}"),
            ApplyError::Refused(e) => write!(f, "refused: {e}"),
        }
    }
}

impl std::error::Error for ApplyError {}
