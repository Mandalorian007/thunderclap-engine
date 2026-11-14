//! Connections: what the loop does with each tc-net [`Request`].
//!
//! **One body, one driver.** A player may have several connections (a
//! second tab, a reconnect before the old socket timed out); all of them
//! get what the player is sent, but only one drives: its inputs are
//! taken, the others' are dropped. The newest connection drives; a
//! connection takes control back with `TakeControl`. Whenever control
//! moves, the inputs still queued from the old driver are dropped and
//! both connections are told (`Control`).
//!
//! **Presence.** A player is present while it has a connection: its first
//! connection calls [`Game::presence`] with `true`, its last one closing
//! calls it with `false`.

use std::time::Instant;

use tc_net::transport::Frame;
use tc_net::{ClientMsg, ConnId, Identity, Outbound, Protocol, Request, ServerMsg};
use tc_wire::Wire;

use crate::game::{Game, Outbox, PlayerId};
use crate::input::Taken;
use crate::sim::{Conn, Sim};

/// The connection id a `Disconnect` carries when it only wakes the loop
/// (see [`crate::Control`]).
pub(crate) const WAKE: ConnId = ConnId::MAX;

impl<G: Game> Sim<G> {
    /// Handles one request from tc-net.
    pub fn handle(&mut self, request: Request<G::Protocol>) {
        let now = Instant::now();
        match request {
            Request::Connect {
                conn,
                identity,
                hello,
                out,
            } => self.connect(conn, &identity, &hello, out, now),
            Request::Client {
                conn, msg, permit, ..
            } => {
                self.client(conn, msg, now);
                drop(permit);
            }
            Request::Disconnect { conn } if conn == WAKE => {}
            Request::Disconnect { conn } => self.disconnect(conn),
        }
    }

    fn connect(
        &mut self,
        conn: ConnId,
        identity: &Identity,
        hello: &<G::Protocol as Protocol>::Hello,
        out: Outbound,
        now: Instant,
    ) {
        if let Some(e) = &self.store_error {
            let closed = ServerMsg::<G::Protocol>::Closed {
                code: tc_net::close::RESTART,
                reason: format!("the server can't save: {e}"),
            };
            let _ = out.try_send(closed.to_bytes());
            return;
        }
        let mut events = Vec::new();
        let player = match self.core.game().join(identity, hello, &mut events) {
            Ok(player) => player,
            Err(reason) => {
                let rejected = ServerMsg::<G::Protocol>::Rejected {
                    reason,
                    stale_schema: false,
                };
                let _ = out.try_send(rejected.to_bytes());
                return;
            }
        };
        // Catch up first, so the events land at the time it is now.
        self.tick(now);
        self.commit(events);
        let first = !self.conns_of.contains_key(&player);
        if first {
            let mut events = Vec::new();
            self.core.game().presence(player, true, &mut events);
            self.commit(events);
            self.inputs.join(player);
        }
        self.flush_all();
        self.conns.insert(
            conn,
            Conn {
                player,
                out,
                overflowed: Default::default(),
                over_budget_since: None,
            },
        );
        self.conns_of.entry(player).or_default().push(conn);
        let welcome = ServerMsg::<G::Protocol>::Welcome {
            player,
            time: self.core.time(),
            paused: self.clock.paused(),
            step_us: self.clock.step_us(),
            ext: self.core.game().welcome(player),
        };
        let mut greeting = vec![welcome];
        self.core.game().greet(player, &mut greeting);
        if let Some(c) = self.conns.get(&conn) {
            for msg in greeting {
                c.send_frame(Frame::from(msg.to_bytes()));
            }
        }
        self.drive(player, conn);
        tracing::info!(conn, player, name = %identity.name, "joined");
        self.publish_status(now);
    }

    /// Makes `conn` drive `player`, telling it and the connection that
    /// drove before.
    fn drive(&mut self, player: PlayerId, conn: ConnId) {
        let before = self.drivers.insert(player, conn);
        if before == Some(conn) {
            return;
        }
        if let Some(old) = before {
            self.inputs.drop_inputs(player);
            self.send_to(old, &ServerMsg::Control { driving: false });
        }
        self.send_to(conn, &ServerMsg::Control { driving: true });
    }

    fn send_to(&self, conn: ConnId, msg: &ServerMsg<G::Protocol>) {
        if let Some(c) = self.conns.get(&conn) {
            c.send_frame(Frame::from(msg.to_bytes()));
        }
    }

    fn client(&mut self, conn: ConnId, msg: ClientMsg<G::Protocol>, now: Instant) {
        let Some(player) = self.conns.get(&conn).map(|c| c.player) else {
            return;
        };
        match msg {
            ClientMsg::Command { seq, command } => {
                self.tick(now);
                let mut events = Vec::new();
                let result = self.core.game().command(player, command, &mut events);
                self.commit(events);
                // Read your writes: what the command changed goes out
                // before its result.
                self.flush_all();
                self.send_to(conn, &ServerMsg::CommandResult { seq, result });
            }
            ClientMsg::Ping { client_time } => {
                let time = self.clock.target(now).unwrap_or(self.core.time());
                let pong = ServerMsg::Pong {
                    client_time,
                    time: time.max(self.core.time()),
                    paused: self.clock.paused(),
                };
                self.send_to(conn, &pong);
            }
            ClientMsg::Input { seq, input } => {
                if self.drivers.get(&player) != Some(&conn) {
                    return;
                }
                if self.inputs.push(player, seq, input, now) == Taken::DroppedOldest {
                    tracing::debug!(player, "input buffer full; the oldest dropped");
                }
                if self.next_input_tick.is_none() && self.inputs.has_inputs() {
                    let tick = self.inputs.config().tick;
                    let at = self.last_input_tick.map_or(now, |t| (t + tick).max(now));
                    self.next_input_tick = Some(at);
                }
            }
            ClientMsg::TakeControl => self.drive(player, conn),
            ClientMsg::Subscribe { sub, query, .. } => {
                let failed = ServerMsg::QueryFailed {
                    sub,
                    reason: format!("no query {query:?}: this server serves no queries"),
                };
                self.send_to(conn, &failed);
            }
            ClientMsg::SetInterest { .. } => {
                let rejected = ServerMsg::InterestRejected {
                    reason: "this server keeps no interest".into(),
                };
                self.send_to(conn, &rejected);
            }
            ClientMsg::Game(msg) => {
                self.tick(now);
                let mut events = Vec::new();
                let mut out = Outbox::new();
                self.core.game().message(player, msg, &mut events, &mut out);
                self.commit(events);
                self.deliver(out);
            }
            // Nothing to unsubscribe, no entity stream to resync; the
            // session handles `Hello` and `Ack`.
            ClientMsg::Unsubscribe { .. }
            | ClientMsg::EntityResync
            | ClientMsg::Hello { .. }
            | ClientMsg::Ack { .. } => {}
        }
    }

    /// Forgets `conn`. The player's last connection closing ends its
    /// presence; if `conn` drove, the newest one left drives.
    pub(crate) fn disconnect(&mut self, conn: ConnId) {
        let Some(c) = self.conns.remove(&conn) else {
            return;
        };
        let player = c.player;
        let now = Instant::now();
        let left = self.conns_of.get_mut(&player).map(|conns| {
            conns.retain(|id| *id != conn);
            conns.last().copied()
        });
        match left.flatten() {
            Some(newest) => {
                if self.drivers.get(&player) == Some(&conn) {
                    self.drive(player, newest);
                }
            }
            None => {
                self.conns_of.remove(&player);
                self.drivers.remove(&player);
                self.inputs.leave(player);
                self.tick(now);
                let mut events = Vec::new();
                self.core.game().presence(player, false, &mut events);
                self.commit(events);
                tracing::info!(conn, player, "left");
            }
        }
        self.publish_status(now);
    }
}
