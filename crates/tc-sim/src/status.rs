//! What the loop says about the game it runs, for whoever watches the
//! server: who is online, the version and time, whether the clock runs,
//! the last clock mark and a reload in progress. Published when someone
//! joins or leaves, at every clock mark, when the clock is paused or
//! resumed, after a reload, and at most once a [`STATUS_PUBLISH`] while
//! the game advances. [`SimStatus`]'s `Display` is the one-line status.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use crate::counters::SimCounters;
use crate::game::PlayerId;
use crate::sync::SyncStats;

/// The longest a published status lags the game while it advances.
pub const STATUS_PUBLISH: Duration = Duration::from_secs(1);

/// A clock mark the loop asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarkStatus {
    /// The time it records.
    pub time: u64,
    /// The last entry it covers.
    pub version: u64,
    /// When it was asked for, in seconds since the Unix epoch.
    pub wall: u64,
}

/// The game as the loop last published it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SimStatus {
    /// Players present (with a connection), in order.
    pub players: Vec<PlayerId>,
    /// Each present player's name, as its newest connection signed in
    /// (the token's identity).
    pub names: BTreeMap<PlayerId, String>,
    /// Open connections.
    pub connections: usize,
    /// The version: the last log entry.
    pub version: u64,
    /// The time, in steps.
    pub time: u64,
    /// The clock is paused.
    pub paused: bool,
    /// The last clock mark asked for, if any since the loop started.
    pub last_mark: Option<MarkStatus>,
    /// A reload is running.
    pub reloading: bool,
    /// Why the store stopped taking writes, if it did (the clock is
    /// paused).
    pub store_error: Option<String>,
    /// Batches of events refused because the log couldn't encode them (a
    /// game bug; the loop runs on).
    pub refused: u64,
    /// Game messages dropped over a rate lane's budget
    /// ([`Game::lanes`](crate::Game::lanes)).
    pub limited: u64,
    /// The live queries' counters.
    pub sync: SyncStats,
    /// What the loop did so far ([`Sim::counters`](crate::Sim::counters)).
    pub counters: SimCounters,
}

impl fmt::Display for SimStatus {
    /// One line: `v41 t1200 running 2 players 3 conns mark t1000/v40`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "v{} t{} {} {} player{} {} conn{}",
            self.version,
            self.time,
            if self.paused { "paused" } else { "running" },
            self.players.len(),
            if self.players.len() == 1 { "" } else { "s" },
            self.connections,
            if self.connections == 1 { "" } else { "s" },
        )?;
        if let Some(mark) = self.last_mark {
            write!(f, " mark t{}/v{}", mark.time, mark.version)?;
        }
        if self.reloading {
            f.write_str(" reloading")?;
        }
        if self.refused > 0 {
            write!(f, " {} refused", self.refused)?;
        }
        if self.limited > 0 {
            write!(f, " {} limited", self.limited)?;
        }
        if self.sync.entries > 0 {
            write!(f, " {} queries", self.sync.entries)?;
        }
        if let Some(e) = &self.store_error {
            write!(f, " store failed: {e}")?;
        }
        Ok(())
    }
}

/// Where the loop publishes its [`SimStatus`]; cheap to clone and read
/// from any thread.
#[derive(Clone, Debug, Default)]
pub struct StatusHandle(Arc<Mutex<Option<SimStatus>>>);

impl StatusHandle {
    /// The status as last published (an empty one before the loop first
    /// publishes).
    pub fn get(&self) -> SimStatus {
        self.published().unwrap_or_default()
    }

    /// The status as last published, or `None` before the loop first
    /// does.
    pub fn published(&self) -> Option<SimStatus> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn set(&self, status: SimStatus) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(status);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_published_until_the_loop_publishes() {
        let handle = StatusHandle::default();
        assert_eq!(handle.published(), None);
        assert_eq!(handle.get(), SimStatus::default());
        let status = SimStatus {
            version: 146,
            ..SimStatus::default()
        };
        handle.set(status.clone());
        assert_eq!(handle.published(), Some(status.clone()));
        assert_eq!(handle.get(), status);
    }

    #[test]
    fn the_status_line() {
        let mut s = SimStatus {
            players: vec![4],
            connections: 2,
            version: 41,
            time: 1200,
            ..SimStatus::default()
        };
        assert_eq!(s.to_string(), "v41 t1200 running 1 player 2 conns");
        s.paused = true;
        s.last_mark = Some(MarkStatus {
            time: 1000,
            version: 40,
            wall: 0,
        });
        s.reloading = true;
        assert_eq!(
            s.to_string(),
            "v41 t1200 paused 1 player 2 conns mark t1000/v40 reloading"
        );
    }
}
