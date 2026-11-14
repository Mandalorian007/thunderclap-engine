//! A tiny game on tc-net for the interop test and `examples/echo`: string
//! commands, one live query, an entity stream and the bulk lane.
//!
//! Commands (each answered with a `CommandResult`):
//!
//! - any text: the result is the text upper-cased, and `echo` queries'
//!   `count` goes up (an `Update` patch to each subscriber);
//! - `bulk N`: N `Game` messages on the bulk lane (result `"N"`);
//! - `ghosts N`: an entity-stream frame of N ghosts;
//! - `restart`: closes the connection with a code that reconnects;
//! - `kick`: closes it with a final code.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::mpsc::Receiver;

use tc_net::envelope::Protocol;
use tc_net::{
    ClientMsg, ConnId, Empty, EntityEncoder, Outbound, Request, ServerMsg, close, schema_builder,
};
use tc_wire::diff::{diff, hash_hex, result_hash};
use tc_wire::schema::{Field, QueryDef, Schema, TypeRef};
use tc_wire::{Bytes, Reader, Wire};

/// The echo game's roles.
#[derive(Debug, Clone, PartialEq)]
pub struct Echo;

impl Protocol for Echo {
    type Hello = Empty;
    type Welcome = Empty;
    type Command = String;
    type Result = String;
    type Interest = Empty;
    type Input = Empty;
    type State = Empty;
    type Client = Empty;
    type Server = String;
}

/// The `echo` query's result.
#[derive(Wire, Debug, Clone, PartialEq)]
pub struct Echoed {
    /// The query's argument.
    pub text: String,
    /// Commands so far.
    pub count: u32,
}

/// One thing in the entity stream.
#[derive(Wire, Debug, Clone, PartialEq)]
pub struct Ghost {
    /// Where.
    pub x: i32,
    /// Where.
    pub y: i32,
}

/// The echo game's schema: the envelope, `Ghost` (the entity view) and
/// `echo(text: String) -> Echoed`.
pub fn schema() -> Schema {
    let mut b = schema_builder::<Echo>();
    b.root::<Ghost>();
    let result = b.describe::<Echoed>();
    b.query(QueryDef {
        name: "echo",
        doc: "",
        player: false,
        args: vec![Field::new("text", "", TypeRef::String)],
        result,
    });
    b.finish().expect("the echo schema is valid")
}

struct Conn {
    out: Outbound,
    subs: BTreeMap<u32, (String, u64)>,
    ghosts: EntityEncoder<Ghost>,
    tick: u64,
}

/// Runs the game until every sender of `requests` is gone.
pub fn run(requests: Receiver<Request<Echo>>) {
    let schema = schema();
    let mut conns: BTreeMap<ConnId, Conn> = BTreeMap::new();
    let mut count = 0u32;
    let send = |out: &Outbound, msg: ServerMsg<Echo>| {
        let _ = out.try_send(msg.to_bytes());
    };
    for request in requests {
        match request {
            Request::Connect { conn, out, .. } => {
                send(
                    &out,
                    ServerMsg::Welcome {
                        player: conn,
                        time: 0,
                        paused: false,
                        step_us: 50_000,
                        ext: Empty,
                    },
                );
                let ghosts = EntityEncoder::new(&schema).expect("Ghost is a view");
                conns.insert(
                    conn,
                    Conn {
                        out,
                        subs: BTreeMap::new(),
                        ghosts,
                        tick: 0,
                    },
                );
            }
            Request::Disconnect { conn } => {
                conns.remove(&conn);
            }
            Request::Client { conn, msg, .. } => {
                let Some(c) = conns.get_mut(&conn) else {
                    continue;
                };
                match msg {
                    ClientMsg::Command { seq, command } => {
                        let words: Vec<&str> = command.split_whitespace().collect();
                        let n = words
                            .get(1)
                            .and_then(|n| n.parse::<u32>().ok())
                            .unwrap_or(0);
                        let result = |result: String| ServerMsg::CommandResult { seq, result };
                        match words.first().copied() {
                            Some("bulk") => {
                                send(&c.out, result(n.to_string()));
                                for i in 0..n {
                                    let msg = ServerMsg::<Echo>::Game(format!(
                                        "bulk {i} {}",
                                        "x".repeat(200)
                                    ));
                                    c.out.try_send_bulk(msg.to_bytes(), None);
                                }
                                c.out.wake();
                            }
                            Some("ghosts") => {
                                send(&c.out, result(n.to_string()));
                                let ghosts: Vec<Ghost> =
                                    (0..n as i32).map(|i| Ghost { x: i, y: -i }).collect();
                                c.tick += 1;
                                let things =
                                    ghosts.iter().enumerate().map(|(i, g)| (i as u64 + 1, g));
                                if let Some(frame) = c.ghosts.frame(c.tick, things) {
                                    send(&c.out, ServerMsg::EntityStream { data: Bytes(frame) });
                                }
                            }
                            Some("restart") => {
                                send(&c.out, result("restarting".into()));
                                send(
                                    &c.out,
                                    ServerMsg::Closed {
                                        code: close::RESTART,
                                        reason: "restart".into(),
                                    },
                                );
                                conns.remove(&conn);
                            }
                            Some("kick") => {
                                send(
                                    &c.out,
                                    ServerMsg::Closed {
                                        code: close::REVOKED,
                                        reason: "kicked".into(),
                                    },
                                );
                                conns.remove(&conn);
                            }
                            _ => {
                                send(&c.out, result(command.to_uppercase()));
                                let was = count;
                                count += 1;
                                for c in conns.values_mut() {
                                    for (sub, (text, version)) in &mut c.subs {
                                        let old = Echoed {
                                            text: text.clone(),
                                            count: was,
                                        }
                                        .to_bytes();
                                        let new = Echoed {
                                            text: text.clone(),
                                            count,
                                        }
                                        .to_bytes();
                                        let patch =
                                            diff(&schema, &TypeRef::Named("Echoed"), &old, &new)
                                                .expect("both are Echoed");
                                        *version += 1;
                                        send(
                                            &c.out,
                                            ServerMsg::Update {
                                                sub: *sub,
                                                version: *version,
                                                hash: hash_hex(result_hash(&new)),
                                                patch,
                                            },
                                        );
                                    }
                                }
                            }
                        }
                    }
                    ClientMsg::Subscribe {
                        sub, query, args, ..
                    } => {
                        let mut r = Reader::new(&args.0);
                        let text = match (query.as_str(), r.read_string()) {
                            ("echo", Ok(text)) if r.finish().is_ok() => text,
                            _ => {
                                send(
                                    &c.out,
                                    ServerMsg::QueryFailed {
                                        sub,
                                        reason: format!("no query {query}"),
                                    },
                                );
                                continue;
                            }
                        };
                        let result = Echoed {
                            text: text.clone(),
                            count,
                        }
                        .to_bytes();
                        send(
                            &c.out,
                            ServerMsg::Resync {
                                sub,
                                version: 1,
                                result: Bytes(result),
                            },
                        );
                        c.subs.insert(sub, (text, 1));
                    }
                    ClientMsg::Unsubscribe { sub } => {
                        c.subs.remove(&sub);
                    }
                    ClientMsg::Ping { client_time } => {
                        send(
                            &c.out,
                            ServerMsg::Pong {
                                client_time,
                                time: 0,
                                paused: false,
                            },
                        );
                    }
                    ClientMsg::EntityResync => c.ghosts.resync(),
                    _ => {}
                }
            }
        }
    }
}
