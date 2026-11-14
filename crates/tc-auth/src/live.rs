//! The open sessions' tokens ([`LiveTokens`]): which connection joined as
//! which name on which token, for as long as it stays. What an operator's
//! revoke reads to say how many sessions it closed ([`LiveTokens::revoke`]).
//!
//! Register sessions with the Hello hook ([`LiveTokens::hook`], for
//! [`tc_net::hooks::Hooks::hello`]), or from a game's own hook with
//! [`LiveTokens::add`], whose [`LiveSlot`] the hook returns as its guard.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tc_net::hooks::{HelloGuard, OnHello};
use tc_net::{Auth, ConnId, Protocol};
use tokio::sync::watch;

/// The open sessions, each with its name and token.
#[derive(Debug)]
pub struct LiveTokens {
    conns: Mutex<BTreeMap<ConnId, (String, String)>>,
    /// Moves each time a session leaves.
    left: watch::Sender<u64>,
}

impl Default for LiveTokens {
    fn default() -> LiveTokens {
        LiveTokens {
            conns: Mutex::new(BTreeMap::new()),
            left: watch::Sender::new(0),
        }
    }
}

/// What [`LiveTokens::revoke`] saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Revoked {
    /// The name's generation, read from the store again.
    pub generation: u32,
    /// Sessions on tokens it replaced that closed.
    pub closed: usize,
    /// Those still open when the wait ran out.
    pub closing: usize,
}

impl LiveTokens {
    /// An empty registry.
    pub fn new() -> Arc<LiveTokens> {
        Arc::default()
    }

    /// Adds session `conn`, joined as `name` on `token`, until the slot is
    /// dropped.
    pub fn add(self: &Arc<LiveTokens>, conn: ConnId, name: &str, token: &str) -> LiveSlot {
        self.lock()
            .insert(conn, (name.to_string(), token.to_string()));
        LiveSlot {
            live: self.clone(),
            conn,
        }
    }

    /// A Hello hook that adds every session that joins, for its life.
    pub fn hook<P: Protocol>(self: &Arc<LiveTokens>) -> OnHello<P> {
        let live = self.clone();
        Arc::new(move |seen| {
            let slot = live.add(seen.conn, &seen.identity.name, seen.token);
            Ok(Some(Box::new(slot) as Box<dyn std::any::Any + Send>) as HelloGuard)
        })
    }

    /// The sessions joined as `name`, each with its token.
    pub fn on(&self, name: &str) -> Vec<(ConnId, String)> {
        self.lock()
            .iter()
            .filter(|(_, (n, _))| n == name)
            .map(|(conn, (_, token))| (*conn, token.clone()))
            .collect()
    }

    /// Whether session `conn` is still open.
    pub fn has(&self, conn: ConnId) -> bool {
        self.lock().contains_key(&conn)
    }

    /// The open sessions.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Whether no session is open.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Changes each time a session leaves.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.left.subscribe()
    }

    /// After a revoke of `name` (its generation moved on in the store):
    /// reads the generation again through `auth`, so the sessions on the
    /// tokens it replaced close ([`Auth::revisions`]), and waits up to
    /// `wait` for them to go. `None`: `auth` has no generations
    /// ([`Auth::generation`]).
    pub async fn revoke(&self, auth: &dyn Auth, name: &str, wait: Duration) -> Option<Revoked> {
        // Taken before the store is read: a session that closes in between
        // is still counted.
        let before = self.on(name);
        let mut left = self.subscribe();
        let generation = auth.generation(name)?;
        let doomed: Vec<ConnId> = before
            .into_iter()
            .filter(|(_, token)| auth.verify(token).is_err())
            .map(|(conn, _)| conn)
            .collect();
        let deadline = tokio::time::Instant::now() + wait;
        let still = || doomed.iter().filter(|c| self.has(**c)).count();
        while still() > 0 {
            match tokio::time::timeout_at(deadline, left.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
        let closing = still();
        Some(Revoked {
            generation,
            closed: doomed.len() - closing,
            closing,
        })
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<ConnId, (String, String)>> {
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A session's place in [`LiveTokens`], for as long as it lives.
#[derive(Debug)]
pub struct LiveSlot {
    live: Arc<LiveTokens>,
    conn: ConnId,
}

impl Drop for LiveSlot {
    fn drop(&mut self) {
        self.live.lock().remove(&self.conn);
        self.live.left.send_modify(|n| *n += 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Claim, MemoryAccounts, SessionAuth, TokenFormat};

    #[tokio::test]
    async fn a_revoke_counts_the_sessions_it_closes() {
        let accounts = Arc::new(MemoryAccounts::default());
        let auth = SessionAuth::new("k", TokenFormat::default(), accounts);
        let old = auth.issue(&Claim::name("ada"), &[]).unwrap().token;
        let live = LiveTokens::new();
        let a = live.add(1, "ada", &old);
        let b = live.add(2, "ada", &old);
        let _other = live.add(3, "bo", "x");
        assert_eq!((live.len(), live.on("ada").len()), (3, 2));
        auth.revoke("ada").unwrap();
        // The sessions close as tc-net would on the revision.
        let closer = tokio::spawn(async move {
            drop(a);
            tokio::task::yield_now().await;
            drop(b);
        });
        let r = live
            .revoke(&auth, "ada", Duration::from_secs(5))
            .await
            .unwrap();
        closer.await.unwrap();
        assert_eq!(
            r,
            Revoked {
                generation: 2,
                closed: 2,
                closing: 0
            }
        );
        assert!(!live.has(1) && live.has(3));
        assert_eq!(
            live.revoke(&tc_net::AllowAll, "ada", Duration::ZERO).await,
            None
        );
    }

    #[tokio::test]
    async fn one_still_open_is_closing() {
        let auth = SessionAuth::new(
            "k",
            TokenFormat::default(),
            Arc::new(MemoryAccounts::default()),
        );
        let old = auth.issue(&Claim::name("ada"), &[]).unwrap().token;
        let live = LiveTokens::new();
        let _held = live.add(1, "ada", &old);
        let fresh = auth.issue(&Claim::name("ada").reset(), &[]).unwrap().token;
        let _fresh = live.add(2, "ada", &fresh);
        let r = live
            .revoke(&auth, "ada", Duration::from_millis(10))
            .await
            .unwrap();
        assert_eq!((r.closed, r.closing), (0, 1), "the fresh token stays");
    }
}
