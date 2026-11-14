//! The WebSocket server: binds, accepts, runs a [session](crate::session)
//! per connection, and hands the game every connection's [`Request`]s.
//!
//! ```no_run
//! # async fn demo<P: tc_net::Protocol>(schema_hash: String) -> std::io::Result<()> {
//! let (requests, game) = std::sync::mpsc::channel();
//! let server = tc_net::Server::<P>::start(tc_net::ServerConfig::new(schema_hash), requests).await?;
//! std::thread::spawn(move || {
//!     for request in game {
//!         // Connect: send Welcome on `out` and keep it; Client: answer.
//!         # let _: tc_net::Request<P> = request;
//!     }
//! });
//! println!("listening on {}", server.local_addr());
//! # Ok(()) }
//! ```

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::mpsc::Sender;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

use crate::auth::{AllowAll, Auth};
use crate::deflate::{Deflater, threads};
use crate::envelope::Protocol;
use crate::origin::Origins;
use crate::session::{self, ConnId, GameState, Limits, Pending, Request, SessionContext};
use crate::stats::{IoCounters, IoStats};
use crate::ws::{WsConfig, WsListener};

/// How long shutdown waits for sessions to finish closing.
pub const SESSION_DRAIN: Duration = Duration::from_secs(3);

/// How a server runs.
#[derive(Clone)]
pub struct ServerConfig {
    /// Address to listen on.
    pub host: String,
    /// Port to listen on; 0 picks a free one.
    pub port: u16,
    /// The schema hash clients must send in `Hello` (the game's
    /// [`schema_builder`](crate::schema_builder) schema's `hash()`).
    pub schema_hash: String,
    /// Verifies tokens; [`AllowAll`] by default.
    pub auth: Arc<dyn Auth>,
    /// Browser origins allowed to connect besides loopback pages
    /// (`scheme://host[:port]`); see the `origin` module.
    pub allow_origins: Vec<String>,
    /// Limits on connections and their messages.
    pub limits: Limits,
    /// Threads compressing the bulk lane; `None`: a quarter of the cores.
    pub deflate_threads: Option<usize>,
}

impl ServerConfig {
    /// Loopback, a free port, every token good: a dev server for clients of
    /// `schema_hash`.
    pub fn new(schema_hash: impl Into<String>) -> ServerConfig {
        ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            schema_hash: schema_hash.into(),
            auth: Arc::new(AllowAll),
            allow_origins: Vec::new(),
            limits: Limits::default(),
            deflate_threads: None,
        }
    }
}

/// A running server.
pub struct Server<P: Protocol> {
    local_addr: SocketAddr,
    stop: watch::Sender<bool>,
    game_state: watch::Sender<GameState>,
    io: Arc<IoCounters>,
    accept: JoinHandle<()>,
    _protocol: std::marker::PhantomData<fn() -> P>,
}

impl<P: Protocol> Server<P> {
    /// Binds and starts accepting connections, handing their requests to
    /// `game`. Call within a tokio runtime.
    pub async fn start(
        config: ServerConfig,
        game: Sender<Request<P>>,
    ) -> std::io::Result<Server<P>> {
        let origins = Origins::new(&config.allow_origins)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        let listener = WsListener::bind((config.host.as_str(), config.port)).await?;
        let local_addr = listener.local_addr()?;
        let (stop, shutdown) = watch::channel(false);
        let (game_state_tx, game_state) = watch::channel(GameState::Running);
        let io = Arc::new(IoCounters::default());
        let deflate = Deflater::start(config.deflate_threads.unwrap_or_else(threads), io.clone())?;
        let ctx = SessionContext {
            schema_hash: config.schema_hash.into(),
            auth: config.auth,
            game,
            shutdown,
            game_state,
            rates: config.limits.rates,
            io: io.clone(),
            deflate,
        };
        let ws = WsConfig {
            origins: Arc::new(origins),
            ping_interval: config.limits.ping_interval,
            pong_timeout: config.limits.pong_timeout,
        };
        info!(%local_addr, "listening");
        let accept = tokio::spawn(accept_loop(listener, ctx, ws, config.limits));
        Ok(Server {
            local_addr,
            stop,
            game_state: game_state_tx,
            io,
            accept,
            _protocol: std::marker::PhantomData,
        })
    }

    /// The address it listens on (with the port picked, if 0 was asked).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// The network work so far.
    pub fn io(&self) -> IoStats {
        self.io.snapshot()
    }

    /// Tells the sessions the game has stopped taking requests: they close
    /// (sending `Rejected` with [`session::GAME_CRASHED`] if `crashed`).
    pub fn game_ended(&self, crashed: bool) {
        let state = if crashed {
            GameState::Crashed
        } else {
            GameState::Stopped
        };
        self.game_state.send_replace(state);
    }

    /// Stops accepting, closes every session (waiting up to
    /// [`SESSION_DRAIN`]) and returns once they are gone.
    pub async fn stop(self) {
        self.stop.send_replace(true);
        let _ = self.accept.await;
        info!("server stopped");
    }
}

async fn accept_loop<P: Protocol>(
    listener: WsListener,
    ctx: SessionContext<P>,
    ws: WsConfig,
    limits: Limits,
) {
    let mut shutdown = ctx.shutdown.clone();
    let mut sessions = JoinSet::new();
    let pending = Pending::new(limits.max_pending);
    let mut next_conn: ConnId = 1;
    loop {
        tokio::select! {
            () = session::stopped(&mut shutdown) => break,
            accepted = listener.accept() => match accepted {
                Ok(incoming) => {
                    if sessions.len() >= limits.max_connections {
                        // Dropping it closes the TCP connection.
                        debug!(peer = %incoming.peer(), "refused: too many connections");
                        continue;
                    }
                    let conn = next_conn;
                    next_conn += 1;
                    let ctx = ctx.clone();
                    let ws = ws.clone();
                    let mut slot = pending.add(conn);
                    // One deadline covers the handshake and Hello together.
                    let hello_deadline = tokio::time::Instant::now() + limits.hello_timeout;
                    sessions.spawn(async move {
                        let peer = incoming.peer();
                        let opened = tokio::select! {
                            opened = tokio::time::timeout_at(hello_deadline, incoming.open(&ws)) => opened,
                            () = slot.evicted() => return,
                        };
                        match opened {
                            Ok(Ok(transport)) => {
                                debug!(conn, %peer, "connection opened");
                                session::run(transport, conn, ctx, hello_deadline, slot).await;
                            }
                            Ok(Err(e)) => debug!(conn, %peer, "{e}"),
                            Err(_) => debug!(conn, %peer, "websocket handshake timed out"),
                        }
                    });
                }
                Err(e) => {
                    // Usually out of file descriptors; back off briefly.
                    warn!("accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            Some(_) = sessions.join_next(), if !sessions.is_empty() => {}
        }
    }
    drop(listener);
    let drain = async { while sessions.join_next().await.is_some() {} };
    if tokio::time::timeout(SESSION_DRAIN, drain).await.is_err() {
        sessions.abort_all();
    }
}
