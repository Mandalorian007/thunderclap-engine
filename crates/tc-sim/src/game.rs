//! The [`Game`] trait: what a game gives the loop.
//!
//! **The model.** A game's state changes only by *events*, which go
//! through the game's tc-store [`LogCodec`] into the log, and by its own
//! *scheduled* events and *steps*, which follow from the state and are
//! never logged. Live play and a replay of the log run the same code
//! ([`Game::apply`], [`Game::fire`], [`Game::step`]) at the same times, so
//! they reach the same state, and [`Core::state_hash`](crate::Core::state_hash)
//! says so.
//!
//! What clients send never changes the state directly. A command
//! ([`Game::command`]), an input ([`Game::input`]), a game message
//! ([`Game::message`]), a join ([`Game::join`]) and presence
//! ([`Game::presence`]) read the state (`&self`) and push the events that
//! carry out what they decided; the loop logs those events at the current
//! time and applies them, in order.
//!
//! **Determinism is a hard rule.** Time is a count of fixed steps (`u64`,
//! at most [`MAX_TIME`](crate::MAX_TIME)); the state is integers or fixed
//! point, never floats that differ between machines; every collection the
//! state walks is ordered (`BTreeMap`, `Vec`, never a `HashMap`); and
//! nothing reads the wall clock, a random source not seeded from the
//! state, or anything else outside the state and the event.

use std::fmt::Debug;
use std::sync::Arc;

use tc_net::{Identity, Protocol, ServerMsg};
use tc_store::LogCodec;
use tc_wire::hash::StableHasher;

use crate::changes::Changes;
use crate::scheduler::{EventKey, Scheduler};

/// A player, as `Welcome.player` names it: the game's own id.
pub type PlayerId = u64;

/// The events a game's [`Game::Codec`] logs.
pub type EventOf<G> = <<G as Game>::Codec as LogCodec>::Event;

/// A game the loop runs. See the [module docs](self).
pub trait Game: Sized + Send + 'static {
    /// The game's roles on the wire (tc-net).
    type Protocol: Protocol;
    /// How its events go into the log (tc-store). The events must be
    /// `Clone` (a reload keeps the ones written while it runs) and
    /// `Debug`.
    type Codec: LogCodec<Event: Clone + Debug> + Clone;
    /// What it schedules for later: hashed by its wire bytes, so two
    /// equal states hash the same.
    type Scheduled: tc_wire::Wire + Clone + Debug + Send + 'static;
    /// What it marks as changed ([`crate::Changes`]).
    type Change: Ord + Clone + Debug + Send + 'static;
    /// The data it is built from and can reload while running (its
    /// content: rules, tables, tuning).
    type Data: Send + Sync + 'static;

    /// Its codec, for the log.
    fn codec(&self) -> Self::Codec;

    /// Applies a logged event at the current time (`cx.time()`), live or
    /// in a replay. An error means the event doesn't apply to this state
    /// (a log written under other data): live play logs a warning, a
    /// replay skips it and counts it.
    fn apply(&mut self, event: &EventOf<Self>, cx: &mut Cx<'_, Self>) -> Result<(), String>;

    /// A scheduled event fires (`cx.time()` is its time). The default
    /// does nothing.
    fn fire(&mut self, event: Self::Scheduled, cx: &mut Cx<'_, Self>) {
        let _ = (event, cx);
    }

    /// True if the game runs [`Game::step`] every step. A game that only
    /// reacts to events and its schedule leaves it false, and time jumps
    /// straight to the next scheduled event.
    fn steps(&self) -> bool {
        false
    }

    /// One step of the game's own (`cx.time()` is the step's time, after
    /// the events scheduled for it fired). Only called if
    /// [`Game::steps`].
    fn step(&mut self, cx: &mut Cx<'_, Self>) {
        let _ = cx;
    }

    /// Feeds the whole state into `h`, in a canonical order: everything
    /// that affects the future and nothing that doesn't (no counters, no
    /// caches). The loop adds the time, the version and the schedule.
    fn hash_state(&self, h: &mut StableHasher);

    /// A connection passed `Hello` as `identity`: who it plays as, and
    /// the events that record a first join (none for a returning player).
    /// An error refuses it (`Rejected`).
    fn join(
        &self,
        identity: &Identity,
        hello: &<Self::Protocol as Protocol>::Hello,
        events: &mut Vec<EventOf<Self>>,
    ) -> Result<PlayerId, String>;

    /// `Welcome.ext` for `player`.
    fn welcome(&self, player: PlayerId) -> <Self::Protocol as Protocol>::Welcome;

    /// What a connection is sent right after its `Welcome` (the state it
    /// starts from). The default sends nothing.
    fn greet(&self, player: PlayerId, out: &mut Vec<ServerMsg<Self::Protocol>>) {
        let _ = (player, out);
    }

    /// `player`'s first connection opened (`present`) or its last one
    /// closed; the events record it if the game keeps presence. The
    /// default records nothing.
    fn presence(&self, player: PlayerId, present: bool, events: &mut Vec<EventOf<Self>>) {
        let _ = (player, present, events);
    }

    /// A command from `player`: its result, and the events that carry it
    /// out.
    fn command(
        &self,
        player: PlayerId,
        command: <Self::Protocol as Protocol>::Command,
        events: &mut Vec<EventOf<Self>>,
    ) -> <Self::Protocol as Protocol>::Result;

    /// An input from `player`'s driving connection, taken off its queue
    /// at an input tick ([`crate::InputQueue`]): the events it makes. The
    /// default ignores inputs.
    fn input(
        &self,
        player: PlayerId,
        input: <Self::Protocol as Protocol>::Input,
        events: &mut Vec<EventOf<Self>>,
    ) {
        let _ = (player, input, events);
    }

    /// What `player`'s connections are told after an input tick applied
    /// its inputs (`PlayerState`), if anything.
    fn player_state(&self, player: PlayerId) -> Option<<Self::Protocol as Protocol>::State> {
        let _ = player;
        None
    }

    /// A game message from `player` (`ClientMsg::Game`): the events it
    /// makes, and anything to send. The default ignores it.
    fn message(
        &self,
        player: PlayerId,
        msg: <Self::Protocol as Protocol>::Client,
        events: &mut Vec<EventOf<Self>>,
        out: &mut Outbox<Self::Protocol>,
    ) {
        let _ = (player, msg, events, out);
    }

    /// What changed since the last flush (never empty): sends what the
    /// changes touch. Called at most every
    /// [`FLUSH_INTERVAL`](crate::FLUSH_INTERVAL), and after each command
    /// before its result (read-your-writes). The default sends nothing.
    fn flush(&self, changes: &Changes<Self::Change>, out: &mut Outbox<Self::Protocol>) {
        let _ = (changes, out);
    }

    /// A new game, at its start, built from `data`: what a reload
    /// replays the log into. Called on the loop's thread; the replay runs
    /// on another.
    fn reload(&self, data: Arc<Self::Data>) -> Result<Self, String>;

    /// The new game was swapped in by a reload: the players present (in
    /// order) are still connected. The default does nothing.
    fn reloaded(&self, present: &[PlayerId], out: &mut Outbox<Self::Protocol>) {
        let _ = (present, out);
    }
}

/// What a game's apply, fire and step may touch besides its state: the
/// time, its schedule and its change marks.
pub struct Cx<'a, G: Game> {
    pub(crate) time: u64,
    pub(crate) scheduler: &'a mut Scheduler<G::Scheduled>,
    pub(crate) changes: &'a mut Changes<G::Change>,
}

impl<G: Game> Cx<'_, G> {
    /// The current time, in steps.
    pub fn time(&self) -> u64 {
        self.time
    }

    /// Schedules `event` at `time`, or at the next step if `time` isn't
    /// after now (so firing never loops within a step). Returns its key,
    /// for [`Cx::cancel`].
    pub fn schedule(&mut self, time: u64, event: G::Scheduled) -> EventKey {
        let time = time.max(self.time.saturating_add(1));
        self.scheduler.schedule(time, event)
    }

    /// Cancels a scheduled event, returning it if it was pending.
    pub fn cancel(&mut self, key: EventKey) -> Option<G::Scheduled> {
        self.scheduler.cancel(key)
    }

    /// The pending schedule, in firing order.
    pub fn scheduled(&self) -> impl Iterator<Item = (&EventKey, &G::Scheduled)> {
        self.scheduler.iter()
    }

    /// Marks `key` as changed (ignored in a replay).
    pub fn mark(&mut self, key: G::Change) {
        self.changes.mark(key);
    }
}

/// Where a connection's messages go.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum To {
    /// Every connection of a player.
    Player(PlayerId),
    /// One connection.
    Conn(tc_net::ConnId),
    /// Every connection.
    All,
}

/// Messages a game hands the loop to send, in order.
#[derive(Debug)]
pub struct Outbox<P: Protocol> {
    pub(crate) msgs: Vec<(To, ServerMsg<P>)>,
}

impl<P: Protocol> Default for Outbox<P> {
    fn default() -> Self {
        Outbox { msgs: Vec::new() }
    }
}

impl<P: Protocol> Outbox<P> {
    /// An empty outbox.
    pub fn new() -> Outbox<P> {
        Outbox::default()
    }

    /// Sends `msg` to `to`.
    pub fn send(&mut self, to: To, msg: ServerMsg<P>) {
        self.msgs.push((to, msg));
    }

    /// Sends a game message (`ServerMsg::Game`) to `to`.
    pub fn game(&mut self, to: To, msg: P::Server) {
        self.send(to, ServerMsg::Game(msg));
    }

    /// True if nothing is waiting.
    pub fn is_empty(&self) -> bool {
        self.msgs.is_empty()
    }

    /// The messages, in order.
    pub fn messages(&self) -> &[(To, ServerMsg<P>)] {
        &self.msgs
    }
}
