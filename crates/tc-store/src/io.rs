//! The store's I/O thread: clock marks sync the log files here, off the
//! thread that appends.
//!
//! The appending thread hands over a [`Mark`] (the game time, the last
//! entry it covers, the keyed files written since the last mark, and the
//! directories a keyed file was created in since then) and goes on. The
//! thread makes those files, their new names and `main.log` durable, then
//! appends the mark to `main.log` and syncs that, so a mark on disk proves
//! every entry it covers is on disk, in a file whose name is too. Entries
//! appended meanwhile may or may not be made durable with them; the mark
//! doesn't claim them.
//!
//! # macOS
//!
//! A durable sync on macOS is an `F_FULLFSYNC` (what `File::sync_data`
//! does there): the file's writes go to the drive, then the drive flushes
//! its whole write cache. Each takes milliseconds, and while one runs,
//! appends to every file on the volume wait, not just to its own: syncing
//! a hundred files that way kept appends waiting for tens of milliseconds
//! at a time (in Forge Wilds). So the thread hands each keyed file's
//! writes to the drive with a plain `fsync` (fractions of a millisecond;
//! durable once the drive's cache is flushed), then makes them durable
//! together with one `F_FULLFSYNC` of `main.log`, which flushes the cache:
//! two cache flushes per mark, the second for the mark itself, whatever
//! the number of files. A directory that gained a keyed file is handed
//! over the same way (a plain `fsync` of the directory), once per mark.
//! Appends don't wait for either: while one runs they are held in memory
//! and written as it returns (see the `hold` module). The
//! [`crate::Background`] thread holds them around its own durable syncs
//! the same way, and the two take turns (see the `durable` module).
//! Elsewhere (`fdatasync`) each sync is durable on its own and doesn't
//! hold up other files.
//!
//! Marks are written in the order they were asked for. A mark asked for
//! while another is still waiting to start is merged into it (the later
//! time and coverage, both sets of files), so a slow disk delays marks but
//! never queues them up.
//!
//! # Failures
//!
//! A failed mark is reported once, by the next [`Io::take_error`] or
//! [`Io::wait`], and no mark is written until one succeeds. Meanwhile the
//! store refuses appends ([`Io::blocked`]): it can't make them durable,
//! and an entry acknowledged now could be lost. How it recovers depends on
//! what failed:
//!
//! - **The file couldn't be opened** to sync it (too many open files, a
//!   file moved away), or the mark couldn't be appended (disk full; the
//!   write is rolled back): nothing was lost from the page cache, so the
//!   next mark syncs the same files again, and once one is written the
//!   store accepts appends again.
//! - **A sync itself failed** (`fsync`/`fdatasync`/`F_FULLFSYNC` returned
//!   an error, say EIO from a failing disk): the kernel may have dropped
//!   the unsynced data and marked it clean, so a later sync of the same
//!   file can succeed without writing it (Linux's "fsyncgate"). No later
//!   mark could be trusted, so the store refuses appends and marks for
//!   good. Reopening reads what really reached the disk. An append held
//!   during a sync that then couldn't be written counts the same, whichever
//!   thread held it ([`Hold::failed`]).

use std::collections::VecDeque;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;

use crate::error::StoreError;
use crate::hold::Hold;
use crate::log_file::LogFile;
use crate::{durable, format, io_err};

/// Locks `mutex`, ignoring poisoning: the store's state stays consistent
/// across a panic (every write is rolled back or poisons the store).
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A log file to sync: its path and, if it was open, its handle.
pub(crate) struct ToSync {
    pub path: PathBuf,
    pub file: Option<Arc<File>>,
}

/// A clock mark waiting for its files to be synced.
pub(crate) struct Mark {
    pub time: u64,
    /// The last entry appended before the mark was asked for.
    pub covers: u64,
    /// When it was asked for, in seconds since the Unix epoch.
    pub wall: u64,
    /// True if the caller gave the wall time: the mark is written as asked,
    /// never folded with another.
    pub exact: bool,
    /// Every keyed file written since the last mark was asked for, and
    /// the main log it was asked under, with the files of a generation
    /// rotated away since the last mark (see the `gens` module).
    pub files: Vec<ToSync>,
    /// Every directory a keyed file was created in since the last mark
    /// was asked for, each once: the files' names must be durable before
    /// the mark is.
    pub dirs: Vec<PathBuf>,
}

impl Mark {
    /// Folds a later mark into this one.
    fn merge(&mut self, later: Mark) {
        self.time = self.time.max(later.time);
        self.covers = self.covers.max(later.covers);
        self.wall = self.wall.max(later.wall);
        merge_files(&mut self.files, later.files);
        merge_dirs(&mut self.dirs, later.dirs);
    }
}

/// Adds `more` to `dirs`, each once.
fn merge_dirs(dirs: &mut Vec<PathBuf>, more: Vec<PathBuf>) {
    for dir in more {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
}

/// Adds `more` to `files`, each path once.
fn merge_files(files: &mut Vec<ToSync>, more: Vec<ToSync>) {
    for file in more {
        if !files.iter().any(|f| f.path == file.path) {
            files.push(file);
        }
    }
}

#[derive(Default)]
struct State {
    /// The marks waiting to start, oldest first, each with the count of
    /// marks asked for it finishes (marks without a wall time of their own
    /// are folded into the one waiting behind them).
    pending: VecDeque<(Mark, u64)>,
    /// Marks asked for, and how many of those are finished (written, or
    /// failed).
    requested: u64,
    finished: u64,
    /// The first failure not yet reported.
    error: Option<StoreError>,
    /// Why appends are refused: the last mark failed (until one succeeds)
    /// or a sync failed (for good). See the module docs.
    blocked: Option<String>,
    /// A sync itself failed: nothing is made durable from here on.
    sync_failed: bool,
    stop: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Signals a new mark, a finished one, or the stop.
    changed: Condvar,
    /// Makes every sync of `main.log` fail, for tests of the failure path.
    fail_syncs: AtomicBool,
    /// Holds the I/O thread inside its sync of `main.log` while set, and
    /// says when it is there: for the tests of held appends.
    #[cfg(test)]
    stall: AtomicBool,
    #[cfg(test)]
    stalled: AtomicBool,
    /// What the thread did, in order (see [`Io::trace`]): for tests.
    #[cfg(test)]
    trace: Mutex<Vec<Step>>,
}

/// One thing the I/O thread did for a mark, for tests of their order.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Handed a keyed file's writes to the drive.
    Pushed(PathBuf),
    /// Handed a directory's new names to the drive.
    Dir(PathBuf),
    /// Synced `main.log` (on macOS flushing the drive's cache).
    SyncedMain,
    /// Appended a mark covering the entries through this one.
    Mark(u64),
}

/// The I/O thread. Dropping it waits for every mark asked for to finish.
pub(crate) struct Io {
    shared: Arc<Shared>,
    hold: Arc<Hold>,
    thread: Option<JoinHandle<()>>,
}

impl Io {
    /// Starts the thread; it appends marks to `main`, and holds the
    /// store's appends in `hold` while it syncs.
    pub fn start(main: Arc<Mutex<LogFile>>, hold: Arc<Hold>) -> std::io::Result<Io> {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            fail_syncs: AtomicBool::new(false),
            #[cfg(test)]
            stall: AtomicBool::new(false),
            #[cfg(test)]
            stalled: AtomicBool::new(false),
            #[cfg(test)]
            trace: Mutex::new(Vec::new()),
        });
        let thread = {
            let (shared, hold) = (shared.clone(), hold.clone());
            std::thread::Builder::new()
                .name("tc-store-io".into())
                .spawn(move || run(&shared, &main, &hold))?
        };
        Ok(Io {
            shared,
            hold,
            thread: Some(thread),
        })
    }

    /// Asks for a mark, merging it into one still waiting to start unless
    /// either is [`Mark::exact`]. Returns at once.
    pub fn request(&self, mark: Mark) {
        let mut state = lock(&self.shared.state);
        state.requested += 1;
        let through = state.requested;
        match state.pending.back_mut() {
            Some((last, done)) if !last.exact && !mark.exact => {
                last.merge(mark);
                *done = through;
            }
            _ => state.pending.push_back((mark, through)),
        }
        self.shared.changed.notify_all();
    }

    /// The first failure since the last one reported, if any.
    pub fn take_error(&self) -> Option<StoreError> {
        lock(&self.shared.state).error.take()
    }

    /// Why the store must refuse appends, if it must: the last mark failed
    /// and none has succeeded since, or a sync failed, or an append held
    /// during one couldn't be written (see the module docs).
    pub fn blocked(&self) -> Option<StoreError> {
        let blocked = lock(&self.shared.state).blocked.clone();
        blocked
            .or_else(|| self.hold.failed().map(given_up))
            .map(StoreError::NotDurable)
    }

    /// Makes every later sync of `main.log` fail (or stop failing), as a
    /// failing disk would: for tests.
    pub fn fail_syncs(&self, fail: bool) {
        self.shared.fail_syncs.store(fail, Ordering::Relaxed);
    }

    /// Holds the I/O thread inside its next syncs of `main.log` until set
    /// back to false: for tests.
    #[cfg(test)]
    pub fn stall_syncs(&self, stall: bool) {
        self.shared.stall.store(stall, Ordering::Relaxed);
    }

    /// True while the I/O thread is held inside a sync by
    /// [`Io::stall_syncs`].
    #[cfg(test)]
    pub fn stalled(&self) -> bool {
        self.shared.stalled.load(Ordering::Relaxed)
    }

    /// What the thread did for marks so far, in order: for tests.
    #[cfg(test)]
    pub fn trace(&self) -> Vec<Step> {
        lock(&self.shared.trace).clone()
    }

    /// True while a mark asked for isn't finished.
    pub fn pending(&self) -> bool {
        let state = lock(&self.shared.state);
        state.finished < state.requested
    }

    /// Waits until every mark asked for is finished, then reports the
    /// first failure since the last one reported.
    pub fn wait(&self) -> Result<(), StoreError> {
        let mut state = lock(&self.shared.state);
        while state.finished < state.requested {
            state = self
                .shared
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        state.error.take().map_or(Ok(()), Err)
    }
}

impl Drop for Io {
    fn drop(&mut self) {
        lock(&self.shared.state).stop = true;
        self.shared.changed.notify_all();
        if let Some(thread) = self.thread.take() {
            // A panic there has nothing left to report.
            let _ = thread.join();
        }
        // The background thread may be inside a sync with appends held:
        // they are written as it returns.
        self.hold.settle();
    }
}

/// Why nothing more can be saved after a failed sync (`why`).
fn given_up(why: String) -> String {
    format!("a sync failed ({why}); nothing more can be saved until a restart")
}

/// The thread: writes marks until stopped, finishing any still asked for.
fn run(shared: &Shared, main: &Mutex<LogFile>, hold: &Hold) {
    // Files and directories whose last sync failed: their writes may not
    // be on disk.
    let mut retry = Retry::default();
    loop {
        let (mark, through) = {
            let mut state = lock(&shared.state);
            loop {
                if let Some(next) = state.pending.pop_front() {
                    break next;
                }
                if state.stop {
                    return;
                }
                state = shared
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        };
        let sync_failed = lock(&shared.state).sync_failed;
        let result = if let Some(why) = hold.failed().filter(|_| !sync_failed) {
            Err(Failure::Sync(StoreError::NotDurable(why)))
        } else if sync_failed {
            Err(Failure::Sync(StoreError::NotDurable(
                "an earlier sync failed; restart once the disk is fixed".into(),
            )))
        } else {
            write_mark(mark, main, hold, &mut retry, shared)
        };
        let mut state = lock(&shared.state);
        state.finished = through;
        match result {
            Ok(()) => state.blocked = None,
            Err(failure) => {
                let (e, sync) = match failure {
                    Failure::Retry(e) => (e, false),
                    Failure::Sync(e) => (e, true),
                };
                state.sync_failed |= sync;
                state.blocked = Some(if state.sync_failed {
                    given_up(e.to_string())
                } else {
                    format!("the last clock mark failed ({e}); retrying with the next one")
                });
                state.error.get_or_insert(e);
            }
        }
        shared.changed.notify_all();
    }
}

/// Why a mark failed: something worth retrying, or a sync (see the module
/// docs).
#[derive(Debug)]
pub(crate) enum Failure {
    /// A file couldn't be opened, or the mark couldn't be appended.
    Retry(StoreError),
    /// A sync call failed: what it was to make durable may be gone.
    Sync(StoreError),
}

impl From<StoreError> for Failure {
    fn from(e: StoreError) -> Failure {
        Failure::Retry(e)
    }
}

/// What a failed mark left to sync again: the next mark syncs it first.
#[derive(Default)]
struct Retry {
    files: Vec<ToSync>,
    dirs: Vec<PathBuf>,
}

/// Makes the mark's keyed files and new names (and any that failed
/// before) and `main.log` durable, then appends the mark to `main.log`
/// and syncs it. Writes no mark if a sync fails. The store's appends are
/// held while it syncs, and written as each sync returns (see the `hold`
/// module).
fn write_mark(
    mark: Mark,
    main: &Mutex<LogFile>,
    hold: &Hold,
    retry: &mut Retry,
    shared: &Shared,
) -> Result<(), Failure> {
    #[cfg(test)]
    let note = |step: Step| lock(&shared.trace).push(step);
    let sync_main = |file: &File| {
        #[cfg(test)]
        while shared.stall.load(Ordering::Relaxed) {
            shared.stalled.store(true, Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        #[cfg(test)]
        shared.stalled.store(false, Ordering::Relaxed);
        if shared.fail_syncs.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("injected sync failure"));
        }
        #[cfg(test)]
        note(Step::SyncedMain);
        durable::note_sync();
        // Its data only (`fdatasync` elsewhere): the store's other durable
        // syncs go through `durable`, but this one holds appends itself.
        #[allow(clippy::disallowed_methods)]
        file.sync_data()
    };
    let mut files = std::mem::take(&mut retry.files);
    merge_files(&mut files, mark.files);
    let mut dirs = std::mem::take(&mut retry.dirs);
    merge_dirs(&mut dirs, mark.dirs);
    // The main log appended to now. A rotation (see the `gens` module)
    // may have replaced the one the mark was asked under: that one is
    // among `files`, with the old generation's keyed files.
    let main_log = lock(main).to_sync();
    let (pushed, released) = hold.during(|| {
        files
            .iter()
            .filter(|f| f.path != main_log.path)
            .try_for_each(|f| {
                #[cfg(test)]
                note(Step::Pushed(f.path.clone()));
                with_file(f, |h| durable::push(h, &f.path))
            })
            .and_then(|()| {
                dirs.iter().try_for_each(|d| {
                    #[cfg(test)]
                    note(Step::Dir(d.clone()));
                    push_dir(d)
                })
            })
            // Durable from here: on macOS this flushes the drive's cache.
            .and_then(|()| with_file(&main_log, sync_main))
    });
    // The held appends were written before the mark, so it lands after
    // them, as an append that waited out the sync would have.
    released.map_err(held_lost)?;
    if let Err(e) = pushed {
        // A plain fsync isn't durable until a flush succeeds: start over.
        *retry = Retry { files, dirs };
        return Err(e);
    }

    let mut bytes = Vec::new();
    format::push_mark(&mut bytes, mark.time, mark.covers, Some(mark.wall));
    // Into the main log as it is now (a rotation may have come between).
    let written = {
        let mut main = lock(main);
        main.write(&bytes, hold)?;
        main.to_sync()
    };
    #[cfg(test)]
    note(Step::Mark(mark.covers));
    let (synced, released) = hold.during(|| with_file(&written, sync_main));
    released.map_err(held_lost)?;
    synced
}

/// An append held during a sync couldn't be written when it returned. It
/// can't be refused any more (its entry was accepted), so it counts as a
/// failed sync: the store saves nothing more until it is reopened.
fn held_lost(e: std::io::Error) -> Failure {
    Failure::Sync(StoreError::NotDurable(format!(
        "an append held during a sync couldn't be written: {e}"
    )))
}

/// Runs `op` on the file through its handle, or, if it is closed, through
/// a handle opened for the purpose (a sync makes the file's data durable
/// whichever handle wrote it; see [`crate::open_to_sync`]). A failure to
/// open it is worth retrying; a failure of `op` is a failed sync.
fn with_file(file: &ToSync, op: impl FnOnce(&File) -> std::io::Result<()>) -> Result<(), Failure> {
    let opened;
    let f = match file.file.as_deref() {
        Some(f) => f,
        None => {
            opened = match crate::open_to_sync(&file.path) {
                Ok(f) => f,
                Err(e) => return Err(Failure::Retry(io_err(&file.path)(e))),
            };
            &opened
        }
    };
    op(f).map_err(|e| Failure::Sync(io_err(&file.path)(e)))
}

/// Hands the names created in directory `dir` to the drive, as
/// [`durable::push`] does a file's writes (durable once the drive's cache
/// is flushed on macOS; durable on its own elsewhere). Windows has nothing
/// to sync (see [`durable::sync_dir`]).
fn push_dir(dir: &std::path::Path) -> Result<(), Failure> {
    #[cfg(unix)]
    {
        let handle = File::open(dir).map_err(|e| Failure::Retry(io_err(dir)(e)))?;
        durable::push_dir_handle(&handle, dir).map_err(|e| Failure::Sync(io_err(dir)(e)))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}
