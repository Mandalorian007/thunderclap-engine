//! ThunderClap's event-log store: an append-only log of a game's events in
//! a directory, with the game's own codec ([`LogCodec`]), clock marks that
//! prove what is durable, log generations, crash recovery and a lock that
//! keeps a second process out.
//!
//! # A store directory
//!
//! - `store.meta`: the game's metadata bytes, written once at creation (via
//!   a temporary file and a rename), so a directory with it is complete.
//! - `log/main.log`: entries with no file key, and the clock marks.
//! - `log/<name>`: entries with a file key, one file per key, named by the
//!   codec ([`LogCodec::file_name`]).
//! - `log/g<n>/`: the same files for log generation `n` (those in `log/`
//!   are generation 0), each started by a rotation ([`Log::rotate`]).
//! - `store.lock` (and `store.holder` on Windows): the lock ([`StoreLock`]).
//! - `recovered/`: every byte recovery cut off a file, kept
//!   (`<file>.<from>-<to>.<unix time>.tail`), and the old log (and
//!   archive) a repair or rollback in place replaced
//!   (`<repair|rollback>.<unix time>/`).
//! - `archive/g<n>/`: generation `n`, archived by [`tidy`]: each file
//!   deflated (`<file>.z`) and an `info` file (its entries, latest wall
//!   time, size). Pruned by age and size ([`ArchivePolicy`]: a week, 1 GiB).
//! - `.swap/`: a repair or rollback in place, while it is written; opening
//!   finishes or clears it.
//!
//! Every entry carries its global sequence number, so opening reads the
//! files of every generation and merges them by sequence. The binary
//! layout is in the `format` module.
//!
//! # Durability
//!
//! Appends aren't synced. A clock mark ([`Log::mark`]) names the last entry
//! it covers and is written to `main.log` only once every file written
//! before it was asked for is durable, then synced itself: a mark on disk
//! proves every entry it covers is on disk. Marks are written on the
//! store's I/O thread, so the thread that appends never waits on a sync;
//! while that thread syncs, appends are held in memory and written as the
//! sync returns (the `hold` module). A failed mark refuses appends until
//! one succeeds; a failed sync refuses them until the store is reopened.
//!
//! # Recovery
//!
//! An OS crash can lose any unsynced suffix of each file independently.
//! Opening ([`Log::open`]) keeps the longest gap-free prefix of sequence
//! numbers that lost writes explain, drops a batch it ends inside of (a
//! batch is all or none), cuts every file back to it, saves what it cuts
//! in `recovered/`, and writes again a clock mark cut off with dropped
//! entries. Anything else (damage before a file's end, a mark covering a
//! missing entry, a duplicate entry) is an error that changes nothing.
//! What opening did is the [`OpenReport`].
//!
//! Past that: [`check`] says what is wrong, changing nothing; [`repair`]
//! writes a new log holding what can be trusted; [`rollback`] one holding
//! an earlier point. Both write a copy or work in place, the old log moved
//! to `recovered/`, never destroyed. [`backup`] copies a store while it is
//! appended to, and the copy opens cleanly.
//!
//! # Windows
//!
//! Every sync goes through a writable handle (`FlushFileBuffers` needs
//! write access), a cut through a handle opened to write, directories
//! aren't synced (NTFS journals its own metadata), and the lock's holder is
//! written beside the locked file, which no other handle can read.
//!
//! # Parts
//!
//! `codec` (the game's side), `format` (framing and records), `log_file`
//! (one file appended to), `writer` ([`Log`]: create, open, append, marks,
//! generations), `io` (the I/O thread), `hold` (appends held while it
//! syncs), `durable` (every sync), `background` (jobs off the appending
//! thread), `read` and `load` (decoding and recovery), `recovered` (what
//! recovery keeps), `gens` (generations), `lock` and `crash` (crash points
//! for tests); `salvage` ([`check`], [`repair`]), `rollback`, `copy` (a
//! store's history read and written again), `swap` (in place), `archive`
//! ([`tidy`]), `backup`, `tail` ([`LogReader`]) and `memory` ([`Store`],
//! [`MemoryLog`]).

mod archive;
mod background;
mod backup;
mod codec;
mod copy;
mod crash;
mod durable;
mod error;
pub mod format;
mod gens;
mod hold;
mod io;
mod load;
mod lock;
mod log_file;
mod memory;
mod read;
mod recovered;
mod rollback;
mod salvage;
mod swap;
mod tail;
mod writer;

#[cfg(test)]
mod tests;

use std::fs::File;
#[cfg(windows)]
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

pub use archive::{ARCHIVE_DIR, ArchivePolicy, Archived, Tidied, summary, tidy};
pub use background::Background;
pub use backup::{BackupReport, backup};
pub use codec::{LogCodec, LogEntry, NameTable, Names};
pub use error::StoreError;
pub use gens::gen_dir;
pub use load::{ReadLog, read};
pub use lock::{HOLDER_FILE, Holder, LOCK_FILE, StoreLock, holder};
pub use memory::{MemoryLog, Store};
pub use rollback::{RollbackReport, RollbackTo, rollback};
pub use salvage::{
    CheckReport, FileSummary, Refused, RepairReport, Salvage, check, repair, repair_with,
};
pub use swap::{Output, SWAP_DIR};
pub use tail::{LogReader, ReadMark};
pub use writer::{Counters, CutFile, Log, LogCut, Opened, Prepared, prepare, sync_frozen};

/// The most keyed log files a [`Log`] keeps open at once; the least
/// recently written is closed (not synced) to make room.
pub const MAX_OPEN_FILES: usize = 64;

/// The file in `log/` (and each `log/g<n>/`) that holds the entries with
/// no file key, and the clock marks.
pub const MAIN_LOG: &str = "main.log";

/// The game's metadata file in a store directory.
pub const META_FILE: &str = "store.meta";

/// Where the bytes cut off a log file are saved, in the store directory.
pub const RECOVERED_DIR: &str = "recovered";

/// What opening a store recovered from. Empty after a clean shutdown.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenReport {
    /// The first missing entry, when the log had a gap that lost writes
    /// explain. The log resumes just before it.
    pub missing: Option<u64>,
    /// Entries after the gap, dropped because the durable log ends before
    /// them, in sequence order.
    pub dropped: Vec<u64>,
    /// Files cut back to their durable prefix, by torn records or dropped
    /// entries.
    pub truncated: Vec<Truncated>,
    /// A batch (its first and last entries) a crash left incomplete: its
    /// entries that reached the disk are among `dropped`.
    pub partial_batch: Option<(u64, u64)>,
}

impl OpenReport {
    /// True if nothing was recovered.
    pub fn is_clean(&self) -> bool {
        self.missing.is_none()
            && self.dropped.is_empty()
            && self.truncated.is_empty()
            && self.partial_batch.is_none()
    }
}

/// A log file cut back when a store was opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Truncated {
    /// The file.
    pub path: PathBuf,
    /// Its length before.
    pub from: u64,
    /// Its length after (0 when not even the header was whole; the header
    /// is then rewritten).
    pub to: u64,
    /// Where the bytes cut off were saved (in `recovered/`), once
    /// [`Log::open`] has cut them; `None` from [`read`], which cuts
    /// nothing.
    pub saved: Option<PathBuf>,
}

/// Which log a file is: the main log, or a keyed one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FileKind<K> {
    Main,
    Keyed(K),
}

fn io_err(path: &Path) -> impl FnOnce(std::io::Error) -> StoreError + '_ {
    move |error| StoreError::Io {
        path: path.to_path_buf(),
        error,
    }
}

/// Opens the file at `path` to sync it when no handle to it is open. A
/// sync makes the file's data durable whichever handle wrote it: on Unix
/// a read-only handle can sync, but Windows' `FlushFileBuffers` needs
/// write access, so there the handle is opened for writing (and nothing
/// is written through it).
pub(crate) fn open_to_sync(path: &Path) -> std::io::Result<File> {
    #[cfg(windows)]
    return OpenOptions::new().write(true).open(path);
    #[cfg(not(windows))]
    File::open(path)
}

/// Cuts `file` (open at `path`) to `len` bytes. On Windows a handle opened
/// to append can't (truncating needs the `FILE_WRITE_DATA` access Rust
/// leaves out of an append handle), so it is done through a handle opened
/// for writing. Appends through `file` go to the new end either way.
pub(crate) fn set_len(file: &File, path: &Path, len: u64) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let _ = file;
        OpenOptions::new().write(true).open(path)?.set_len(len)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        file.set_len(len)
    }
}

fn log_dir(dir: &Path) -> PathBuf {
    dir.join("log")
}

/// The time [`unix_now`] says instead of the clock's, if not 0.
static FAKE_CLOCK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Makes [`unix_now`] say `now` (seconds since the Unix epoch) until set
/// back to `None`: for tests. For the whole process.
#[doc(hidden)]
pub fn set_clock_for_tests(now: Option<u64>) {
    FAKE_CLOCK.store(now.unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
}

/// Seconds since the Unix epoch now: a clock mark's wall time, and the
/// names of the files `recovered/` keeps. Nothing replayed reads it.
pub fn unix_now() -> u64 {
    let fake = FAKE_CLOCK.load(std::sync::atomic::Ordering::Relaxed);
    if fake != 0 {
        return fake;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
