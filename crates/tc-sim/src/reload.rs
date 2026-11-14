//! Hot reload: the game rebuilt from new data, the log replayed into it,
//! swapped in while connections stay open.
//!
//! A reload asks the game for a new one built from the data
//! ([`Game::reload`]) on the loop's thread, makes the log durable and
//! notes its last entry, then replays every entry up to it into the new
//! game on another thread while the loop keeps serving. Entries logged
//! meanwhile are kept; once the replay is done the loop applies them too,
//! brings the new game to the current time, swaps it in and calls
//! [`Game::reloaded`] so it can send what the new data changed. One
//! reload runs at a time; a game the replay can't rebuild (an entry out of
//! sequence) leaves the old one running.

use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tc_store::LogEntry;

use crate::core::{ApplyError, Core, Replayed};
use crate::game::{EventOf, Game, Outbox};
use crate::sim::Sim;

/// How often the loop checks on a running replay.
pub const RELOAD_POLL: Duration = Duration::from_millis(5);

/// What a reload did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReloadReport {
    /// The time it swapped in at.
    pub time: u64,
    /// The version it swapped in at.
    pub version: u64,
    /// How long the replay took (off the loop's thread).
    pub replay: Duration,
    /// How long the loop paused to catch up and swap.
    pub pause: Duration,
    /// Entries replayed, and refused ones skipped.
    pub replayed: Replayed,
    /// Entries logged during the replay, applied before the swap.
    pub caught_up: usize,
    /// Connections open at the swap.
    pub clients: usize,
}

/// Where a reload's outcome goes.
pub type ReloadReply = mpsc::Sender<Result<ReloadReport, String>>;

type ReplayOutcome<G> = Result<(Core<G>, Replayed), String>;

struct Running<G: Game> {
    started: Instant,
    thread: JoinHandle<ReplayOutcome<G>>,
    /// Entries logged since the replay's last one.
    later: Vec<LogEntry<EventOf<G>>>,
    reply: Option<ReloadReply>,
    next_poll: Instant,
}

/// The reload in progress, if any.
pub(crate) struct Reloads<G: Game> {
    running: Option<Running<G>>,
}

impl<G: Game> Default for Reloads<G> {
    fn default() -> Self {
        Reloads { running: None }
    }
}

impl<G: Game> Reloads<G> {
    pub(crate) fn running(&self) -> bool {
        self.running.is_some()
    }

    pub(crate) fn poll_at(&self) -> Option<Instant> {
        self.running.as_ref().map(|r| r.next_poll)
    }

    /// Entries just logged: kept for the catch-up.
    pub(crate) fn written(&mut self, entries: &[LogEntry<EventOf<G>>]) {
        if let Some(r) = &mut self.running {
            r.later.extend(entries.iter().map(|e| LogEntry {
                seq: e.seq,
                time: e.time,
                event: e.event.clone(),
            }));
        }
    }

    /// Answers the reload in progress with `reason` and forgets it (its
    /// replay finishes on its own and is dropped).
    pub(crate) fn cancel(&mut self, reason: &str) {
        if let Some(r) = self.running.take()
            && let Some(reply) = r.reply
        {
            let _ = reply.send(Err(reason.to_string()));
        }
    }
}

impl<G: Game> Sim<G> {
    /// Starts reloading the game from `data`; the outcome goes to `reply`
    /// (if any) once it is swapped in. Refused while another reload runs.
    pub fn reload(&mut self, data: Arc<G::Data>, reply: Option<ReloadReply>) {
        let refuse = |reply: Option<ReloadReply>, e: String| {
            tracing::warn!("reload refused: {e}");
            if let Some(reply) = reply {
                let _ = reply.send(Err(e));
            }
        };
        if self.reloads.running() {
            return refuse(reply, "a reload is already running".into());
        }
        let game = match self.core.game().reload(data) {
            Ok(game) => game,
            Err(e) => return refuse(reply, e),
        };
        let source = match self.replay_source() {
            Ok(source) => source,
            Err(e) => return refuse(reply, format!("the log can't be read back: {e}")),
        };
        let started = Instant::now();
        let thread = std::thread::Builder::new()
            .name("tc-sim-reload".into())
            .spawn(move || {
                let entries = source.entries()?;
                Core::replayed(game, &entries)
            });
        let thread = match thread {
            Ok(thread) => thread,
            Err(e) => return refuse(reply, format!("no replay thread: {e}")),
        };
        self.reloads.running = Some(Running {
            started,
            thread,
            later: Vec::new(),
            reply,
            next_poll: started + RELOAD_POLL,
        });
        self.publish_status(started);
    }

    /// Swaps in a finished replay.
    pub(crate) fn poll_reload(&mut self, now: Instant) {
        let Some(r) = &mut self.reloads.running else {
            return;
        };
        if !r.thread.is_finished() {
            if now >= r.next_poll {
                r.next_poll = now + RELOAD_POLL;
            }
            return;
        }
        let Some(r) = self.reloads.running.take() else {
            return;
        };
        let replay = r.started.elapsed();
        let outcome = r
            .thread
            .join()
            .unwrap_or_else(|_| Err("the replay panicked".into()))
            .and_then(|(core, replayed)| self.swap(core, &r.later).map(|n| (replayed, n)));
        let paused = Instant::now();
        let result = outcome.map(|(replayed, caught_up)| ReloadReport {
            time: self.core.time(),
            version: self.core.version(),
            replay,
            pause: paused.saturating_duration_since(now),
            replayed,
            caught_up,
            clients: self.conns.len(),
        });
        match &result {
            Ok(report) => tracing::info!(?report, "reloaded"),
            Err(e) => tracing::warn!("reload failed; the old game runs on: {e}"),
        }
        if let Some(reply) = r.reply {
            let _ = reply.send(result);
        }
        self.publish_status(now);
    }

    /// Applies the entries logged during the replay to `core`, brings it
    /// to the current time and swaps it in. Returns how many it caught up.
    fn swap(&mut self, mut core: Core<G>, later: &[LogEntry<EventOf<G>>]) -> Result<usize, String> {
        core.mute_changes(true);
        for entry in later {
            match core.apply(entry) {
                Ok(()) | Err(ApplyError::Refused(_)) => {}
                Err(e @ ApplyError::Sequence(_)) => return Err(e.to_string()),
            }
        }
        if core.version() != self.core.version() {
            return Err(format!(
                "the replay reached version {}, not {}",
                core.version(),
                self.core.version()
            ));
        }
        core.advance_to(self.core.time());
        core.mute_changes(false);
        // What the old game marked goes out before it goes.
        self.flush_all();
        self.core = core;
        let mut out = Outbox::new();
        let present = self.present();
        self.core.game().reloaded(&present, &mut out);
        self.deliver(out);
        Ok(later.len())
    }
}
