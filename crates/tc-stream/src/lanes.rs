//! Where the stream's frames go ([`Lanes`]): each connection's priority
//! and bulk lanes. tc-net's [`Outbound`]s are lanes as they are; tests use
//! their own.

use std::collections::{BTreeMap, HashMap};

use tc_net::flow::BULK_HIGH_WATER;
use tc_net::{BulkTicket, ConnId, Outbound};

/// Where the stream sends: every connection's lanes.
pub trait Lanes {
    /// Queues a frame in the priority lane (a held section's change);
    /// false if it could not be queued.
    fn send(&mut self, conn: ConnId, frame: Vec<u8>) -> bool;
    /// Queues a frame in the bulk lane, with the ticket the session checks
    /// before writing it; false if it could not be queued.
    fn send_bulk(&mut self, conn: ConnId, frame: Vec<u8>, ticket: Option<BulkTicket>) -> bool;
    /// Bytes waiting in the bulk lane.
    fn bulk_queued(&self, conn: ConnId) -> usize;
    /// No new sections are queued while the bulk lane holds this many
    /// bytes (the session's pacing may lower it).
    fn bulk_high_water(&self, _conn: ConnId) -> usize {
        BULK_HIGH_WATER
    }
    /// True if the connection is too far behind for changes now: they wait
    /// for a later flush.
    fn behind(&self, _conn: ConnId) -> bool {
        false
    }
    /// Called once a [`flush`](crate::SectionStream::flush) has queued
    /// every connection's changes and unloads, before it builds new
    /// sections. A game that holds its sessions' wakes through its flush
    /// ([`Outbound::hold`]: query updates, entity frames and section
    /// changes written in one wake) lets them write here, not after the
    /// loads. Does nothing by default; tc-net's `Outbound` maps release
    /// held wakes ([`Outbound::release`], nothing when none are held).
    fn edits_queued(&mut self) {}
}

/// The priority lane's backlog past which changes wait.
pub const BEHIND_BYTES: usize = 1 << 20;

fn send(out: Option<&Outbound>, frame: Vec<u8>) -> bool {
    out.is_some_and(|o| o.try_send(frame).is_ok())
}

fn bulk(out: Option<&Outbound>, frame: Vec<u8>, ticket: Option<BulkTicket>) -> bool {
    out.is_some_and(|o| o.try_send_bulk(frame, ticket))
}

macro_rules! outbound_lanes {
    ($map:ident) => {
        impl Lanes for $map<ConnId, Outbound> {
            fn send(&mut self, conn: ConnId, frame: Vec<u8>) -> bool {
                send(self.get(&conn), frame)
            }

            fn send_bulk(
                &mut self,
                conn: ConnId,
                frame: Vec<u8>,
                ticket: Option<BulkTicket>,
            ) -> bool {
                bulk(self.get(&conn), frame, ticket)
            }

            fn bulk_queued(&self, conn: ConnId) -> usize {
                self.get(&conn).map_or(0, Outbound::bulk_queued)
            }

            fn bulk_high_water(&self, conn: ConnId) -> usize {
                self.get(&conn)
                    .and_then(Outbound::bulk_high_water)
                    .unwrap_or(BULK_HIGH_WATER)
            }

            fn behind(&self, conn: ConnId) -> bool {
                self.get(&conn).is_some_and(|o| o.queued() > BEHIND_BYTES)
            }

            fn edits_queued(&mut self) {
                for o in self.values() {
                    o.release();
                }
            }
        }
    };
}

outbound_lanes!(BTreeMap);
outbound_lanes!(HashMap);
