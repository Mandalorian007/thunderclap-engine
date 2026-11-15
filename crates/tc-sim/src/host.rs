//! The host loop: the timing, waking, idling and request handling under
//! every server loop, generic over what it hosts ([`Host`]) and the
//! requests it takes ([`Host::Request`]). [`Sim::run`](crate::Sim::run)
//! is [`run_host`] over a [`Sim`](crate::Sim); a game that owns its
//! connections, its requests and its state (its own sessions, presence,
//! sync and streams) implements [`Host`] and runs on the same loop.

use std::ops::ControlFlow;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use crate::idle::IDLE_RETRY;
use crate::sim::IDLE_MARGIN;

/// What [`run_host`] runs: one authoritative server, its clock and its
/// connections. Only [`Host::tick`], [`Host::deadline`] and
/// [`Host::handle`] are required.
///
/// Each pass of the loop:
///
/// 1. [`Host::poll`] (the owner's controls; `Break` stops the loop);
/// 2. [`Host::tick`] at the wall clock (catch up, do what is due);
/// 3. [`Host::wake_outbound`] (wake the sessions for what was queued);
/// 4. while [`Host::idle_work`] holds, [`Host::idle`] until the next
///    [`Host::deadline`] less [`Host::idle_margin`] (or [`IDLE_RETRY`]
///    from now with no deadline), cut short as soon as a request is
///    waiting; that request is then handled and the pass starts over;
/// 5. a wait for a request until the deadline (at most [`IDLE_RETRY`]
///    while idle work is left). A request, and every one waiting behind
///    it, goes to [`Host::handle`] (`Break` stops the loop); a wait that
///    timed out reports how late it woke ([`Host::woke_late`]).
///
/// The loop never reads the host's state: what is deterministic stays
/// the host's (its record, its schedule), and the loop only decides
/// *when* the host runs.
pub trait Host {
    /// What the loop receives: a connection's message, a connect, a
    /// disconnect, a control (tc-net's `Request` for a [`Sim`](crate::Sim);
    /// the host's own enum otherwise).
    type Request;

    /// At the start of every pass, before the tick: take the owner's
    /// controls (pause, reload, stop), poll background work. `Break`
    /// ends the loop ([`HostExit::Stopped`]). The default goes on.
    fn poll(&mut self) -> ControlFlow<()> {
        ControlFlow::Continue(())
    }

    /// Catches up with the wall clock (`now`) and does what is due:
    /// steps, ticks, flushes, clock pushes and marks.
    fn tick(&mut self, now: Instant);

    /// Wakes the sessions for what was queued this pass (bulk frames
    /// gathered rather than written one at a time). Called after the
    /// tick and after idle work. The default does nothing.
    fn wake_outbound(&mut self, now: Instant) {
        let _ = now;
    }

    /// When the loop must wake next without a request, if ever.
    fn deadline(&self) -> Option<Instant>;

    /// True while the host has work for its spare time (a world still
    /// streaming to a client). The default has none.
    fn idle_work(&self) -> bool {
        false
    }

    /// How long before the deadline idle work must stop. The default is
    /// [`IDLE_MARGIN`]; a host short of CPU may ask for more.
    fn idle_margin(&self) -> Duration {
        IDLE_MARGIN
    }

    /// Spare time until `until` (which may already have passed: return
    /// at once): return by then, and as soon as `interrupted()` says a
    /// request is waiting. The default does nothing.
    fn idle(&mut self, until: Instant, interrupted: &mut dyn FnMut() -> bool) {
        let _ = (until, interrupted);
    }

    /// One request. `Break` ends the loop ([`HostExit::Stopped`]).
    fn handle(&mut self, request: Self::Request) -> ControlFlow<()>;

    /// A wait of `wait` for the deadline woke `late` after it: the
    /// machine is short of CPU when this grows (a host holds back its
    /// idle work). The default ignores it.
    fn woke_late(&mut self, late: Duration, wait: Duration) {
        let _ = (late, wait);
    }
}

/// Why [`run_host`] returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostExit {
    /// [`Host::poll`] or [`Host::handle`] said stop.
    Stopped,
    /// Every request sender is gone.
    Disconnected,
}

/// Runs `host` on this thread until it says stop or every sender of
/// `requests` is gone (see [`Host`] for a pass). The host is left as it
/// stopped: the caller stops it (writes its last mark, closes its
/// connections).
pub fn run_host<H: Host>(host: &mut H, requests: &Receiver<H::Request>) -> HostExit {
    let mut waiting: Option<H::Request> = None;
    loop {
        if host.poll().is_break() {
            return HostExit::Stopped;
        }
        let now = Instant::now();
        host.tick(now);
        host.wake_outbound(now);
        let mut deadline = host.deadline();
        if host.idle_work() {
            let retry = now + IDLE_RETRY;
            let until = deadline
                .unwrap_or(retry)
                .checked_sub(host.idle_margin())
                .unwrap_or(now);
            let mut interrupted = || {
                if waiting.is_none() {
                    waiting = requests.try_recv().ok();
                }
                waiting.is_some()
            };
            host.idle(until, &mut interrupted);
            host.wake_outbound(Instant::now());
            if let Some(request) = waiting.take() {
                if handle_waiting(host, request, requests).is_break() {
                    return HostExit::Stopped;
                }
                continue;
            }
            deadline = host.deadline();
            if host.idle_work() {
                deadline = Some(deadline.map_or(retry, |d| d.min(retry)));
            }
        }
        let started = Instant::now();
        let next = match deadline {
            Some(at) => requests.recv_timeout(at.saturating_duration_since(started)),
            None => requests.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match next {
            Ok(request) => {
                if handle_waiting(host, request, requests).is_break() {
                    return HostExit::Stopped;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(at) = deadline {
                    let late = Instant::now().saturating_duration_since(at);
                    host.woke_late(late, at.saturating_duration_since(started));
                }
            }
            Err(RecvTimeoutError::Disconnected) => return HostExit::Disconnected,
        }
    }
}

/// Handles `request` and whatever else is waiting, before the next tick.
fn handle_waiting<H: Host>(
    host: &mut H,
    request: H::Request,
    requests: &Receiver<H::Request>,
) -> ControlFlow<()> {
    host.handle(request)?;
    while let Ok(request) = requests.try_recv() {
        host.handle(request)?;
    }
    ControlFlow::Continue(())
}
