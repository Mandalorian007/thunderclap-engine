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
//! On Windows the lock is `LockFileEx` over the whole file, which keeps
//! every other handle from reading it, so the holder is written to
//! `store.holder` beside it ([`HOLDER_FILE`]) as well, and read from there.
//!
//! Reading a store ([`crate::read`]) takes no lock.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
    holder: Mutex<Holder>,
}

impl StoreLock {
    /// Locks the store directory `dir` (which must exist), or fails with
    /// [`StoreError::InUse`] if another process holds it (or another
    /// handle in this one).
    pub fn acquire(dir: &Path) -> Result<StoreLock, StoreError> {
        let path = dir.join(LOCK_FILE);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(io_err(&path))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(StoreError::InUse {
                    dir: dir.to_path_buf(),
                    holder: read_holder(&path),
                });
            }
            Err(TryLockError::Error(error)) => return Err(io_err(&path)(error)),
        }
        let lock = StoreLock {
            file,
            path,
            holder: Mutex::new(Holder {
                pid: Some(std::process::id()),
                port: None,
            }),
        };
        lock.write()?;
        Ok(lock)
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
            let holder = self.path.with_file_name(HOLDER_FILE);
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
    let path = dir.join(LOCK_FILE);
    let file = File::open(&path).ok()?;
    match file.try_lock() {
        Err(TryLockError::WouldBlock) => Some(read_holder(&path)),
        _ => None,
    }
}

/// What the lock file says, as far as it can be read: on Windows, the file
/// beside it that names the holder.
fn read_holder(path: &Path) -> Holder {
    #[cfg(windows)]
    let path = &path.with_file_name(HOLDER_FILE);
    let mut text = String::new();
    match File::open(path).and_then(|mut f| f.read_to_string(&mut text)) {
        Ok(_) => Holder::parse(&text),
        Err(_) => Holder::default(),
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
