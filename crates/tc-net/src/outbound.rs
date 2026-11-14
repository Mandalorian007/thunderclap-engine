//! The queue between the game and one session: its priority and bulk
//! lanes, and the session's end of them. The game fills it from any
//! thread; the session drains it.
//!
//! **Wakes.** Waking a session's task from the game's thread costs a
//! worker thread's unpark (a system call) on the async runtime, and a
//! session woken for every frame writes every frame on its own (one
//! `sendto` each). So the lanes wake their session differently: a frame in
//! the priority lane (a `PlayerState`, an entity frame, a query update, a
//! command's result) wakes it at once, since its latency is what players
//! feel; frames in the bulk lane (bulk data, built a piece at a time
//! during a flush) wake it only once [`BULK_WAKE_BYTES`] have gathered or
//! the game calls [`Outbound::wake`], which it does for every
//! connection before it waits for its next request or timer. A session
//! takes everything queued when it wakes and writes it with one flush
//! ([`OutboundRx::take`]), and keeps taking until the bulk lane is empty;
//! bulk frames queued after that wait for their own wake, even while the
//! session is busy writing.
//!
//! **Lingering.** While the game is still filling a connection's
//! view, the game wakes it before waiting only once its bulk frames
//! have waited [`BULK_LINGER`] ([`Outbound::wake_lingering`]); the
//! [`BULK_WAKE_BYTES`] wake sends the rest.
//!
//! Both keep a view's batches full on a machine short of CPU. There a pass
//! of the loop builds a few frames, and a session that took whatever
//! the bulk lane held whenever it looked, or was woken after every pass,
//! wrote a cached 16/8 view in up to 500 small `Bulk` messages (load
//! averages of 15 to 30) instead of about a dozen full ones.
//!
//! **Held wakes.** A flush queues a batch of priority frames for many
//! sessions at once (query updates, entity frames, edits), several
//! for each, and their number grows with the players times what each
//! sees. While the game holds a queue ([`Outbound::hold`]) its
//! priority frames wake nobody; [`Outbound::release`] (or
//! [`Outbound::wake`]) wakes the session once for all of them, as soon as
//! the batch is queued.
//!
//! **Shared frames.** A priority frame is a [`Frame`]: bytes behind a
//! reference count, so one frame queued for many connections (an
//! event, the clock, chat) is encoded once and shared, never copied
//! per connection. The session hands it to the transport as it is.

use std::collections::VecDeque;
use std::future::poll_fn;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::Poll;
use std::time::Instant;

use futures_util::task::AtomicWaker;
use tokio::sync::mpsc::error::{TryRecvError, TrySendError};

use crate::ticket::BulkTicket;
use crate::transport::Frame;

/// Frames queued for one connection before it counts as not reading and is
/// disconnected.
pub const OUTBOUND_QUEUE: usize = 1024;

/// Frames the bulk lane (bulk data) can hold; the game keeps far
/// fewer bytes than this queued ([`crate::flow::BULK_HIGH_WATER`]), and
/// retries anything refused.
pub const BULK_QUEUE: usize = 1 << 16;

/// Bytes of bulk frames queued since the session was last woken past
/// which the next one wakes it, so a long bulk flush keeps the socket
/// busy instead of handing over everything at its end.
pub const BULK_WAKE_BYTES: usize = 64 * 1024;

/// How long bulk frames queued for a connection whose view is still
/// loading may wait for more before the game wakes its session
/// anyway (see [`Outbound::wake_lingering`]).
pub const BULK_LINGER: std::time::Duration = std::time::Duration::from_millis(20);

/// One frame in the bulk lane, with the ticket the session checks before
/// writing it (`None`: always written).
type BulkFrame = (Vec<u8>, Option<BulkTicket>);

/// What the game and the session share.
#[derive(Debug, Default)]
struct Shared {
    /// Priority frames, with when each was queued (for [`crate::stats`]).
    prio: Mutex<VecDeque<(Frame, Instant)>>,
    bulk: Mutex<VecDeque<BulkFrame>>,
    /// Bytes in each lane not yet taken by the session.
    queued: AtomicUsize,
    bulk_queued: AtomicUsize,
    /// The most bulk bytes the game may keep queued, set by a
    /// session with flow control ([`crate::flow`]); 0 if it has none.
    bulk_high_water: AtomicUsize,
    /// Bulk bytes queued since the session was last woken.
    unwoken: AtomicUsize,
    /// When the first of those was queued.
    unwoken_since: Mutex<Option<Instant>>,
    /// The session was woken for the bulk frames queued, and takes them
    /// until the lane is empty; frames queued after that wait for the next
    /// wake (see the module docs).
    bulk_woken: AtomicBool,
    /// Priority frames are queued without waking the session (see
    /// [`Outbound::hold`]), and whether any were since it was last woken.
    held: AtomicBool,
    prio_unwoken: AtomicBool,
    /// The session's task, waiting for frames.
    waker: AtomicWaker,
    /// Every [`Outbound`] was dropped: nothing more will be queued.
    closed: AtomicBool,
    /// The [`OutboundRx`] was dropped: the session ended.
    rx_closed: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Marks the queue closed when the last [`Outbound`] clone is dropped.
#[derive(Debug)]
struct Sender(Arc<Shared>);

impl Drop for Sender {
    fn drop(&mut self) {
        self.0.closed.store(true, Ordering::Release);
        self.0.waker.wake();
    }
}

/// Where the game queues one connection's encoded `ServerMsg`
/// frames, in two lanes. The priority lane holds everything but bulk
/// data, at most [`OUTBOUND_QUEUE`] frames; the bulk lane holds bulk frames,
/// their timelines, and unloads. The session always writes the priority
/// lane first, so query updates and command results never wait behind
/// bulk data; a bulk frame whose [`BulkTicket`] was withdrawn is skipped.
/// Each lane counts its bytes until the session takes them. Dropping it
/// (every clone) tells the session to close the connection. See the
/// [module docs](self) for when the session is woken.
#[derive(Clone, Debug)]
pub struct Outbound {
    shared: Arc<Shared>,
    _sender: Arc<Sender>,
}

impl Outbound {
    /// Queues a frame in the priority lane without waiting, and wakes the
    /// session (unless the queue is held: see [`Outbound::hold`]). A
    /// [`Frame`] shared with other connections is queued as it is.
    pub fn try_send(&self, frame: impl Into<Frame>) -> Result<(), TrySendError<Frame>> {
        let frame = frame.into();
        let s = &self.shared;
        if s.rx_closed.load(Ordering::Acquire) {
            return Err(TrySendError::Closed(frame));
        }
        {
            let mut prio = lock(&s.prio);
            if prio.len() >= OUTBOUND_QUEUE {
                return Err(TrySendError::Full(frame));
            }
            s.queued.fetch_add(frame.len(), Ordering::Relaxed);
            prio.push_back((frame, Instant::now()));
        }
        if s.held.load(Ordering::Relaxed) {
            s.prio_unwoken.store(true, Ordering::Relaxed);
        } else {
            s.waker.wake();
        }
        Ok(())
    }

    /// Holds the session's wakes for priority frames until
    /// [`Outbound::release`] or [`Outbound::wake`]: a batch of frames
    /// queued together wakes it once.
    pub fn hold(&self) {
        self.shared.held.store(true, Ordering::Relaxed);
    }

    /// Stops holding wakes, and wakes the session if priority frames were
    /// queued while they were held.
    pub fn release(&self) {
        let s = &self.shared;
        s.held.store(false, Ordering::Relaxed);
        if s.prio_unwoken.swap(false, Ordering::Relaxed) {
            s.unwoken.store(0, Ordering::Release);
            s.bulk_woken.store(true, Ordering::Release);
            s.waker.wake();
        }
    }

    /// Queues a frame in the bulk lane without waiting, to be written
    /// unless `ticket` is withdrawn first; false if the lane is full or
    /// closed. Wakes the session only once [`BULK_WAKE_BYTES`] have
    /// gathered since it was last woken (see [`Outbound::wake`]).
    pub fn try_send_bulk(&self, frame: Vec<u8>, ticket: Option<BulkTicket>) -> bool {
        let s = &self.shared;
        if s.rx_closed.load(Ordering::Acquire) {
            return false;
        }
        let len = frame.len();
        {
            let mut bulk = lock(&s.bulk);
            if bulk.len() >= BULK_QUEUE {
                return false;
            }
            s.bulk_queued.fetch_add(len, Ordering::Relaxed);
            bulk.push_back((frame, ticket));
        }
        let before = s.unwoken.fetch_add(len, Ordering::AcqRel);
        if before + len >= BULK_WAKE_BYTES {
            self.wake();
        } else if before == 0 {
            *lock(&s.unwoken_since) = Some(Instant::now());
        }
        true
    }

    /// Wakes the session if bulk frames were queued since it was last
    /// woken, and releases held wakes. The game calls it for every
    /// connection before it waits.
    pub fn wake(&self) {
        let s = &self.shared;
        self.release();
        if s.unwoken.load(Ordering::Acquire) > 0 {
            s.unwoken.store(0, Ordering::Release);
            s.bulk_woken.store(true, Ordering::Release);
            s.waker.wake();
        }
    }

    /// [`Outbound::wake`], except that bulk frames queued less than
    /// [`BULK_LINGER`] before `now` wait while `more` are coming (the game
    /// is still filling this connection's view): a later pass, or
    /// [`BULK_WAKE_BYTES`] of them, wakes the session for them all. Held
    /// priority frames are released either way.
    pub fn wake_lingering(&self, now: Instant, more: bool) {
        if more {
            let since = *lock(&self.shared.unwoken_since);
            if since.is_some_and(|t| now.saturating_duration_since(t) < BULK_LINGER) {
                self.release();
                return;
            }
        }
        self.wake();
    }

    /// Bytes queued in the priority lane and not yet taken by the session.
    pub fn queued(&self) -> usize {
        self.shared.queued.load(Ordering::Relaxed)
    }

    /// Bytes queued in the bulk lane and not yet taken by the session.
    pub fn bulk_queued(&self) -> usize {
        self.shared.bulk_queued.load(Ordering::Relaxed)
    }

    /// The most bulk bytes the game may keep queued, if the
    /// session set it ([`OutboundRx::set_bulk_high_water`]).
    pub fn bulk_high_water(&self) -> Option<usize> {
        match self.shared.bulk_high_water.load(Ordering::Relaxed) {
            0 => None,
            bytes => Some(bytes),
        }
    }

    /// Frames the priority lane has room for.
    #[cfg(test)]
    pub(super) fn capacity(&self) -> usize {
        OUTBOUND_QUEUE.saturating_sub(lock(&self.shared.prio).len())
    }
}

/// The session's end of a connection's queue: its two lanes.
#[derive(Debug)]
pub struct OutboundRx {
    shared: Arc<Shared>,
}

impl Drop for OutboundRx {
    fn drop(&mut self) {
        self.shared.rx_closed.store(true, Ordering::Release);
    }
}

/// Frames taken to write together ([`OutboundRx::take`]).
#[derive(Debug, Default)]
pub struct Batch {
    /// The frames, in the order to write them.
    pub frames: Vec<Frame>,
    /// When each priority frame among them (the first ones) was queued.
    pub prio_queued: Vec<Instant>,
    /// Bulk frames packed into the last of `frames` (a `Bulk` message),
    /// or 0.
    pub packed: usize,
}

/// What [`OutboundRx::ready`] found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ready {
    /// Frames are waiting.
    Frames,
    /// The game dropped the queue and everything in the lane was
    /// taken.
    Closed,
}

impl OutboundRx {
    /// Resolves once the priority lane holds a frame (or, with `bulk`, the
    /// bulk lane holds frames the session was woken for), or the queue is
    /// closed and empty. Cancel-safe.
    pub async fn ready(&self, bulk: bool) -> Ready {
        let s = &self.shared;
        poll_fn(|cx| {
            s.waker.register(cx.waker());
            // Closed is read before the lanes: a frame queued before the
            // close is seen.
            let closed = s.closed.load(Ordering::Acquire);
            let bulk = bulk && s.bulk_woken.load(Ordering::Acquire);
            if !lock(&s.prio).is_empty() || (bulk && !lock(&s.bulk).is_empty()) {
                return Poll::Ready(Ready::Frames);
            }
            if closed {
                return Poll::Ready(Ready::Closed);
            }
            Poll::Pending
        })
        .await
    }

    /// Takes every priority frame into `out`, then (with `bulk_bytes` above
    /// zero) bulk frames until `out` holds at least that many bytes, in the
    /// order the session writes them. Bulk frames whose ticket was
    /// withdrawn are dropped here, never written.
    pub fn take(&mut self, out: &mut Batch, bulk_bytes: usize) {
        let s = &self.shared;
        let mut bytes = 0;
        {
            let mut prio = lock(&s.prio);
            for (frame, queued) in prio.drain(..) {
                bytes += frame.len();
                out.frames.push(frame);
                out.prio_queued.push(queued);
            }
        }
        let out = &mut out.frames;
        s.queued.fetch_sub(bytes, Ordering::Relaxed);
        if bulk_bytes == 0 {
            return;
        }
        let mut taken = 0;
        let mut bulk = lock(&s.bulk);
        while bytes < bulk_bytes {
            let Some((frame, ticket)) = bulk.pop_front() else {
                break;
            };
            taken += frame.len();
            if ticket.is_none_or(|t| t.take()) {
                bytes += frame.len();
                out.push(frame.into());
            }
        }
        // Emptied under the lock: a frame queued after this is woken for
        // again (the game queues, then wakes).
        if bulk.is_empty() {
            s.bulk_woken.store(false, Ordering::Release);
        }
        s.bulk_queued.fetch_sub(taken, Ordering::Relaxed);
    }

    /// The next frame if one is queued, priority lane first, as the session
    /// writes them; `Disconnected` once the queue is closed and empty. (For
    /// tests and benches: a shared frame is copied out.)
    pub fn try_recv(&mut self) -> Result<Vec<u8>, TryRecvError> {
        let s = &self.shared;
        let closed = s.closed.load(Ordering::Acquire);
        if let Some((frame, _)) = lock(&s.prio).pop_front() {
            s.queued.fetch_sub(frame.len(), Ordering::Relaxed);
            return Ok(frame.into());
        }
        let mut bulk = lock(&s.bulk);
        while let Some((frame, ticket)) = bulk.pop_front() {
            s.bulk_queued.fetch_sub(frame.len(), Ordering::Relaxed);
            if ticket.is_none_or(|t| t.take()) {
                return Ok(frame);
            }
        }
        Err(if closed {
            TryRecvError::Disconnected
        } else {
            TryRecvError::Empty
        })
    }

    /// Bytes queued in the bulk lane and not yet taken.
    pub fn bulk_queued(&self) -> usize {
        self.shared.bulk_queued.load(Ordering::Relaxed)
    }

    /// Sets how many bulk bytes the game may keep queued (at least
    /// 1): what the session's flow control lets it write soon.
    pub fn set_bulk_high_water(&self, bytes: usize) {
        self.shared
            .bulk_high_water
            .store(bytes.max(1), Ordering::Relaxed);
    }

    /// True once the game dropped the queue.
    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }
}

/// The queue between the game and one session.
pub fn outbound() -> (Outbound, OutboundRx) {
    let shared = Arc::new(Shared::default());
    (
        Outbound {
            shared: shared.clone(),
            _sender: Arc::new(Sender(shared.clone())),
        },
        OutboundRx { shared },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_frames_come_first_and_bulk_is_capped_by_bytes() {
        let (out, mut rx) = outbound();
        assert!(out.try_send_bulk(vec![1; 10], None));
        assert!(out.try_send_bulk(vec![2; 10], None));
        assert!(out.try_send_bulk(vec![3; 10], None));
        out.try_send(vec![9; 4]).unwrap();
        assert_eq!(out.queued(), 4);
        assert_eq!(out.bulk_queued(), 30);
        let mut batch = Batch::default();
        rx.take(&mut batch, 0);
        assert_eq!(batch.frames, vec![vec![9; 4]]);
        assert_eq!(batch.prio_queued.len(), 1);
        batch.frames.clear();
        rx.take(&mut batch, 15);
        assert_eq!(batch.frames, vec![vec![1; 10], vec![2; 10]]);
        assert_eq!(out.queued(), 0);
        assert_eq!(out.bulk_queued(), 10);
    }

    #[test]
    fn held_priority_frames_wake_the_session_once_released() {
        let (out, rx) = outbound();
        let woken = Arc::new(AtomicUsize::new(0));
        let waker = futures_util::task::waker(Arc::new(Count(woken.clone())));
        let mut cx = std::task::Context::from_waker(&waker);
        let mut ready = Box::pin(rx.ready(false));
        assert!(ready.as_mut().poll(&mut cx).is_pending());
        out.hold();
        out.try_send(vec![1]).unwrap();
        out.try_send(vec![2]).unwrap();
        assert_eq!(woken.load(Ordering::SeqCst), 0, "held");
        out.release();
        assert_eq!(woken.load(Ordering::SeqCst), 1, "woken once");
        assert!(ready.as_mut().poll(&mut cx).is_ready());
        // Released: each frame wakes again; nothing held, nothing to wake.
        out.release();
        assert_eq!(woken.load(Ordering::SeqCst), 1);
    }

    struct Count(Arc<AtomicUsize>);

    impl futures_util::task::ArcWake for Count {
        fn wake_by_ref(arc_self: &Arc<Self>) {
            arc_self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn withdrawn_bulk_frames_are_skipped() {
        let (out, mut rx) = outbound();
        let ticket = BulkTicket::new();
        assert!(out.try_send_bulk(vec![1], Some(ticket.clone())));
        assert!(out.try_send_bulk(vec![2], None));
        ticket.withdraw();
        let mut batch = Batch::default();
        rx.take(&mut batch, usize::MAX);
        assert_eq!(batch.frames, vec![vec![2]]);
        assert_eq!(out.bulk_queued(), 0);
    }

    #[test]
    fn the_queue_closes_after_its_frames_when_every_sender_is_dropped() {
        let (out, mut rx) = outbound();
        let copy = out.clone();
        out.try_send(vec![1]).unwrap();
        drop(out);
        assert!(!rx.is_closed());
        drop(copy);
        assert!(rx.is_closed());
        assert_eq!(rx.try_recv(), Ok(vec![1]));
        assert_eq!(rx.try_recv(), Err(TryRecvError::Disconnected));
    }

    #[test]
    fn a_dropped_session_refuses_frames() {
        let (out, rx) = outbound();
        drop(rx);
        assert!(matches!(
            out.try_send(vec![1]),
            Err(TrySendError::Closed(_))
        ));
        assert!(!out.try_send_bulk(vec![1], None));
    }

    #[test]
    fn the_priority_lane_holds_at_most_outbound_queue_frames() {
        let (out, _rx) = outbound();
        for _ in 0..OUTBOUND_QUEUE {
            out.try_send(vec![0]).unwrap();
        }
        assert!(matches!(out.try_send(vec![0]), Err(TrySendError::Full(_))));
        assert_eq!(out.capacity(), 0);
    }

    /// Bulk frames wake the session only once enough gathered or the
    /// simulation asks; priority frames wake it at once.
    #[test]
    fn bulk_frames_wake_the_session_late_priority_frames_at_once() {
        use std::future::Future;
        use std::task::{Context, Wake, Waker};

        #[derive(Default)]
        struct Count(AtomicUsize);
        impl Wake for Count {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let count = Arc::new(Count::default());
        let waker = Waker::from(count.clone());
        let mut cx = Context::from_waker(&waker);
        let (out, mut rx) = outbound();
        let wakes = || count.0.load(Ordering::SeqCst);
        let mut poll = |rx: &OutboundRx, bulk| {
            let mut ready = std::pin::pin!(rx.ready(bulk));
            ready.as_mut().poll(&mut cx)
        };
        assert_eq!(poll(&rx, true), Poll::Pending);
        assert!(out.try_send_bulk(vec![0; 10], None));
        assert_eq!(wakes(), 0, "a small bulk frame waits for the wake");
        assert_eq!(poll(&rx, false), Poll::Pending);
        assert_eq!(
            poll(&rx, true),
            Poll::Pending,
            "nor is the session ready for it"
        );
        out.wake();
        assert_eq!(wakes(), 1);
        // A wake uses up the registration; the session registers again
        // each time it waits.
        assert_eq!(poll(&rx, true), Poll::Ready(Ready::Frames));
        out.wake();
        assert_eq!(wakes(), 1, "nothing new to wake for");
        assert!(out.try_send_bulk(vec![0; BULK_WAKE_BYTES], None));
        assert_eq!(wakes(), 2, "enough bulk bytes wake it at once");
        // Taking part of the lane leaves the rest ready; once it is empty,
        // what is queued next waits for its own wake.
        rx.take(&mut Batch::default(), 1);
        assert_eq!(poll(&rx, true), Poll::Ready(Ready::Frames));
        rx.take(&mut Batch::default(), usize::MAX);
        assert_eq!(poll(&rx, true), Poll::Pending);
        assert!(out.try_send_bulk(vec![0; 10], None));
        assert_eq!(poll(&rx, true), Poll::Pending);
        out.wake();
        assert_eq!(wakes(), 3);
        rx.take(&mut Batch::default(), usize::MAX);
        assert_eq!(poll(&rx, true), Poll::Pending);
        out.try_send(vec![1]).unwrap();
        assert_eq!(wakes(), 4, "a priority frame wakes it at once");
        rx.take(&mut Batch::default(), 0);
        assert_eq!(poll(&rx, true), Poll::Pending);
        drop(out);
        assert_eq!(wakes(), 5, "closing wakes it");
        assert_eq!(poll(&rx, false), Poll::Ready(Ready::Closed));
    }

    /// While more are coming, bulk frames wait up to `BULK_LINGER` for a
    /// wake before the game waits; otherwise they go at once.
    #[test]
    fn bulk_frames_linger_while_more_are_coming() {
        let (out, rx) = outbound();
        let ready = |rx: &OutboundRx| rx.shared.bulk_woken.load(Ordering::Acquire);
        assert!(out.try_send_bulk(vec![0; 10], None));
        let queued = Instant::now();
        out.wake_lingering(queued, true);
        assert!(!ready(&rx), "frames just queued wait for more");
        out.wake_lingering(queued + BULK_LINGER, true);
        assert!(ready(&rx), "frames that waited long enough go");
        let (out, rx) = outbound();
        assert!(out.try_send_bulk(vec![0; 10], None));
        out.wake_lingering(Instant::now(), false);
        assert!(ready(&rx), "with nothing more coming they go at once");
    }
}
