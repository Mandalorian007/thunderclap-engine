//! [`FileAccounts`]: the accounts in `<dir>/names.json`.
//!
//! ```json
//! {"format":1,"names":{
//!   "alice":{"account":"chat:123","created":1763100000,"generation":2,"last_seen":1763200000}
//! }}
//! ```
//!
//! **Writers** (a claim: the game's CLI, a chat bot on the same host, the
//! server itself) hold `names.lock` while they read, change and write, so
//! two at once can't lose an update. A write goes to a temporary file that
//! is synced and renamed over `names.json`, after the previous good copy is
//! kept as `names.json.bak`: a reader sees the old file or the new, never
//! half of one.
//!
//! **The server** reads the file again whenever it changed (its
//! modification time, size or inode) when a token is checked
//! ([`Accounts::generation`]), and tells the sessions
//! ([`Accounts::subscribe`]) if a generation or an account moved, so live
//! sessions on a revoked token close within one handshake.
//!
//! **Last seen** is kept in memory and written with the next claim or
//! [`FileAccounts::flush`]: verifying a token never writes.
//!
//! **Recovering by itself.** A broken `names.json` (a disk fault, a hand
//! edit) is never a reason to refuse everyone: the server falls back to
//! the backup, else keeps what it last read, else knows no names (every
//! name at generation 0, so every token joins), and logs which. A writer
//! starts from the backup, else sets the broken file aside as
//! `names.json.broken-<unix seconds>` and starts empty, and says so.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::SystemTime;

use tokio::sync::watch;
use tracing::{error, info, warn};

use super::records::check;
use super::{
    AccountError, Accounts, Claim, Claimed, Clock, Record, Records, system_clock, unix_now,
};
use crate::names::NameRules;
use crate::token::ClaimWords;

/// The store.
pub(super) const NAMES_FILE: &str = "names.json";
/// The previous good copy of the store.
pub(super) const BACKUP_FILE: &str = "names.json.bak";
const TEMP_FILE: &str = "names.json.tmp";
const LOCK_FILE: &str = "names.lock";

/// What reading the store found.
struct Loaded {
    /// The records, unless both files are broken.
    records: Option<Records>,
    /// Whether `names.json` itself read cleanly (or doesn't exist).
    main_good: bool,
    /// What went wrong, to log.
    warnings: Vec<String>,
}

/// Reads the store in `dir`: `names.json`, else its backup. Neither file:
/// no names (a new store).
fn load(dir: &Path, rules: &NameRules) -> Loaded {
    let main = dir.join(NAMES_FILE);
    let mut warnings = Vec::new();
    let main_missing = match fs::read_to_string(&main) {
        Ok(text) => match Records::parse(&text, rules) {
            Ok(records) => {
                return Loaded {
                    records: Some(records),
                    main_good: true,
                    warnings,
                };
            }
            Err(e) => {
                warnings.push(format!("{} is broken ({e})", main.display()));
                false
            }
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => true,
        Err(e) => {
            warnings.push(format!("could not read {}: {e}", main.display()));
            false
        }
    };
    let backup = dir.join(BACKUP_FILE);
    let records = match fs::read_to_string(&backup) {
        Ok(text) => match Records::parse(&text, rules) {
            Ok(records) => {
                warnings.push(format!("using its backup, {}", backup.display()));
                Some(records)
            }
            Err(e) => {
                warnings.push(format!(
                    "its backup {} is broken too ({e})",
                    backup.display()
                ));
                None
            }
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => main_missing.then(Records::default),
        Err(e) => {
            warnings.push(format!("could not read {}: {e}", backup.display()));
            None
        }
    };
    Loaded {
        records,
        main_good: main_missing,
        warnings,
    }
}

/// Identifies one version of `names.json`: a rename over it changes the
/// inode even when the time and size don't.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    modified: Option<SystemTime>,
    len: u64,
    inode: u64,
}

impl Stamp {
    fn of(path: &Path) -> Option<Stamp> {
        let meta = fs::metadata(path).ok()?;
        #[cfg(unix)]
        let inode = std::os::unix::fs::MetadataExt::ino(&meta);
        #[cfg(not(unix))]
        let inode = 0;
        Some(Stamp {
            modified: meta.modified().ok(),
            len: meta.len(),
            inode,
        })
    }
}

/// The accounts in one directory's `names.json`. Reads the file again
/// whenever it changed, when a token is checked; claims hold the store's
/// lock throughout.
pub struct FileAccounts {
    dir: PathBuf,
    rules: NameRules,
    words: ClaimWords,
    clock: Clock,
    state: Mutex<Live>,
    revisions: watch::Sender<u64>,
}

struct Live {
    /// The version of `names.json` last read (`None`: there was none).
    stamp: Option<Stamp>,
    records: Records,
}

impl FileAccounts {
    /// The store in `dir`, read now, names following `rules`. Creates
    /// nothing: the first claim makes `dir`.
    pub fn open(dir: &Path, rules: NameRules) -> FileAccounts {
        let store = FileAccounts {
            dir: dir.to_path_buf(),
            rules,
            words: ClaimWords::default(),
            clock: system_clock(),
            state: Mutex::new(Live {
                stamp: None,
                records: Records::default(),
            }),
            revisions: watch::Sender::new(0),
        };
        store.read(Stamp::of(&store.path()));
        let names = store.lock().records.len();
        info!(store = %store.path().display(), names, "accounts");
        store
    }

    /// The same store, stamping records with `clock` (Unix seconds).
    pub fn with_clock(self, clock: Clock) -> FileAccounts {
        FileAccounts { clock, ..self }
    }

    /// The same store, refusing claims in `words`.
    pub fn with_words(self, words: ClaimWords) -> FileAccounts {
        FileAccounts { words, ..self }
    }

    /// `names.json`.
    pub fn path(&self) -> PathBuf {
        self.dir.join(NAMES_FILE)
    }

    /// Reads the store again if `names.json` changed since it was last read.
    pub fn refresh(&self) {
        let stamp = Stamp::of(&self.path());
        if stamp == self.lock().stamp {
            return;
        }
        self.read(stamp);
    }

    /// Writes the last-seen times noted since the last write, if any.
    pub fn flush(&self) -> Result<(), AccountError> {
        self.write_locked(|_| Ok(None)).map(|_| ())
    }

    fn read(&self, stamp: Option<Stamp>) {
        let loaded = load(&self.dir, &self.rules);
        let mut live = self.lock();
        live.stamp = stamp;
        for w in &loaded.warnings {
            warn!("accounts: {w}");
        }
        let Some(mut records) = loaded.records else {
            error!(
                names = live.records.len(),
                "accounts: no readable copy; keeping the names it had (the next claim sets the \
                 broken file aside and starts over)"
            );
            return;
        };
        records.keep_seen(&live.records);
        let changed = !records.same_keys(&live.records);
        live.records = records;
        drop(live);
        if changed {
            self.revisions.send_modify(|r| *r += 1);
        }
    }

    fn lock(&self) -> MutexGuard<'_, Live> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Creates `dir` if missing, holds `names.lock`, reads the store (with
    /// the last-seen times held in memory), applies `change` and writes if
    /// anything moved, then reads its own write.
    fn write_locked(
        &self,
        change: impl FnOnce(&mut Records) -> Result<Option<Claimed>, AccountError>,
    ) -> Result<(Option<Claimed>, Vec<String>), AccountError> {
        let dir = &self.dir;
        fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        let lock_path = dir.join(LOCK_FILE);
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .map_err(|e| format!("opening {}: {e}", lock_path.display()))?;
        lock.lock()
            .map_err(|e| format!("locking {}: {e}", lock_path.display()))?;

        let loaded = load(dir, &self.rules);
        let mut warnings = loaded.warnings;
        let mut main_good = loaded.main_good;
        let (mut records, before) = match loaded.records {
            Some(records) => {
                let before = records.to_json();
                (records, Some(before))
            }
            None => {
                let main = dir.join(NAMES_FILE);
                let aside = dir.join(format!("{NAMES_FILE}.broken-{}", unix_now()));
                if fs::rename(&main, &aside).is_ok() {
                    warnings.push(format!("set it aside as {}", aside.display()));
                }
                warnings.push(
                    "starting with no names: every name is at generation 0 until claimed again"
                        .to_string(),
                );
                main_good = true;
                (Records::default(), None)
            }
        };
        records.keep_seen(&self.lock().records);
        let claimed = change(&mut records)?;
        let after = records.to_json();
        if before.as_deref() != Some(after.as_str()) {
            write(dir, &after, main_good)?;
        }
        drop(lock);
        self.refresh();
        Ok((claimed, warnings))
    }
}

impl fmt::Debug for FileAccounts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileAccounts")
            .field("dir", &self.dir)
            .finish_non_exhaustive()
    }
}

impl Accounts for FileAccounts {
    fn generation(&self, name: &str) -> u32 {
        self.refresh();
        self.lock().records.generation(name)
    }

    fn get(&self, name: &str) -> Option<Record> {
        self.refresh();
        self.lock().records.get(name)
    }

    fn claim(&self, claim: &Claim) -> Result<Claimed, AccountError> {
        check(claim, &self.rules, &self.words)?;
        let now = (self.clock)();
        let (claimed, warnings) = self.write_locked(|records| {
            records
                .claim(claim, &self.rules, &self.words, now)
                .map(Some)
        })?;
        let claimed = claimed.expect("a claim returns what it claimed");
        Ok(Claimed {
            warnings,
            ..claimed
        })
    }

    fn seen(&self, name: &str, now: u64) {
        self.lock().records.seen(name, now);
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.revisions.subscribe()
    }
}

/// Writes `json` over the store in `dir`, keeping the current
/// `names.json` as the backup if it was good (`main_good`).
fn write(dir: &Path, json: &str, main_good: bool) -> Result<(), AccountError> {
    let main = dir.join(NAMES_FILE);
    let temp = dir.join(TEMP_FILE);
    let failed = |what: &str, path: &Path, e: io::Error| {
        AccountError(format!("{what} {}: {e}", path.display()))
    };
    let mut file = File::create(&temp).map_err(|e| failed("creating", &temp, e))?;
    file.write_all(json.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| failed("writing", &temp, e))?;
    drop(file);
    if main_good && main.exists() {
        let backup = dir.join(BACKUP_FILE);
        // Best effort: a failed backup leaves the older one.
        if let Err(e) = fs::copy(&main, &backup).and_then(|_| File::open(&backup)?.sync_all()) {
            warn!("could not back up {}: {e}", main.display());
        }
    }
    fs::rename(&temp, &main).map_err(|e| failed("replacing", &main, e))?;
    #[cfg(unix)]
    File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| failed("syncing", dir, e))?;
    Ok(())
}
