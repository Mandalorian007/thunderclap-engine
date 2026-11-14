//! [`MemoryAccounts`]: accounts kept in memory, for tests and throwaway
//! servers.

use std::fmt;
use std::sync::{Mutex, MutexGuard};

use tokio::sync::watch;

use super::{AccountError, Accounts, Claim, Claimed, Clock, Record, Records, system_clock};
use crate::names::NameRules;

/// Accounts in memory: the same rules as the file, no disk, and a change
/// is seen at once.
pub struct MemoryAccounts {
    rules: NameRules,
    clock: Clock,
    records: Mutex<Records>,
    revisions: watch::Sender<u64>,
}

impl MemoryAccounts {
    /// No names yet; names follow `rules`.
    pub fn new(rules: NameRules) -> MemoryAccounts {
        MemoryAccounts {
            rules,
            clock: system_clock(),
            records: Mutex::new(Records::default()),
            revisions: watch::Sender::new(0),
        }
    }

    /// The same store, stamping records with `clock` (Unix seconds).
    pub fn with_clock(self, clock: Clock) -> MemoryAccounts {
        MemoryAccounts { clock, ..self }
    }

    fn lock(&self) -> MutexGuard<'_, Records> {
        self.records.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Default for MemoryAccounts {
    fn default() -> MemoryAccounts {
        MemoryAccounts::new(NameRules::default())
    }
}

impl fmt::Debug for MemoryAccounts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryAccounts")
            .field("names", &self.lock().len())
            .finish_non_exhaustive()
    }
}

impl Accounts for MemoryAccounts {
    fn generation(&self, name: &str) -> u32 {
        self.lock().generation(name)
    }

    fn get(&self, name: &str) -> Option<Record> {
        self.lock().get(name)
    }

    fn claim(&self, claim: &Claim) -> Result<Claimed, AccountError> {
        let now = (self.clock)();
        let mut records = self.lock();
        let before = records.clone();
        let claimed = records.claim(claim, &self.rules, now)?;
        let changed = !records.same_keys(&before);
        drop(records);
        if changed {
            self.revisions.send_modify(|r| *r += 1);
        }
        Ok(claimed)
    }

    fn seen(&self, name: &str, now: u64) {
        self.lock().seen(name, now);
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.revisions.subscribe()
    }
}
