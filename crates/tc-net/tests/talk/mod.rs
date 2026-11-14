//! A game with a wire of its own on tc-net, for the interop test: its
//! messages are variants of the envelope (no `Game` wrapper), the
//! envelope's variants and `Hello`/`Welcome` fields are in its own order,
//! the bulk lane is acked with a running total and `Closed` carries its
//! own close enum. `src/net/talk-interop.test.ts` spells the same layout.
//!
//! - `Hello`'s field: a name. `Welcome`'s: the name's length.
//! - `Command(n)`: the result is `"n"`, then `n` `Said`s on the bulk lane.
//! - `Say { text }`: `Said { "name: text", from }` to everyone.
//! - `Wave`: closed as `Bye::Kicked` (final).

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::mpsc::Receiver;

use tc_net::envelope::{
    AckMode, ClientSlot, CloseCodes, Envelope, HelloField, Protocol, ServerSlot, WelcomeField,
};
use tc_net::{ClientMsg, ConnId, Empty, Outbound, Request, ServerMsg, close, schema_builder};
use tc_wire::Wire;
use tc_wire::schema::Schema;

/// The talk game's roles and wire.
#[derive(Debug, Clone, PartialEq)]
pub struct Talk;

/// What a player sends.
#[derive(Wire, Debug, Clone, PartialEq)]
pub enum Speak {
    /// A line to everyone.
    Say {
        /// The line.
        text: String,
    },
    /// Leave, waving.
    Wave,
}

/// What a player hears.
#[derive(Wire, Debug, Clone, PartialEq)]
pub enum Heard {
    /// Someone said something.
    Said {
        /// `name: line`.
        text: String,
        /// Who.
        from: u32,
    },
}

/// Why the server closed.
#[derive(Wire, Debug, Clone, Copy, PartialEq)]
pub enum Bye {
    /// Come back.
    Restart,
    /// Gone for good.
    Kicked,
}

/// `Bye::Kicked`'s code.
pub const KICKED: u16 = 4003;

impl Protocol for Talk {
    type Hello = String;
    type Welcome = u32;
    type Command = u32;
    type Result = String;
    type Interest = Empty;
    type Input = Empty;
    type State = Empty;
    type Client = Speak;
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
        hello: &[
            HelloField::SchemaHash,
            HelloField::Token,
            HelloField::Bulk,
            HelloField::Ext,
        ],
        welcome: &[
            WelcomeField::Player,
            WelcomeField::Paused,
            WelcomeField::Time,
            WelcomeField::Ext,
        ],
        ack: AckMode::Total,
        close: Some(CloseCodes {
            describe: <Bye as Wire>::describe,
            codes: &[close::RESTART, KICKED],
        }),
        ..Envelope::ENGINE
    };
}

/// The talk game's schema: the envelope alone.
pub fn schema() -> Schema {
    schema_builder::<Talk>()
        .finish()
        .expect("the talk schema is valid")
}

/// Runs the game until every sender of `requests` is gone.
pub fn run(requests: Receiver<Request<Talk>>) {
    let mut conns: BTreeMap<ConnId, (Outbound, String)> = BTreeMap::new();
    let send = |out: &Outbound, msg: ServerMsg<Talk>| {
        let _ = out.try_send(msg.to_bytes());
    };
    for request in requests {
        match request {
            Request::Connect {
                conn, hello, out, ..
            } => {
                send(
                    &out,
                    ServerMsg::Welcome {
                        player: conn,
                        time: 0,
                        paused: false,
                        step_us: 0,
                        ext: hello.len() as u32,
                    },
                );
                conns.insert(conn, (out, hello));
            }
            Request::Disconnect { conn } => {
                conns.remove(&conn);
            }
            Request::Wake => {}
            Request::Client { conn, msg, .. } => {
                let Some((out, name)) = conns.get(&conn) else {
                    continue;
                };
                match msg {
                    ClientMsg::Command { seq, command } => {
                        send(
                            out,
                            ServerMsg::CommandResult {
                                seq,
                                result: command.to_string(),
                            },
                        );
                        for i in 0..command {
                            let said = ServerMsg::<Talk>::Game(Heard::Said {
                                text: format!("bulk {i} {}", "x".repeat(100)),
                                from: 0,
                            });
                            out.try_send_bulk(said.to_bytes(), None);
                        }
                        out.wake();
                    }
                    ClientMsg::Game(Speak::Say { text }) => {
                        let text = format!("{name}: {text}");
                        for (out, _) in conns.values() {
                            let said = Heard::Said {
                                text: text.clone(),
                                from: conn as u32,
                            };
                            send(out, ServerMsg::Game(said));
                        }
                    }
                    ClientMsg::Game(Speak::Wave) => {
                        send(
                            out,
                            ServerMsg::Closed {
                                code: KICKED,
                                reason: "waved".into(),
                            },
                        );
                        conns.remove(&conn);
                    }
                    ClientMsg::Ping { client_time } => send(
                        out,
                        ServerMsg::Pong {
                            client_time,
                            time: 0,
                            paused: false,
                        },
                    ),
                    _ => {}
                }
            }
        }
    }
}
