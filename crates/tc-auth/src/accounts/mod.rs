//! Accounts: which names are taken, by which account, each name's
//! generation, and when it was made and last seen.
//!
//! A session token (see [`crate::SessionAuth`]) carries its name's
//! generation from when it was issued; a revoke bumps the generation, and
//! the server refuses tokens below it. Each account id takes one name,
//! once, and each name belongs to at most one account. A name no store
//! knows is at generation 0, so a lost store only lets old tokens back in;
//! it never locks anyone out.
//!
//! **The seam** is [`Accounts`]: the auth and a game's tools see only it.
//! The rules (what a claim may take, when a generation moves) live once,
//! in `Records::claim`; a backend only keeps the records somewhere and
//! says when they change.
//!
//! - [`FileAccounts`]: one JSON file in a directory, with a backup, a lock
//!   for writers and recovery by itself (`file.rs`).
//! - [`MemoryAccounts`]: in memory, for tests and throwaway servers.
//!
//! **A new backend** is a type that implements [`Accounts`] by applying
//! `Records::claim` to the records it keeps. A log-backed store (tc-store,
//! E3) plugs in here: append each changed [`Record`] as a log entry, fold
//! them into `Records` on open, and bump [`Accounts::subscribe`]'s watch
//! when a claim changes a generation or an account.

mod file;
mod memory;
mod records;
#[cfg(test)]
mod tests;

use std::fmt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

pub use file::FileAccounts;
pub use memory::MemoryAccounts;
pub(crate) use records::Records;

/// One name's record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    /// The name: the record's key, and what its tokens carry.
    pub name: String,
    /// The account that took it (an external id such as `chat:123`), if
    /// one did. An operator may claim a name with no account.
    pub account: Option<String>,
    /// Tokens below it are refused (from 1).
    pub generation: u32,
    /// When it was first claimed, in Unix seconds.
    pub created: u64,
    /// When a token for it last verified (or it was claimed), in Unix
    /// seconds.
    pub last_seen: u64,
}

/// Where accounts are kept: what an auth checks a token's generation
/// against, and what a game's tools claim names in.
pub trait Accounts: Send + Sync + 'static {
    /// `name`'s generation now (0 for a name it doesn't know): a token
    /// below it is refused. A backend that can change behind the server's
    /// back (the file) reads it again first if it changed.
    fn generation(&self, name: &str) -> u32;

    /// `name`'s record, if it has one.
    fn get(&self, name: &str) -> Option<Record>;

    /// Takes a name, or finds an account's, and bumps its generation if
    /// the claim asks for a reset.
    fn claim(&self, claim: &Claim) -> Result<Claimed, AccountError>;

    /// Notes that `name` was seen at `now` (Unix seconds). Cheap and never
    /// blocking: a backend may keep it in memory until its next write.
    fn seen(&self, name: &str, now: u64);

    /// Changes each time a generation or an account changes (never for
    /// [`Accounts::seen`]): sessions verify their tokens again then.
    fn subscribe(&self) -> watch::Receiver<u64>;
}

/// What [`Accounts::claim`] is asked for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Claim {
    /// The name. Optional with an account that has one.
    pub name: Option<String>,
    /// The account claiming it, if any. An account takes one name, once;
    /// a name taken by an account is that account's.
    pub account: Option<String>,
    /// Bump the generation, revoking every older token.
    pub reset: bool,
}

impl Claim {
    /// A claim of `name` with no account.
    pub fn name(name: impl Into<String>) -> Claim {
        Claim {
            name: Some(name.into()),
            ..Claim::default()
        }
    }

    /// The same claim, asking for a reset.
    pub fn reset(self) -> Claim {
        Claim {
            reset: true,
            ..self
        }
    }
}

/// What [`Accounts::claim`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claimed {
    /// The name.
    pub name: String,
    /// Its generation now: what a new token carries.
    pub generation: u32,
    /// The name is new to the store.
    pub created: bool,
    /// Problems with the store it recovered from, to tell the operator.
    pub warnings: Vec<String>,
}

/// Why a claim was refused: a sentence for the operator or player.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountError(pub String);

impl fmt::Display for AccountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AccountError {}

impl From<String> for AccountError {
    fn from(s: String) -> AccountError {
        AccountError(s)
    }
}

/// The time a store stamps records with, in Unix seconds.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The system clock, in Unix seconds.
pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// [`unix_now`] as a [`Clock`].
pub(crate) fn system_clock() -> Clock {
    Arc::new(unix_now)
}
