//! [`Driver`]: a [`Sim`] run in-process by hand, with no sockets or
//! threads: connections are tc-net outbound queues the caller reads, and
//! time moves only when the caller ticks. For tests, bots and tools.

use std::sync::Arc;
use std::time::Instant;

use tc_net::outbound::{OutboundRx, outbound};
use tc_net::{ClientMsg, ConnId, Identity, Protocol, Request, ServerMsg};
use tc_wire::Wire;
use tokio::sync::Semaphore;

use crate::core::Core;
use crate::game::Game;
use crate::sim::Sim;

/// A [`Sim`] driven by hand. See the [module docs](self).
pub struct Driver<G: Game> {
    sim: Sim<G>,
    next_conn: ConnId,
    permits: Arc<Semaphore>,
}

impl<G: Game> Driver<G> {
    /// Drives `sim`.
    pub fn new(sim: Sim<G>) -> Driver<G> {
        Driver {
            sim,
            next_conn: 1,
            permits: Arc::new(Semaphore::new(Semaphore::MAX_PERMITS)),
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
        self.sim.handle(Request::Connect {
            conn,
            identity: Identity {
                name: name.to_string(),
                permissions: Vec::new(),
            },
            hello,
            out,
        });
        (conn, rx)
    }

    /// A message from `conn`.
    pub fn client(&mut self, conn: ConnId, msg: ClientMsg<G::Protocol>) {
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .expect("the driver's permits never run out");
        self.sim.handle(Request::Client {
            conn,
            msg,
            permit,
            sent: Instant::now(),
        });
    }

    /// Closes `conn`.
    pub fn disconnect(&mut self, conn: ConnId) {
        self.sim.handle(Request::Disconnect { conn });
    }

    /// Catches up with the wall clock at `now` ([`Sim::tick`]).
    pub fn tick(&mut self, now: Instant) {
        self.sim.tick(now);
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
