//! The envelope: the handshake and transport messages every networked
//! game needs, generic over the game's [`Protocol`]. The same messages, in
//! the same order, as `src/net/envelope.ts`: a game's schema built with
//! [`schema_builder`] has the canonical text and hash `defineSchema` gives
//! the same game types in TypeScript.
//!
//! Variant order is the wire order: append, never reorder. A game with a
//! protocol of its own lays the envelope out its way ([`Envelope`]).

use tc_wire::diff::PatchOp;
use tc_wire::schema::{Field, SchemaBuilder, TypeKind, TypeRef, Variant, VariantFields};

use self::ClientMsg as C;
use self::ServerMsg as S;
use tc_wire::{Bytes, DecodeError, Reader, Wire, Writer};

/// The game's types for each role of the envelope. A role a game doesn't
/// use is [`Empty`] (the TypeScript `defineSchema` leaves it out).
pub trait Protocol: std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static {
    /// Extra fields of `Hello` (`ext`).
    type Hello: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;
    /// Extra fields of `Welcome` (`ext`).
    type Welcome: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;
    /// What a client's `Command` carries.
    type Command: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;
    /// What a `CommandResult` carries back.
    type Result: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;
    /// The interest shape `SetInterest` carries.
    type Interest: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;
    /// One predicted input (`Input`).
    type Input: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;
    /// The authoritative predicted state (`PlayerState`).
    type State: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;
    /// The game's own client messages (`ClientMsg::Game`).
    type Client: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;
    /// The game's own server messages (`ServerMsg::Game`).
    type Server: Wire + std::fmt::Debug + Clone + PartialEq + Send + Sync + 'static;

    /// True for a command that has its own, looser rate limit
    /// ([`crate::rate::Rates::bulk_commands`]): a tool's or a bot's batch
    /// work. None by default.
    fn bulk_command(_command: &Self::Command) -> bool {
        false
    }

    /// How the envelope is laid out on the wire: the engine's
    /// ([`Envelope::ENGINE`]) unless the game has a protocol of its own.
    const ENVELOPE: &'static Envelope = &Envelope::ENGINE;
}

/// The empty value: what a role a game doesn't use carries. No bytes on
/// the wire; the schema's `struct Empty {  }`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Empty;

impl Wire for Empty {
    fn encode(&self, _: &mut Writer) {}
    fn decode(_: &mut Reader<'_>) -> Result<Self, DecodeError> {
        Ok(Empty)
    }
    fn describe(s: &mut SchemaBuilder) -> TypeRef {
        s.define("Empty", "tc_net::Empty", "", |_| {
            TypeKind::Struct(Vec::new())
        })
    }
}

/// What a client resuming a live query holds: the version and the hash of
/// its result. A server that still has that version may send only a patch.
#[derive(Wire, Debug, Clone, PartialEq, Eq)]
pub struct Resume {
    /// The version held.
    pub version: u64,
    /// The hash of the result held (`tc_wire::diff::hash_hex`).
    pub hash: String,
}

/// Close codes. The client closes for good on 4000 to 4999 (the game's
/// own: kicked, banned, revoked); any other code (a restart's 1001 or
/// 1012) makes it reconnect.
pub mod close {
    /// The server is going away (a restart): the client reconnects.
    pub const GOING_AWAY: u16 = 1001;
    /// The server is restarting: the client reconnects.
    pub const RESTART: u16 = 1012;
    /// The first final code. Codes from here to [`FINAL_END`] close the
    /// client for good.
    pub const FINAL: u16 = 4000;
    /// One past the last final code.
    pub const FINAL_END: u16 = 5000;
    /// The link a session joined with is no longer good (E2b's auth).
    pub const REVOKED: u16 = 4001;

    /// True if `code` closes the client for good.
    pub const fn is_final(code: u16) -> bool {
        code >= FINAL && code < FINAL_END
    }
}

/// `Bulk` codecs: how a `Bulk`'s data is coded. `Hello.bulk` names the
/// best one a client takes; the server sends that or [`NONE`](codec::NONE).
pub mod codec {
    /// The frames as they are.
    pub const NONE: u8 = 0;
    /// Raw deflate (RFC 1951) of the frames.
    pub const DEFLATE: u8 = 1;
}

/// A `ClientMsg` variant's place in an [`Envelope`]: the variant's tag on
/// the wire is its slot's position in [`Envelope::client`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClientSlot {
    /// [`ClientMsg::Hello`].
    Hello,
    /// [`ClientMsg::Command`].
    Command,
    /// [`ClientMsg::Subscribe`].
    Subscribe,
    /// [`ClientMsg::Unsubscribe`].
    Unsubscribe,
    /// [`ClientMsg::Ping`].
    Ping,
    /// [`ClientMsg::SetInterest`].
    SetInterest,
    /// [`ClientMsg::Input`].
    Input,
    /// [`ClientMsg::TakeControl`].
    TakeControl,
    /// [`ClientMsg::EntityResync`].
    EntityResync,
    /// [`ClientMsg::Ack`].
    Ack,
    /// [`ClientMsg::Game`]: the game's messages wrapped in one variant.
    Game,
    /// One of the game's own messages as a variant of its own (in place of
    /// `Game`; [`Protocol::Client`] is then an enum): the n-th `Inline`
    /// slot is the game enum's variant n, under its own name and fields.
    Inline,
}

impl ClientSlot {
    /// The slot `msg` goes in (`Game` for a game message).
    pub fn of<P: Protocol>(msg: &ClientMsg<P>) -> ClientSlot {
        match msg {
            C::Hello { .. } => ClientSlot::Hello,
            C::Command { .. } => ClientSlot::Command,
            C::Subscribe { .. } => ClientSlot::Subscribe,
            C::Unsubscribe { .. } => ClientSlot::Unsubscribe,
            C::Ping { .. } => ClientSlot::Ping,
            C::SetInterest { .. } => ClientSlot::SetInterest,
            C::Input { .. } => ClientSlot::Input,
            C::TakeControl => ClientSlot::TakeControl,
            C::EntityResync => ClientSlot::EntityResync,
            C::Ack { .. } => ClientSlot::Ack,
            C::Game(_) => ClientSlot::Game,
        }
    }
}

/// A `ServerMsg` variant's place in an [`Envelope`], as [`ClientSlot`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ServerSlot {
    /// [`ServerMsg::Welcome`].
    Welcome,
    /// [`ServerMsg::Rejected`].
    Rejected,
    /// [`ServerMsg::CommandResult`].
    CommandResult,
    /// [`ServerMsg::Update`].
    Update,
    /// [`ServerMsg::Resync`].
    Resync,
    /// [`ServerMsg::QueryFailed`].
    QueryFailed,
    /// [`ServerMsg::Clock`].
    Clock,
    /// [`ServerMsg::Pong`].
    Pong,
    /// [`ServerMsg::InterestRejected`].
    InterestRejected,
    /// [`ServerMsg::EntityStream`].
    EntityStream,
    /// [`ServerMsg::PlayerState`].
    PlayerState,
    /// [`ServerMsg::Control`].
    Control,
    /// [`ServerMsg::Closed`].
    Closed,
    /// [`ServerMsg::Bulk`].
    Bulk,
    /// [`ServerMsg::Game`]: the game's messages wrapped in one variant.
    Game,
    /// One of the game's own messages as a variant of its own, as
    /// [`ClientSlot::Inline`] ([`Protocol::Server`] is then an enum).
    Inline,
}

impl ServerSlot {
    /// The slot `msg` goes in (`Game` for a game message).
    pub fn of<P: Protocol>(msg: &ServerMsg<P>) -> ServerSlot {
        match msg {
            S::Welcome { .. } => ServerSlot::Welcome,
            S::Rejected { .. } => ServerSlot::Rejected,
            S::CommandResult { .. } => ServerSlot::CommandResult,
            S::Update { .. } => ServerSlot::Update,
            S::Resync { .. } => ServerSlot::Resync,
            S::QueryFailed { .. } => ServerSlot::QueryFailed,
            S::Clock { .. } => ServerSlot::Clock,
            S::Pong { .. } => ServerSlot::Pong,
            S::InterestRejected { .. } => ServerSlot::InterestRejected,
            S::EntityStream { .. } => ServerSlot::EntityStream,
            S::PlayerState { .. } => ServerSlot::PlayerState,
            S::Control { .. } => ServerSlot::Control,
            S::Closed { .. } => ServerSlot::Closed,
            S::Bulk { .. } => ServerSlot::Bulk,
            S::Game(_) => ServerSlot::Game,
        }
    }
}

/// A field of `Hello`, in an [`Envelope`]'s order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HelloField {
    /// `token` (required).
    Token,
    /// `schema_hash` (required).
    SchemaHash,
    /// `bulk`; left out, the client has no bulk lane (read as `None`).
    Bulk,
    /// `ext`, the game's fields (required).
    Ext,
}

/// A field of `Welcome`, in an [`Envelope`]'s order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WelcomeField {
    /// `player` (required).
    Player,
    /// `time` (required).
    Time,
    /// `paused` (required).
    Paused,
    /// `step_us`; left out, read as 0.
    StepUs,
    /// `ext`, the game's fields (required).
    Ext,
}

/// What a client's `Ack` counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AckMode {
    /// One `Bulk`'s data bytes (`Ack { bytes }`): the engine's.
    Each,
    /// Every `Bulk`'s data bytes taken since `Hello`, cumulative
    /// (`Ack { total }`; [`ClientMsg::Ack`]'s `bytes` holds the total).
    Total,
}

impl AckMode {
    /// The `Ack` field's name on the wire.
    pub const fn field(self) -> &'static str {
        match self {
            AckMode::Each => "bytes",
            AckMode::Total => "total",
        }
    }
}

/// `Closed`'s code as a game enum of unit variants: variant `i` stands for
/// close code `codes[i]` ([`close`]: 4000 to 4999 final).
#[derive(Debug, Clone, Copy)]
pub struct CloseCodes {
    /// Describes the enum (`<GameClose as Wire>::describe`).
    pub describe: fn(&mut SchemaBuilder) -> TypeRef,
    /// The close code of each variant, in order.
    pub codes: &'static [u16],
}

impl CloseCodes {
    /// The variant sent for `code`: its own, else the first of the same
    /// kind (final or not), else the first.
    pub fn index(&self, code: u16) -> u64 {
        let at = self.codes.iter().position(|&c| c == code).or_else(|| {
            let fin = close::is_final(code);
            self.codes.iter().position(|&c| close::is_final(c) == fin)
        });
        at.unwrap_or(0) as u64
    }

    /// Describes the enum into `s`, checking it is one of unit variants,
    /// one for each code.
    fn describe_in(&self, s: &mut SchemaBuilder) -> TypeRef {
        let ty = (self.describe)(s);
        let ok = match &ty {
            TypeRef::Named(name) => match s.defined(name).map(|d| &d.kind) {
                Some(TypeKind::Enum(v)) => {
                    v.len() == self.codes.len() && v.iter().all(|v| v.fields == VariantFields::Unit)
                }
                _ => false,
            },
            _ => false,
        };
        assert!(
            ok,
            "envelope close: `{ty}` must be an enum of unit variants, one for each of {} codes",
            self.codes.len()
        );
        ty
    }
}

/// How a protocol lays the envelope out on the wire ([`Protocol::ENVELOPE`]),
/// for a game with a protocol of its own: which messages, at which tags,
/// with which `Hello` and `Welcome` fields in which order, what an `Ack`
/// counts, and `Closed`'s code. [`Envelope::ENGINE`] is the engine's own
/// wire. The same layout as `src/net/envelope.ts`'s `EnvelopeSpec`; the
/// schema's text and hash follow it.
///
/// An engine message not in the layout is not on the wire: encoding one
/// gives no bytes (a session drops the empty frame).
#[derive(Debug, Clone, Copy)]
pub struct Envelope {
    /// `ClientMsg`'s slots in wire order: `Hello` and `Ping` required.
    pub client: &'static [ClientSlot],
    /// `ServerMsg`'s slots in wire order: `Welcome`, `Rejected`, `Pong`
    /// and `Closed` required; `Bulk`'s tag under 128.
    pub server: &'static [ServerSlot],
    /// `Hello`'s fields in wire order.
    pub hello: &'static [HelloField],
    /// `Welcome`'s fields in wire order.
    pub welcome: &'static [WelcomeField],
    /// What an `Ack` counts.
    pub ack: AckMode,
    /// `Closed`'s code as a game enum; `None`, a `u16`.
    pub close: Option<CloseCodes>,
}

impl Envelope {
    /// The engine's wire.
    pub const ENGINE: Envelope = Envelope {
        client: &[
            ClientSlot::Hello,
            ClientSlot::Command,
            ClientSlot::Subscribe,
            ClientSlot::Unsubscribe,
            ClientSlot::Ping,
            ClientSlot::SetInterest,
            ClientSlot::Input,
            ClientSlot::TakeControl,
            ClientSlot::EntityResync,
            ClientSlot::Ack,
            ClientSlot::Game,
        ],
        server: &[
            ServerSlot::Welcome,
            ServerSlot::Rejected,
            ServerSlot::CommandResult,
            ServerSlot::Update,
            ServerSlot::Resync,
            ServerSlot::QueryFailed,
            ServerSlot::Clock,
            ServerSlot::Pong,
            ServerSlot::InterestRejected,
            ServerSlot::EntityStream,
            ServerSlot::PlayerState,
            ServerSlot::Control,
            ServerSlot::Closed,
            ServerSlot::Bulk,
            ServerSlot::Game,
        ],
        hello: &[
            HelloField::Token,
            HelloField::SchemaHash,
            HelloField::Bulk,
            HelloField::Ext,
        ],
        welcome: &[
            WelcomeField::Player,
            WelcomeField::Time,
            WelcomeField::Paused,
            WelcomeField::StepUs,
            WelcomeField::Ext,
        ],
        ack: AckMode::Each,
        close: None,
    };

    /// `slot`'s tag, if it is on the wire.
    pub fn client_tag(&self, slot: ClientSlot) -> Option<u64> {
        self.client
            .iter()
            .position(|&s| s == slot)
            .map(|i| i as u64)
    }

    /// `slot`'s tag, if it is on the wire.
    pub fn server_tag(&self, slot: ServerSlot) -> Option<u64> {
        self.server
            .iter()
            .position(|&s| s == slot)
            .map(|i| i as u64)
    }

    /// `Bulk`'s tag, if it is on the wire (the first byte of its head).
    pub fn bulk_tag(&self) -> Option<u8> {
        self.server_tag(ServerSlot::Bulk).map(|t| t as u8)
    }

    /// True if `Hello` carries `bulk` and `ServerMsg` has `Bulk`: clients
    /// may ask for the bulk lane.
    pub fn has_bulk(&self) -> bool {
        self.hello.contains(&HelloField::Bulk) && self.bulk_tag().is_some()
    }

    /// True if this is [`Envelope::ENGINE`].
    pub fn is_engine(&self) -> bool {
        let e = &Envelope::ENGINE;
        self.client == e.client
            && self.server == e.server
            && self.hello == e.hello
            && self.welcome == e.welcome
            && self.ack == e.ack
            && self.close.is_none()
    }

    fn client_inline(&self) -> bool {
        self.client.contains(&ClientSlot::Inline)
    }

    fn server_inline(&self) -> bool {
        self.server.contains(&ServerSlot::Inline)
    }

    fn client_inline_tag(&self, n: u64) -> Option<u64> {
        nth(self.client, ClientSlot::Inline, n)
    }

    fn server_inline_tag(&self, n: u64) -> Option<u64> {
        nth(self.server, ServerSlot::Inline, n)
    }

    /// The game variant of the inline slot at `tag`.
    fn inline_index<T: PartialEq>(&self, slots: &[T], tag: usize, inline: T) -> u64 {
        slots[..tag].iter().filter(|&s| *s == inline).count() as u64
    }

    fn count<T: PartialEq>(&self, slots: &[T], slot: T) -> usize {
        slots.iter().filter(|&s| *s == slot).count()
    }

    /// Panics, saying why, if the layout is not one a session can follow.
    fn check(&self) {
        let fail = |why: String| panic!("invalid tc_net::Envelope: {why}");
        for (i, slot) in self.client.iter().enumerate() {
            if *slot != ClientSlot::Inline && self.client[..i].contains(slot) {
                fail(format!("ClientMsg lists {slot:?} twice"));
            }
        }
        for (i, slot) in self.server.iter().enumerate() {
            if *slot != ServerSlot::Inline && self.server[..i].contains(slot) {
                fail(format!("ServerMsg lists {slot:?} twice"));
            }
        }
        for slot in [ClientSlot::Hello, ClientSlot::Ping] {
            if !self.client.contains(&slot) {
                fail(format!("ClientMsg needs {slot:?}"));
            }
        }
        for slot in [
            ServerSlot::Welcome,
            ServerSlot::Rejected,
            ServerSlot::Pong,
            ServerSlot::Closed,
        ] {
            if !self.server.contains(&slot) {
                fail(format!("ServerMsg needs {slot:?}"));
            }
        }
        if self.client_inline() && self.client.contains(&ClientSlot::Game) {
            fail("ClientMsg has both Game and Inline slots".into());
        }
        if self.server_inline() && self.server.contains(&ServerSlot::Game) {
            fail("ServerMsg has both Game and Inline slots".into());
        }
        if self.bulk_tag().is_some_and(|t| t >= 128) {
            fail("Bulk's tag must be under 128".into());
        }
        let hello = |f: HelloField| self.hello.iter().filter(|&&g| g == f).count();
        for f in [HelloField::Token, HelloField::SchemaHash, HelloField::Ext] {
            if hello(f) != 1 {
                fail(format!("Hello needs {f:?} once"));
            }
        }
        if hello(HelloField::Bulk) > 1 {
            fail("Hello lists Bulk twice".into());
        }
        let welcome = |f: WelcomeField| self.welcome.iter().filter(|&&g| g == f).count();
        for f in [
            WelcomeField::Player,
            WelcomeField::Time,
            WelcomeField::Paused,
            WelcomeField::Ext,
        ] {
            if welcome(f) != 1 {
                fail(format!("Welcome needs {f:?} once"));
            }
        }
        if welcome(WelcomeField::StepUs) > 1 {
            fail("Welcome lists StepUs twice".into());
        }
    }
}

/// The position of the `n`-th `slot` in `slots`.
fn nth<T: PartialEq + Copy>(slots: &[T], slot: T, n: u64) -> Option<u64> {
    slots
        .iter()
        .enumerate()
        .filter(|(_, s)| **s == slot)
        .nth(n as usize)
        .map(|(i, _)| i as u64)
}

/// A message from a client. See `src/net/envelope.ts`.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientMsg<P: Protocol> {
    /// The handshake: the first message, and only once.
    Hello {
        /// The client's token (checked by [`crate::Auth`]).
        token: String,
        /// The client's schema hash; the server refuses another.
        schema_hash: String,
        /// The best `Bulk` codec the client takes ([`codec`]); `None`
        /// for no bulk lane.
        bulk: Option<u8>,
        /// The game's fields.
        ext: P::Hello,
    },
    /// A game command; answered by a `CommandResult` with its `seq`.
    Command {
        /// Numbers the command for its result.
        seq: u32,
        /// The command.
        command: P::Command,
    },
    /// Starts live query `query` as subscription `sub`.
    Subscribe {
        /// The subscription's id, the client's choice.
        sub: u32,
        /// The query's wire name.
        query: String,
        /// The encoded arguments.
        args: Bytes,
        /// What the client still holds of it, after a reconnect.
        resume: Option<Resume>,
    },
    /// Stops subscription `sub`.
    Unsubscribe {
        /// The subscription.
        sub: u32,
    },
    /// Liveness and latency: answered by `Pong`.
    Ping {
        /// The client's time, echoed.
        client_time: u64,
    },
    /// What the server should stream to this client.
    SetInterest {
        /// The game's interest shape.
        interest: P::Interest,
    },
    /// One predicted input, numbered.
    Input {
        /// Numbers the input; `PlayerState` names the last one applied.
        seq: u32,
        /// The input.
        input: P::Input,
    },
    /// Asks to drive the predicted thing.
    TakeControl,
    /// The entity stream didn't decode: send a key frame.
    EntityResync,
    /// The bulk lane's data taken: the bytes of one `Bulk`'s data.
    Ack {
        /// The `Bulk`'s data length, as written.
        bytes: u64,
    },
    /// A game client message.
    Game(P::Client),
}

/// A message from the server. See `src/net/envelope.ts`.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerMsg<P: Protocol> {
    /// The handshake succeeded.
    Welcome {
        /// The client's player id.
        player: u64,
        /// The server's game time, in steps.
        time: u64,
        /// Whether game time is stopped.
        paused: bool,
        /// One step's length, microseconds.
        step_us: u32,
        /// The game's fields.
        ext: P::Welcome,
    },
    /// The handshake was refused; the connection closes.
    Rejected {
        /// Why.
        reason: String,
        /// The client's schema is not the server's (it should update).
        stale_schema: bool,
    },
    /// A command's result.
    CommandResult {
        /// The command's `seq`.
        seq: u32,
        /// The result.
        result: P::Result,
    },
    /// A live query's result changed: the patch from the version held.
    Update {
        /// The subscription.
        sub: u32,
        /// The new version.
        version: u64,
        /// The hash of the patched result (empty: unchecked).
        hash: String,
        /// The patch.
        patch: Vec<PatchOp>,
    },
    /// A live query's whole result.
    Resync {
        /// The subscription.
        sub: u32,
        /// Its version.
        version: u64,
        /// The result's hash, as in `Update` (empty: unchecked).
        hash: String,
        /// The encoded result.
        result: Bytes,
    },
    /// A live query was refused.
    QueryFailed {
        /// The subscription.
        sub: u32,
        /// Why.
        reason: String,
    },
    /// The game clock.
    Clock {
        /// Game time, in steps.
        time: u64,
        /// Whether it is stopped.
        paused: bool,
    },
    /// The answer to a `Ping`.
    Pong {
        /// The ping's time, echoed.
        client_time: u64,
        /// Game time, in steps.
        time: u64,
        /// Whether it is stopped.
        paused: bool,
    },
    /// An interest shape was refused.
    InterestRejected {
        /// Why.
        reason: String,
    },
    /// One entity-stream frame ([`crate::entity`]).
    EntityStream {
        /// The frame.
        data: Bytes,
    },
    /// The authoritative predicted state after input `seq`.
    PlayerState {
        /// The last input applied.
        seq: u32,
        /// The state.
        state: P::State,
        /// The step the state was taken at, microseconds into it.
        tick_us: u32,
    },
    /// Whether this connection drives the predicted thing.
    Control {
        /// True: it drives.
        driving: bool,
    },
    /// The server closes the connection ([`close`]).
    Closed {
        /// The close code.
        code: u16,
        /// Why.
        reason: String,
    },
    /// Many frames as one message (the bulk lane).
    Bulk {
        /// How the data is coded ([`codec`]).
        codec: u8,
        /// Each frame's length, then the frame, coded.
        data: Bytes,
    },
    /// A game server message.
    Game(P::Server),
}

/// A schema builder rooted at the envelope of `P`: `ClientMsg`, then
/// `ServerMsg`. Add the game's further roots (an entity-stream view) and
/// live queries, then `finish`.
///
/// # Panics
///
/// If `P::ENVELOPE` is not a valid layout ([`Envelope`]).
pub fn schema_builder<P: Protocol>() -> SchemaBuilder {
    let mut b = SchemaBuilder::new();
    b.root::<ClientMsg<P>>();
    b.root::<ServerMsg<P>>();
    b
}

fn field<T: Wire>(s: &mut SchemaBuilder, name: &'static str) -> Field {
    Field::new(name, "", T::describe(s))
}

/// The variants of the game enum `T`, and the builder that described them
/// (their types are adopted from it as the envelope reaches them).
fn game_variants<T: Wire>(what: &str) -> (SchemaBuilder, Vec<Variant>) {
    let mut scratch = SchemaBuilder::new();
    let TypeRef::Named(name) = T::describe(&mut scratch) else {
        panic!("{what}: inline game messages need the game's messages to be an enum");
    };
    let variants = match scratch.defined(name).map(|d| &d.kind) {
        Some(TypeKind::Enum(variants)) => variants.clone(),
        _ => panic!("{what}: inline game messages need `{name}` to be an enum"),
    };
    (scratch, variants)
}

/// Lays the game's variant `v` out in `s`: its types adopted from
/// `scratch`, in the order the envelope reaches them.
fn adopt_variant(s: &mut SchemaBuilder, scratch: &SchemaBuilder, v: &Variant) -> Variant {
    match &v.fields {
        VariantFields::Unit => {}
        VariantFields::Named(fields) => fields.iter().for_each(|f| s.adopt(scratch, &f.ty)),
        VariantFields::Newtype(ty) => s.adopt(scratch, ty),
    }
    v.clone()
}

/// The game enum `T`'s variants for `slots` inline slots, laid into the
/// envelope one by one as it reaches each slot ([`adopt_variant`]).
struct Inline {
    scratch: SchemaBuilder,
    variants: std::vec::IntoIter<Variant>,
}

impl Inline {
    fn of<T: Wire>(what: &str, slots: usize) -> Inline {
        let (scratch, variants) = game_variants::<T>(what);
        assert!(
            variants.len() == slots,
            "{what}: {slots} inline slots for the game's {} messages",
            variants.len()
        );
        Inline {
            scratch,
            variants: variants.into_iter(),
        }
    }

    fn next(&mut self, s: &mut SchemaBuilder) -> Variant {
        let v = self
            .variants
            .next()
            .expect("one variant for each inline slot");
        adopt_variant(s, &self.scratch, &v)
    }
}

/// Encodes the game message `msg` as its inline variant: the game enum's
/// variant index rewritten to its tag. Nothing if it has no slot.
fn encode_inline<T: Wire>(msg: &T, w: &mut Writer, tag: impl Fn(u64) -> Option<u64>) {
    let at = w.len();
    msg.encode(w);
    if w.len() == at {
        return;
    }
    let n = Reader::new(&w.as_bytes()[at..])
        .read_variant()
        .expect("a game enum starts with its variant");
    match tag(n) {
        Some(tag) => {
            w.replace_varint(at, tag);
        }
        None => panic!("game message variant {n} has no inline slot"),
    }
}

fn hello_fields<P: Protocol>(s: &mut SchemaBuilder) -> Vec<Field> {
    P::ENVELOPE
        .hello
        .iter()
        .map(|f| match f {
            HelloField::Token => field::<String>(s, "token"),
            HelloField::SchemaHash => field::<String>(s, "schema_hash"),
            HelloField::Bulk => field::<Option<u8>>(s, "bulk"),
            HelloField::Ext => field::<P::Hello>(s, "ext"),
        })
        .collect()
}

fn welcome_fields<P: Protocol>(s: &mut SchemaBuilder) -> Vec<Field> {
    P::ENVELOPE
        .welcome
        .iter()
        .map(|f| match f {
            WelcomeField::Player => field::<u64>(s, "player"),
            WelcomeField::Time => field::<u64>(s, "time"),
            WelcomeField::Paused => field::<bool>(s, "paused"),
            WelcomeField::StepUs => field::<u32>(s, "step_us"),
            WelcomeField::Ext => field::<P::Welcome>(s, "ext"),
        })
        .collect()
}

impl<P: Protocol> Wire for ClientMsg<P> {
    fn encode(&self, w: &mut Writer) {
        let env = P::ENVELOPE;
        if let C::Game(msg) = self
            && env.client_inline()
        {
            return encode_inline(msg, w, |n| env.client_inline_tag(n));
        }
        let Some(tag) = env.client_tag(ClientSlot::of(self)) else {
            // Not on this protocol's wire: no message (an empty frame,
            // which a session drops).
            return;
        };
        w.write_varint(tag);
        match self {
            C::Hello {
                token,
                schema_hash,
                bulk,
                ext,
            } => {
                for f in env.hello {
                    match f {
                        HelloField::Token => token.encode(w),
                        HelloField::SchemaHash => schema_hash.encode(w),
                        HelloField::Bulk => bulk.encode(w),
                        HelloField::Ext => ext.encode(w),
                    }
                }
            }
            C::Command { seq, command } => {
                seq.encode(w);
                command.encode(w);
            }
            C::Subscribe {
                sub,
                query,
                args,
                resume,
            } => {
                sub.encode(w);
                query.encode(w);
                args.encode(w);
                resume.encode(w);
            }
            C::Unsubscribe { sub } => sub.encode(w),
            C::Ping { client_time } => client_time.encode(w),
            C::SetInterest { interest } => interest.encode(w),
            C::Input { seq, input } => {
                seq.encode(w);
                input.encode(w);
            }
            C::TakeControl | C::EntityResync => {}
            C::Ack { bytes } => bytes.encode(w),
            C::Game(msg) => msg.encode(w),
        }
    }

    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let env = P::ENVELOPE;
        let at = r.position();
        let tag = r.read_variant()?;
        let Some(&slot) = env.client.get(tag as usize) else {
            return Err(DecodeError::unknown_variant(at, "ClientMsg", tag));
        };
        Ok(match slot {
            ClientSlot::Hello => {
                let (mut token, mut schema_hash, mut bulk, mut ext) =
                    (String::new(), String::new(), None, None);
                for f in env.hello {
                    match f {
                        HelloField::Token => token = Wire::decode(r)?,
                        HelloField::SchemaHash => schema_hash = Wire::decode(r)?,
                        HelloField::Bulk => bulk = Wire::decode(r)?,
                        HelloField::Ext => ext = Some(Wire::decode(r)?),
                    }
                }
                C::Hello {
                    token,
                    schema_hash,
                    bulk,
                    ext: ext.expect("an envelope's Hello has `ext`"),
                }
            }
            ClientSlot::Command => C::Command {
                seq: Wire::decode(r)?,
                command: Wire::decode(r)?,
            },
            ClientSlot::Subscribe => C::Subscribe {
                sub: Wire::decode(r)?,
                query: Wire::decode(r)?,
                args: Wire::decode(r)?,
                resume: Wire::decode(r)?,
            },
            ClientSlot::Unsubscribe => C::Unsubscribe {
                sub: Wire::decode(r)?,
            },
            ClientSlot::Ping => C::Ping {
                client_time: Wire::decode(r)?,
            },
            ClientSlot::SetInterest => C::SetInterest {
                interest: Wire::decode(r)?,
            },
            ClientSlot::Input => C::Input {
                seq: Wire::decode(r)?,
                input: Wire::decode(r)?,
            },
            ClientSlot::TakeControl => C::TakeControl,
            ClientSlot::EntityResync => C::EntityResync,
            ClientSlot::Ack => C::Ack {
                bytes: Wire::decode(r)?,
            },
            ClientSlot::Game => C::Game(Wire::decode(r)?),
            ClientSlot::Inline => {
                r.set_variant(env.inline_index(env.client, tag as usize, ClientSlot::Inline));
                C::Game(Wire::decode(r)?)
            }
        })
    }

    fn describe(s: &mut SchemaBuilder) -> TypeRef {
        let env = P::ENVELOPE;
        env.check();
        s.define(
            "ClientMsg",
            "tc_net::ClientMsg",
            "A message from a client.",
            |s| {
                let mut variants = Vec::with_capacity(env.client.len());
                let mut inline = None;
                for slot in env.client {
                    variants.push(match slot {
                        ClientSlot::Hello => Variant::named("Hello", "", hello_fields::<P>(s)),
                        ClientSlot::Command => Variant::named(
                            "Command",
                            "",
                            vec![field::<u32>(s, "seq"), field::<P::Command>(s, "command")],
                        ),
                        ClientSlot::Subscribe => Variant::named(
                            "Subscribe",
                            "",
                            vec![
                                field::<u32>(s, "sub"),
                                field::<String>(s, "query"),
                                field::<Bytes>(s, "args"),
                                field::<Option<Resume>>(s, "resume"),
                            ],
                        ),
                        ClientSlot::Unsubscribe => {
                            Variant::named("Unsubscribe", "", vec![field::<u32>(s, "sub")])
                        }
                        ClientSlot::Ping => {
                            Variant::named("Ping", "", vec![field::<u64>(s, "client_time")])
                        }
                        ClientSlot::SetInterest => Variant::named(
                            "SetInterest",
                            "",
                            vec![field::<P::Interest>(s, "interest")],
                        ),
                        ClientSlot::Input => Variant::named(
                            "Input",
                            "",
                            vec![field::<u32>(s, "seq"), field::<P::Input>(s, "input")],
                        ),
                        ClientSlot::TakeControl => Variant::unit("TakeControl", ""),
                        ClientSlot::EntityResync => Variant::unit("EntityResync", ""),
                        ClientSlot::Ack => {
                            Variant::named("Ack", "", vec![field::<u64>(s, env.ack.field())])
                        }
                        ClientSlot::Game => Variant::newtype("Game", "", P::Client::describe(s)),
                        ClientSlot::Inline => inline
                            .get_or_insert_with(|| {
                                Inline::of::<P::Client>(
                                    "ClientMsg",
                                    env.count(env.client, ClientSlot::Inline),
                                )
                            })
                            .next(s),
                    });
                }
                TypeKind::Enum(variants)
            },
        )
    }
}

impl<P: Protocol> Wire for ServerMsg<P> {
    fn encode(&self, w: &mut Writer) {
        let env = P::ENVELOPE;
        if let S::Game(msg) = self
            && env.server_inline()
        {
            return encode_inline(msg, w, |n| env.server_inline_tag(n));
        }
        let Some(tag) = env.server_tag(ServerSlot::of(self)) else {
            // Not on this protocol's wire: no message (an empty frame,
            // which a session drops).
            return;
        };
        w.write_varint(tag);
        match self {
            S::Welcome {
                player,
                time,
                paused,
                step_us,
                ext,
            } => {
                for f in env.welcome {
                    match f {
                        WelcomeField::Player => player.encode(w),
                        WelcomeField::Time => time.encode(w),
                        WelcomeField::Paused => paused.encode(w),
                        WelcomeField::StepUs => step_us.encode(w),
                        WelcomeField::Ext => ext.encode(w),
                    }
                }
            }
            S::Rejected {
                reason,
                stale_schema,
            } => {
                reason.encode(w);
                stale_schema.encode(w);
            }
            S::CommandResult { seq, result } => {
                seq.encode(w);
                result.encode(w);
            }
            S::Update {
                sub,
                version,
                hash,
                patch,
            } => {
                sub.encode(w);
                version.encode(w);
                hash.encode(w);
                patch.encode(w);
            }
            S::Resync {
                sub,
                version,
                hash,
                result,
            } => {
                sub.encode(w);
                version.encode(w);
                hash.encode(w);
                result.encode(w);
            }
            S::QueryFailed { sub, reason } => {
                sub.encode(w);
                reason.encode(w);
            }
            S::Clock { time, paused } => {
                time.encode(w);
                paused.encode(w);
            }
            S::Pong {
                client_time,
                time,
                paused,
            } => {
                client_time.encode(w);
                time.encode(w);
                paused.encode(w);
            }
            S::InterestRejected { reason } => reason.encode(w),
            S::EntityStream { data } => data.encode(w),
            S::PlayerState {
                seq,
                state,
                tick_us,
            } => {
                seq.encode(w);
                state.encode(w);
                tick_us.encode(w);
            }
            S::Control { driving } => driving.encode(w),
            S::Closed { code, reason } => {
                match &env.close {
                    Some(close) => w.write_varint(close.index(*code)),
                    None => code.encode(w),
                }
                reason.encode(w);
            }
            S::Bulk { codec, data } => {
                codec.encode(w);
                data.encode(w);
            }
            S::Game(msg) => msg.encode(w),
        }
    }

    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let env = P::ENVELOPE;
        let at = r.position();
        let tag = r.read_variant()?;
        let Some(&slot) = env.server.get(tag as usize) else {
            return Err(DecodeError::unknown_variant(at, "ServerMsg", tag));
        };
        Ok(match slot {
            ServerSlot::Welcome => {
                let (mut player, mut time, mut paused, mut step_us, mut ext) =
                    (0, 0, false, 0, None);
                for f in env.welcome {
                    match f {
                        WelcomeField::Player => player = Wire::decode(r)?,
                        WelcomeField::Time => time = Wire::decode(r)?,
                        WelcomeField::Paused => paused = Wire::decode(r)?,
                        WelcomeField::StepUs => step_us = Wire::decode(r)?,
                        WelcomeField::Ext => ext = Some(Wire::decode(r)?),
                    }
                }
                S::Welcome {
                    player,
                    time,
                    paused,
                    step_us,
                    ext: ext.expect("an envelope's Welcome has `ext`"),
                }
            }
            ServerSlot::Rejected => S::Rejected {
                reason: Wire::decode(r)?,
                stale_schema: Wire::decode(r)?,
            },
            ServerSlot::CommandResult => S::CommandResult {
                seq: Wire::decode(r)?,
                result: Wire::decode(r)?,
            },
            ServerSlot::Update => S::Update {
                sub: Wire::decode(r)?,
                version: Wire::decode(r)?,
                hash: Wire::decode(r)?,
                patch: Wire::decode(r)?,
            },
            ServerSlot::Resync => S::Resync {
                sub: Wire::decode(r)?,
                version: Wire::decode(r)?,
                hash: Wire::decode(r)?,
                result: Wire::decode(r)?,
            },
            ServerSlot::QueryFailed => S::QueryFailed {
                sub: Wire::decode(r)?,
                reason: Wire::decode(r)?,
            },
            ServerSlot::Clock => S::Clock {
                time: Wire::decode(r)?,
                paused: Wire::decode(r)?,
            },
            ServerSlot::Pong => S::Pong {
                client_time: Wire::decode(r)?,
                time: Wire::decode(r)?,
                paused: Wire::decode(r)?,
            },
            ServerSlot::InterestRejected => S::InterestRejected {
                reason: Wire::decode(r)?,
            },
            ServerSlot::EntityStream => S::EntityStream {
                data: Wire::decode(r)?,
            },
            ServerSlot::PlayerState => S::PlayerState {
                seq: Wire::decode(r)?,
                state: Wire::decode(r)?,
                tick_us: Wire::decode(r)?,
            },
            ServerSlot::Control => S::Control {
                driving: Wire::decode(r)?,
            },
            ServerSlot::Closed => S::Closed {
                code: match &env.close {
                    Some(close) => {
                        let at = r.position();
                        let index = r.read_variant()?;
                        match close.codes.get(index as usize) {
                            Some(&code) => code,
                            None => {
                                return Err(DecodeError::unknown_variant(at, "close code", index));
                            }
                        }
                    }
                    None => Wire::decode(r)?,
                },
                reason: Wire::decode(r)?,
            },
            ServerSlot::Bulk => S::Bulk {
                codec: Wire::decode(r)?,
                data: Wire::decode(r)?,
            },
            ServerSlot::Game => S::Game(Wire::decode(r)?),
            ServerSlot::Inline => {
                r.set_variant(env.inline_index(env.server, tag as usize, ServerSlot::Inline));
                S::Game(Wire::decode(r)?)
            }
        })
    }

    fn describe(s: &mut SchemaBuilder) -> TypeRef {
        let env = P::ENVELOPE;
        env.check();
        s.define(
            "ServerMsg",
            "tc_net::ServerMsg",
            "A message from the server.",
            |s| {
                let mut variants = Vec::with_capacity(env.server.len());
                let mut inline = None;
                for slot in env.server {
                    variants.push(match slot {
                        ServerSlot::Welcome => {
                            Variant::named("Welcome", "", welcome_fields::<P>(s))
                        }
                        ServerSlot::Rejected => Variant::named(
                            "Rejected",
                            "",
                            vec![
                                field::<String>(s, "reason"),
                                field::<bool>(s, "stale_schema"),
                            ],
                        ),
                        ServerSlot::CommandResult => Variant::named(
                            "CommandResult",
                            "",
                            vec![field::<u32>(s, "seq"), field::<P::Result>(s, "result")],
                        ),
                        ServerSlot::Update => Variant::named(
                            "Update",
                            "",
                            vec![
                                field::<u32>(s, "sub"),
                                field::<u64>(s, "version"),
                                field::<String>(s, "hash"),
                                field::<Vec<PatchOp>>(s, "patch"),
                            ],
                        ),
                        ServerSlot::Resync => Variant::named(
                            "Resync",
                            "",
                            vec![
                                field::<u32>(s, "sub"),
                                field::<u64>(s, "version"),
                                field::<String>(s, "hash"),
                                field::<Bytes>(s, "result"),
                            ],
                        ),
                        ServerSlot::QueryFailed => Variant::named(
                            "QueryFailed",
                            "",
                            vec![field::<u32>(s, "sub"), field::<String>(s, "reason")],
                        ),
                        ServerSlot::Clock => Variant::named(
                            "Clock",
                            "",
                            vec![field::<u64>(s, "time"), field::<bool>(s, "paused")],
                        ),
                        ServerSlot::Pong => Variant::named(
                            "Pong",
                            "",
                            vec![
                                field::<u64>(s, "client_time"),
                                field::<u64>(s, "time"),
                                field::<bool>(s, "paused"),
                            ],
                        ),
                        ServerSlot::InterestRejected => Variant::named(
                            "InterestRejected",
                            "",
                            vec![field::<String>(s, "reason")],
                        ),
                        ServerSlot::EntityStream => {
                            Variant::named("EntityStream", "", vec![field::<Bytes>(s, "data")])
                        }
                        ServerSlot::PlayerState => Variant::named(
                            "PlayerState",
                            "",
                            vec![
                                field::<u32>(s, "seq"),
                                field::<P::State>(s, "state"),
                                field::<u32>(s, "tick_us"),
                            ],
                        ),
                        ServerSlot::Control => {
                            Variant::named("Control", "", vec![field::<bool>(s, "driving")])
                        }
                        ServerSlot::Closed => {
                            let code = match &env.close {
                                Some(close) => Field::new("code", "", close.describe_in(s)),
                                None => field::<u16>(s, "code"),
                            };
                            Variant::named("Closed", "", vec![code, field::<String>(s, "reason")])
                        }
                        ServerSlot::Bulk => Variant::named(
                            "Bulk",
                            "",
                            vec![field::<u8>(s, "codec"), field::<Bytes>(s, "data")],
                        ),
                        ServerSlot::Game => Variant::newtype("Game", "", P::Server::describe(s)),
                        ServerSlot::Inline => inline
                            .get_or_insert_with(|| {
                                Inline::of::<P::Server>(
                                    "ServerMsg",
                                    env.count(env.server, ServerSlot::Inline),
                                )
                            })
                            .next(s),
                    });
                }
                TypeKind::Enum(variants)
            },
        )
    }
}

/// The head of a `Bulk` of `codec` (its variant and codec, the data's
/// length and data to follow) on the engine's wire, where `Bulk` is
/// variant 13. A game with its own layout writes its tag
/// ([`Envelope::bulk_tag`]) in the first byte.
pub fn bulk_head(codec: u8) -> [u8; 2] {
    [13, codec]
}

#[cfg(test)]
pub(crate) mod tests {
    use tc_wire::schema::QueryDef;

    use super::*;

    /// A small game for tests: a `u32` command and hello, the rest empty.
    #[derive(Debug, Clone, PartialEq)]
    pub struct Game;

    impl Protocol for Game {
        type Hello = u32;
        type Welcome = Empty;
        type Command = u32;
        type Result = String;
        type Interest = Empty;
        type Input = Empty;
        type State = Empty;
        type Client = Empty;
        type Server = String;
    }

    #[test]
    fn every_message_round_trips() {
        let client: Vec<ClientMsg<Game>> = vec![
            ClientMsg::Hello {
                token: "t".into(),
                schema_hash: "h".into(),
                bulk: Some(codec::DEFLATE),
                ext: 9,
            },
            ClientMsg::Command { seq: 1, command: 2 },
            ClientMsg::Subscribe {
                sub: 3,
                query: "q".into(),
                args: Bytes(vec![1, 2]),
                resume: Some(Resume {
                    version: 4,
                    hash: "ab".into(),
                }),
            },
            ClientMsg::Unsubscribe { sub: 3 },
            ClientMsg::Ping { client_time: 5 },
            ClientMsg::SetInterest { interest: Empty },
            ClientMsg::Input {
                seq: 6,
                input: Empty,
            },
            ClientMsg::TakeControl,
            ClientMsg::EntityResync,
            ClientMsg::Ack { bytes: 7 },
            ClientMsg::Game(Empty),
        ];
        for (i, msg) in client.iter().enumerate() {
            let bytes = msg.to_bytes();
            assert_eq!(bytes[0] as usize, i, "{msg:?}");
            assert_eq!(&ClientMsg::<Game>::from_bytes(&bytes).unwrap(), msg);
        }
        let server: Vec<ServerMsg<Game>> = vec![
            ServerMsg::Welcome {
                player: 1,
                time: 2,
                paused: true,
                step_us: 50_000,
                ext: Empty,
            },
            ServerMsg::Rejected {
                reason: "r".into(),
                stale_schema: true,
            },
            ServerMsg::CommandResult {
                seq: 1,
                result: "ok".into(),
            },
            ServerMsg::Update {
                sub: 1,
                version: 2,
                hash: String::new(),
                patch: vec![],
            },
            ServerMsg::Resync {
                sub: 1,
                version: 2,
                hash: "00ff".into(),
                result: Bytes(vec![3]),
            },
            ServerMsg::QueryFailed {
                sub: 1,
                reason: "no".into(),
            },
            ServerMsg::Clock {
                time: 3,
                paused: false,
            },
            ServerMsg::Pong {
                client_time: 1,
                time: 2,
                paused: false,
            },
            ServerMsg::InterestRejected { reason: "x".into() },
            ServerMsg::EntityStream {
                data: Bytes(vec![0]),
            },
            ServerMsg::PlayerState {
                seq: 1,
                state: Empty,
                tick_us: 2,
            },
            ServerMsg::Control { driving: true },
            ServerMsg::Closed {
                code: close::REVOKED,
                reason: "bye".into(),
            },
            ServerMsg::Bulk {
                codec: codec::NONE,
                data: Bytes(vec![1, 2]),
            },
            ServerMsg::Game("hi".into()),
        ];
        for (i, msg) in server.iter().enumerate() {
            let bytes = msg.to_bytes();
            assert_eq!(bytes[0] as usize, i, "{msg:?}");
            assert_eq!(&ServerMsg::<Game>::from_bytes(&bytes).unwrap(), msg);
        }
        assert!(ClientMsg::<Game>::from_bytes(&[11]).is_err());
        assert!(ServerMsg::<Game>::from_bytes(&[15]).is_err());
    }

    #[test]
    fn the_bulk_head_is_the_encoded_head() {
        for c in [codec::NONE, codec::DEFLATE] {
            let empty = ServerMsg::<Game>::Bulk {
                codec: c,
                data: Bytes(Vec::new()),
            };
            assert_eq!(tc_wire::bulk::head(&empty), bulk_head(c));
        }
    }

    #[test]
    fn close_codes_4000_to_4999_are_final() {
        assert!(close::is_final(4000) && close::is_final(4999) && close::is_final(close::REVOKED));
        assert!(!close::is_final(close::GOING_AWAY) && !close::is_final(close::RESTART));
        assert!(!close::is_final(5000));
    }

    /// The canonical text `defineSchema` gives the same game in TypeScript
    /// (`src/net/envelope.ts`; the interop test checks the hash end to
    /// end).
    #[test]
    fn the_schema_is_the_typescript_one() {
        let mut b = schema_builder::<Game>();
        b.query(QueryDef {
            name: "echo",
            doc: "",
            player: false,
            args: vec![Field::new("text", "", TypeRef::String)],
            result: TypeRef::String,
        });
        let schema = b.finish().unwrap();
        let text = schema.canonical_text();
        assert!(text.starts_with("thunderclap-wire 2\nroot ClientMsg\nroot ServerMsg\nquery echo(text: String) -> String\n"), "{text}");
        assert!(text.contains("struct Empty {  }\n"), "{text}");
        assert!(
            text.contains("  Game(Empty)\n") && text.contains("  Game(String)\n"),
            "{text}"
        );
    }

    /// A game with a protocol of its own: its messages inline, tags and
    /// fields reordered, a cumulative `Ack`, its own close codes.
    #[derive(Debug, Clone, PartialEq)]
    pub struct Custom;

    #[derive(Wire, Debug, Clone, PartialEq)]
    pub enum Talk {
        Say { text: String },
        Wave,
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    pub enum Heard {
        Said { text: String, from: u32 },
    }

    #[derive(Wire, Debug, Clone, Copy, PartialEq)]
    pub enum Bye {
        Restart,
        Kicked,
        Banned,
    }

    impl Protocol for Custom {
        type Hello = String;
        type Welcome = u32;
        type Command = u32;
        type Result = String;
        type Interest = Empty;
        type Input = Empty;
        type State = Empty;
        type Client = Talk;
        type Server = Heard;
        const ENVELOPE: &'static Envelope = &Envelope {
            client: &[
                ClientSlot::Ping,
                ClientSlot::Hello,
                ClientSlot::Inline,
                ClientSlot::Command,
                ClientSlot::Inline,
                ClientSlot::Ack,
            ],
            server: &[
                ServerSlot::Pong,
                ServerSlot::Welcome,
                ServerSlot::Inline,
                ServerSlot::Rejected,
                ServerSlot::Closed,
                ServerSlot::CommandResult,
                ServerSlot::Bulk,
            ],
            hello: &[HelloField::SchemaHash, HelloField::Token, HelloField::Ext],
            welcome: &[
                WelcomeField::Player,
                WelcomeField::Paused,
                WelcomeField::Time,
                WelcomeField::Ext,
            ],
            ack: AckMode::Total,
            close: Some(CloseCodes {
                describe: <Bye as Wire>::describe,
                codes: &[close::RESTART, 4003, 4004],
            }),
        };
    }

    #[test]
    fn a_custom_envelope_lays_messages_out_its_way() {
        type Cm = ClientMsg<Custom>;
        type Sm = ServerMsg<Custom>;
        let hello = Cm::Hello {
            token: "t".into(),
            schema_hash: "h".into(),
            bulk: None,
            ext: "ann".into(),
        };
        // Tag 1, then the hash before the token, no bulk, the game's field.
        assert_eq!(hello.to_bytes(), [1, 1, b'h', 1, b't', 3, b'a', b'n', b'n']);
        // The game's variants take their own tags: Say at 2, Wave at 4.
        let say = Cm::Game(Talk::Say { text: "x".into() });
        assert_eq!(say.to_bytes(), [2, 1, b'x']);
        assert_eq!(Cm::Game(Talk::Wave).to_bytes(), [4]);
        assert_eq!(Cm::Ack { bytes: 300 }.to_bytes(), [5, 0xac, 0x02]);
        let welcome = Sm::Welcome {
            player: 7,
            time: 9,
            paused: true,
            step_us: 0,
            ext: 3,
        };
        assert_eq!(welcome.to_bytes(), [1, 7, 1, 9, 3]);
        let said = Sm::Game(Heard::Said {
            text: "y".into(),
            from: 5,
        });
        assert_eq!(said.to_bytes(), [2, 1, b'y', 5]);
        // Close codes as the game's enum: its own, else the first of its kind.
        let closed = |code| Sm::Closed {
            code,
            reason: String::new(),
        };
        assert_eq!(closed(4004).to_bytes(), [4, 2, 0]);
        assert_eq!(closed(close::REVOKED).to_bytes(), [4, 1, 0]);
        assert_eq!(closed(close::GOING_AWAY).to_bytes(), [4, 0, 0]);
        for msg in [
            hello,
            say,
            Cm::Game(Talk::Wave),
            Cm::Ping { client_time: 4 },
            Cm::Command { seq: 1, command: 2 },
            Cm::Ack { bytes: 300 },
        ] {
            assert_eq!(Cm::from_bytes(&msg.to_bytes()).unwrap(), msg);
        }
        for msg in [
            welcome,
            said,
            closed(4003),
            closed(close::RESTART),
            Sm::Pong {
                client_time: 1,
                time: 2,
                paused: false,
            },
            Sm::Rejected {
                reason: "no".into(),
                stale_schema: true,
            },
            Sm::CommandResult {
                seq: 3,
                result: "ok".into(),
            },
            Sm::Bulk {
                codec: codec::NONE,
                data: Bytes(vec![1, 2]),
            },
        ] {
            assert_eq!(Sm::from_bytes(&msg.to_bytes()).unwrap(), msg);
        }
        // Messages not on this wire are no bytes; unknown tags don't decode.
        assert!(Cm::TakeControl.to_bytes().is_empty());
        assert!(
            Sm::Clock {
                time: 1,
                paused: false
            }
            .to_bytes()
            .is_empty()
        );
        assert!(Cm::from_bytes(&[6]).is_err() && Sm::from_bytes(&[7]).is_err());
        assert!(Sm::from_bytes(&[4, 3, 0]).is_err(), "no fourth close code");
        // `Bulk`'s head is its tag and codec.
        let empty = Sm::Bulk {
            codec: codec::DEFLATE,
            data: Bytes(Vec::new()),
        };
        assert_eq!(
            tc_wire::bulk::head(&empty),
            [Custom::ENVELOPE.bulk_tag().unwrap(), codec::DEFLATE]
        );
        assert!(!Custom::ENVELOPE.has_bulk(), "Hello has no bulk field");
        assert!(Envelope::ENGINE.is_engine() && !Custom::ENVELOPE.is_engine());
    }

    /// The text `defineSchema` gives with the same `envelope` spec
    /// (`src/net/envelope.test.ts` checks the same text).
    #[test]
    fn a_custom_envelope_has_the_typescript_schema() {
        let schema = schema_builder::<Custom>().finish().unwrap();
        let text = schema.canonical_text();
        let want = "thunderclap-wire 2
root ClientMsg
root ServerMsg
enum ClientMsg {
  Ping { client_time: u64 }
  Hello { schema_hash: String, token: String, ext: String }
  Say { text: String }
  Command { seq: u32, command: u32 }
  Wave
  Ack { total: u64 }
}
enum ServerMsg {
  Pong { client_time: u64, time: u64, paused: bool }
  Welcome { player: u64, paused: bool, time: u64, ext: u32 }
  Said { text: String, from: u32 }
  Rejected { reason: String, stale_schema: bool }
  Closed { code: Bye, reason: String }
  CommandResult { seq: u32, result: String }
  Bulk { codec: u8, data: Bytes }
}
enum Bye {
  Restart
  Kicked
  Banned
}
";
        assert_eq!(text, want);
    }

    #[derive(Debug, Clone, PartialEq)]
    struct NoPing;

    impl Protocol for NoPing {
        type Hello = Empty;
        type Welcome = Empty;
        type Command = Empty;
        type Result = Empty;
        type Interest = Empty;
        type Input = Empty;
        type State = Empty;
        type Client = Empty;
        type Server = Empty;
        const ENVELOPE: &'static Envelope = &Envelope {
            client: &[ClientSlot::Hello],
            ..Envelope::ENGINE
        };
    }

    #[test]
    #[should_panic(expected = "ClientMsg needs Ping")]
    fn a_layout_without_a_required_message_panics() {
        schema_builder::<NoPing>();
    }
}
