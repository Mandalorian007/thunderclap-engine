//! [`Record`]: a game that keeps its own time, schedule, log and state
//! hash, which the [`Core`](crate::Core) then delegates to.

use crate::changes::Changes;
use crate::game::{EventOf, Game};

/// Why [`Record::commit`] didn't apply a batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordError {
    /// The batch can't be written (an event the log can't encode, or too
    /// large): nothing was logged or applied, and the loop runs on (a game
    /// bug, counted in `SimStatus::refused`).
    Refused(String),
    /// The store can't write: nothing was applied, and the loop pauses the
    /// clock, tells every client and changes nothing more.
    Store(String),
}

impl std::fmt::Display for RecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecordError::Refused(e) => write!(f, "refused: {e}"),
            RecordError::Store(e) => write!(f, "the store failed: {e}"),
        }
    }
}

impl std::error::Error for RecordError {}

/// The record of a game that keeps its own: an event-sourced world with
/// its own clock, scheduler, store (log, bases, compaction) and state hash.
/// [`Game::record`] and [`Game::record_mut`] hand it to the core, which
/// then keeps none of its own and delegates:
///
/// - the time and version ([`Core::time`](crate::Core::time),
///   [`Core::version`](crate::Core::version)) are the record's;
/// - advancing time ([`Core::advance_to`](crate::Core::advance_to), the
///   loop's catch-up, a dev jump) calls [`Record::advance`], which fires
///   the game's own schedule and steps (not [`Game::fire`] or
///   [`Game::step`]);
/// - a batch of events (a command's, a join's, a live hook's) goes to
///   [`Record::commit`], which logs and applies it (not tc-store or
///   [`Game::apply`]); [`Game::after_batch`] still judges it;
/// - [`Core::state_hash`](crate::Core::state_hash) is
///   [`Record::state_hash`], and a clock mark is [`Record::mark`];
/// - a store failure ([`RecordError::Store`], or [`Record::take_error`]
///   polled every tick and after every hook) pauses the clock and reports
///   it, as tc-store's does.
///
/// The game opens, replays, bases and reloads itself: build the sim with
/// `Sim::new(Core::new(game), None, config)`; [`Sim::open`](crate::Sim::open),
/// [`Core::apply`](crate::Core::apply), [`Core::replay`](crate::Core::replay),
/// bases and [`Sim::reload`](crate::Sim::reload) refuse.
///
/// Its change marks go to the `changes` it is handed, so the loop's
/// flushes, queries and entity streams see what fired and applied.
pub trait Record<G: Game> {
    /// The time, in steps.
    fn time(&self) -> u64;

    /// The last log entry applied (0 before any).
    fn version(&self) -> u64;

    /// When the next scheduled event fires, if any (the loop sleeps until
    /// then when the game doesn't [`Game::steps`]).
    fn next_event(&self) -> Option<u64>;

    /// Advances to `target` (at most [`MAX_TIME`](crate::MAX_TIME), never
    /// back), firing what is due and stepping, and stops early (between
    /// steps or events) once `go_on` says no. Returns the events fired.
    fn advance(
        &mut self,
        target: u64,
        changes: &mut Changes<G::Change>,
        go_on: &mut dyn FnMut() -> bool,
    ) -> u64;

    /// Logs `events` at `time` (the current time) as one batch, all or
    /// none, and applies them.
    fn commit(
        &mut self,
        time: u64,
        events: Vec<EventOf<G>>,
        changes: &mut Changes<G::Change>,
    ) -> Result<(), RecordError>;

    /// The determinism hash of the whole state: live play and a replay of
    /// the same log reach the same one.
    fn state_hash(&self) -> u64;

    /// Marks the clock at `time` in the log, so a restart resumes there;
    /// with `wait`, until it is durable (the loop is stopping). An error
    /// fails the store. The default marks nothing.
    fn mark(&mut self, time: u64, wait: bool) -> Result<(), String> {
        let _ = (time, wait);
        Ok(())
    }

    /// A store failure noticed since the last call (a mark or write on an
    /// I/O thread, a write a hook made): the loop pauses and reports it.
    /// The default has none.
    fn take_error(&mut self) -> Option<String> {
        None
    }
}
