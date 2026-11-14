//! Where a repair or a rollback writes its new log ([`Output`]), and
//! swapping a new log in for a store's own, recoverably.
//!
//! In place, the new store is written whole to `.swap/` in the store
//! directory (`store.meta` last, so a `.swap/` with it is complete). Then,
//! under the store's lock, the old `archive/`, `base/` (the game's bases,
//! which a log holding the whole history no longer needs) and `log/` are moved to
//! `recovered/<label>.<unix time>/` (never destroyed) and `.swap/log` is
//! renamed to `log/`. A swap cut short is finished, or a `.swap/` left
//! incomplete cleared, the next time the store is opened or swapped
//! ([`finish_swap`]).

use std::fs;
use std::path::{Path, PathBuf};

use crate::archive::ARCHIVE_DIR;
use crate::base::BASE_DIR;
use crate::durable::sync_dir;
use crate::error::StoreError;
use crate::lock::StoreLock;
use crate::{META_FILE, RECOVERED_DIR, io_err, unix_now};

/// The directory a new log is written to before it is swapped in.
pub const SWAP_DIR: &str = ".swap";

/// Where a repair or rollback puts the log it writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Output<'a> {
    /// A new store directory (which must not exist, or be empty); the
    /// store read is left as it was.
    Copy(&'a Path),
    /// The store itself, which must not be open: the old log (and archive)
    /// is moved to `recovered/` and the new one takes its place.
    InPlace,
}

/// Runs `write` to write a new store for `dir` where `output` says: for
/// [`Output::InPlace`], under the store's lock, into `.swap/`, then swaps
/// it in. Returns what `write` returned and, in place, where the old log
/// went.
pub(crate) fn write_output<T>(
    dir: &Path,
    output: Output<'_>,
    label: &str,
    write: impl FnOnce(&Path) -> Result<T, StoreError>,
) -> Result<(T, Option<PathBuf>), StoreError> {
    match output {
        Output::Copy(out) => Ok((write(out)?, None)),
        Output::InPlace => {
            let _lock = StoreLock::acquire(dir)?;
            finish_swap(dir, "swap")?;
            let swap = dir.join(SWAP_DIR);
            let made = write(&swap)?;
            let moved = finish_swap(dir, label)?;
            Ok((made, moved))
        }
    }
}

/// Finishes a swap: if `.swap/` holds a complete store, moves the store's
/// `archive/` and `log/` to `recovered/<label>.<unix time>/` and renames
/// `.swap/log` to `log/` (returning where the old ones went); then
/// removes `.swap/`. Run with the store's lock held.
pub(crate) fn finish_swap(dir: &Path, label: &str) -> Result<Option<PathBuf>, StoreError> {
    let swap = dir.join(SWAP_DIR);
    if !swap.exists() {
        return Ok(None);
    }
    let new_log = swap.join("log");
    let mut moved = None;
    if swap.join(META_FILE).exists() && new_log.exists() {
        let aside = aside_dir(dir, label)?;
        for name in [ARCHIVE_DIR, BASE_DIR, "log"] {
            let from = dir.join(name);
            if from.exists() {
                let to = aside.join(name);
                fs::rename(&from, &to).map_err(io_err(&to))?;
            }
        }
        sync_dir(&aside)?;
        sync_dir(dir)?;
        let to = dir.join("log");
        fs::rename(&new_log, &to).map_err(io_err(&to))?;
        sync_dir(dir)?;
        moved = Some(aside);
    }
    fs::remove_dir_all(&swap).map_err(io_err(&swap))?;
    sync_dir(dir)?;
    Ok(moved)
}

/// A new directory `recovered/<label>.<unix time>[.n]/`, durable.
fn aside_dir(dir: &Path, label: &str) -> Result<PathBuf, StoreError> {
    let recovered = dir.join(RECOVERED_DIR);
    let created = !recovered.exists();
    fs::create_dir_all(&recovered).map_err(io_err(&recovered))?;
    if created {
        sync_dir(dir)?;
    }
    let now = unix_now();
    let mut n = 0;
    loop {
        let name = match n {
            0 => format!("{label}.{now}"),
            n => format!("{label}.{now}.{n}"),
        };
        let path = recovered.join(name);
        match fs::create_dir(&path) {
            Ok(()) => {
                sync_dir(&recovered)?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(error) => return Err(StoreError::Io { path, error }),
        }
    }
}
