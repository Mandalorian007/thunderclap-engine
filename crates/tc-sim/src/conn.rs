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
//! connection makes its body ([`Game::body`]) and calls
//! [`Game::presence`] with `true`, its last one closing calls it with
//! `false` and the body it leaves.
//!
//! **Observers** ([`Seat::Observer`]) are never present and only watch:
//! their commands get [`Game::command_error`], their inputs, control and
//! game messages are dropped, and a per-player query is refused.

use std::time::Instant;

use tc_net::transport::Frame;
use tc_net::{ClientMsg, ConnId, Identity, Outbound, Protocol, Request, ServerMsg};
use tc_wire::Wire;

use crate::game::{Game, Outbox, PlayerId, Seat};
use crate::input::Taken;
use crate::query::{Query, ViewCx};
use crate::sim::{Conn, Sim};

impl<G: Game> Sim<G> {
    /// Handles one request from tc-net.
    pub fn handle(&mut self, request: Request<G::Protocol>) {
        self.handle_at(request, Instant::now());
    }

    /// [`Sim::handle`] as if it arrived at `now` (a test's clock).
    pub fn handle_at(&mut self, request: Request<G::Protocol>, now: Instant) {
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
            Request::Wake => {}
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
        let seat = match self.core.game().join(identity, hello, &mut events) {
            Ok(seat) => seat,
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
        if let Err(reason) = self.commit(events) {
            let rejected = ServerMsg::<G::Protocol>::Rejected {
                reason,
                stale_schema: false,
            };
            let _ = out.try_send(rejected.to_bytes());
            return;
        }
        let player = match seat {
            Seat::Player(player) => Some(player),
            Seat::Observer => None,
        };
        if let Some(player) = player
            && !self.conns_of.contains_key(&player)
        {
            let body = self.core.game().body(player);
            let mut events = Vec::new();
            self.core
                .game()
                .presence(player, true, body.as_ref(), &mut events);
            let _ = self.commit(events);
            if let Some(body) = body {
                self.bodies.insert(player, body);
                self.moved.insert(player);
            }
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
        self.sync.connect(conn, player);
        let id = player.unwrap_or(0);
        let welcome = ServerMsg::<G::Protocol>::Welcome {
            player: id,
            time: self.core.time(),
            paused: self.clock.paused(),
            step_us: self.clock.step_us(),
            ext: self.core.game().welcome(id),
        };
        let mut greeting = vec![welcome];
        if let Some(player) = player {
            self.core.game().greet(player, &mut greeting);
        }
        if let Some(c) = self.conns.get(&conn) {
            for msg in greeting {
                c.send_frame(Frame::from(msg.to_bytes()));
            }
        }
        if let Some(player) = player {
            self.conns_of.entry(player).or_default().push(conn);
            self.drive(player, conn);
            // A game whose streams follow the body: this connection's
            // starts now.
            if self.follow(player) {
                self.flush_entities(&Default::default(), false, Some(conn));
            }
        }
        tracing::info!(conn, player = id, name = %identity.name, "joined");
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

    pub(crate) fn send_to(&self, conn: ConnId, msg: &ServerMsg<G::Protocol>) {
        if let Some(c) = self.conns.get(&conn) {
            c.send_frame(Frame::from(msg.to_bytes()));
        }
    }

    fn client(&mut self, conn: ConnId, msg: ClientMsg<G::Protocol>, now: Instant) {
        let Some(seat) = self.conns.get(&conn).map(|c| c.player) else {
            return;
        };
        match msg {
            ClientMsg::Subscribe {
                sub,
                query,
                args,
                resume,
            } => {
                self.tick(now);
                let cx = ViewCx {
                    game: self.core.game(),
                    player: seat,
                    interest: self.streams.get(&conn).map(|s| &s.interest),
                };
                let view = |q: &Query<G>, args: &[u8]| q.view_of(&cx, args);
                match self
                    .sync
                    .subscribe(conn, sub, (&query, args.0), resume.as_ref(), now, view)
                {
                    Ok(()) => self.flush(Some(conn)),
                    Err(reason) => self.send_to(conn, &ServerMsg::QueryFailed { sub, reason }),
                }
                self.schedule_flush(now);
                return;
            }
            ClientMsg::Unsubscribe { sub } => {
                self.sync.unsubscribe(conn, sub, now);
                return;
            }
            ClientMsg::SetInterest { interest } => {
                self.tick(now);
                self.set_interest(conn, interest);
                return;
            }
            ClientMsg::EntityResync => {
                self.entity_resync(conn);
                return;
            }
            ClientMsg::Ping { client_time } => {
                let time = self.clock.target(now).unwrap_or(self.core.time());
                let pong = ServerMsg::Pong {
                    client_time,
                    time: time.max(self.core.time()),
                    paused: self.clock.paused(),
                };
                self.send_to(conn, &pong);
                return;
            }
            _ => {}
        }
        let Some(player) = seat else {
            // An observer only watches.
            if let ClientMsg::Command { seq, .. } = msg {
                let result = self
                    .core
                    .game()
                    .command_error("an observer can't act".into());
                self.send_to(conn, &ServerMsg::CommandResult { seq, result });
            }
            return;
        };
        match msg {
            ClientMsg::Command { seq, command } => {
                self.tick(now);
                self.counters.commands += 1;
                let result = if let Some(e) = &self.store_error {
                    let reason = format!("the server can't save: {e}");
                    self.core.game().command_error(reason)
                } else {
                    let started = Instant::now();
                    let (result, applied) =
                        self.run_live(now, |game, cx| game.act(cx, player, command));
                    self.counters.live_us += crate::counters::micros(started);
                    match applied {
                        Ok(()) => result,
                        Err(reason) => self.core.game().command_error(reason),
                    }
                };
                // Read your writes: what the command changed goes out
                // before its result.
                self.flush_all();
                if self.close_slow_senders && self.behind_with_effects(conn) {
                    self.counters.closed_slow += 1;
                    tracing::info!(
                        conn,
                        "closing: over its byte budget with a command's effects to send"
                    );
                    if let Some(c) = self.conns.get(&conn) {
                        c.overflowed.set(true);
                    }
                    self.drop_overflowed();
                    return;
                }
                self.send_to(conn, &ServerMsg::CommandResult { seq, result });
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
            ClientMsg::Game(msg) => {
                if let Some(lane) = self.core.game().lane(&msg)
                    && let Some(rule) = self.lanes.get(lane)
                    && !self.budgets.take(player, lane, rule, now)
                {
                    self.limited += 1;
                    tracing::debug!(player, lane = rule.name, "over its lane's budget; dropped");
                    return;
                }
                self.tick(now);
                let mut events = Vec::new();
                let mut out = Outbox::new();
                self.core.game().message(player, msg, &mut events, &mut out);
                let _ = self.commit(events);
                self.deliver(out);
            }
            // Handled above, or by the session (`Hello`, `Ack`).
            _ => {}
        }
    }

    /// True if `conn` is over its byte budget and the flush skipped live
    /// query results it waits for.
    fn behind_with_effects(&self, conn: ConnId) -> bool {
        self.conns
            .get(&conn)
            .is_some_and(|c| c.out.queued() > crate::sim::OUTBOUND_BUDGET)
            && self.sync.pending(conn)
    }

    /// Forgets `conn`. The player's last connection closing ends its
    /// presence; if `conn` drove, the newest one left drives.
    pub(crate) fn disconnect(&mut self, conn: ConnId) {
        let Some(c) = self.conns.remove(&conn) else {
            return;
        };
        let now = Instant::now();
        self.sync.disconnect(conn, now);
        self.drop_stream(conn);
        let Some(player) = c.player else {
            tracing::info!(conn, "an observer left");
            self.publish_status(now);
            return;
        };
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
                self.budgets.forget(player);
                self.tick(now);
                let body = self.bodies.remove(&player);
                self.moved.insert(player);
                let mut events = Vec::new();
                self.core
                    .game()
                    .presence(player, false, body.as_ref(), &mut events);
                let _ = self.commit(events);
                tracing::info!(conn, player, "left");
            }
        }
        self.publish_status(now);
    }
}
