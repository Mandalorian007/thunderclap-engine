//! Appends held in memory while the store's other threads sync ([`Hold`]),
//! so the thread that appends never waits on a sync.
//!
//! On macOS a durable sync (`F_FULLFSYNC`) holds every write that grows a
//! file on the volume until it finishes, not just writes to its own file:
//! 3 to 5 ms twice a clock mark (once before the mark, once for it). An
//! append that came then would wait it out. So while the I/O thread syncs,
//! an append copies its bytes here instead of writing them, and the thread
//! writes them, in the order they came, as soon as the sync returns,
//! before anything else it writes (the mark included). Each file's bytes
//! are the same, in the same order, as if they had been written at once.
//! Another process's sync on the volume still holds an append up: the
//! store can't see it coming.
//!
//! The [`crate::Background`] thread holds them the same way around each of
//! its durable syncs (see the `durable` module). Syncs take turns
//! ([`Hold::during`]): one that waits for its turn waits off the appending
//! thread, and each starts with nothing held, so everything appended
//! before the I/O thread's sync is in the files it syncs.
//!
//! What this changes: an entry appended during a sync reaches the OS a few
//! milliseconds later. Durability is unchanged (no mark covers an entry
//! appended after it was asked for, and a mark is written only after the
//! held bytes are), but a process killed (`SIGKILL`, an abort) during a
//! sync loses the entries held then, as an OS crash would. A panic or a
//! clean stop doesn't: dropping the store waits for the I/O thread, which
//! writes them.
//!
//! A held write that fails (the disk full) can't be refused any more: its
//! entry was accepted. It counts as a failed sync ([`Hold::failed`]), which
//! stops the store saving until it is reopened (see the `io` module),
//! whichever thread wrote it; a torn tail it may leave is cut on opening,
//! as a crash's is.

use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::io::lock;

/// The bytes that can be held, allocated once so that holding never
/// allocates (Forge Wilds' biggest bench held up to 11 KiB during one
/// sync). An append that doesn't fit waits for the sync, as all did before.
const HELD_BYTES: usize = 32 * 1024;

/// The runs (see `Held::runs`) that can be held, likewise.
const HELD_RUNS: usize = 32;

struct Held {
    /// The I/O thread is syncing: appends are held.
    syncing: bool,
    /// The held bytes, file after file in the order they came.
    bytes: Vec<u8>,
    /// Each run of consecutive held bytes for one file: the file, and where
    /// its run ends in `bytes`.
    runs: Vec<(Arc<File>, usize)>,
    /// Why held bytes couldn't be written, once one couldn't.
    failed: Option<String>,
}

/// The appends held while the store's I/O or background thread syncs.
/// Shared by the store (the game appends through it) and those
/// threads.
pub(crate) struct Hold {
    held: Mutex<Held>,
    /// Signalled when the held bytes are written.
    released: Condvar,
    /// Taken for each sync that holds appends ([`Hold::during`]): one at a
    /// time.
    turn: Mutex<()>,
    /// Durable syncs the background thread made with appends held (see
    /// the `durable` module): for the store's counters.
    background_syncs: AtomicU64,
    /// Holds the background thread inside its next durable syncs while
    /// set, and says when it is there: for tests.
    #[cfg(test)]
    stall: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    stalled: std::sync::atomic::AtomicBool,
}

impl Hold {
    pub fn new() -> Hold {
        Hold::with_room(HELD_BYTES, HELD_RUNS)
    }

    /// A hold no thread syncs under, so nothing is ever held: for a file
    /// written before the store starts. Allocates nothing.
    pub fn unused() -> Hold {
        Hold::with_room(0, 0)
    }

    fn with_room(bytes: usize, runs: usize) -> Hold {
        Hold {
            held: Mutex::new(Held {
                syncing: false,
                bytes: Vec::with_capacity(bytes),
                runs: Vec::with_capacity(runs),
                failed: None,
            }),
            released: Condvar::new(),
            turn: Mutex::new(()),
            background_syncs: AtomicU64::new(0),
            #[cfg(test)]
            stall: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            stalled: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Runs `sync` with appends held, once no other sync holds them, and
    /// writes what was held when it returns. Returns `sync`'s result, and
    /// whether the held bytes were written (a failure is also kept for
    /// [`Hold::failed`]).
    pub fn during<T>(&self, sync: impl FnOnce() -> T) -> (T, std::io::Result<()>) {
        let _turn = lock(&self.turn);
        self.begin();
        let out = sync();
        (out, self.release())
    }

    /// Why held bytes couldn't be written, if some couldn't: the store
    /// saves nothing more (see the module docs).
    pub fn failed(&self) -> Option<String> {
        lock(&self.held).failed.clone()
    }

    /// Counts a durable sync the background thread made with appends
    /// held.
    pub fn note_background_sync(&self) {
        self.background_syncs.fetch_add(1, Ordering::Relaxed);
    }

    /// The durable syncs the background thread made with appends held.
    pub fn background_syncs(&self) -> u64 {
        self.background_syncs.load(Ordering::Relaxed)
    }

    /// Writes `bytes` to `file` now, or, while a sync runs, holds them for
    /// the I/O thread to write when it returns (waiting for that instead
    /// if they don't fit). A write now that fails is returned (the caller
    /// rolls it back); a held one can't fail here.
    pub fn write(&self, file: &Arc<File>, bytes: &[u8]) -> std::io::Result<()> {
        let mut held = lock(&self.held);
        loop {
            if !held.syncing {
                // Under the lock, so a sync never starts with a write under
                // way.
                return (&**file).write_all(bytes);
            }
            let same_run = held.runs.last().is_some_and(|(f, _)| Arc::ptr_eq(f, file));
            let fits = held.bytes.len() + bytes.len() <= held.bytes.capacity()
                && (same_run || held.runs.len() < held.runs.capacity());
            if fits {
                held.bytes.extend_from_slice(bytes);
                let end = held.bytes.len();
                match held.runs.last_mut() {
                    Some((_, e)) if same_run => *e = end,
                    _ => held.runs.push((file.clone(), end)),
                }
                return Ok(());
            }
            held = self
                .released
                .wait(held)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Starts holding appends, once any write under way is done.
    fn begin(&self) {
        lock(&self.held).syncing = true;
    }

    /// Writes the held bytes, in order, and stops holding appends. On a
    /// failure the bytes not yet written are dropped, and the store stops
    /// saving (see the module docs).
    fn release(&self) -> std::io::Result<()> {
        let mut held = lock(&self.held);
        let held = &mut *held;
        let mut start = 0;
        let mut result = Ok(());
        for (file, end) in held.runs.drain(..) {
            if result.is_ok() {
                result = (&*file).write_all(&held.bytes[start..end]);
            }
            start = end;
        }
        held.bytes.clear();
        held.syncing = false;
        if let Err(e) = &result {
            held.failed.get_or_insert_with(|| {
                format!("an append held during a sync couldn't be written: {e}")
            });
        }
        self.released.notify_all();
        result
    }

    /// Waits until no append is held: before something reads the files
    /// up to the lengths the store knows (a cut), swaps them (a rotation)
    /// or cuts one back (a write rolled back). Waits only while a sync
    /// that holds appends runs.
    pub fn settle(&self) {
        let mut held = lock(&self.held);
        while held.syncing && !held.runs.is_empty() {
            held = self
                .released
                .wait(held)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Holds the background thread inside its next durable syncs (with
    /// appends held) until set back to false: for tests.
    #[cfg(test)]
    pub fn stall_background(&self, stall: bool) {
        self.stall.store(stall, Ordering::Relaxed);
    }

    /// True while the background thread is held inside a sync by
    /// [`Hold::stall_background`].
    #[cfg(test)]
    pub fn background_stalled(&self) -> bool {
        self.stalled.load(Ordering::Relaxed)
    }

    /// Where the background thread waits while stalled: for tests.
    #[cfg(test)]
    pub fn wait_if_stalled(&self) {
        while self.stall.load(Ordering::Relaxed) {
            self.stalled.store(true, Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        self.stalled.store(false, Ordering::Relaxed);
    }

    /// How many bytes are held now: for tests.
    #[cfg(test)]
    pub fn held_len(&self) -> usize {
        lock(&self.held).bytes.len()
    }

    /// How many bytes can be held: for tests.
    #[cfg(test)]
    pub fn room(&self) -> usize {
        lock(&self.held).bytes.capacity()
    }
}
