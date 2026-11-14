//! ThunderClap's accounts and auth for a networked game's server, plugged
//! into tc-net's [`Auth`](tc_net::Auth) seam. No game nouns: the names a
//! game allows ([`NameRules`]), its token prefixes and permissions
//! ([`TokenFormat`]) and the words a player reads are the game's.
//!
//! - **Accounts** ([`Accounts`]): a [`Record`] per name (its account id,
//!   generation, created and last-seen times). [`MemoryAccounts`] for tests,
//!   [`FileAccounts`] for a real server (one JSON file, a backup, a lock for
//!   writers, recovery by itself). A log-backed store plugs in at the same
//!   trait (see the `accounts` module).
//! - **Auth**: [`SessionAuth`] issues, verifies and revokes signed session
//!   tokens; a revoke moves [`Auth::revisions`](tc_net::Auth::revisions),
//!   and tc-net closes every session on an older token with 4001
//!   (`close::REVOKED`), which the client takes as final. Its guest mode
//!   ([`SessionAuth::with_guests`]) lets an empty token in, for dev.
//!   [`DevTokens`] are signed tokens with no store, for dev servers.
//! - **Live tokens** ([`LiveTokens`]): the open sessions' names and
//!   tokens, through tc-net's Hello hook, so a revoke can say how many
//!   sessions it closed ([`LiveTokens::revoke`]).
//!
//! Tokens are Forge Wilds' scheme with its nouns made options:
//! `<prefix>.<name>.<perms>[.<generation>].<hex HMAC-SHA256>`.
//!
//! ```
//! use std::sync::Arc;
//! use tc_auth::{Claim, MemoryAccounts, SessionAuth, TokenFormat};
//! use tc_net::Auth;
//!
//! let auth = SessionAuth::new("secret", TokenFormat::default(), Arc::new(MemoryAccounts::default()));
//! let issued = auth.issue(&Claim::name("ada"), &[]).unwrap();
//! assert_eq!(auth.verify(&issued.token).unwrap().name, "ada");
//! auth.revoke("ada").unwrap();
//! assert!(auth.verify(&issued.token).is_err());
//! ```

mod accounts;
mod auth;
mod live;
mod names;
mod token;

pub use accounts::{
    AccountError, Accounts, Claim, Claimed, Clock, FileAccounts, MemoryAccounts, Record, unix_now,
};
pub use auth::{DevTokens, GUEST_PERMISSION, GUEST_TOKEN_PREFIX, Issued, SessionAuth};
pub use live::{LiveSlot, LiveTokens, Revoked};
pub use names::{NameRules, quote};
pub use token::{TokenError, TokenFormat, TokenWords};
