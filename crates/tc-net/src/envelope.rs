//! The envelope: the handshake and transport messages every networked
//! game needs, generic over the game's [`Protocol`]. The same messages, in
//! the same order, as `src/net/envelope.ts`: a game's schema built with
//! [`schema_builder`] has the canonical text and hash `defineSchema` gives
//! the same game types in TypeScript.
//!
//! Variant order is the wire order: append, never reorder.

use tc_wire::diff::PatchOp;
use tc_wire::schema::{Field, SchemaBuilder, TypeKind, TypeRef, Variant};

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
pub fn schema_builder<P: Protocol>() -> SchemaBuilder {
    let mut b = SchemaBuilder::new();
    b.root::<ClientMsg<P>>();
    b.root::<ServerMsg<P>>();
    b
}

fn field<T: Wire>(s: &mut SchemaBuilder, name: &'static str) -> Field {
    Field::new(name, "", T::describe(s))
}

impl<P: Protocol> Wire for ClientMsg<P> {
    fn encode(&self, w: &mut Writer) {
        match self {
            C::Hello {
                token,
                schema_hash,
                bulk,
                ext,
            } => {
                w.write_varint(0);
                token.encode(w);
                schema_hash.encode(w);
                bulk.encode(w);
                ext.encode(w);
            }
            C::Command { seq, command } => {
                w.write_varint(1);
                seq.encode(w);
                command.encode(w);
            }
            C::Subscribe {
                sub,
                query,
                args,
                resume,
            } => {
                w.write_varint(2);
                sub.encode(w);
                query.encode(w);
                args.encode(w);
                resume.encode(w);
            }
            C::Unsubscribe { sub } => {
                w.write_varint(3);
                sub.encode(w);
            }
            C::Ping { client_time } => {
                w.write_varint(4);
                client_time.encode(w);
            }
            C::SetInterest { interest } => {
                w.write_varint(5);
                interest.encode(w);
            }
            C::Input { seq, input } => {
                w.write_varint(6);
                seq.encode(w);
                input.encode(w);
            }
            C::TakeControl => w.write_varint(7),
            C::EntityResync => w.write_varint(8),
            C::Ack { bytes } => {
                w.write_varint(9);
                bytes.encode(w);
            }
            C::Game(msg) => {
                w.write_varint(10);
                msg.encode(w);
            }
        }
    }

    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let at = r.position();
        Ok(match r.read_variant()? {
            0 => C::Hello {
                token: Wire::decode(r)?,
                schema_hash: Wire::decode(r)?,
                bulk: Wire::decode(r)?,
                ext: Wire::decode(r)?,
            },
            1 => C::Command {
                seq: Wire::decode(r)?,
                command: Wire::decode(r)?,
            },
            2 => C::Subscribe {
                sub: Wire::decode(r)?,
                query: Wire::decode(r)?,
                args: Wire::decode(r)?,
                resume: Wire::decode(r)?,
            },
            3 => C::Unsubscribe {
                sub: Wire::decode(r)?,
            },
            4 => C::Ping {
                client_time: Wire::decode(r)?,
            },
            5 => C::SetInterest {
                interest: Wire::decode(r)?,
            },
            6 => C::Input {
                seq: Wire::decode(r)?,
                input: Wire::decode(r)?,
            },
            7 => C::TakeControl,
            8 => C::EntityResync,
            9 => C::Ack {
                bytes: Wire::decode(r)?,
            },
            10 => C::Game(Wire::decode(r)?),
            index => return Err(DecodeError::unknown_variant(at, "ClientMsg", index)),
        })
    }

    fn describe(s: &mut SchemaBuilder) -> TypeRef {
        s.define(
            "ClientMsg",
            "tc_net::ClientMsg",
            "A message from a client.",
            |s| {
                TypeKind::Enum(vec![
                    Variant::named(
                        "Hello",
                        "",
                        vec![
                            field::<String>(s, "token"),
                            field::<String>(s, "schema_hash"),
                            field::<Option<u8>>(s, "bulk"),
                            field::<P::Hello>(s, "ext"),
                        ],
                    ),
                    Variant::named(
                        "Command",
                        "",
                        vec![field::<u32>(s, "seq"), field::<P::Command>(s, "command")],
                    ),
                    Variant::named(
                        "Subscribe",
                        "",
                        vec![
                            field::<u32>(s, "sub"),
                            field::<String>(s, "query"),
                            field::<Bytes>(s, "args"),
                            field::<Option<Resume>>(s, "resume"),
                        ],
                    ),
                    Variant::named("Unsubscribe", "", vec![field::<u32>(s, "sub")]),
                    Variant::named("Ping", "", vec![field::<u64>(s, "client_time")]),
                    Variant::named("SetInterest", "", vec![field::<P::Interest>(s, "interest")]),
                    Variant::named(
                        "Input",
                        "",
                        vec![field::<u32>(s, "seq"), field::<P::Input>(s, "input")],
                    ),
                    Variant::unit("TakeControl", ""),
                    Variant::unit("EntityResync", ""),
                    Variant::named("Ack", "", vec![field::<u64>(s, "bytes")]),
                    Variant::newtype("Game", "", P::Client::describe(s)),
                ])
            },
        )
    }
}

impl<P: Protocol> Wire for ServerMsg<P> {
    fn encode(&self, w: &mut Writer) {
        match self {
            S::Welcome {
                player,
                time,
                paused,
                step_us,
                ext,
            } => {
                w.write_varint(0);
                player.encode(w);
                time.encode(w);
                paused.encode(w);
                step_us.encode(w);
                ext.encode(w);
            }
            S::Rejected {
                reason,
                stale_schema,
            } => {
                w.write_varint(1);
                reason.encode(w);
                stale_schema.encode(w);
            }
            S::CommandResult { seq, result } => {
                w.write_varint(2);
                seq.encode(w);
                result.encode(w);
            }
            S::Update {
                sub,
                version,
                hash,
                patch,
            } => {
                w.write_varint(3);
                sub.encode(w);
                version.encode(w);
                hash.encode(w);
                patch.encode(w);
            }
            S::Resync {
                sub,
                version,
                result,
            } => {
                w.write_varint(4);
                sub.encode(w);
                version.encode(w);
                result.encode(w);
            }
            S::QueryFailed { sub, reason } => {
                w.write_varint(5);
                sub.encode(w);
                reason.encode(w);
            }
            S::Clock { time, paused } => {
                w.write_varint(6);
                time.encode(w);
                paused.encode(w);
            }
            S::Pong {
                client_time,
                time,
                paused,
            } => {
                w.write_varint(7);
                client_time.encode(w);
                time.encode(w);
                paused.encode(w);
            }
            S::InterestRejected { reason } => {
                w.write_varint(8);
                reason.encode(w);
            }
            S::EntityStream { data } => {
                w.write_varint(9);
                data.encode(w);
            }
            S::PlayerState {
                seq,
                state,
                tick_us,
            } => {
                w.write_varint(10);
                seq.encode(w);
                state.encode(w);
                tick_us.encode(w);
            }
            S::Control { driving } => {
                w.write_varint(11);
                driving.encode(w);
            }
            S::Closed { code, reason } => {
                w.write_varint(12);
                code.encode(w);
                reason.encode(w);
            }
            S::Bulk { codec, data } => {
                w.write_varint(13);
                codec.encode(w);
                data.encode(w);
            }
            S::Game(msg) => {
                w.write_varint(14);
                msg.encode(w);
            }
        }
    }

    fn decode(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        let at = r.position();
        Ok(match r.read_variant()? {
            0 => S::Welcome {
                player: Wire::decode(r)?,
                time: Wire::decode(r)?,
                paused: Wire::decode(r)?,
                step_us: Wire::decode(r)?,
                ext: Wire::decode(r)?,
            },
            1 => S::Rejected {
                reason: Wire::decode(r)?,
                stale_schema: Wire::decode(r)?,
            },
            2 => S::CommandResult {
                seq: Wire::decode(r)?,
                result: Wire::decode(r)?,
            },
            3 => S::Update {
                sub: Wire::decode(r)?,
                version: Wire::decode(r)?,
                hash: Wire::decode(r)?,
                patch: Wire::decode(r)?,
            },
            4 => S::Resync {
                sub: Wire::decode(r)?,
                version: Wire::decode(r)?,
                result: Wire::decode(r)?,
            },
            5 => S::QueryFailed {
                sub: Wire::decode(r)?,
                reason: Wire::decode(r)?,
            },
            6 => S::Clock {
                time: Wire::decode(r)?,
                paused: Wire::decode(r)?,
            },
            7 => S::Pong {
                client_time: Wire::decode(r)?,
                time: Wire::decode(r)?,
                paused: Wire::decode(r)?,
            },
            8 => S::InterestRejected {
                reason: Wire::decode(r)?,
            },
            9 => S::EntityStream {
                data: Wire::decode(r)?,
            },
            10 => S::PlayerState {
                seq: Wire::decode(r)?,
                state: Wire::decode(r)?,
                tick_us: Wire::decode(r)?,
            },
            11 => S::Control {
                driving: Wire::decode(r)?,
            },
            12 => S::Closed {
                code: Wire::decode(r)?,
                reason: Wire::decode(r)?,
            },
            13 => S::Bulk {
                codec: Wire::decode(r)?,
                data: Wire::decode(r)?,
            },
            14 => S::Game(Wire::decode(r)?),
            index => return Err(DecodeError::unknown_variant(at, "ServerMsg", index)),
        })
    }

    fn describe(s: &mut SchemaBuilder) -> TypeRef {
        s.define(
            "ServerMsg",
            "tc_net::ServerMsg",
            "A message from the server.",
            |s| {
                TypeKind::Enum(vec![
                    Variant::named(
                        "Welcome",
                        "",
                        vec![
                            field::<u64>(s, "player"),
                            field::<u64>(s, "time"),
                            field::<bool>(s, "paused"),
                            field::<u32>(s, "step_us"),
                            field::<P::Welcome>(s, "ext"),
                        ],
                    ),
                    Variant::named(
                        "Rejected",
                        "",
                        vec![
                            field::<String>(s, "reason"),
                            field::<bool>(s, "stale_schema"),
                        ],
                    ),
                    Variant::named(
                        "CommandResult",
                        "",
                        vec![field::<u32>(s, "seq"), field::<P::Result>(s, "result")],
                    ),
                    Variant::named(
                        "Update",
                        "",
                        vec![
                            field::<u32>(s, "sub"),
                            field::<u64>(s, "version"),
                            field::<String>(s, "hash"),
                            field::<Vec<PatchOp>>(s, "patch"),
                        ],
                    ),
                    Variant::named(
                        "Resync",
                        "",
                        vec![
                            field::<u32>(s, "sub"),
                            field::<u64>(s, "version"),
                            field::<Bytes>(s, "result"),
                        ],
                    ),
                    Variant::named(
                        "QueryFailed",
                        "",
                        vec![field::<u32>(s, "sub"), field::<String>(s, "reason")],
                    ),
                    Variant::named(
                        "Clock",
                        "",
                        vec![field::<u64>(s, "time"), field::<bool>(s, "paused")],
                    ),
                    Variant::named(
                        "Pong",
                        "",
                        vec![
                            field::<u64>(s, "client_time"),
                            field::<u64>(s, "time"),
                            field::<bool>(s, "paused"),
                        ],
                    ),
                    Variant::named("InterestRejected", "", vec![field::<String>(s, "reason")]),
                    Variant::named("EntityStream", "", vec![field::<Bytes>(s, "data")]),
                    Variant::named(
                        "PlayerState",
                        "",
                        vec![
                            field::<u32>(s, "seq"),
                            field::<P::State>(s, "state"),
                            field::<u32>(s, "tick_us"),
                        ],
                    ),
                    Variant::named("Control", "", vec![field::<bool>(s, "driving")]),
                    Variant::named(
                        "Closed",
                        "",
                        vec![field::<u16>(s, "code"), field::<String>(s, "reason")],
                    ),
                    Variant::named(
                        "Bulk",
                        "",
                        vec![field::<u8>(s, "codec"), field::<Bytes>(s, "data")],
                    ),
                    Variant::newtype("Game", "", P::Server::describe(s)),
                ])
            },
        )
    }
}

/// The head of a `Bulk` of `codec` (its variant and codec, the data's
/// length and data to follow): the same for every protocol, since `Bulk`
/// is variant 13 of every `ServerMsg`.
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
}
