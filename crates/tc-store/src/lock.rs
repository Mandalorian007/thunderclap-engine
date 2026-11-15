//! The store directory's lock ([`StoreLock`]): one process writes a store
//! at a time.
//!
//! Creating or opening a store takes an exclusive OS file lock
//! (`File::try_lock`: `flock` on Unix) on `store.lock` in the store
//! directory and holds it as long as the store is open. A second process
//! that tries fails at once with [`StoreError::InUse`], naming the holder:
//! the lock file holds the holder's pid, and a server adds its port once
//! it listens ([`StoreLock::note_port`]).
//!
//! The OS releases the lock when its holder exits, however it exits (a
//! crash, `SIGKILL`), so a lock is never stale: the file stays, but only
//! the lock taken on it counts, and the next holder rewrites it. The file
//! is never deleted: a process could otherwise lock a file another has
//! just unlinked while a third locks its replacement.
//!
//! A lock is the OS's until every copy of its handle is closed, and a
//! child process this one spawns holds a copy from its fork until its
//! exec closes it (the handle is close-on-exec). So a lock let go while
//! another thread spawns a process can look held, by this process, for a
//! moment after: a lock file that names this process while no lock of its
//! own is on it is waited on (up to [`RELEASE_WAIT`]) rather than refused.
//!
//! On Windows the lock is `LockFileEx` over the whole file, which keeps
//! every other handle from reading it, so the holder is written to
//! `store.holder` beside it ([`HOLDER_FILE`]) as well, and read from there.
//!
//! Reading a store ([`crate::read`]) takes no lock.
//!
//! The same lock can guard a directory of a game's own under another file
//! name ([`StoreLock::acquire_named`], [`holder_named`]); a store opens only
//! under [`LOCK_FILE`].

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::StoreError;
use crate::io_err;

/// The lock file's name, in the store directory.
pub const LOCK_FILE: &str = "store.lock";

/// The name of the file that names the lock's holder on Windows, where the
/// locked file can't be read (see the module docs). Not written elsewhere.
pub const HOLDER_FILE: &str = "store.holder";

/// The process holding a store, from its lock file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Holder {
    /// Its process id, if the file names one.
    pub pid: Option<u32>,
    /// The port it serves the store on, if it said.
    pub port: Option<u16>,
}

impl std::fmt::Display for Holder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (self.pid, self.port) {
            (Some(pid), Some(port)) => write!(f, "pid {pid}, port {port}"),
            (Some(pid), None) => write!(f, "pid {pid}"),
            (None, Some(port)) => write!(f, "port {port}"),
            (None, None) => f.write_str("pid unknown"),
        }
    }
}

impl Holder {
    /// Parses the lock file's text: `pid <n>` and `port <n>` lines.
    fn parse(text: &str) -> Holder {
        let mut holder = Holder::default();
        for line in text.lines() {
            match line.split_once(' ') {
                Some(("pid", n)) => holder.pid = n.trim().parse().ok(),
                Some(("port", n)) => holder.port = n.trim().parse().ok(),
                _ => {}
            }
        }
        holder
    }

    fn text(&self) -> String {
        let mut text = String::new();
        if let Some(pid) = self.pid {
            text.push_str(&format!("pid {pid}\n"));
        }
        if let Some(port) = self.port {
            text.push_str(&format!("port {port}\n"));
        }
        text
    }
}

/// An exclusive lock on a store directory, held until dropped.
#[derive(Debug)]
pub struct StoreLock {
    file: File,
    path: PathBuf,
    dir: PathBuf,
    /// The locked file, in this process's set of the locks it holds.
    held: Held,
    /// Tells this lock from every other taken in the process (a scan
    /// names the lock it was taken under).
    id: u64,
    holder: Mutex<Holder>,
}

/// The next [`StoreLock::id`].
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl StoreLock {
    /// Locks the store directory `dir` (which must exist), or fails with
    /// [`StoreError::InUse`] if another process holds it (or another
    /// handle in this one).
    pub fn acquire(dir: &Path) -> Result<StoreLock, StoreError> {
        StoreLock::acquire_named(dir, LOCK_FILE)
    }

    /// Locks directory `dir` (which must exist) through the file `name` in
    /// it, as [`StoreLock::acquire`] does through [`LOCK_FILE`]: for a
    /// directory of a game's own (a store opens only under its own name).
    /// On Windows the holder is written to `<name>.holder` beside it
    /// ([`HOLDER_FILE`] for the store's).
    pub fn acquire_named(dir: &Path, name: &str) -> Result<StoreLock, StoreError> {
        let path = dir.join(name);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(io_err(&path))?;
        match try_lock(&file, &path) {
            Ok(Ok(())) => {}
            Ok(Err(holder)) => {
                return Err(StoreError::InUse {
                    dir: dir.to_path_buf(),
                    holder,
                });
            }
            Err(error) => return Err(io_err(&path)(error)),
        }
        let held = Held::of(&file);
        held.mark();
        let lock = StoreLock {
            file,
            path,
            dir: dir.to_path_buf(),
            held,
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            holder: Mutex::new(Holder {
                pid: Some(std::process::id()),
                port: None,
            }),
        };
        lock.write()?;
        Ok(lock)
    }

    /// The directory locked.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The lock file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True if this is a store's own lock ([`LOCK_FILE`]).
    pub(crate) fn is_store_lock(&self) -> bool {
        self.path.file_name().is_some_and(|n| n == LOCK_FILE)
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    /// Records the port this process serves the store on, so a second
    /// process that finds the store in use can say where.
    pub fn note_port(&self, port: u16) -> Result<(), StoreError> {
        crate::io::lock(&self.holder).port = Some(port);
        self.write()
    }

    fn write(&self) -> Result<(), StoreError> {
        let text = crate::io::lock(&self.holder).text();
        let mut file = &self.file;
        file.set_len(0)
            .and_then(|()| file.seek(SeekFrom::Start(0)))
            .and_then(|_| file.write_all(text.as_bytes()))
            .map_err(io_err(&self.path))?;
        // Only a name for messages: a holder file that can't be written
        // (another program holding it) never keeps a store from opening,
        // and one left from an earlier holder is removed so it names
        // nobody ("pid unknown").
        #[cfg(windows)]
        {
            let holder = holder_path(&self.path);
            if std::fs::write(&holder, text.as_bytes()).is_err() {
                let _ = std::fs::remove_file(&holder);
            }
        }
        Ok(())
    }
}

/// Who holds `dir`'s lock now, if anyone: tries the lock and lets it go.
/// Takes nothing and creates no file.
pub fn holder(dir: &Path) -> Option<Holder> {
    holder_named(dir, LOCK_FILE)
}

/// [`holder`] of a lock taken through the file `name`
/// ([`StoreLock::acquire_named`]).
pub fn holder_named(dir: &Path, name: &str) -> Option<Holder> {
    let path = dir.join(name);
    let file = File::open(&path).ok()?;
    try_lock(&file, &path).ok()?.err()
}

/// How long a lock that names this process, but that it doesn't hold, is
/// waited on: the copy a spawning child holds until its exec (see the
/// module docs).
pub const RELEASE_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// Takes `file`'s lock (at `path`), or names its holder. A lock held by
/// another process, or by a [`StoreLock`] of this one, is refused at once;
/// one that names this process with no lock of its own on it is a copy a
/// spawning child holds, and is waited on, up to [`RELEASE_WAIT`].
fn try_lock(file: &File, path: &Path) -> std::io::Result<Result<(), Holder>> {
    let start = std::time::Instant::now();
    let mut pause = std::time::Duration::from_millis(1);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(Ok(())),
            Err(TryLockError::Error(error)) => return Err(error),
            Err(TryLockError::WouldBlock) => {
                let holder = read_holder(path);
                let ours = cfg!(unix) && holder.pid == Some(std::process::id());
                if !ours || Held::of(file).is_marked() || start.elapsed() >= RELEASE_WAIT {
                    return Ok(Err(holder));
                }
                std::thread::sleep(pause);
                pause = (pause * 2).min(std::time::Duration::from_millis(20));
            }
        }
    }
}

/// A lock file, by identity (device and inode on Unix), in this process's
/// set of the locks its [`StoreLock`]s hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Held(Option<(u64, u64)>);

/// The lock files this process's [`StoreLock`]s hold.
static HELD: Mutex<Vec<(u64, u64)>> = Mutex::new(Vec::new());

impl Held {
    fn of(file: &File) -> Held {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Held(file.metadata().ok().map(|m| (m.dev(), m.ino())))
        }
        #[cfg(not(unix))]
        {
            let _ = file;
            Held(None)
        }
    }

    fn mark(self) {
        if let Some(id) = self.0 {
            crate::io::lock(&HELD).push(id);
        }
    }

    fn is_marked(self) -> bool {
        self.0
            .is_some_and(|id| crate::io::lock(&HELD).contains(&id))
    }

    fn unmark(self) {
        if let Some(id) = self.0 {
            let mut held = crate::io::lock(&HELD);
            if let Some(i) = held.iter().position(|h| *h == id) {
                held.swap_remove(i);
            }
        }
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        // Before the file closes: one taken here meanwhile waits for it.
        self.held.unmark();
    }
}

/// What the lock file says, as far as it can be read: on Windows, the file
/// beside it that names the holder.
fn read_holder(path: &Path) -> Holder {
    #[cfg(windows)]
    let path = &holder_path(path);
    let mut text = String::new();
    match File::open(path).and_then(|mut f| f.read_to_string(&mut text)) {
        Ok(_) => Holder::parse(&text),
        Err(_) => Holder::default(),
    }
}

/// The file naming the holder of the lock at `lock` on Windows:
/// [`HOLDER_FILE`] for the store's, `<name>.holder` for another.
#[cfg(windows)]
fn holder_path(lock: &Path) -> PathBuf {
    match lock.file_name().and_then(|n| n.to_str()) {
        Some(LOCK_FILE) | None => lock.with_file_name(HOLDER_FILE),
        Some(name) => lock.with_file_name(format!("{name}.holder")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tc-store-lock-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_second_lock_fails_naming_the_holder() {
        let dir = temp("second");
        let first = StoreLock::acquire(&dir).unwrap();
        let me = Some(std::process::id());
        assert_eq!(holder(&dir).unwrap().pid, me);
        match StoreLock::acquire(&dir) {
            Err(StoreError::InUse { holder, .. }) => {
                assert_eq!(
                    holder,
                    Holder {
                        pid: me,
                        port: None
                    }
                );
            }
            other => panic!("expected InUse, got {other:?}"),
        }
        first.note_port(8171).unwrap();
        let err = StoreLock::acquire(&dir).unwrap_err().to_string();
        assert!(
            err.contains("in use by another process")
                && err.contains(&format!("pid {}, port 8171", std::process::id())),
            "{err}"
        );
        drop(first);
        // Released: the next holder takes it and rewrites the file.
        assert_eq!(holder(&dir), None);
        let again = StoreLock::acquire(&dir).unwrap();
        assert_eq!(
            read_holder(&dir.join(LOCK_FILE)),
            Holder {
                pid: me,
                port: None
            },
            "rewritten: the port is gone"
        );
        drop(again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A holder file that can't be written (here a directory in its place)
    /// doesn't keep the store from opening.
    #[test]
    fn an_unwritable_holder_file_never_blocks_the_lock() {
        let dir = temp("holder");
        std::fs::create_dir(dir.join(HOLDER_FILE)).unwrap();
        let lock = StoreLock::acquire(&dir).unwrap();
        lock.note_port(8171).unwrap();
        match StoreLock::acquire(&dir) {
            Err(StoreError::InUse { .. }) => {}
            other => panic!("expected InUse, got {other:?}"),
        }
        drop(lock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A copy of a let-go lock's handle (what a child holds between its
    /// fork and its exec) is waited out, not taken for a holder; a lock
    /// this process does hold is still refused at once.
    #[cfg(unix)]
    #[test]
    fn a_spawning_childs_copy_of_a_let_go_lock_is_waited_out() {
        let dir = temp("child-copy");
        let lock = StoreLock::acquire(&dir).unwrap();
        let copy = lock.file.try_clone().unwrap();
        drop(lock);
        let closer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(copy);
        });
        let start = std::time::Instant::now();
        assert_eq!(holder(&dir), None);
        assert!(start.elapsed() >= std::time::Duration::from_millis(50));
        let again = StoreLock::acquire(&dir).unwrap();
        closer.join().unwrap();
        let start = std::time::Instant::now();
        assert!(matches!(
            StoreLock::acquire(&dir),
            Err(StoreError::InUse { .. })
        ));
        assert!(start.elapsed() < std::time::Duration::from_millis(50));
        drop(again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_named_lock_is_its_own() {
        let dir = temp("named");
        let store = StoreLock::acquire(&dir).unwrap();
        let other = StoreLock::acquire_named(&dir, "game.lock").unwrap();
        assert!(store.is_store_lock() && !other.is_store_lock());
        assert_ne!(store.id(), other.id());
        assert_eq!(other.dir(), dir);
        assert!(matches!(
            StoreLock::acquire_named(&dir, "game.lock"),
            Err(StoreError::InUse { .. })
        ));
        assert_eq!(
            holder_named(&dir, "game.lock").unwrap().pid,
            Some(std::process::id())
        );
        drop(other);
        assert_eq!(holder_named(&dir, "game.lock"), None);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn holder_text_round_trips() {
        let h = Holder {
            pid: Some(42),
            port: Some(8172),
        };
        assert_eq!(Holder::parse(&h.text()), h);
        assert_eq!(Holder::parse("garbage\n"), Holder::default());
        assert_eq!(Holder::default().to_string(), "pid unknown");
    }
}
