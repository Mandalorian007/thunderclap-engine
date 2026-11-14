//! The store's syncs, in one place: a durable sync of a file or a
//! directory ([`full`], [`sync_dir`]), and handing one's writes to the
//! drive ([`push`], [`push_dir`]). Every sync in the crate goes through
//! here (clippy refuses `File::sync_all` and `sync_data` elsewhere: see
//! the crate's `clippy.toml`).
//!
//! # macOS
//!
//! A durable sync is an `F_FULLFSYNC`: several milliseconds, during which
//! every write that grows a file on the volume waits (see the `hold`
//! module). So a batch of files is pushed file by file (a plain `fsync`,
//! fractions of a millisecond, durable once the drive's cache is flushed)
//! and made durable by one durable sync at the end, which flushes the
//! cache: the model the I/O thread's clock marks use (see the `io`
//! module). And a thread that syncs while the game appends (the I/O
//! thread, the [`crate::Background`] thread) holds the appends around each
//! durable sync ([`hold_appends_here`], [`crate::hold::Hold::during`]).
//!
//! Elsewhere a push is a sync, durable on its own (`fdatasync`), and a
//! durable sync is `fsync`; directories sync on Unix only (NTFS journals
//! its metadata itself).

use std::cell::{Cell, RefCell};
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use crate::error::StoreError;
use crate::hold::Hold;
use crate::io_err;

thread_local! {
    /// Syncs the store made on this thread (durable syncs and pushes): the
    /// appending thread should make none (see [`crate::Counters`]).
    static SYNCS: Cell<u64> = const { Cell::new(0) };
    /// The store whose appends this thread's durable syncs hold, if any:
    /// set for the store's background thread.
    static HOLDS: RefCell<Option<Arc<Hold>>> = const { RefCell::new(None) };
}

/// Counts a sync made on this thread.
pub(crate) fn note_sync() {
    SYNCS.with(|n| n.set(n.get() + 1));
}

/// How many syncs the store has made on this thread.
pub(crate) fn syncs_here() -> u64 {
    SYNCS.with(Cell::get)
}

/// Makes every durable sync this thread makes from now on hold `hold`'s
/// appends while it runs: for the store's background thread, which syncs
/// while the game appends.
pub(crate) fn hold_appends_here(hold: Arc<Hold>) {
    HOLDS.with(|h| *h.borrow_mut() = Some(hold));
}

/// True if this thread's durable syncs hold a store's appends.
#[cfg(test)]
pub(crate) fn holds_appends_here() -> bool {
    HOLDS.with(|h| h.borrow().is_some())
}

/// Makes `file` (at `path`) durable: its data, and on macOS the drive's
/// whole cache, so everything pushed before it too. On the store's
/// background thread the store's appends are held meanwhile; one held
/// that then can't be written fails the sync too (and stops the store).
#[allow(clippy::disallowed_methods)]
pub(crate) fn full(file: &File, path: &Path) -> std::io::Result<()> {
    note_sync();
    trace(Synced::Full(path.to_path_buf()));
    HOLDS.with(|h| match h.borrow().as_deref() {
        Some(hold) => {
            hold.note_background_sync();
            let (synced, released) = hold.during(|| {
                #[cfg(test)]
                hold.wait_if_stalled();
                file.sync_all()
            });
            synced.and(released)
        }
        None => file.sync_all(),
    })
}

/// Hands `file`'s (at `path`) writes to the drive: on macOS a plain
/// `fsync`, durable once a later [`full`] flushes the drive's cache;
/// elsewhere a sync, durable on its own.
#[allow(clippy::disallowed_methods)]
pub(crate) fn push(file: &File, path: &Path) -> std::io::Result<()> {
    note_sync();
    trace(Synced::Pushed(path.to_path_buf()));
    #[cfg(target_vendor = "apple")]
    return rustix::fs::fsync(file).map_err(std::io::Error::from);
    #[cfg(not(target_vendor = "apple"))]
    file.sync_data()
}

/// Makes the creation, removal, or renaming of files in `dir` durable
/// (with [`full`]).
pub(crate) fn sync_dir(dir: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    File::open(dir)
        .and_then(|d| full(&d, dir))
        .map_err(io_err(dir))?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// Hands the names created or removed in `dir` to the drive (with
/// [`push`]): durable once a later [`full`] flushes the drive's cache.
pub(crate) fn push_dir(dir: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    File::open(dir)
        .and_then(|d| push_dir_handle(&d, dir))
        .map_err(io_err(dir))?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// [`push_dir`] through an open handle to the directory: on macOS a plain
/// `fsync`, elsewhere an `fsync`, durable on its own.
#[cfg(unix)]
#[allow(clippy::disallowed_methods)]
pub(crate) fn push_dir_handle(handle: &File, dir: &Path) -> std::io::Result<()> {
    #[cfg(target_vendor = "apple")]
    return push(handle, dir);
    #[cfg(not(target_vendor = "apple"))]
    {
        note_sync();
        trace(Synced::Pushed(dir.to_path_buf()));
        handle.sync_all()
    }
}

/// Opens the file at `path` and pushes it (see [`push`]).
pub(crate) fn push_path(path: &Path) -> Result<(), StoreError> {
    crate::open_to_sync(path)
        .and_then(|f| push(&f, path))
        .map_err(io_err(path))
}

/// One sync this thread made, in order: for tests of what is durable
/// before what (`traced`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Synced {
    /// Handed to the drive: durable at the next `Full`.
    Pushed(std::path::PathBuf),
    /// Made durable, with everything pushed before it.
    Full(std::path::PathBuf),
}

#[cfg(test)]
thread_local! {
    static TRACE: RefCell<Option<Vec<Synced>>> = const { RefCell::new(None) };
}

fn trace(synced: Synced) {
    #[cfg(test)]
    TRACE.with(|t| {
        if let Some(t) = t.borrow_mut().as_mut() {
            t.push(synced);
        }
    });
    #[cfg(not(test))]
    let _ = synced;
}

/// Runs `f`, returning what it returned and the syncs it made on this
/// thread, in order: for tests.
#[cfg(test)]
pub(crate) fn traced<T>(f: impl FnOnce() -> T) -> (T, Vec<Synced>) {
    TRACE.with(|t| *t.borrow_mut() = Some(Vec::new()));
    let out = f();
    let syncs = TRACE.with(|t| t.borrow_mut().take().unwrap_or_default());
    (out, syncs)
}
