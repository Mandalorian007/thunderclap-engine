//! Hot reload: the game rebuilt from new data, the log replayed into it,
//! swapped in while connections stay open.
//!
//! A reload asks the game for a new one built from the data
//! ([`Game::reload`]) on the loop's thread, makes the log durable and
//! notes its last entry, then replays every entry up to it into the new
//! game on another thread while the loop keeps serving. Entries logged
//! meanwhile are kept; once the replay is done the loop applies them too,
//! brings the new game to the current time, swaps it in and calls
//! [`Game::reloaded`] so it can send what the new data changed.
//!
//! **Rounds.** If more than [`SWAP_BEHIND`] entries were logged during a
//! round, applying them would pause the loop too long: another round
//! applies them off the thread while the loop keeps logging, up to
//! [`MAX_ROUNDS`], and the last round's few are applied at the swap.
//!
//! One reload runs at a time; one asked for meanwhile waits its turn
//! (and builds from the game then running). A game the replay can't
//! rebuild (an entry out of sequence) leaves the old one running.
//! Bodies ([`Game::Body`]) are not logged and stay as they are; live
//! queries and entity streams rerun against the new game.

use std::collections::VecDeque;
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

/// A round that ends further behind than this many entries is followed by
/// another round off the loop's thread.
pub const SWAP_BEHIND: usize = 256;

/// The most rounds a reload takes; the last one's entries are applied at
/// the swap however many.
pub const MAX_ROUNDS: u32 = 8;

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
    /// Entries logged during the replay, applied in later rounds or at the
    /// swap.
    pub caught_up: usize,
    /// Rounds taken: 1 for the replay, one more for each catch-up.
    pub rounds: u32,
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
    rounds: u32,
    /// Entries applied by catch-up rounds so far.
    caught_up: usize,
}

/// The reload in progress, if any, and those waiting their turn.
pub(crate) struct Reloads<G: Game> {
    running: Option<Running<G>>,
    queued: VecDeque<(Arc<G::Data>, Option<ReloadReply>)>,
}

impl<G: Game> Default for Reloads<G> {
    fn default() -> Self {
        Reloads {
            running: None,
            queued: VecDeque::new(),
        }
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

    /// Answers the reload in progress and those queued with `reason` and
    /// forgets them (a running replay finishes on its own and is dropped).
    pub(crate) fn cancel(&mut self, reason: &str) {
        let replies = self.running.take().and_then(|r| r.reply);
        let queued = self.queued.drain(..).filter_map(|(_, reply)| reply);
        for reply in replies.into_iter().chain(queued) {
            let _ = reply.send(Err(reason.to_string()));
        }
    }
}

impl<G: Game> Sim<G> {
    /// Starts reloading the game from `data`; the outcome goes to `reply`
    /// (if any) once it is swapped in. While another reload runs, it waits
    /// for that one to finish.
    pub fn reload(&mut self, data: Arc<G::Data>, reply: Option<ReloadReply>) {
        let refuse = |reply: Option<ReloadReply>, e: String| {
            tracing::warn!("reload refused: {e}");
            if let Some(reply) = reply {
                let _ = reply.send(Err(e));
            }
        };
        if self.reloads.running() {
            self.reloads.queued.push_back((data, reply));
            return;
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
            .spawn(move || source.replayed(game));
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
            rounds: 1,
            caught_up: 0,
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
        let Some(mut r) = self.reloads.running.take() else {
            return;
        };
        let replay = r.started.elapsed();
        let joined = r
            .thread
            .join()
            .unwrap_or_else(|_| Err("the replay panicked".into()));
        let later = std::mem::take(&mut r.later);
        let joined = match joined {
            Ok((core, replayed)) if later.len() > SWAP_BEHIND && r.rounds < MAX_ROUNDS => {
                // Too far behind to catch up in one pause: another round.
                match spawn_catch_up(core, replayed, later) {
                    Ok((thread, n)) => {
                        r.thread = thread;
                        r.rounds += 1;
                        r.caught_up += n;
                        r.next_poll = now + RELOAD_POLL;
                        self.reloads.running = Some(r);
                        return;
                    }
                    Err(e) => return self.reload_done(r.reply, Err(e), now),
                }
            }
            other => other,
        };
        let outcome =
            joined.and_then(|(core, replayed)| self.swap(core, &later).map(|n| (replayed, n)));
        let paused = Instant::now();
        let result = outcome.map(|(replayed, caught_up)| ReloadReport {
            time: self.core.time(),
            version: self.core.version(),
            replay,
            pause: paused.saturating_duration_since(now),
            replayed,
            caught_up: r.caught_up + caught_up,
            rounds: r.rounds,
            clients: self.conns.len(),
        });
        self.reload_done(r.reply, result, now);
    }

    /// Answers a finished reload and starts the next queued one.
    fn reload_done(
        &mut self,
        reply: Option<ReloadReply>,
        result: Result<ReloadReport, String>,
        now: Instant,
    ) {
        match &result {
            Ok(report) => tracing::info!(?report, "reloaded"),
            Err(e) => tracing::warn!("reload failed; the old game runs on: {e}"),
        }
        if let Some(reply) = reply {
            let _ = reply.send(result);
        }
        self.schedule_flush(now);
        self.publish_status(now);
        // The next queued (one refused at once lets the one after start).
        while !self.reloads.running() {
            let Some((data, reply)) = self.reloads.queued.pop_front() else {
                break;
            };
            self.reload(data, reply);
        }
    }

    /// Applies the entries logged during the replay to `core`, brings it
    /// to the current time and swaps it in. Returns how many it caught up.
    fn swap(&mut self, mut core: Core<G>, later: &[LogEntry<EventOf<G>>]) -> Result<usize, String> {
        catch_up(&mut core, later)?;
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
        self.flushed_version = self.core.version();
        self.sync.reload();
        self.streams_due();
        let mut out = Outbox::new();
        let present = self.present();
        self.core.game().reloaded(&present, &mut out);
        self.deliver(out);
        Ok(later.len())
    }
}

/// Applies `later` to `core`, muted (the swap unmutes it).
fn catch_up<G: Game>(core: &mut Core<G>, later: &[LogEntry<EventOf<G>>]) -> Result<(), String> {
    core.mute_changes(true);
    for entry in later {
        match core.apply(entry) {
            Ok(()) | Err(ApplyError::Refused(_)) => {}
            Err(e @ ApplyError::Sequence(_)) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// A catch-up round: `later` applied to `core` off the loop's thread.
fn spawn_catch_up<G: Game>(
    mut core: Core<G>,
    replayed: Replayed,
    later: Vec<LogEntry<EventOf<G>>>,
) -> Result<(JoinHandle<ReplayOutcome<G>>, usize), String> {
    let n = later.len();
    std::thread::Builder::new()
        .name("tc-sim-reload".into())
        .spawn(move || {
            catch_up(&mut core, &later)?;
            Ok((core, replayed))
        })
        .map(|thread| (thread, n))
        .map_err(|e| format!("no catch-up thread: {e}"))
}
