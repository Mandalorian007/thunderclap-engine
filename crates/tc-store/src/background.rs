//! The store's background thread ([`Background`]): work a game does off
//! the thread that appends, such as writing a base for a log generation
//! (a snapshot of its state, so opening replays only the newer
//! generations).
//!
//! It starts with the store, so the appending thread never starts a
//! thread or waits for one to end: it only hands a job over (a channel
//! send) and later takes the job's result from the job's own channel. A
//! spawn costs tens of microseconds, and a join waits for the other thread
//! to be scheduled again, which on a loaded machine can take a millisecond
//! or more.
//!
//! Its durable syncs hold the store's appends while they run, as the I/O
//! thread's do (see the `durable` module).
//!
//! Jobs run one at a time, in the order given. A job that panics ends with
//! its result channel closed, as its own thread's would have, and the
//! thread goes on to the next. Dropping the store lets a job under way
//! finish and then the thread ends.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::{Arc, mpsc};

use crate::error::StoreError;
use crate::hold::Hold;
use crate::{durable, io_err};

type Job = Box<dyn FnOnce() + Send>;

/// Hands jobs to the store's background thread ([`crate::Log::background`]).
/// Cloning it hands jobs to the same thread.
#[derive(Clone)]
pub struct Background {
    tx: mpsc::Sender<Job>,
}

impl Background {
    /// Starts the thread, named for the store directory `dir` in errors.
    /// Its durable syncs hold the appends of `hold`.
    #[allow(clippy::disallowed_methods)]
    pub(crate) fn start(dir: &Path, hold: Arc<Hold>) -> Result<Background, StoreError> {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("tc-store-background".into())
            .spawn(move || {
                durable::hold_appends_here(hold);
                for job in rx {
                    // The panic is reported by the hook; the job's result
                    // channel closes with it.
                    let _ = catch_unwind(AssertUnwindSafe(job));
                }
            })
            .map_err(io_err(dir))?;
        Ok(Background { tx })
    }

    /// Runs `job` on the thread, after any given before it. Returns at
    /// once; fails only if the thread is gone.
    pub fn run(&self, job: impl FnOnce() + Send + 'static) -> Result<(), StoreError> {
        self.tx
            .send(Box::new(job))
            .map_err(|_| StoreError::Sequence("the store's background thread is gone".into()))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{Arc, mpsc};

    use crate::hold::Hold;
    use crate::*;

    #[test]
    fn jobs_run_in_order_and_a_panic_ends_only_its_own() {
        let background = Background::start(Path::new("test"), Arc::new(Hold::unused())).unwrap();
        let (tx, rx) = mpsc::channel();
        for i in 0..3 {
            let tx = tx.clone();
            background.run(move || tx.send(i).unwrap()).unwrap();
        }
        // A job that panics closes its own result channel, as a job's
        // thread used to when it panicked.
        let (panic_tx, panic_rx) = mpsc::channel::<()>();
        background
            .run(move || {
                let _tx = panic_tx;
                panic!("a job that fails");
            })
            .unwrap();
        // The jobs after it still run.
        background.run(move || tx.send(3).unwrap()).unwrap();
        assert_eq!(rx.iter().collect::<Vec<_>>(), [0, 1, 2, 3]);
        assert!(panic_rx.recv().is_err());
    }
}
