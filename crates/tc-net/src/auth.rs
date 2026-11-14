//! Who a connection is: the seam where a game's accounts plug in. The
//! session hands `Hello.token` to [`Auth::verify`] and joins the
//! connection as the [`Identity`] it returns, or sends `Rejected` with the
//! error. [`AllowAll`] is the dev implementation: every token is good.

use std::fmt;

use tokio::sync::watch;

/// Who a verified token belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    /// The account's name.
    pub name: String,
    /// What the account may do beyond play, as the game names it (an
    /// operator's `dev`, say); the game reads it.
    pub permissions: Vec<String>,
}

impl Identity {
    /// An identity named `name` with no permissions.
    pub fn new(name: impl Into<String>) -> Identity {
        Identity {
            name: name.into(),
            permissions: Vec::new(),
        }
    }

    /// True if the identity has `permission`.
    pub fn has(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }
}

/// Why a token was refused: the reason `Rejected` carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthError(pub String);

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AuthError {}

/// Verifies tokens.
pub trait Auth: Send + Sync + 'static {
    /// Who `token` belongs to, or why it is refused.
    fn verify(&self, token: &str) -> Result<Identity, AuthError>;

    /// For an auth whose tokens can go bad while a session is open (a
    /// replaced sign-in link): a watch that moves whenever they may have.
    /// Each session then verifies its token again and closes with
    /// [`close::REVOKED`](crate::close::REVOKED) if it no longer passes.
    /// `None` (the default): a good token stays good.
    fn revisions(&self) -> Option<watch::Receiver<u64>> {
        None
    }
}

/// The dev auth: every token is good, and names its player (an empty one
/// is `guest`). Never for a server others can reach.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAll;

impl Auth for AllowAll {
    fn verify(&self, token: &str) -> Result<Identity, AuthError> {
        let name = clip(token);
        Ok(Identity::new(if name.is_empty() { "guest" } else { name }))
    }
}

/// At most 64 characters of `s`, for logs and reasons.
pub fn clip(s: &str) -> &str {
    match s.char_indices().nth(64) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_all_names_the_player_by_token() {
        assert_eq!(AllowAll.verify("ada").unwrap().name, "ada");
        assert_eq!(AllowAll.verify("").unwrap().name, "guest");
        let long = "x".repeat(100);
        assert_eq!(AllowAll.verify(&long).unwrap().name.len(), 64);
        assert!(AllowAll.revisions().is_none());
        let mut id = Identity::new("op");
        id.permissions.push("dev".into());
        assert!(id.has("dev") && !id.has("admin"));
    }
}
