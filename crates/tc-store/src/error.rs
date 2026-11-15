//! The store's errors.

use std::fmt;
use std::path::PathBuf;

use crate::lock::Holder;

/// What went wrong reading or writing a store.
#[derive(Debug)]
pub enum StoreError {
    /// A file system call failed on `path`.
    Io {
        /// The file or directory.
        path: PathBuf,
        /// What the OS said.
        error: std::io::Error,
    },
    /// A log file holds something that can't be a crash's torn tail.
    Corrupt {
        /// The file.
        path: PathBuf,
        /// Where in it.
        offset: u64,
        /// Why.
        reason: String,
    },
    /// The log's entries don't fit together (a gap no lost write explains,
    /// a duplicate, a mark covering a missing entry), or the caller asked
    /// for something out of order.
    Sequence(String),
    /// Another process (or another lock in this one) holds the directory.
    InUse {
        /// The store directory.
        dir: PathBuf,
        /// Who holds it, as far as its lock file says.
        holder: Holder,
    },
    /// Appends are refused: what they wrote might never become durable
    /// (see [`crate::Log::blocked`]).
    NotDurable(String),
    /// A failed write couldn't be rolled back: the store writes nothing
    /// more until it is reopened.
    Poisoned,
    /// An entry's record would be over [`crate::format::MAX_PAYLOAD`].
    RecordTooLarge {
        /// The entry.
        seq: u64,
        /// Its payload's length.
        len: usize,
        /// The limit.
        max: usize,
    },
    /// The codec couldn't encode an entry.
    Encode {
        /// The entry.
        seq: u64,
        /// What the codec said.
        reason: String,
    },
    /// A store already exists in the directory.
    Exists(PathBuf),
    /// The directory is in an older layout the game's [`crate::Upgrade`]
    /// converts: a reader refuses it, changing nothing; opening it (a
    /// writer) upgrades it.
    UpgradeDue {
        /// The store directory.
        dir: PathBuf,
        /// What the upgrade would do.
        what: String,
    },
    /// The directory isn't a store, or holds something a store can't.
    Meta {
        /// The file.
        path: PathBuf,
        /// Why.
        reason: String,
    },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Io { path, error } => write!(f, "{}: {error}", path.display()),
            StoreError::Corrupt {
                path,
                offset,
                reason,
            } => write!(
                f,
                "{} is damaged at byte {offset}: {reason}",
                path.display()
            ),
            StoreError::Sequence(reason) => write!(f, "the log is out of sequence: {reason}"),
            StoreError::InUse { dir, holder } => write!(
                f,
                "{} is in use by another process ({holder})",
                dir.display()
            ),
            StoreError::NotDurable(reason) => write!(f, "nothing can be saved: {reason}"),
            StoreError::Poisoned => {
                f.write_str("a failed write couldn't be undone; reopen the store")
            }
            StoreError::RecordTooLarge { seq, len, max } => write!(
                f,
                "entry {seq} is {len} bytes, over the {max}-byte record limit"
            ),
            StoreError::Encode { seq, reason } => {
                write!(f, "entry {seq} couldn't be encoded: {reason}")
            }
            StoreError::Exists(dir) => write!(f, "a store already exists in {}", dir.display()),
            StoreError::UpgradeDue { dir, what } => write!(
                f,
                "{} is in an older layout; nothing was changed, and opening it to write \
                 upgrades it ({what})",
                dir.display()
            ),
            StoreError::Meta { path, reason } => write!(f, "{}: {reason}", path.display()),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::Io { error, .. } => Some(error),
            _ => None,
        }
    }
}
