//! [`Driver`]: a [`Sim`] run in-process by hand, with no sockets or
//! threads: connections are tc-net outbound queues the caller reads, and
//! time moves only when the caller ticks. For tests, bots and tools.
//!
//! **Its clock.** A driver keeps its own instant, which moves only when
//! the caller says ([`Driver::wait`], [`Driver::input_tick`], or
//! [`Driver::tick`] with a later instant); every request is handled at
//! it. So a test feeds inputs with [`Driver::push_input`] and takes them
//! with [`Driver::input_tick`], with no wall-clock instants of its own.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tc_net::outbound::{OutboundRx, outbound};
use tc_net::{ClientMsg, ConnId, Identity, Protocol, Request, ServerMsg};
use tc_wire::Wire;
use tokio::sync::Semaphore;

use crate::core::Core;
use crate::game::Game;
use crate::sim::Sim;

/// A [`Sim`] driven by hand. See the [crate docs](crate).
pub struct Driver<G: Game> {
    sim: Sim<G>,
    next_conn: ConnId,
    permits: Arc<Semaphore>,
    now: Instant,
    seqs: BTreeMap<ConnId, u32>,
}

impl<G: Game> Driver<G> {
    /// Drives `sim`.
    pub fn new(sim: Sim<G>) -> Driver<G> {
        Driver {
            sim,
            next_conn: 1,
            permits: Arc::new(Semaphore::new(Semaphore::MAX_PERMITS)),
            now: Instant::now(),
            seqs: BTreeMap::new(),
        }
    }

    /// The sim.
    pub fn sim(&self) -> &Sim<G> {
        &self.sim
    }

    /// The sim, mutably (pause, advance, reload...).
    pub fn sim_mut(&mut self) -> &mut Sim<G> {
        &mut self.sim
    }

    /// The core.
    pub fn core(&self) -> &Core<G> {
        self.sim.core()
    }

    /// Opens a connection as `name` with `hello`: its id, and the queue
    /// its frames arrive on.
    pub fn connect(
        &mut self,
        name: &str,
        hello: <G::Protocol as Protocol>::Hello,
    ) -> (ConnId, OutboundRx) {
        let conn = self.next_conn;
        self.next_conn += 1;
        let (out, rx) = outbound();
        self.sim.handle_at(
            Request::Connect {
                conn,
                identity: Identity {
                    name: name.to_string(),
                    permissions: Vec::new(),
                },
                hello,
                out,
            },
            self.now,
        );
        (conn, rx)
    }

    /// A message from `conn`.
    pub fn client(&mut self, conn: ConnId, msg: ClientMsg<G::Protocol>) {
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .expect("the driver's permits never run out");
        self.sim.handle_at(
            Request::Client {
                conn,
                msg,
                permit,
                sent: self.now,
            },
            self.now,
        );
    }

    /// Closes `conn`.
    pub fn disconnect(&mut self, conn: ConnId) {
        self.sim.handle_at(Request::Disconnect { conn }, self.now);
        self.seqs.remove(&conn);
    }

    /// The driver's clock (see the [module docs](self)).
    pub fn now(&self) -> Instant {
        self.now
    }

    /// Moves the driver's clock to `now` (never back) and catches up with
    /// it ([`Sim::tick`]).
    pub fn tick(&mut self, now: Instant) {
        self.now = self.now.max(now);
        self.sim.tick(self.now);
    }

    /// Moves the driver's clock on by `by` and catches up with it.
    pub fn wait(&mut self, by: Duration) {
        self.tick(self.now + by);
    }

    /// Queues `input` from `conn` (`ClientMsg::Input`, with the next
    /// `seq` for that connection, which it returns). The input is taken
    /// at the next input tick ([`Driver::input_tick`]).
    pub fn push_input(&mut self, conn: ConnId, input: <G::Protocol as Protocol>::Input) -> u32 {
        let seq = self.seqs.entry(conn).or_insert(0);
        *seq += 1;
        let seq = *seq;
        self.client(conn, ClientMsg::Input { seq, input });
        seq
    }

    /// Moves the clock on by one input tick, which takes the inputs
    /// waiting ([`Game::input`], then [`Game::moved`]).
    pub fn input_tick(&mut self) {
        let tick = self.sim.inputs.config().tick;
        self.wait(tick);
    }

    /// Jumps `steps` ahead ([`Sim::advance`]).
    pub fn advance(&mut self, steps: u64) -> Result<u64, String> {
        self.sim.advance(steps)
    }

    /// Every message waiting on `rx`, decoded.
    pub fn received(rx: &mut OutboundRx) -> Vec<ServerMsg<G::Protocol>> {
        let mut msgs = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            match ServerMsg::from_bytes(&frame) {
                Ok(msg) => msgs.push(msg),
                Err(e) => panic!("a frame that doesn't decode: {e:?}"),
            }
        }
        msgs
    }

    /// Stops the sim ([`Sim::stop`]): the core.
    pub fn stop(self) -> Core<G> {
        self.sim.stop()
    }
}
