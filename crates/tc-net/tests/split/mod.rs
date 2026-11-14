//! A game whose existing protocol the envelope's options fit, for the
//! interop test: the game's `Hello` fields sit among the envelope's
//! (`token, schema_hash, watch, bulk, content, opening`), `Rejected` has no
//! `stale_schema`, the bulk lane is acked by whole messages and a stale
//! client's hash is quoted. `src/net/split-interop.test.ts` spells the same
//! layout.
//!
//! - `Welcome`'s field: the `Hello` fields read back, `"watch content opening"`.
//! - `Command(n)`: the result is `"n"`, then `n` lines on the bulk lane.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::mpsc::Receiver;

use tc_net::envelope::{AckMode, ClientText, Envelope, HelloField, Protocol, RejectedField};
use tc_net::{ClientMsg, ConnId, Empty, Outbound, Request, ServerMsg, schema_builder};
use tc_wire::Wire;
use tc_wire::schema::Schema;

/// The split game's roles and wire.
#[derive(Debug, Clone, PartialEq)]
pub struct Split;

/// What a player says on joining.
#[derive(Wire, Debug, Clone, PartialEq)]
pub struct Joining {
    /// Watching, not playing.
    pub watch: bool,
    /// The content the client has.
    pub content: String,
    /// Where it opens, if anywhere.
    pub opening: Option<u32>,
}

impl Protocol for Split {
    type Hello = Joining;
    type Welcome = String;
    type Command = u32;
    type Result = String;
    type Interest = Empty;
    type Input = Empty;
    type State = Empty;
    type Client = Empty;
    type Server = String;
    const ENVELOPE: &'static Envelope = &Envelope {
        hello: &[
            HelloField::Token,
            HelloField::SchemaHash,
            HelloField::ExtFields(1),
            HelloField::Bulk,
            HelloField::ExtFields(2),
        ],
        rejected: &[RejectedField::Reason],
        ack: AckMode::Messages,
        client_text: ClientText::QUOTED,
        ..Envelope::ENGINE
    };
}

/// The split game's schema: the envelope alone.
pub fn schema() -> Schema {
    schema_builder::<Split>()
        .finish()
        .expect("the split schema is valid")
}

/// Runs the game until every sender of `requests` is gone.
pub fn run(requests: Receiver<Request<Split>>) {
    let mut conns: BTreeMap<ConnId, Outbound> = BTreeMap::new();
    let send = |out: &Outbound, msg: ServerMsg<Split>| {
        let _ = out.try_send(msg.to_bytes());
    };
    for request in requests {
        match request {
            Request::Connect {
                conn, hello, out, ..
            } => {
                let opening = hello.opening.map_or("-".into(), |o| o.to_string());
                send(
                    &out,
                    ServerMsg::Welcome {
                        player: conn,
                        time: 0,
                        paused: false,
                        step_us: 0,
                        ext: format!("{} {} {opening}", hello.watch, hello.content),
                    },
                );
                conns.insert(conn, out);
            }
            Request::Disconnect { conn } => {
                conns.remove(&conn);
            }
            Request::Wake => {}
            Request::Client { conn, msg, .. } => {
                let Some(out) = conns.get(&conn) else {
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
                            let line =
                                ServerMsg::<Split>::Game(format!("bulk {i} {}", "x".repeat(100)));
                            out.try_send_bulk(line.to_bytes(), None);
                        }
                        out.wake();
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
