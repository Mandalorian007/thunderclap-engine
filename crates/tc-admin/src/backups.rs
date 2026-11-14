//! Backups of a store into a directory of them, `<dir>/<unix secs>[-n]`,
//! keeping the newest few: what the control channel's `backup` and an
//! offline `backup` command both do. [`tc_store::backup`] copies a store
//! whether or not a server writes it.

use std::fs;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

/// Backups the facade keeps by default.
pub const KEEP_BACKUPS: usize = 5;

/// Where a store's backups go, and how many are kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Backups {
    /// The store.
    pub store: PathBuf,
    /// The directory of backups.
    pub dir: PathBuf,
    /// The newest this many in [`Backups::dir`] are kept; older ones go
    /// after each new one. 0 keeps every one.
    pub keep: usize,
}

/// What a backup did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackedUp {
    /// Where the copy is.
    pub dir: PathBuf,
    /// Its log files.
    pub files: u64,
    /// Their bytes.
    pub bytes: u64,
    /// The last entry it holds.
    pub last_seq: u64,
    /// Older backups removed.
    pub pruned: u64,
}

impl Backups {
    /// Backups of `store` into `dir`, keeping [`KEEP_BACKUPS`].
    pub fn new(store: impl Into<PathBuf>, dir: impl Into<PathBuf>) -> Backups {
        Backups {
            store: store.into(),
            dir: dir.into(),
            keep: KEEP_BACKUPS,
        }
    }

    /// Copies the store into `out`, or a new directory in
    /// [`Backups::dir`] named for now; then removes the oldest of those
    /// past [`Backups::keep`]. Blocks while it copies.
    pub fn run(&self, out: Option<&Path>) -> Result<BackedUp, String> {
        let out = match out {
            Some(o) => o.to_path_buf(),
            None => {
                fs::create_dir_all(&self.dir)
                    .map_err(|e| format!("creating {}: {e}", self.dir.display()))?;
                self.fresh()
            }
        };
        let report = tc_store::backup(&self.store, &out, false).map_err(|e| e.to_string())?;
        let pruned = self.prune();
        info!(out = %out.display(), files = report.files, bytes = report.bytes, last_seq = report.last_seq, pruned, "backed up");
        Ok(BackedUp {
            dir: out,
            files: report.files as u64,
            bytes: report.bytes,
            last_seq: report.last_seq,
            pruned,
        })
    }

    /// A name in [`Backups::dir`] not taken: now, then `-2`, `-3`, ....
    fn fresh(&self) -> PathBuf {
        let secs = tc_store::unix_now();
        let mut n = 1;
        loop {
            let name = if n == 1 {
                secs.to_string()
            } else {
                format!("{secs}-{n}")
            };
            let path = self.dir.join(name);
            if !path.exists() {
                return path;
            }
            n += 1;
        }
    }

    /// The backups in [`Backups::dir`] (those named as [`Backups::run`]
    /// names them), oldest first.
    pub fn list(&self) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut found: Vec<((u64, u32), PathBuf)> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let (secs, n) = match name.split_once('-') {
                    Some((s, n)) => (s.parse().ok()?, n.parse().ok()?),
                    None => (name.parse().ok()?, 1),
                };
                Some(((secs, n), e.path()))
            })
            .collect();
        found.sort();
        found.into_iter().map(|(_, p)| p).collect()
    }

    fn prune(&self) -> u64 {
        if self.keep == 0 {
            return 0;
        }
        let all = self.list();
        let extra = all.len().saturating_sub(self.keep);
        let mut gone = 0;
        for old in &all[..extra] {
            match fs::remove_dir_all(old) {
                Ok(()) => gone += 1,
                Err(e) => warn!("could not remove the old backup {}: {e}", old.display()),
            }
        }
        gone
    }
}
