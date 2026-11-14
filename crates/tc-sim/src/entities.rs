//! The entity stream: each connection that set an interest gets
//! [`Game::entities`] for it as tc-net entity frames
//! ([`tc_net::EntityEncoder`]), each the change from what that connection
//! was last sent.
//!
//! A stream is made by the first accepted `SetInterest` ([`Game::interest`])
//! and reruns at a flush only when it is due: its interest changed, its
//! client asked for a key frame (`EntityResync`), something it read
//! changed (its [`Reads`]), or the game was reloaded. A client over its
//! byte budget is skipped and stays due; its next frame skips the states
//! between. Frames carry the game's time as their tick.
//!
//! Games with many watchers of a large world keep their own reverse index
//! (which watcher reads which area) in their change keys: a stream reads
//! only the keys of what it covers.

use std::collections::BTreeSet;

use tc_net::transport::Frame;
use tc_net::{ConnId, EntityEncoder, ServerMsg};
use tc_wire::{Bytes, Wire};

use crate::game::{Game, InterestOf};
use crate::query::{Key, QueryCtx, Reads};
use crate::sim::{OUTBOUND_BUDGET, Sim};

/// One connection's entity stream.
pub(crate) struct Stream<G: Game> {
    interest: InterestOf<G>,
    encoder: EntityEncoder<G::View>,
    reads: Reads<G::Change>,
    due: bool,
}

impl<G: Game> Stream<G> {
    pub(crate) fn due(&self) -> bool {
        self.due
    }

    pub(crate) fn valid_until(&self) -> Option<u64> {
        self.reads.valid_until
    }

    pub(crate) fn set_due(&mut self) {
        self.due = true;
    }
}

impl<G: Game> Sim<G> {
    /// `SetInterest`: checked by the game, then the stream follows it.
    pub(crate) fn set_interest(&mut self, conn: ConnId, interest: InterestOf<G>) {
        let Some(c) = self.conns.get(&conn) else {
            return;
        };
        let rejected = |reason: String| ServerMsg::<G::Protocol>::InterestRejected { reason };
        if let Err(reason) = self.core.game().interest(c.player, &interest) {
            self.send_to(conn, &rejected(reason));
            return;
        }
        match self.streams.get_mut(&conn) {
            Some(s) => {
                s.interest = interest;
                s.due = true;
            }
            None => match EntityEncoder::new(&self.schema) {
                Ok(encoder) => {
                    self.streams.insert(
                        conn,
                        Stream {
                            interest,
                            encoder,
                            reads: Reads::default(),
                            due: true,
                        },
                    );
                }
                Err(e) => {
                    self.send_to(conn, &rejected(format!("no entity stream: {e}")));
                    return;
                }
            },
        }
        self.flush_entities(&BTreeSet::new(), false, Some(conn));
    }

    /// `EntityResync`: the next frame is a key frame.
    pub(crate) fn entity_resync(&mut self, conn: ConnId) {
        if let Some(s) = self.streams.get_mut(&conn) {
            s.encoder.resync();
            s.due = true;
        }
        self.flush_entities(&BTreeSet::new(), false, Some(conn));
    }

    /// Sends a frame to each stream (or to `only`) that is due or whose
    /// reads `changed` (or, if volatile, anything changed: `any`).
    pub(crate) fn flush_entities(
        &mut self,
        changed: &BTreeSet<Key<G::Change>>,
        any: bool,
        only: Option<ConnId>,
    ) {
        let time = self.core.time();
        let game = self.core.game();
        let mut things = Vec::new();
        for (conn, s) in &mut self.streams {
            if only.is_some_and(|o| o != *conn) {
                continue;
            }
            if s.reads.stale(changed, any, time) {
                s.due = true;
            }
            let Some(c) = self.conns.get(conn) else {
                continue;
            };
            if !s.due || c.out.queued() > OUTBOUND_BUDGET {
                continue;
            }
            things.clear();
            let cx = QueryCtx::new(game, c.player, time, &self.bodies);
            game.entities(&cx, &s.interest, &mut things);
            s.reads = cx.into_reads();
            s.due = false;
            if let Some(frame) = s.encoder.frame(time, things.iter().map(|(id, v)| (*id, v))) {
                let msg = ServerMsg::<G::Protocol>::EntityStream { data: Bytes(frame) };
                c.send_frame(Frame::from(msg.to_bytes()));
            }
        }
    }

    /// Forgets `conn`'s stream.
    pub(crate) fn drop_stream(&mut self, conn: ConnId) {
        self.streams.remove(&conn);
    }

    /// Every stream sends a frame at the next flush (a reload).
    pub(crate) fn streams_due(&mut self) {
        for s in self.streams.values_mut() {
            s.set_due();
        }
    }

    /// The earliest time a stream's frame runs out.
    pub(crate) fn streams_expiry(&self) -> Option<u64> {
        self.streams.values().filter_map(Stream::valid_until).min()
    }

    /// True if a stream waits for a flush.
    pub(crate) fn streams_waiting(&self) -> bool {
        self.streams.values().any(Stream::due)
    }
}
