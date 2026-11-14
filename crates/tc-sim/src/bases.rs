//! A game's bases ([`Game::save`]): every [`SimConfig::base_every`]
//! entries the loop starts a new log generation, writes the game's state
//! through the last entry of the old one (a base, in tc-store's `base/`),
//! and archives the generations behind the older of the two bases it
//! keeps, so the store's live log stays bounded. Opening restores the
//! newest base that reads back whole and replays only the log after it;
//! a reload does the same with the new game.
//!
//! The steps, so the loop never waits for the disk: tc-store's background
//! thread makes the next generation's files ([`tc_store::prepare`]); the
//! loop swaps them in ([`Log::rotate`]) and encodes the base at that
//! entry, in the same tick; the background thread makes the old
//! generations durable and writes the base; the loop notes it
//! ([`Log::note_base`]) and, once the clock mark asked for at the
//! rotation is on disk (it holds the old generation's files open until
//! then), the background thread archives behind the kept bases
//! ([`tc_store::tidy`]).

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};

use tc_store::{ArchivePolicy, BaseFile, Log, LogCodec, Prepared, StoreError};
use tracing::{info, warn};

use crate::core::{Core, base_intact};
use crate::game::Game;
use crate::sim::Sim;

/// The bases a store keeps: the newest, and one before it in case the
/// newest can't be restored.
pub const KEEP_BASES: usize = 2;

/// The longest [`Sim::finish_base`] waits.
pub const BASE_SETTLE: Duration = Duration::from_secs(60);

type Key<G> = <<G as Game>::Codec as LogCodec>::Key;

/// Where the loop is in writing a base.
pub(crate) enum Step<G: Game> {
    Idle,
    Preparing(Receiver<Result<Prepared<Key<G>>, StoreError>>),
    Writing(Receiver<Result<Vec<BaseFile>, StoreError>>),
    /// Archiving behind `below` once the rotation's mark is on disk.
    Tidying {
        below: u64,
    },
}

/// The loop's bases.
pub(crate) struct Bases<G: Game> {
    pub(crate) every: u64,
    pub(crate) archive: ArchivePolicy,
    /// The entry the last base covers (or the loop opened at).
    pub(crate) last: u64,
    pub(crate) step: Step<G>,
    pub(crate) written: u64,
    /// The base the loop opened from: `(generation, after)`.
    pub(crate) opened_from: Option<(u64, u64)>,
}

impl<G: Game> Bases<G> {
    pub(crate) fn new(every: u64, archive: ArchivePolicy, last: u64) -> Bases<G> {
        Bases {
            every,
            archive,
            last,
            step: Step::Idle,
            written: 0,
            opened_from: None,
        }
    }

    pub(crate) fn busy(&self) -> bool {
        !matches!(self.step, Step::Idle)
    }
}

impl<G: Game> Sim<G> {
    /// Bases written since the loop started.
    pub fn bases_written(&self) -> u64 {
        self.bases.written
    }

    /// The base the loop opened from, `(generation, after)`: `None` if it
    /// replayed the whole log.
    pub fn opened_from_base(&self) -> Option<(u64, u64)> {
        self.bases.opened_from
    }

    /// Whether a base is being written.
    pub fn base_pending(&self) -> bool {
        self.bases.busy()
    }

    /// Starts a base now if the game keeps them and none is under way
    /// (a tool, or a test); the loop finishes it over the next ticks.
    pub fn start_base(&mut self) -> bool {
        if self.bases.busy() || self.store_error.is_some() || self.reloads.running() {
            return false;
        }
        let Some(log) = &self.log else {
            return false;
        };
        let (next, keys) = log.to_prepare();
        let dir = log.dir().to_path_buf();
        let codec = log.codec().clone();
        let (tx, rx) = mpsc::channel();
        let job = move || {
            let _ = tx.send(tc_store::prepare(&dir, &codec, next, &keys));
        };
        if let Err(e) = log.background().run(job) {
            warn!("no base: {e}");
            self.bases.last = self.core.version();
            return false;
        }
        self.bases.step = Step::Preparing(rx);
        true
    }

    /// Waits (up to [`BASE_SETTLE`]) for a base under way to be written
    /// and the archive behind it tidied: the loop calls it as it stops, a
    /// test after [`Sim::start_base`].
    pub fn finish_base(&mut self) {
        let deadline = Instant::now() + BASE_SETTLE;
        while self.bases.busy() && Instant::now() < deadline {
            if matches!(self.bases.step, Step::Tidying { .. })
                && let Some(log) = &mut self.log
                && let Err(e) = log.wait()
            {
                self.store_failed(&e.to_string());
                self.bases.step = Step::Idle;
            }
            self.poll_base();
            if self.bases.busy() {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        // The archive's job, if one was handed over.
        if let Some(log) = &self.log {
            let (tx, rx) = mpsc::channel();
            if log
                .background()
                .run(move || {
                    let _ = tx.send(());
                })
                .is_ok()
            {
                let _ = rx.recv_timeout(BASE_SETTLE);
            }
        }
    }

    /// The base cycle's step for this tick (see the module docs).
    pub(crate) fn poll_base(&mut self) {
        match std::mem::replace(&mut self.bases.step, Step::Idle) {
            Step::Idle => {
                let due = self.bases.every > 0
                    && self.core.version() - self.bases.last >= self.bases.every;
                if due {
                    self.start_base();
                }
            }
            Step::Preparing(rx) => match rx.try_recv() {
                Err(TryRecvError::Empty) => self.bases.step = Step::Preparing(rx),
                Err(TryRecvError::Disconnected) => self.base_failed("its job was lost".into()),
                Ok(Err(e)) => self.base_failed(e.to_string()),
                Ok(Ok(prepared)) => self.rotate_and_write(prepared),
            },
            Step::Writing(rx) => match rx.try_recv() {
                Err(TryRecvError::Empty) => self.bases.step = Step::Writing(rx),
                Err(TryRecvError::Disconnected) => self.base_failed("its job was lost".into()),
                Ok(Err(e)) => self.base_failed(e.to_string()),
                Ok(Ok(kept)) => {
                    self.bases.written += 1;
                    let newest = kept.first().map_or(0, |b| b.generation);
                    if let Some(log) = &mut self.log {
                        log.note_base(newest);
                    }
                    let below = kept.last().map_or(0, |b| b.generation);
                    self.bases.step = Step::Tidying { below };
                }
            },
            Step::Tidying { below } => {
                let Some(log) = &self.log else { return };
                if self.store_error.is_some() {
                    return;
                }
                if log.marks_pending() {
                    self.bases.step = Step::Tidying { below };
                    return;
                }
                let dir = log.dir().to_path_buf();
                tidy_later(log, dir, below, self.bases.archive);
            }
        }
    }

    /// The new generation's files are ready: rotate to them and write the
    /// base of the game as it is, through the old generation's last entry.
    fn rotate_and_write(&mut self, prepared: Prepared<Key<G>>) {
        let base = self.core.to_base();
        let time = self.core.time();
        let Some(log) = &mut self.log else { return };
        debug_assert_eq!(log.last_seq(), self.core.version());
        // Rotated to even without a base, so the files made aren't left
        // unused.
        let cut = match log.rotate(prepared, time) {
            Ok(cut) => cut,
            Err(e) => {
                self.store_failed(&format!("starting a log generation: {e}"));
                return;
            }
        };
        let Some(base) = base else {
            // The game keeps no bases: none is tried again.
            self.bases.every = 0;
            return;
        };
        self.bases.last = cut.last_seq();
        // Hands the old generation's files to the I/O thread now: the
        // archive waits for this mark.
        self.mark_clock();
        let Some(log) = &self.log else { return };
        let dir = log.dir().to_path_buf();
        let frozen: Vec<PathBuf> = cut.frozen_paths().map(Path::to_path_buf).collect();
        let (generation, after) = (cut.generation(), cut.last_seq());
        let (tx, rx) = mpsc::channel();
        let job = move || {
            let written = tc_store::sync_frozen(&dir, frozen.iter().map(PathBuf::as_path))
                .and_then(|()| tc_store::write_base(&dir, generation, after, &base))
                .and_then(|_| tc_store::prune_bases(&dir, KEEP_BASES));
            let _ = tx.send(written);
        };
        match log.background().run(job) {
            Ok(()) => self.bases.step = Step::Writing(rx),
            Err(e) => self.base_failed(e.to_string()),
        }
    }

    fn base_failed(&mut self, e: String) {
        warn!("a base wasn't written ({e}); the next is tried after as many entries again");
        self.bases.last = self.core.version();
        self.bases.step = Step::Idle;
    }

    /// After opening from a base: archives what an earlier run left
    /// behind the kept bases, before the loop starts (no job of this run
    /// is under way yet).
    pub(crate) fn tidy_after_open(&mut self) {
        let Some(log) = &mut self.log else { return };
        let Some((generation, _)) = self.bases.opened_from else {
            return;
        };
        log.note_base(generation);
        let dir = log.dir().to_path_buf();
        let below = match tc_store::prune_bases(&dir, KEEP_BASES) {
            Ok(kept) => kept.last().map_or(0, |b| b.generation).min(generation),
            Err(e) => {
                warn!("the bases weren't pruned: {e}");
                return;
            }
        };
        if below > 0
            && let Err(e) = tc_store::tidy(&dir, log.codec(), below, &self.bases.archive)
        {
            warn!("the log wasn't archived behind its base: {e}");
        }
    }
}

/// Archives the generations below `below` on the store's background
/// thread.
fn tidy_later<C: LogCodec + Clone>(log: &Log<C>, dir: PathBuf, below: u64, policy: ArchivePolicy) {
    if below == 0 {
        return;
    }
    let codec = log.codec().clone();
    let job = move || match tc_store::tidy(&dir, &codec, below, &policy) {
        Ok(t) if !t.archived.is_empty() || !t.pruned.is_empty() => {
            info!(archived = ?t.archived, pruned = ?t.pruned, bytes = t.bytes, "log archived behind a base");
        }
        Ok(_) => {}
        Err(e) => warn!("the log wasn't archived behind its base: {e}"),
    };
    if let Err(e) = log.background().run(job) {
        warn!("the log wasn't archived: {e}");
    }
}

/// Opens the store in `dir` from its newest base that reads back whole,
/// replaying the log after it into `game`; or, if it keeps none, from the
/// start.
#[allow(clippy::type_complexity)]
pub(crate) fn open_log<G: Game>(
    dir: &Path,
    game: G,
) -> Result<
    (
        Log<G::Codec>,
        tc_store::Opened<crate::game::EventOf<G>>,
        Core<G>,
        Option<(u64, u64)>,
    ),
    String,
> {
    let codec = game.codec();
    let bases = tc_store::bases(dir).map_err(|e| e.to_string())?;
    for base in bases {
        let bytes = match std::fs::read(&base.path) {
            Ok(bytes) if base_intact(&bytes) => bytes,
            Ok(_) => {
                warn!(path = %base.path.display(), "a damaged base is skipped");
                continue;
            }
            Err(e) => {
                warn!(path = %base.path.display(), "a base can't be read ({e}); skipped");
                continue;
            }
        };
        let (log, opened) = match Log::open_from(dir, codec.clone(), base.generation, base.after) {
            Ok(opened) => opened,
            Err(e @ StoreError::InUse { .. }) => return Err(e.to_string()),
            Err(e) => {
                warn!(path = %base.path.display(), "the log after a base can't be read ({e}); skipped");
                continue;
            }
        };
        let core = Core::from_base(game, &bytes, true)?;
        return Ok((log, opened, core, Some((base.generation, base.after))));
    }
    let (log, opened) = Log::open(dir, codec).map_err(|e| e.to_string())?;
    Ok((log, opened, Core::new(game), None))
}
