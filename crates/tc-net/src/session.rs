//! One client connection, from `Hello` to close. Generic over
//! [`Transport`] (it knows nothing about WebSocket) and over the game's
//! [`Protocol`].
//!
//! The first frame must be `Hello` with the server's schema hash and a
//! token [`Auth`] accepts; otherwise the session sends `Rejected` and
//! closes (`stale_schema` when the hashes differ, so a page reloads for
//! the new build). After that it hands decoded messages to the game
//! ([`Request`]) and writes whatever the game queues for it ([`Outbound`]),
//! in order. `Welcome` is the game's to send, on [`Request::Connect`].
//!
//! A client that takes a bulk lane (`Hello.bulk`) gets each write's bulk
//! frames as one `Bulk` message after the write's priority frames, instead
//! of a WebSocket message each: a browser pays for every message on its
//! main thread. One that takes [`codec::DEFLATE`] gets each `Bulk` over 1
//! KiB compressed, by [`crate::deflate`]'s threads.
//!
//! The client acknowledges each `Bulk` it takes (`Ack { bytes }`, the
//! `Bulk`'s data length); from the first ack the session paces the bulk
//! lane to the link: it keeps no more in flight than [`crate::flow`]'s
//! window, so what the priority lane writes meets a short queue on the
//! way. The session takes acks itself; they never reach the game and
//! aren't rate-limited.
//!
//! A session has at most [`SESSION_REQUESTS`] messages waiting for the
//! game; past that it stops reading from the client until the game
//! catches up. It also stops reading while the client is over its message
//! rates ([`crate::rate`]).
//!
//! Connections not yet past `Hello` are capped separately ([`Pending`]):
//! when a new one would go over the cap, the oldest is closed, so idle
//! sockets that never send `Hello` can't lock real clients out.

use std::collections::BTreeMap;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tc_wire::{Reader, Wire};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch};
use tokio::time::Instant;
use tracing::{debug, info};

use crate::auth::{Auth, Identity, clip};
use crate::envelope::{ClientMsg, Protocol, ServerMsg, close, codec};
use crate::flow::{BULK_HIGH_WATER, Flow};
use crate::outbound::{self, Batch, Outbound, Ready};
use crate::rate::{Kind, Limiter, Rates};
use crate::stats::IoCounters;
use crate::transport::{Frame, Transport};

/// A connection's id: unique for the server's life, never reused.
pub type ConnId = u64;

/// How long a new connection has, from being accepted, to finish the
/// WebSocket handshake and send `Hello`.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// Connections at once that haven't sent `Hello` yet; past this the
/// oldest of them is closed.
pub const MAX_PENDING: usize = 32;

/// Messages one session may have waiting for the game.
pub const SESSION_REQUESTS: usize = 64;

/// How long writing one batch of frames may take before the client counts
/// as gone.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// The most bulk data one write takes from the bulk lane (it takes every
/// priority frame first), without flow control: enough that a burst goes
/// out in a few writes, little enough that the session soon reads its
/// client again.
pub const BATCH_BYTES: usize = 64 * 1024;

/// Sent to clients when the game's thread dies.
pub const GAME_CRASHED: &str = "the server stopped unexpectedly";

/// What a session asks of the game, in order per connection.
#[derive(Debug)]
pub enum Request<P: Protocol> {
    /// A client passed `Hello`. The game answers with `Welcome` (or
    /// `Closed`) on `out`, and keeps `out` for as long as it serves the
    /// connection; dropping it closes the connection.
    Connect {
        /// The connection.
        conn: ConnId,
        /// Who it is ([`Auth::verify`]).
        identity: Identity,
        /// `Hello`'s game fields.
        hello: P::Hello,
        /// Where the game queues the connection's frames.
        out: Outbound,
    },
    /// A message from the client (never `Hello` or `Ack`).
    Client {
        /// The connection.
        conn: ConnId,
        /// The message.
        msg: ClientMsg<P>,
        /// One of the session's [`SESSION_REQUESTS`] places: drop it once
        /// the message is handled, so the session reads on.
        permit: OwnedSemaphorePermit,
        /// When the session handed it on.
        sent: std::time::Instant,
    },
    /// The connection closed; nothing more comes from it.
    Disconnect {
        /// The connection.
        conn: ConnId,
    },
}

/// Whether the game is still taking requests, as sessions see it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameState {
    /// Taking requests.
    Running,
    /// Stopped on purpose.
    Stopped,
    /// Died: sessions tell their clients ([`GAME_CRASHED`]).
    Crashed,
}

/// Limits on connections.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Connections open at once, counting those not yet past `Hello`;
    /// more are closed as soon as they are accepted.
    pub max_connections: usize,
    /// See [`MAX_PENDING`].
    pub max_pending: usize,
    /// See [`HELLO_TIMEOUT`].
    pub hello_timeout: Duration,
    /// See [`crate::ws::PING_INTERVAL`].
    pub ping_interval: Duration,
    /// See [`crate::ws::PONG_TIMEOUT`].
    pub pong_timeout: Duration,
    /// Each connection's message rates.
    pub rates: Rates,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_connections: 1024,
            max_pending: MAX_PENDING,
            hello_timeout: HELLO_TIMEOUT,
            ping_interval: crate::ws::PING_INTERVAL,
            pong_timeout: crate::ws::PONG_TIMEOUT,
            rates: Rates::default(),
        }
    }
}

/// What every session shares.
pub struct SessionContext<P: Protocol> {
    /// The schema hash clients must match.
    pub schema_hash: Arc<str>,
    /// Verifies tokens.
    pub auth: Arc<dyn Auth>,
    /// The game's request queue.
    pub game: Sender<Request<P>>,
    /// Becomes true when the server shuts down.
    pub shutdown: watch::Receiver<bool>,
    /// Whether the game is still running.
    pub game_state: watch::Receiver<GameState>,
    /// Each connection's message rates.
    pub rates: Rates,
    /// Counters of the work.
    pub io: Arc<IoCounters>,
    /// Compresses bulk data for clients that take it so.
    pub deflate: crate::deflate::Deflater,
}

impl<P: Protocol> Clone for SessionContext<P> {
    fn clone(&self) -> Self {
        SessionContext {
            schema_hash: self.schema_hash.clone(),
            auth: self.auth.clone(),
            game: self.game.clone(),
            shutdown: self.shutdown.clone(),
            game_state: self.game_state.clone(),
            rates: self.rates,
            io: self.io.clone(),
            deflate: self.deflate.clone(),
        }
    }
}

impl<P: Protocol> SessionContext<P> {
    fn game_crashed(&self) -> bool {
        *self.game_state.borrow() == GameState::Crashed
    }
}

/// The connections not yet past `Hello`, oldest first, each with a way to
/// close it.
#[derive(Debug)]
pub struct Pending {
    max: usize,
    conns: Mutex<BTreeMap<ConnId, oneshot::Sender<()>>>,
}

impl Pending {
    /// Room for `max` connections at once.
    pub fn new(max: usize) -> Arc<Pending> {
        Arc::new(Pending {
            max,
            conns: Mutex::default(),
        })
    }

    /// Adds a new connection (ids only grow), closing the oldest if that
    /// goes over the cap.
    pub fn add(self: &Arc<Pending>, conn: ConnId) -> PendingSlot {
        let (evict, evicted) = oneshot::channel();
        let mut conns = self.lock();
        while conns.len() >= self.max.max(1) {
            let Some((old, evict)) = conns.pop_first() else {
                break;
            };
            debug!(
                conn = old,
                "closing: too many connections waiting to send Hello"
            );
            let _ = evict.send(());
        }
        conns.insert(conn, evict);
        PendingSlot {
            pending: self.clone(),
            conn,
            evicted,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<ConnId, oneshot::Sender<()>>> {
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// One connection's place in [`Pending`]; dropping it frees the place.
#[derive(Debug)]
pub struct PendingSlot {
    pending: Arc<Pending>,
    conn: ConnId,
    evicted: oneshot::Receiver<()>,
}

impl PendingSlot {
    /// Resolves if the connection is closed to make room for a newer one.
    pub async fn evicted(&mut self) {
        if (&mut self.evicted).await.is_err() {
            // Never evicted: only dropping the slot removes it otherwise.
            std::future::pending::<()>().await;
        }
    }
}

impl Drop for PendingSlot {
    fn drop(&mut self) {
        self.pending.lock().remove(&self.conn);
    }
}

/// Runs one connection to completion. `Hello` must arrive by
/// `hello_deadline`; until it does, the connection holds `pending` and is
/// closed if that is evicted.
pub async fn run<T: Transport, P: Protocol>(
    mut transport: T,
    conn: ConnId,
    mut ctx: SessionContext<P>,
    hello_deadline: Instant,
    mut pending: PendingSlot,
) {
    let first = tokio::select! {
        first = tokio::time::timeout_at(hello_deadline, transport.recv()) => Some(first),
        () = stopped(&mut ctx.shutdown) => None,
        () = pending.evicted() => None,
    };
    drop(pending);
    // Taken before the token is checked, so a change after the check is
    // seen.
    let mut revisions = ctx.auth.revisions();
    let Some(first) = first else {
        transport.close().await;
        return;
    };
    let first = match first {
        Ok(Ok(Some(frame))) => frame,
        Ok(Ok(None)) => return,
        Ok(Err(e)) => {
            debug!(conn, "connection failed before Hello: {e}");
            transport.close().await;
            return;
        }
        Err(_) => {
            reject::<_, P>(&mut transport, conn, "timed out waiting for Hello", false).await;
            return;
        }
    };
    let Hello {
        token,
        identity,
        bulk,
        ext,
    } = match hello::<P>(&first, &ctx.schema_hash, ctx.auth.as_ref()) {
        Ok(hello) => hello,
        Err((reason, stale_schema)) => {
            reject::<_, P>(&mut transport, conn, &reason, stale_schema).await;
            return;
        }
    };

    let (out_tx, mut out_rx) = outbound::outbound();
    let mut batch = Batch::default();
    let connect = Request::Connect {
        conn,
        identity,
        hello: ext,
        out: out_tx,
    };
    if ctx.game.send(connect).is_err() {
        reject::<_, P>(&mut transport, conn, GAME_CRASHED, false).await;
        return;
    }
    let requests = Arc::new(Semaphore::new(SESSION_REQUESTS));
    let mut limiter = Limiter::new(ctx.rates, Instant::now());
    let mut throttled = false;
    // Flow control on the bulk lane, from the client's first ack; without
    // it bulk data is written as fast as it is queued.
    let mut flow: Option<Flow> = None;
    // Bulk data written since `Hello`, as written (compressed), and acked:
    // each `Ack` names one `Bulk`'s data.
    let mut bulk_sent: u64 = 0;
    let mut bulk_acked: u64 = 0;
    // How many times smaller this client's bulk data is on the wire.
    let mut ratio = Ratio::default();

    loop {
        // Priority lane first, then the client's messages, then bulk data:
        // query updates and command results never wait behind it. Each
        // write takes everything queued (bulk data up to `BATCH_BYTES`, or
        // the flow's batch) and flushes once. With flow control, bulk data
        // waits for room in the window and for its pace. The pace is armed
        // even with nothing queued: bulk data queued while it holds the
        // bulk branch off must find it on again when it allows. A client
        // that doesn't ack reads no clock here.
        let (may_write, paced) = match &flow {
            None => (true, None),
            Some(f) => {
                let now = std::time::Instant::now();
                (f.may_write(now), f.paced_until(now))
            }
        };
        tokio::select! {
            biased;
            ready = out_rx.ready(false) => match ready {
                Ready::Frames => {
                    out_rx.take(&mut batch, 0);
                    if !send(&mut transport, conn, &mut batch, &ctx.io).await {
                        break;
                    }
                }
                // The game closed this connection, or died.
                Ready::Closed => {
                    if ctx.game_crashed() {
                        reject::<_, P>(&mut transport, conn, GAME_CRASHED, false).await;
                        return;
                    }
                    break;
                }
            },
            // The server is stopping: the client reconnects to the next.
            () = stopped(&mut ctx.shutdown) => {
                let closed = ServerMsg::<P>::Closed {
                    code: close::GOING_AWAY,
                    reason: "the server is stopping".into(),
                };
                let _ = tokio::time::timeout(SEND_TIMEOUT, transport.send(closed.to_bytes())).await;
                break;
            },
            // The tokens may have changed: is this one still good?
            () = revised(&mut revisions) => if let Err(e) = ctx.auth.verify(&token) {
                info!(conn, "closing: {e}");
                let closed = ServerMsg::<P>::Closed {
                    code: close::REVOKED,
                    reason: e.to_string(),
                };
                let _ = tokio::time::timeout(SEND_TIMEOUT, transport.send(closed.to_bytes())).await;
                break;
            },
            frame = transport.recv() => match frame {
                Ok(Some(frame)) => match ClientMsg::<P>::from_bytes(&frame) {
                    Ok(ClientMsg::Hello { .. }) => {
                        info!(conn, "closing: Hello sent twice");
                        break;
                    }
                    // Only a client with a bulk lane has flow control;
                    // others' acks mean nothing.
                    Ok(ClientMsg::Ack { bytes }) => if bulk.is_some() {
                        let now = std::time::Instant::now();
                        bulk_acked = bulk_acked.saturating_add(bytes);
                        let f = flow.get_or_insert_with(|| Flow::new(now, bulk_sent));
                        if f.acked(bulk_acked, now).is_err() {
                            info!(conn, "closing: acknowledged bulk data never sent");
                            break;
                        }
                        let high_water = ratio.raw(f.high_water(BULK_HIGH_WATER));
                        out_rx.set_bulk_high_water(high_water.min(BULK_HIGH_WATER));
                    },
                    Ok(msg) => {
                        // Over its rate, the client waits (and its next
                        // messages with it).
                        let kind = Kind::of(&msg);
                        let at = limiter.take(kind, Instant::now());
                        if at > Instant::now() {
                            if !throttled {
                                throttled = true;
                                info!(conn, "slowing down a client: too many {} a second", kind.name());
                            }
                            tokio::select! {
                                () = tokio::time::sleep_until(at) => {}
                                () = game_ended(&mut ctx.game_state) => {
                                    if ctx.game_crashed() {
                                        reject::<_, P>(&mut transport, conn, GAME_CRASHED, false).await;
                                        return;
                                    }
                                    break;
                                }
                            }
                        }
                        // Wait for the game to work through this session's
                        // earlier messages, unless it has ended.
                        let permit = tokio::select! {
                            permit = requests.clone().acquire_owned() => {
                                permit.expect("the semaphore is never closed")
                            }
                            () = game_ended(&mut ctx.game_state) => {
                                if ctx.game_crashed() {
                                    reject::<_, P>(&mut transport, conn, GAME_CRASHED, false).await;
                                    return;
                                }
                                break;
                            }
                        };
                        let request = Request::Client {
                            conn,
                            msg,
                            permit,
                            sent: std::time::Instant::now(),
                        };
                        if ctx.game.send(request).is_err() {
                            if ctx.game_crashed() {
                                reject::<_, P>(&mut transport, conn, GAME_CRASHED, false).await;
                                return;
                            }
                            break;
                        }
                    }
                    Err(e) => {
                        info!(conn, "closing: undecodable message: {e}");
                        break;
                    }
                },
                Ok(None) => break,
                Err(e) => {
                    debug!(conn, "receive failed: {e}");
                    break;
                }
            },
            // The pace allows the next write: go round again.
            () = pace(paced), if paced.is_some() => {}
            ready = out_rx.ready(true), if may_write => match ready {
                Ready::Frames => {
                    // The flow's batch is bytes written: compressed, so
                    // more bulk data makes one.
                    let take = ratio.raw(flow.as_ref().map_or(BATCH_BYTES, Flow::batch));
                    out_rx.take(&mut batch, take);
                    if let Some(codec) = bulk {
                        let prio = batch.prio_queued.len();
                        if batch.frames.len() > prio {
                            // Compressed (off this thread) before it counts:
                            // the window holds bytes as written.
                            let frames = batch.frames.split_off(prio);
                            batch.packed += frames.len();
                            let packed = ctx.deflate.pack(frames, codec).await;
                            ctx.io.bulk(packed.raw, packed.message.len());
                            // Every batch it tried counts, so data that
                            // stops compressing brings the ratio back to 1.
                            if packed.tried {
                                ratio.add(packed.raw, packed.data);
                            }
                            batch.frames.push(packed.message.into());
                            // The `Bulk`'s data is what the client acks.
                            bulk_sent += packed.data as u64;
                            if let Some(f) = &mut flow {
                                let idle = out_rx.bulk_queued() == 0;
                                f.wrote(packed.data, std::time::Instant::now(), idle);
                            }
                        }
                    }
                    if !send(&mut transport, conn, &mut batch, &ctx.io).await {
                        break;
                    }
                }
                // Closed: the priority branch ends the session.
                Ready::Closed => {}
            },
        }
    }
    let _ = ctx.game.send(Request::Disconnect { conn });
    transport.close().await;
}

/// How many times smaller a client's bulk data has been on the wire, from
/// the `Bulk`s it tried to compress (1 until one), from 1 to
/// [`Ratio::MAX`]: a session takes that much more bulk data for a write
/// the flow sizes in bytes written, and lets the game queue that much
/// more for it.
#[derive(Debug, Clone, Copy)]
struct Ratio(f64, bool);

impl Default for Ratio {
    fn default() -> Ratio {
        Ratio(1.0, false)
    }
}

impl Ratio {
    /// The most it counts: data of one value all through compresses far
    /// more, and a write of it would take that much.
    const MAX: f64 = 4.0;

    /// A `Bulk` of `raw` bytes of data written as `wire`.
    fn add(&mut self, raw: usize, wire: usize) {
        let sample = (raw as f64 / wire.max(1) as f64).clamp(1.0, Self::MAX);
        if !self.1 {
            // The first one stands for them all: a join's first writes are
            // its smallest, while the flow is still finding the link.
            self.0 = sample;
            self.1 = true;
            return;
        }
        // A moving average over about the last four.
        self.0 += (sample - self.0) / 4.0;
    }

    /// The bulk data, before compression, that makes about `wire` bytes
    /// written.
    fn raw(self, wire: usize) -> usize {
        (wire as f64 * self.0) as usize
    }
}

/// Waits until `until`, or forever without it. A future that does nothing
/// until polled: the session builds one each time round its loop, and only
/// a paced flow's is ever polled.
async fn pace(until: Option<std::time::Instant>) {
    match until {
        Some(at) => tokio::time::sleep_until(at.into()).await,
        None => std::future::pending().await,
    }
}

/// Writes `batch` (emptying it) with one flush; false if the connection is
/// gone or not reading.
async fn send<T: Transport>(
    transport: &mut T,
    conn: ConnId,
    batch: &mut Batch,
    io: &IoCounters,
) -> bool {
    let messages = batch.frames.len() as u64;
    // A `Bulk` counts the frames it carries, not itself.
    let count = messages + std::mem::take(&mut batch.packed).saturating_sub(1) as u64;
    let bytes: usize = batch.frames.iter().map(Frame::len).sum();
    batch.prio_queued.clear();
    let frames = &mut batch.frames;
    let write = async {
        for frame in frames.drain(..) {
            transport.feed(frame).await?;
        }
        transport.flush().await
    };
    match tokio::time::timeout(SEND_TIMEOUT, write).await {
        Ok(Ok(())) => {
            io.wrote(count, messages, bytes as u64);
            true
        }
        Ok(Err(e)) => {
            debug!(conn, "send failed: {e}");
            false
        }
        Err(_) => {
            info!(conn, "closing: the client is not reading its messages");
            false
        }
    }
}

/// What an accepted `Hello` says.
#[derive(Debug)]
struct Hello<P: Protocol> {
    /// Checked again when the tokens change.
    token: String,
    identity: Identity,
    /// The `Bulk` codec to send: the client's, or none.
    bulk: Option<u8>,
    ext: P::Hello,
}

/// Checks the first frame: a `Hello` with our schema hash and a token
/// `auth` accepts. The error is the reason sent in `Rejected`, and whether
/// the client's schema is stale.
fn hello<P: Protocol>(
    frame: &[u8],
    ours: &str,
    auth: &dyn Auth,
) -> Result<Hello<P>, (String, bool)> {
    let mismatch = |theirs: &str| {
        (
            format!(
                "protocol schema mismatch: server {ours}, client {}; update the client",
                clip(theirs)
            ),
            true,
        )
    };
    let msg = match ClientMsg::<P>::from_bytes(frame) {
        Ok(msg) => msg,
        // A client built for another protocol may send a `Hello` of another
        // shape; its schema hash still says so, and a page reloads itself
        // on a stale schema, not on a bad message.
        Err(e) => {
            return Err(match old_hello_schema(frame) {
                Some(theirs) if theirs != ours => mismatch(&theirs),
                _ => (format!("bad message: {e}"), false),
            });
        }
    };
    let ClientMsg::Hello {
        token,
        schema_hash,
        bulk,
        ext,
    } = msg
    else {
        return Err(("the first message must be Hello".into(), false));
    };
    if schema_hash != ours {
        return Err(mismatch(&schema_hash));
    }
    let identity = auth.verify(&token).map_err(|e| (e.to_string(), false))?;
    // A codec this server doesn't know is sent as plain frames.
    let bulk = bulk.map(|c| if c == codec::DEFLATE { c } else { codec::NONE });
    Ok(Hello {
        token,
        identity,
        bulk,
        ext,
    })
}

/// The schema hash of a frame that starts like a `Hello` (variant 0, then
/// the token and the schema hash), whatever follows.
fn old_hello_schema(frame: &[u8]) -> Option<String> {
    let mut r = Reader::new(frame);
    if r.read_variant().ok()? != 0 {
        return None;
    }
    r.read_string().ok()?;
    r.read_string().ok()
}

/// Resolves when the tokens an auth checks may have changed; never
/// without them.
async fn revised(revisions: &mut Option<watch::Receiver<u64>>) {
    if let Some(r) = revisions
        && r.changed().await.is_ok()
    {
        return;
    }
    *revisions = None;
    std::future::pending().await
}

/// Resolves once the game has ended.
async fn game_ended(state: &mut watch::Receiver<GameState>) {
    let _ = state.wait_for(|s| *s != GameState::Running).await;
}

/// Resolves once the server is shutting down.
pub async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stop| *stop).await;
}

async fn reject<T: Transport, P: Protocol>(
    transport: &mut T,
    conn: ConnId,
    reason: &str,
    stale_schema: bool,
) {
    info!(conn, "rejected: {reason}");
    let msg = ServerMsg::<P>::Rejected {
        reason: reason.to_string(),
        stale_schema,
    };
    if transport.send(msg.to_bytes()).await.is_ok() {
        transport.close().await;
    }
}

#[cfg(test)]
mod tests {
    use tc_wire::Writer;

    use super::*;
    use crate::auth::{AllowAll, AuthError};
    use crate::envelope::tests::Game;

    #[test]
    fn the_ratio_scales_by_what_compression_saves_and_falls_back_to_one() {
        let mut ratio = Ratio::default();
        // Until a batch is tried: bytes as they are, exactly.
        for wire in [0, 1, 4096, BULK_HIGH_WATER, usize::MAX >> 12] {
            assert_eq!(ratio.raw(wire), wire);
        }
        // The first stands for them all; past four counts four.
        ratio.add(30_000, 10_000);
        assert_eq!(ratio.raw(1000), 3000);
        ratio.add(1_000_000, 10);
        assert_eq!(ratio.raw(1000), 3250);
        // Data that stops compressing (tried, sent as it was) brings it
        // back to 1, never below.
        for _ in 0..100 {
            ratio.add(60_000, 60_005);
        }
        assert_eq!(ratio.raw(64 * 1024), 64 * 1024);
    }

    fn hello_frame(token: &str, hash: &str, bulk: Option<u8>) -> Vec<u8> {
        ClientMsg::<Game>::Hello {
            token: token.into(),
            schema_hash: hash.into(),
            bulk,
            ext: 7,
        }
        .to_bytes()
    }

    #[test]
    fn hello_says_who_and_how_the_client_takes_the_bulk_lane() {
        for (asked, got) in [
            (None, None),
            (Some(codec::NONE), Some(codec::NONE)),
            (Some(codec::DEFLATE), Some(codec::DEFLATE)),
            // A codec from a newer client: plain frames.
            (Some(9), Some(codec::NONE)),
        ] {
            let h = hello::<Game>(&hello_frame("ada", "h1", asked), "h1", &AllowAll).unwrap();
            assert_eq!(
                (h.identity.name.as_str(), h.bulk, h.ext, h.token.as_str()),
                ("ada", got, 7, "ada")
            );
        }
    }

    #[test]
    fn a_stale_schema_is_said_so_and_a_bad_token_is_not() {
        let (reason, stale) = hello::<Game>(&hello_frame("a", "old", None), "new", &AllowAll)
            .err()
            .unwrap();
        assert!(
            stale && reason.starts_with("protocol schema mismatch"),
            "{reason}"
        );
        // A Hello of another shape is judged by its schema hash.
        let mut w = Writer::new();
        w.write_varint(0);
        w.write_str("a");
        w.write_str("older");
        let (reason, stale) = hello::<Game>(&w.into_bytes(), "new", &AllowAll)
            .err()
            .unwrap();
        assert!(stale, "{reason}");
        // Not a Hello at all.
        let ping = ClientMsg::<Game>::Ping { client_time: 1 }.to_bytes();
        let (reason, stale) = hello::<Game>(&ping, "new", &AllowAll).err().unwrap();
        assert!(!stale && reason.contains("must be Hello"), "{reason}");
        struct Nobody;
        impl Auth for Nobody {
            fn verify(&self, _: &str) -> Result<Identity, AuthError> {
                Err(AuthError("no such account".into()))
            }
        }
        let (reason, stale) = hello::<Game>(&hello_frame("a", "new", None), "new", &Nobody)
            .err()
            .unwrap();
        assert_eq!((reason.as_str(), stale), ("no such account", false));
    }

    #[tokio::test]
    async fn pending_evicts_the_oldest() {
        let pending = Pending::new(2);
        let mut a = pending.add(1);
        let _b = pending.add(2);
        let _c = pending.add(3);
        tokio::time::timeout(Duration::from_secs(1), a.evicted())
            .await
            .expect("the oldest is evicted");
        assert_eq!(pending.lock().len(), 2);
    }
}
