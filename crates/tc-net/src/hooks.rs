//! A game's hooks into its sessions: [`Hooks::hello`] sees each accepted
//! `Hello` and may refuse it with the game's reason (or hold something for
//! the session's life), and [`Hooks::frames`] sees every frame the
//! connection's transport carries. Neither changes a byte: a game whose
//! wire the [envelope](crate::envelope) fits needs no transport of its own.
//!
//! ```
//! # use std::sync::Arc;
//! # use tc_net::{Empty, hooks::Hooks};
//! # #[derive(Debug, Clone, PartialEq)] struct Game;
//! # impl tc_net::Protocol for Game {
//! #     type Hello = Empty; type Welcome = Empty; type Command = Empty;
//! #     type Result = Empty; type Interest = Empty; type Input = Empty;
//! #     type State = Empty; type Client = Empty; type Server = Empty;
//! # }
//! let mut hooks = Hooks::<Game>::default();
//! hooks.hello = Some(Arc::new(|seen| {
//!     if seen.identity.name == "banned" {
//!         return Err("you are banned".into());
//!     }
//!     Ok(None)
//! }));
//! ```

use std::any::Any;
use std::sync::Arc;

use crate::auth::Identity;
use crate::envelope::Protocol;
use crate::session::ConnId;
use crate::transport::{Frame, Transport, TransportError};

/// An accepted `Hello`, as [`Hooks::hello`] sees it: the token checked and
/// the schema matched, the game not yet told.
#[derive(Debug)]
pub struct HelloSeen<'a, P: Protocol> {
    /// The connection.
    pub conn: ConnId,
    /// The token it signed in with (checked again when tokens change).
    pub token: &'a str,
    /// Who the token says it is.
    pub identity: &'a Identity,
    /// The `Bulk` codec the session will send, if it has a bulk lane.
    pub bulk: Option<u8>,
    /// The game's `Hello` fields.
    pub ext: &'a P::Hello,
}

/// What a [`Hooks::hello`] gives back for a `Hello` it lets in: something
/// held for the session's life and dropped when it ends (a place in a
/// game's own registry, say), or nothing.
pub type HelloGuard = Option<Box<dyn Any + Send>>;

/// Sees each accepted `Hello`; `Err(reason)` refuses it, sent as
/// `Rejected { reason }` (not a stale schema) before the game hears of it.
pub type OnHello<P> = Arc<dyn Fn(&HelloSeen<'_, P>) -> Result<HelloGuard, String> + Send + Sync>;

/// Which way a frame went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FrameDir {
    /// From the client.
    In,
    /// To the client.
    Out,
}

/// Sees every frame a connection's transport carries, as it goes: its
/// connection, its way and its bytes (the whole WebSocket message).
pub type OnFrame = Arc<dyn Fn(ConnId, FrameDir, &[u8]) + Send + Sync>;

/// A game's hooks into its sessions ([`crate::session::SessionContext`]'s
/// `hooks`; [`crate::Server::start_with`]). The default has none.
pub struct Hooks<P: Protocol> {
    /// Sees, and may refuse, each accepted `Hello`.
    pub hello: Option<OnHello<P>>,
    /// Sees every frame in and out.
    pub frames: Option<OnFrame>,
}

impl<P: Protocol> Default for Hooks<P> {
    fn default() -> Self {
        Hooks {
            hello: None,
            frames: None,
        }
    }
}

impl<P: Protocol> Clone for Hooks<P> {
    fn clone(&self) -> Self {
        Hooks {
            hello: self.hello.clone(),
            frames: self.frames.clone(),
        }
    }
}

impl<P: Protocol> std::fmt::Debug for Hooks<P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hooks")
            .field("hello", &self.hello.is_some())
            .field("frames", &self.frames.is_some())
            .finish()
    }
}

/// A transport whose frames [`Hooks::frames`] sees.
pub(crate) struct Hooked<T> {
    inner: T,
    conn: ConnId,
    frames: Option<OnFrame>,
}

impl<T: Transport> Hooked<T> {
    pub(crate) fn new(inner: T, conn: ConnId, frames: Option<OnFrame>) -> Self {
        Hooked {
            inner,
            conn,
            frames,
        }
    }
}

impl<T: Transport> Transport for Hooked<T> {
    async fn feed(&mut self, frame: Frame) -> Result<(), TransportError> {
        if let Some(see) = &self.frames {
            see(self.conn, FrameDir::Out, &frame);
        }
        self.inner.feed(frame).await
    }

    async fn flush(&mut self) -> Result<(), TransportError> {
        self.inner.flush().await
    }

    async fn recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        let frame = self.inner.recv().await?;
        if let (Some(see), Some(frame)) = (&self.frames, &frame) {
            see(self.conn, FrameDir::In, frame);
        }
        Ok(frame)
    }

    async fn close(&mut self) {
        self.inner.close().await
    }
}
