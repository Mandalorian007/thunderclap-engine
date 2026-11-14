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
//! **Bodies.** What a player moves many times a second (where it stands,
//! where it looks) is its *body* ([`Game::Body`]), kept by the loop
//! outside the state and never logged: inputs change it
//! ([`Game::input`]), queries and the entity stream read it
//! ([`QueryCtx::body`]), and it is not in the state hash. A body starts
//! from the state when a player arrives ([`Game::body`]) and is handed to
//! [`Game::presence`] when it leaves, so a game logs what of it should
//! last (a position to come back to). A reload keeps it.
//!
//! **Rules that read bodies.** A rule between players' bodies (a tag, a
//! collision, a pickup) runs in [`Game::moved`], after each input tick:
//! it reads every present body ([`Bodies`]) and pushes the events that
//! record what happened (a tag), which are logged and applied like any
//! other. So the movement itself stays unlogged and a replay still
//! reaches the same state, because it replays the events, not the bodies.
//! [`Cx`] (apply, fire, step) never sees bodies: a replay has none.
//!
//! **What clients see.** Live queries ([`Game::queries`], see
//! [`crate::Query`]) and the entity stream ([`Game::entities`], for a
//! connection's interest, [`Game::interest`]) read the state and bodies
//! through a [`QueryCtx`], which records what they read; the loop reruns
//! them only when a change mark ([`Cx::mark`]) or a body they read
//! changed.
//!
//! **Observers.** A join may seat an observer ([`Seat::Observer`]): it
//! is welcomed as player 0, is never present, has no body and sends no
//! commands, inputs or game messages; it subscribes to queries that
//! aren't per player and watches the entity stream.
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
use tc_wire::Wire;
use tc_wire::hash::StableHasher;
use tc_wire::schema::Schema;

use crate::changes::Changes;
use crate::lanes::Lane;
use crate::query::{Query, QueryCtx};
use crate::scheduler::{EventKey, Scheduler};

/// A player, as `Welcome.player` names it: the game's own id.
pub type PlayerId = u64;

/// The events a game's [`Game::Codec`] logs.
pub type EventOf<G> = <<G as Game>::Codec as LogCodec>::Event;

/// Who a connection joins as ([`Game::join`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seat {
    /// A player (never 0).
    Player(PlayerId),
    /// An observer: watches, never acts (see the [crate docs](crate)).
    Observer,
}

/// The interest a game's protocol carries.
pub type InterestOf<G> = <<G as Game>::Protocol as Protocol>::Interest;

/// A game the loop runs. See the [crate docs](crate).
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
    /// A present player's unlogged state, moved by its inputs (see the
    /// [crate docs](crate)); `()` for a game without.
    type Body: Clone + Send + 'static;
    /// One thing in the entity stream, as a client sees it: a struct of
    /// the game's schema ([`tc_net::EntityEncoder`]); `tc_net::Empty` for
    /// a game without one.
    type View: Wire + Send + 'static;

    /// Its schema: [`schema_of`](crate::schema_of) (the envelope, the
    /// view and the queries) unless the game adds to it. Queries diff
    /// against it and the entity stream encodes with it.
    fn schema() -> Schema {
        crate::query::schema_of::<Self>(|_| {})
    }

    /// The live queries it serves. The default serves none.
    fn queries() -> Vec<Query<Self>> {
        Vec::new()
    }

    /// Its rate lanes, indexed by [`Game::lane`] (see [`crate::Lane`]).
    /// The default has none.
    fn lanes() -> Vec<Lane> {
        Vec::new()
    }

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

    /// The state as bytes for a base: everything [`Game::hash_state`]
    /// covers, so [`Game::restore`] rebuilds the same hash. A game that
    /// returns some keeps bases: its loop writes one every
    /// [`SimConfig::base_every`](crate::SimConfig::base_every) entries and
    /// archives the log behind it, so its store stays bounded. `None` (the
    /// default) keeps none, and opening replays the whole log.
    fn save(&self) -> Option<Vec<u8>> {
        None
    }

    /// Sets the state of a new game, at its start (as built for
    /// [`Sim::open`](crate::Sim::open) or a reload), from [`Game::save`]'s
    /// bytes. The loop then applies the log after the base.
    fn restore(&mut self, bytes: &[u8]) -> Result<(), String> {
        let _ = bytes;
        Err("this game keeps no bases".into())
    }

    /// A connection passed `Hello` as `identity`: who it plays as (or
    /// that it observes), and the events that record a first join (none
    /// for a returning player). An error refuses it (`Rejected`).
    ///
    /// **Seat ids.** A new player's id is the one its join events will
    /// give it when applied (the loop applies them before anything else
    /// sees the player, then calls [`Game::body`] and
    /// [`Game::presence`]). Derive it from the state the events change,
    /// such as the next free seat, never from a counter outside the
    /// state: then it is the same in every replay and after a rollback,
    /// and a returning name maps to its old id.
    fn join(
        &self,
        identity: &Identity,
        hello: &<Self::Protocol as Protocol>::Hello,
        events: &mut Vec<EventOf<Self>>,
    ) -> Result<Seat, String>;

    /// The store was opened and its log replayed (`time` is now), before
    /// any connection: the events that tidy what the last run left. A
    /// run that crashed never recorded its players leaving
    /// ([`Game::presence`]), so a game that keeps who is here pushes
    /// their leaving now. The events are logged, so a later replay passes
    /// through them too. [`Sim::open`](crate::Sim::open) calls it (and
    /// so does the thunderclap-server facade); the default pushes none.
    fn on_open(&self, time: u64, events: &mut Vec<EventOf<Self>>) {
        let _ = (time, events);
    }

    /// `Welcome.ext` for `player` (0 for an observer).
    fn welcome(&self, player: PlayerId) -> <Self::Protocol as Protocol>::Welcome;

    /// `player`'s body as it arrives (its first connection opened), from
    /// the state, with its join events already applied; `None` takes no
    /// inputs. The default has none.
    fn body(&self, player: PlayerId) -> Option<Self::Body> {
        let _ = player;
        None
    }

    /// What a connection is sent right after its `Welcome` (the state it
    /// starts from). The default sends nothing.
    fn greet(&self, player: PlayerId, out: &mut Vec<ServerMsg<Self::Protocol>>) {
        let _ = (player, out);
    }

    /// `player`'s first connection opened (`present`, with its new body)
    /// or its last one closed (with the body it leaves); the events record
    /// what should last. The default records nothing.
    fn presence(
        &self,
        player: PlayerId,
        present: bool,
        body: Option<&Self::Body>,
        events: &mut Vec<EventOf<Self>>,
    ) {
        let _ = (player, present, body, events);
    }

    /// A command from `player`: its result, and the events that carry it
    /// out.
    fn command(
        &self,
        player: PlayerId,
        command: <Self::Protocol as Protocol>::Command,
        events: &mut Vec<EventOf<Self>>,
    ) -> <Self::Protocol as Protocol>::Result;

    /// The result a command gets when its events weren't applied: the log
    /// couldn't encode one (a game bug), or the store can't save. `reason`
    /// says which.
    fn command_error(&self, reason: String) -> <Self::Protocol as Protocol>::Result;

    /// An input from `player`'s driving connection, taken off its queue
    /// at an input tick ([`crate::InputQueue`]): it moves `body`, unlogged,
    /// and may push events (a rare one worth keeping). Only a player with
    /// a body takes inputs. The default ignores them.
    fn input(
        &self,
        player: PlayerId,
        body: &mut Self::Body,
        input: <Self::Protocol as Protocol>::Input,
        events: &mut Vec<EventOf<Self>>,
    ) {
        let _ = (player, body, input, events);
    }

    /// After an input tick moved bodies: the rules that read them (see
    /// the [crate docs](crate)). `bodies` holds every present player's
    /// body and which of them this tick moved; the events pushed are
    /// logged and applied at the current time. The default does nothing.
    fn moved(&self, bodies: &Bodies<'_, Self>, events: &mut Vec<EventOf<Self>>) {
        let _ = (bodies, events);
    }

    /// What `player`'s connections are told after an input tick applied
    /// its inputs (`PlayerState`), if anything.
    fn player_state(
        &self,
        player: PlayerId,
        body: &Self::Body,
    ) -> Option<<Self::Protocol as Protocol>::State> {
        let _ = (player, body);
        None
    }

    /// The rate lane `msg` goes in ([`Game::lanes`]), if any: over its
    /// budget it is dropped before [`Game::message`]. The default puts
    /// none in a lane.
    fn lane(&self, msg: &<Self::Protocol as Protocol>::Client) -> Option<usize> {
        let _ = msg;
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

    /// Whether a connection may watch `interest` (`SetInterest`): `player`
    /// is `None` for an observer. An error is sent as `InterestRejected`
    /// and the connection keeps what it watched. The default allows any.
    fn interest(
        &self,
        player: Option<PlayerId>,
        interest: &InterestOf<Self>,
    ) -> Result<(), String> {
        let _ = (player, interest);
        Ok(())
    }

    /// The entity stream for a connection watching `interest`: each thing
    /// in it once, by id, read through `cx` (which records what it read,
    /// and whose [`QueryCtx::player`] is the watcher). It is sent as the
    /// change from what that connection was last sent, rerun only when
    /// something it read changed. The default shows nothing.
    fn entities(
        &self,
        cx: &QueryCtx<'_, Self>,
        interest: &InterestOf<Self>,
        out: &mut Vec<(u64, Self::View)>,
    ) {
        let _ = (cx, interest, out);
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

/// Every present player's body, read by [`Game::moved`] after an input
/// tick.
pub struct Bodies<'a, G: Game> {
    pub(crate) time: u64,
    pub(crate) bodies: &'a std::collections::BTreeMap<PlayerId, G::Body>,
    pub(crate) moved: &'a [PlayerId],
}

impl<'a, G: Game> Bodies<'a, G> {
    /// The current time, in steps.
    pub fn time(&self) -> u64 {
        self.time
    }

    /// `player`'s body, if it is present.
    pub fn get(&self, player: PlayerId) -> Option<&'a G::Body> {
        self.bodies.get(&player)
    }

    /// Every present body, by player id.
    pub fn iter(&self) -> impl Iterator<Item = (PlayerId, &'a G::Body)> + 'a {
        self.bodies.iter().map(|(p, b)| (*p, b))
    }

    /// The players this tick's inputs moved, in id order, once each.
    pub fn moved(&self) -> &'a [PlayerId] {
        self.moved
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
