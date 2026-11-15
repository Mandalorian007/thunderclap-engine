//! Between ticks: [`Conns`] (each connection's outbound lanes, for a game
//! that streams its own bytes), [`IdleCx`] and [`Game::idle`], and the
//! bulk lane's wakes.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use tc_net::outbound::BULK_LINGER;
use tc_net::transport::Frame;
use tc_net::{BulkTicket, ConnId};
use tc_wire::hash::StableHasher;
use tracing::warn;

use crate::counters::micros;
use crate::game::{Game, PlayerId};
use crate::sim::{Conn, OUTBOUND_BUDGET, Sim};

/// While the game has idle work ([`Game::idle_work`]), [`Sim::run`] comes
/// back for more at least this often, even with nothing else due.
pub const IDLE_RETRY: Duration = Duration::from_millis(10);

/// The connections, as a game that writes its own bytes sees them: a
/// priority lane (every message but bulk data; never waits behind bulk)
/// and a bulk lane with backpressure, per connection
/// ([`tc_net::Outbound`]). From [`IdleCx::conns`] and
/// [`LiveCx::conns`](crate::LiveCx::conns).
///
/// Bulk frames gather: the loop wakes each connection's session for them
/// before it waits (after [`BULK_LINGER`] while
/// [`Game::bulk_lingers`] says more are coming), or once
/// `tc_net::outbound::BULK_WAKE_BYTES` gathered.
pub struct Conns<'a> {
    pub(crate) conns: &'a BTreeMap<ConnId, Conn>,
    pub(crate) conns_of: &'a BTreeMap<PlayerId, Vec<ConnId>>,
    pub(crate) bulk_sent: &'a Cell<bool>,
}

impl Conns<'_> {
    /// Every connection, in id order, with its player (`None`: an
    /// observer).
    pub fn iter(&self) -> impl Iterator<Item = (ConnId, Option<PlayerId>)> + '_ {
        self.conns.iter().map(|(id, c)| (*id, c.player))
    }

    /// `conn`'s player: `None` for an observer or a connection gone.
    pub fn player(&self, conn: ConnId) -> Option<PlayerId> {
        self.conns.get(&conn)?.player
    }

    /// `player`'s connections, in id order.
    pub fn of(&self, player: PlayerId) -> &[ConnId] {
        self.conns_of.get(&player).map_or(&[], Vec::as_slice)
    }

    /// Queues `frame` (an encoded `ServerMsg`) on `conn`'s priority lane;
    /// false if the connection is gone or closing (its queue filled, and
    /// it is dropped at the end of the tick).
    pub fn send(&self, conn: ConnId, frame: impl Into<Frame>) -> bool {
        let Some(c) = self.conns.get(&conn) else {
            return false;
        };
        c.send_frame(frame.into());
        !c.overflowed.get()
    }

    /// Queues `frame` on `conn`'s bulk lane, written unless `ticket` is
    /// withdrawn first; false if the lane is full or the connection gone
    /// (try again later: nothing was queued).
    pub fn send_bulk(&self, conn: ConnId, frame: Vec<u8>, ticket: Option<BulkTicket>) -> bool {
        let sent = self
            .conns
            .get(&conn)
            .is_some_and(|c| !c.overflowed.get() && c.out.try_send_bulk(frame, ticket));
        if sent {
            self.bulk_sent.set(true);
        }
        sent
    }

    /// Bytes on `conn`'s priority lane not yet written (`usize::MAX` if it
    /// is gone).
    pub fn queued(&self, conn: ConnId) -> usize {
        self.conns.get(&conn).map_or(usize::MAX, |c| c.out.queued())
    }

    /// Bytes on `conn`'s bulk lane not yet written (`usize::MAX` if it is
    /// gone).
    pub fn bulk_queued(&self, conn: ConnId) -> usize {
        self.conns
            .get(&conn)
            .map_or(usize::MAX, |c| c.out.bulk_queued())
    }

    /// The most bulk bytes `conn`'s session wants queued, if its flow
    /// control set it: queue more only while
    /// [`Conns::bulk_queued`] is under it (the game picks its own
    /// default without one).
    pub fn bulk_high_water(&self, conn: ConnId) -> Option<usize> {
        self.conns.get(&conn)?.out.bulk_high_water()
    }

    /// True if `conn` is gone, closing, or over its byte budget
    /// ([`OUTBOUND_BUDGET`](crate::OUTBOUND_BUDGET)) on the priority lane:
    /// hold back what can wait.
    pub fn behind(&self, conn: ConnId) -> bool {
        self.conns
            .get(&conn)
            .is_none_or(|c| c.overflowed.get() || c.out.queued() > OUTBOUND_BUDGET)
    }

    /// Releases every connection's held priority frames now
    /// (`tc_net::Outbound::release`): what was queued must not wait for
    /// the loop's next pass (a world edit others should see at once).
    pub fn release_all(&self) {
        for c in self.conns.values() {
            c.out.release();
        }
    }
}

/// What [`Game::idle`] may touch: the times, the bodies, the connections,
/// its budget and whether a client's message is waiting.
pub struct IdleCx<'a, G: Game> {
    pub(crate) time: u64,
    pub(crate) version: u64,
    pub(crate) now: Instant,
    pub(crate) until: Instant,
    pub(crate) late: Duration,
    pub(crate) bodies: &'a BTreeMap<PlayerId, G::Body>,
    pub(crate) conns: Conns<'a>,
    pub(crate) interrupted: &'a mut dyn FnMut() -> bool,
}

impl<G: Game> IdleCx<'_, G> {
    /// The game's time, in steps.
    pub fn time(&self) -> u64 {
        self.time
    }

    /// The last log entry applied.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The wall clock when the idle pass started.
    pub fn now(&self) -> Instant {
        self.now
    }

    /// When to return by: the loop's next deadline less its margin
    /// ([`SimConfig::idle_margin`](crate::SimConfig::idle_margin)).
    pub fn until(&self) -> Instant {
        self.until
    }

    /// True once a client's message is waiting: return as soon as you
    /// can (the loop handles it, ticks, and comes back).
    pub fn interrupted(&mut self) -> bool {
        (self.interrupted)()
    }

    /// How late the loop woke last time it slept to a deadline: the
    /// machine is short of CPU when this grows, and idle work should hold
    /// back (return early, do less).
    pub fn late(&self) -> Duration {
        self.late
    }

    /// `player`'s body, if it is present.
    pub fn body(&self, player: PlayerId) -> Option<&G::Body> {
        self.bodies.get(&player)
    }

    /// Every present body, by player id.
    pub fn bodies(&self) -> impl Iterator<Item = (PlayerId, &G::Body)> {
        self.bodies.iter().map(|(p, b)| (*p, b))
    }

    /// The connections, to queue bytes on.
    pub fn conns(&self) -> &Conns<'_> {
        &self.conns
    }
}

fn game_hash<G: Game>(game: &G) -> u64 {
    let mut h = StableHasher::new();
    game.hash_state(&mut h);
    h.finish()
}

impl<G: Game> Sim<G> {
    /// Gives the game the time until `until` for its idle work
    /// ([`Game::idle`]), if it has any; `interrupted` says a client's
    /// message waits. [`Sim::run`](crate::Sim::run) calls it before it
    /// waits; a loop of the game's own calls it the same way. Returns the
    /// time spent.
    pub fn idle(&mut self, until: Instant, interrupted: &mut dyn FnMut() -> bool) -> Duration {
        let started = Instant::now();
        if started >= until || !self.core.game().idle_work() {
            return Duration::ZERO;
        }
        let before = self.verify_live.then(|| game_hash(self.core.game()));
        let time = self.core.time();
        let version = self.core.version();
        {
            let (game, _) = self.core.live_parts();
            let mut cx = IdleCx {
                time,
                version,
                now: started,
                until,
                late: self.late,
                bodies: &self.bodies,
                conns: Conns {
                    conns: &self.conns,
                    conns_of: &self.conns_of,
                    bulk_sent: &self.bulk_sent,
                },
                interrupted,
            };
            game.idle(&mut cx);
        }
        if let Some(before) = before
            && game_hash(self.core.game()) != before
        {
            self.counters.live_misses += 1;
            if self.counters.live_misses == 1 {
                warn!("the idle hook changed the hashed state (a game bug)");
            }
        }
        self.poll_record_error();
        self.counters.idles += 1;
        self.counters.idle_us += micros(started);
        started.elapsed()
    }

    /// Wakes every connection's session for the bulk frames queued since
    /// the last pass (holding back, for at most [`BULK_LINGER`], those of
    /// a connection whose view is still filling: [`Game::bulk_lingers`]).
    /// The loop calls it before it waits.
    pub fn wake_outbound(&mut self, now: Instant) {
        if !self.bulk_sent.get() {
            return;
        }
        let mut lingering = false;
        for (id, c) in &self.conns {
            let more = self.core.game().bulk_lingers(*id);
            c.out.wake_lingering(now, more);
            lingering |= more;
        }
        self.bulk_sent.set(lingering);
        self.next_linger = lingering.then_some(now + BULK_LINGER);
    }
}
