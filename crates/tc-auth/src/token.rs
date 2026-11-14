//! The token format: what a game configures ([`TokenFormat`]), why a token
//! is refused ([`TokenError`]), and the HMAC-SHA256 signature.
//!
//! A token is dot-separated text ending in its signature, the lowercase
//! hex HMAC-SHA256 of everything before the last dot, keyed by the
//! server's secret:
//!
//! - a dev token, `<dev_prefix>.<name>.<perms>.<sig>`, good for as long as
//!   the secret is ([`crate::DevTokens`]);
//! - a session token, `<session_prefix>.<name>.<perms>.<generation>.<sig>`,
//!   good until its name's generation passes it ([`crate::SessionAuth`]).
//!
//! `<perms>` is `-` (none) or a comma list of the permissions the game
//! declares; an exclusive one stands alone.

use std::fmt;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::accounts::AccountError;
use crate::names::{NameRules, quote};

/// How a game's tokens look and what they may carry.
#[derive(Clone, Debug)]
pub struct TokenFormat {
    /// The first field of a dev token (`tc1`).
    pub dev_prefix: String,
    /// The first field of a session token (`tc2`).
    pub session_prefix: String,
    /// What a token's name must be.
    pub names: NameRules,
    /// The permissions a token may carry, as the game names them (an
    /// operator's `dev`, a watcher's `observer`).
    pub permissions: Vec<String>,
    /// Permissions that stand alone: a token carrying one carries no other.
    pub exclusive: Vec<String>,
    /// The reason a revoked session token is refused (and its sessions
    /// closed with 4001): what the player reads.
    pub expired: String,
    /// The reason a dev token is refused where only session tokens are
    /// taken.
    pub needs_session: String,
}

impl Default for TokenFormat {
    fn default() -> TokenFormat {
        TokenFormat {
            dev_prefix: "tc1".into(),
            session_prefix: "tc2".into(),
            names: NameRules::default(),
            permissions: Vec::new(),
            exclusive: Vec::new(),
            expired: "this token has been revoked: ask for a new one".into(),
            needs_session: "this server takes session tokens only".into(),
        }
    }
}

impl TokenFormat {
    /// The reason `error` sends the client: the format's own words for
    /// [`TokenError::Expired`], [`TokenError::NeedsSession`] and a bad name.
    pub fn reason(&self, error: &TokenError) -> String {
        match error {
            TokenError::Expired => self.expired.clone(),
            TokenError::NeedsSession => self.needs_session.clone(),
            TokenError::InvalidName(name) => format!(
                "invalid token: bad name {} (use {})",
                quote(name),
                self.names.describe
            ),
            other => other.to_string(),
        }
    }

    /// The `<perms>` field for `perms`, checked as a token's would be.
    pub(crate) fn perms_field(&self, perms: &[&str]) -> Result<String, TokenError> {
        if perms.is_empty() {
            return Ok("-".into());
        }
        let field = perms.join(",");
        self.parse_perms(&field)?;
        Ok(field)
    }

    /// A token's `<perms>` field: `-`, or a comma list of known
    /// permissions, each once, an exclusive one alone.
    pub(crate) fn parse_perms(&self, field: &str) -> Result<Vec<String>, TokenError> {
        if field == "-" {
            return Ok(Vec::new());
        }
        let mut perms: Vec<String> = Vec::new();
        for perm in field.split(',') {
            if perm.is_empty() {
                return Err(TokenError::Malformed("empty permission".into()));
            }
            if !self.permissions.iter().any(|p| p == perm) {
                return Err(TokenError::UnknownPermission(perm.to_string()));
            }
            if perms.iter().any(|p| p == perm) {
                return Err(TokenError::Malformed(format!(
                    "permission {} twice",
                    quote(perm)
                )));
            }
            perms.push(perm.to_string());
        }
        if perms.len() > 1
            && let Some(alone) = perms.iter().find(|p| self.exclusive.contains(p))
        {
            return Err(TokenError::Malformed(format!(
                "{alone} takes no other permission"
            )));
        }
        Ok(perms)
    }

    /// Checks `name` against the rules.
    pub(crate) fn check_name(&self, name: &str) -> Result<(), TokenError> {
        if self.names.valid(name) {
            Ok(())
        } else {
            Err(TokenError::InvalidName(name.to_string()))
        }
    }
}

/// Why a token was refused, or could not be made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenError {
    /// The token isn't in the format.
    Malformed(String),
    /// The name breaks the [`NameRules`].
    InvalidName(String),
    /// The token names a permission the game doesn't declare.
    UnknownPermission(String),
    /// The signature doesn't match.
    BadSignature,
    /// A session token older than its name's generation: it was revoked.
    Expired,
    /// A dev token where only session tokens are taken.
    NeedsSession,
    /// The account store refused (issuing or revoking).
    Account(AccountError),
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TokenError::Malformed(why) => write!(f, "invalid token: {why}"),
            TokenError::InvalidName(name) => write!(f, "invalid token: bad name {}", quote(name)),
            TokenError::UnknownPermission(p) => {
                write!(f, "invalid token: unknown permission {}", quote(p))
            }
            TokenError::BadSignature => f.write_str("invalid token: bad signature"),
            TokenError::Expired => f.write_str("token revoked"),
            TokenError::NeedsSession => f.write_str("dev token where a session token is needed"),
            TokenError::Account(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for TokenError {}

impl From<AccountError> for TokenError {
    fn from(e: AccountError) -> TokenError {
        TokenError::Account(e)
    }
}

/// Signs and checks token signatures with a secret.
#[derive(Clone)]
pub(crate) struct Signer {
    secret: Vec<u8>,
}

impl Signer {
    pub(crate) fn new(secret: impl Into<Vec<u8>>) -> Signer {
        Signer {
            secret: secret.into(),
        }
    }

    fn mac(&self, payload: &str) -> Hmac<Sha256> {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.secret).expect("HMAC takes keys of any length");
        mac.update(payload.as_bytes());
        mac
    }

    /// `payload.<sig>`.
    pub(crate) fn sign(&self, payload: String) -> String {
        let sig = hex(&self.mac(&payload).finalize().into_bytes());
        format!("{payload}.{sig}")
    }

    /// Checks `token`'s last field, `sig`, against everything before it.
    pub(crate) fn check(&self, token: &str, sig: &str) -> Result<(), TokenError> {
        let bytes = unhex(sig).ok_or_else(|| {
            TokenError::Malformed("signature must be 64 lowercase hex digits".into())
        })?;
        let payload = &token[..token.len() - sig.len() - 1];
        self.mac(payload)
            .verify_slice(&bytes)
            .map_err(|_| TokenError::BadSignature)
    }
}

/// A generation: a decimal `u32`, without leading zeros.
pub(crate) fn parse_generation(text: &str) -> Result<u32, TokenError> {
    let canonical = !text.is_empty()
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    canonical
        .then(|| text.parse().ok())
        .flatten()
        .ok_or_else(|| TokenError::Malformed(format!("bad generation {}", quote(text))))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0xf)] as char);
    }
    out
}

/// Decodes 64 lowercase hex digits into 32 bytes.
fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 {
        return None;
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    text.as_bytes()
        .chunks(2)
        .map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips() {
        let bytes: Vec<u8> = (0..32).map(|i| i * 8).collect();
        assert_eq!(unhex(&hex(&bytes)), Some(bytes));
    }

    #[test]
    fn generations_parse_strictly() {
        assert_eq!(parse_generation("0"), Ok(0));
        assert_eq!(parse_generation("17"), Ok(17));
        assert_eq!(parse_generation("4294967295"), Ok(u32::MAX));
        for bad in ["", "00", "01", "+1", "1e3", "4294967296", " 1"] {
            assert!(parse_generation(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn permissions_parse_strictly() {
        let format = TokenFormat {
            permissions: vec!["dev".into(), "mod".into(), "observer".into()],
            exclusive: vec!["observer".into()],
            ..TokenFormat::default()
        };
        assert_eq!(format.parse_perms("-"), Ok(vec![]));
        assert_eq!(
            format.parse_perms("mod,dev"),
            Ok(vec!["mod".to_string(), "dev".to_string()])
        );
        assert_eq!(format.parse_perms("observer"), Ok(vec!["observer".into()]));
        for bad in ["", "dev,", "dev,dev", "dev,observer", "observer,mod"] {
            assert!(
                matches!(format.parse_perms(bad), Err(TokenError::Malformed(_))),
                "{bad:?}"
            );
        }
        assert_eq!(
            format.parse_perms("admin"),
            Err(TokenError::UnknownPermission("admin".into()))
        );
        assert_eq!(format.perms_field(&[]), Ok("-".into()));
        assert_eq!(format.perms_field(&["dev", "mod"]), Ok("dev,mod".into()));
        assert!(format.perms_field(&["admin"]).is_err());
        assert!(format.perms_field(&["observer", "dev"]).is_err());
    }
}
