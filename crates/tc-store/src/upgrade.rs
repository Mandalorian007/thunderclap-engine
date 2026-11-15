//! Reading a store never writes it; upgrading an older layout is a
//! writer's job.
//!
//! A store is read two ways. A **reader** ([`crate::read`],
//! [`crate::read_from`], [`crate::check`], [`crate::read_archive`], a
//! repair or rollback's source, [`crate::backup`]'s source) takes no lock
//! and changes no file, byte or name, whatever it finds: a torn tail, an
//! archiving or a swap cut short, or a directory in a layout older than
//! the store's. A **writer** ([`crate::Log::open`] and the other opens)
//! takes the lock, and only then recovers, clears leftovers and upgrades.
//!
//! A game whose directories predate its store (written by an older build
//! of its own, say) converts them with an [`Upgrade`], which its codec
//! hands out ([`crate::LogCodec::upgrade`]). Every open runs it under the
//! lock, before reading the log, and says so in
//! [`crate::OpenReport::upgraded`]. Every reader given that codec refuses
//! such a directory with [`StoreError::UpgradeDue`], naming what an open
//! would do and changing nothing. [`upgrade_due`] asks without failing;
//! [`upgrade`] runs it under a lock the game already holds.

use std::path::Path;

use crate::codec::LogCodec;
use crate::error::StoreError;
use crate::lock::StoreLock;

/// A game's conversion of an older layout of its directory onto the
/// store's, in place.
pub trait Upgrade: Send + Sync {
    /// What converting `dir` would do (a line for a person: "rewrites 12
    /// log files' headers"), or `None` if `dir` is already in the store's
    /// layout. Must change nothing: readers call it.
    fn due(&self, dir: &Path) -> Option<String>;

    /// Converts `lock.dir()` in place, under the store's lock, and returns
    /// a line saying what it did. Each step must be safe to run again: a
    /// crash part way leaves a directory [`Upgrade::due`] still names, and
    /// the next open runs it again.
    fn apply(&self, lock: &StoreLock) -> Result<String, StoreError>;
}

/// What an open of `dir` with `codec` would upgrade, or `None`. Changes
/// nothing.
pub fn upgrade_due<C: LogCodec>(dir: &Path, codec: &C) -> Option<String> {
    codec.upgrade().and_then(|u| u.due(dir))
}

/// Runs `codec`'s upgrade on the store locked by `lock`, if one is due:
/// what an open does first, for a game that holds the lock and reads the
/// log its own way. Returns the upgrade's line, or `None` if none was due.
pub fn upgrade<C: LogCodec>(lock: &StoreLock, codec: &C) -> Result<Option<String>, StoreError> {
    if !lock.is_store_lock() {
        return Err(StoreError::Meta {
            path: lock.path().to_path_buf(),
            reason: "a store upgrades only under its own lock".into(),
        });
    }
    match codec.upgrade() {
        Some(u) if u.due(lock.dir()).is_some() => u.apply(lock).map(Some),
        _ => Ok(None),
    }
}

/// Fails with [`StoreError::UpgradeDue`] if `dir` needs an upgrade a
/// reader can't do: every reader calls this before reading anything.
pub(crate) fn refuse_if_due<C: LogCodec>(dir: &Path, codec: &C) -> Result<(), StoreError> {
    match upgrade_due(dir, codec) {
        Some(what) => Err(StoreError::UpgradeDue {
            dir: dir.to_path_buf(),
            what,
        }),
        None => Ok(()),
    }
}
