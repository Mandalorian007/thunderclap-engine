//! The two [`Auth`]s: [`DevTokens`] (signed, never revoked) and
//! [`SessionAuth`] (signed, checked against the accounts' generations,
//! revocable, with an optional dev guest mode).

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tc_net::{Auth, AuthError, Identity};
use tokio::sync::watch;

use crate::accounts::{Accounts, Claim, Claimed, Clock, system_clock};
use crate::names::quote;
use crate::token::{Signer, TokenError, TokenFormat, parse_generation};

/// The permission a guest ([`SessionAuth::with_guests`]) carries.
pub const GUEST_PERMISSION: &str = "guest";

/// Dev tokens, `<dev_prefix>.<name>.<perms>.<sig>`, signed with a secret
/// (HMAC-SHA256) and good for as long as it is. No accounts: anyone with
/// the secret names themselves. For development servers.
#[derive(Clone)]
pub struct DevTokens {
    signer: Signer,
    format: Arc<TokenFormat>,
}

impl fmt::Debug for DevTokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DevTokens").finish_non_exhaustive()
    }
}

impl DevTokens {
    /// Tokens in `format`, signed with `secret`.
    pub fn new(secret: impl Into<Vec<u8>>, format: TokenFormat) -> DevTokens {
        DevTokens {
            signer: Signer::new(secret),
            format: Arc::new(format),
        }
    }

    /// The format.
    pub fn format(&self) -> &TokenFormat {
        &self.format
    }

    /// A signed token for `name` with `perms`.
    pub fn sign(&self, name: &str, perms: &[&str]) -> Result<String, TokenError> {
        self.format.check_name(name)?;
        let perms = self.format.perms_field(perms)?;
        Ok(self
            .signer
            .sign(format!("{}.{name}.{perms}", self.format.dev_prefix)))
    }

    /// Who `token` names, or why it is refused.
    pub fn check(&self, token: &str) -> Result<Identity, TokenError> {
        let format = &self.format;
        let parts: Vec<&str> = token.split('.').collect();
        let [prefix, name, perms, sig] = parts[..] else {
            return Err(TokenError::Malformed(format!(
                "expected {}.<name>.<perms>.<signature>",
                format.dev_prefix
            )));
        };
        if prefix != format.dev_prefix {
            return Err(TokenError::Malformed(format!(
                "unknown token version {}",
                quote(prefix)
            )));
        }
        format.check_name(name)?;
        let permissions = format.parse_perms(perms)?;
        self.signer.check(token, sig)?;
        Ok(Identity {
            name: name.to_string(),
            permissions,
        })
    }
}

impl Auth for DevTokens {
    fn verify(&self, token: &str) -> Result<Identity, AuthError> {
        self.check(token)
            .map_err(|e| AuthError(self.format.reason(&e)))
    }
}

/// A token [`SessionAuth::issue`] made, and the claim behind it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issued {
    /// The token.
    pub token: String,
    /// What the claim did (its generation is the token's).
    pub claimed: Claimed,
}

/// Session tokens, `<session_prefix>.<name>.<perms>.<generation>.<sig>`,
/// checked against an [`Accounts`] store: a token below its name's
/// generation is refused, so [`SessionAuth::revoke`] (a bumped generation)
/// ends every older token, at the next handshake and, through
/// [`Auth::revisions`], in every open session (closed with 4001). Dev
/// tokens are refused. A name the store doesn't know is at generation 0,
/// so a lost store lets tokens in rather than locking everyone out.
pub struct SessionAuth {
    signer: Signer,
    format: Arc<TokenFormat>,
    accounts: Arc<dyn Accounts>,
    clock: Clock,
    guests: Option<AtomicU64>,
}

impl fmt::Debug for SessionAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionAuth")
            .field("guests", &self.guests.is_some())
            .finish_non_exhaustive()
    }
}

impl SessionAuth {
    /// Tokens in `format`, signed with `secret`, whose generations
    /// `accounts` holds.
    pub fn new(
        secret: impl Into<Vec<u8>>,
        format: TokenFormat,
        accounts: Arc<dyn Accounts>,
    ) -> SessionAuth {
        SessionAuth {
            signer: Signer::new(secret),
            format: Arc::new(format),
            accounts,
            clock: system_clock(),
            guests: None,
        }
    }

    /// The dev guest mode: an empty token joins as a new `guest_<n>` with
    /// the [`GUEST_PERMISSION`], no account and nothing stored. Never for
    /// a server others can reach.
    pub fn with_guests(self) -> SessionAuth {
        SessionAuth {
            guests: Some(AtomicU64::new(0)),
            ..self
        }
    }

    /// The same auth, noting last-seen times from `clock` (Unix seconds).
    pub fn with_clock(self, clock: Clock) -> SessionAuth {
        SessionAuth { clock, ..self }
    }

    /// The format.
    pub fn format(&self) -> &TokenFormat {
        &self.format
    }

    /// The store.
    pub fn accounts(&self) -> &Arc<dyn Accounts> {
        &self.accounts
    }

    /// A signed token for `name` with `perms` at `generation`. Normally
    /// [`SessionAuth::issue`], which claims the name first.
    pub fn sign(&self, name: &str, perms: &[&str], generation: u32) -> Result<String, TokenError> {
        self.format.check_name(name)?;
        let perms = self.format.perms_field(perms)?;
        Ok(self.signer.sign(format!(
            "{}.{name}.{perms}.{generation}",
            self.format.session_prefix
        )))
    }

    /// Claims (`claim`, a reset if it asks) and signs a token for the
    /// name at its generation now.
    pub fn issue(&self, claim: &Claim, perms: &[&str]) -> Result<Issued, TokenError> {
        self.format.perms_field(perms)?;
        let claimed = self.accounts.claim(claim)?;
        let token = self.sign(&claimed.name, perms, claimed.generation)?;
        Ok(Issued { token, claimed })
    }

    /// Revokes every token for `name` so far (its generation moves on);
    /// open sessions on them close with 4001. The new generation.
    pub fn revoke(&self, name: &str) -> Result<u32, TokenError> {
        Ok(self.accounts.claim(&Claim::name(name).reset())?.generation)
    }

    /// `name`'s generation, read from the store again now.
    pub fn generation(&self, name: &str) -> u32 {
        self.accounts.generation(name)
    }

    /// Who `token` names, or why it is refused. Notes the name as seen.
    pub fn check(&self, token: &str) -> Result<Identity, TokenError> {
        if token.is_empty()
            && let Some(guests) = &self.guests
        {
            let n = guests.fetch_add(1, Ordering::Relaxed) + 1;
            return Ok(Identity {
                name: format!("guest_{n}"),
                permissions: vec![GUEST_PERMISSION.to_string()],
            });
        }
        let format = &self.format;
        let parts: Vec<&str> = token.split('.').collect();
        if parts.first() == Some(&format.dev_prefix.as_str()) {
            return Err(TokenError::NeedsSession);
        }
        let [prefix, name, perms, generation, sig] = parts[..] else {
            return Err(TokenError::Malformed(format!(
                "expected {}.<name>.<perms>.<generation>.<signature>",
                format.session_prefix
            )));
        };
        if prefix != format.session_prefix {
            return Err(TokenError::Malformed(format!(
                "unknown token version {}",
                quote(prefix)
            )));
        }
        format.check_name(name)?;
        let permissions = format.parse_perms(perms)?;
        let generation = parse_generation(generation)?;
        self.signer.check(token, sig)?;
        // Signed by us: now whether a revoke replaced it. A token newer
        // than the store (a store restored from its backup, or lost) still
        // joins: losing the file must never lock everyone out.
        if generation < self.accounts.generation(name) {
            return Err(TokenError::Expired);
        }
        self.accounts.seen(name, (self.clock)());
        Ok(Identity {
            name: name.to_string(),
            permissions,
        })
    }
}

impl Auth for SessionAuth {
    fn verify(&self, token: &str) -> Result<Identity, AuthError> {
        self.check(token)
            .map_err(|e| AuthError(self.format.reason(&e)))
    }

    fn revisions(&self) -> Option<watch::Receiver<u64>> {
        Some(self.accounts.subscribe())
    }
}
