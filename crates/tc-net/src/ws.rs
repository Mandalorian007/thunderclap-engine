//! [`Transport`] over WebSocket (tokio-tungstenite). The only module that
//! speaks WebSocket; transport.rs names tungstenite's `Bytes` as the
//! [`Frame`] the priority lane queues.
//!
//! The handshake checks the browser `Origin` ([`crate::origin`]). Once
//! open, the server pings a connection it hasn't heard from for
//! [`PING_INTERVAL`] and drops it when a ping goes unanswered (no frame at
//! all) for [`PONG_TIMEOUT`]: a sleeping or vanished client is gone within
//! about 30 s instead of whenever TCP gives up.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream, ToSocketAddrs};
use tokio::time::Instant;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tracing::info;

use crate::origin::Origins;
use crate::transport::Frame;
use crate::transport::{Transport, TransportError};

/// The largest message a client may send, before or after `Hello`. Every
/// client message is small (the largest is a chat line of at most 1 KiB),
/// so this bounds what an unauthenticated connection can make the server
/// buffer.
pub const MAX_MESSAGE: usize = 64 * 1024;

/// Read buffer per connection; tungstenite allocates it up front.
const READ_BUFFER: usize = 8 * 1024;

/// How long [`Transport::close`] may take in all, including waiting for
/// the peer to finish the closing handshake.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// How long a connection may be silent before the server pings it.
pub const PING_INTERVAL: Duration = Duration::from_secs(10);

/// How long a ping may go unanswered (no frame of any kind arriving) before
/// the connection counts as dead and is dropped.
pub const PONG_TIMEOUT: Duration = Duration::from_secs(20);

/// What every WebSocket connection is opened with.
#[derive(Clone, Debug)]
pub struct WsConfig {
    /// The browser origins allowed to connect.
    pub origins: Arc<Origins>,
    /// See [`PING_INTERVAL`].
    pub ping_interval: Duration,
    /// See [`PONG_TIMEOUT`].
    pub pong_timeout: Duration,
}

impl Default for WsConfig {
    fn default() -> WsConfig {
        WsConfig {
            origins: Arc::default(),
            ping_interval: PING_INTERVAL,
            pong_timeout: PONG_TIMEOUT,
        }
    }
}

/// Accepts TCP connections that will become WebSocket transports.
#[derive(Debug)]
pub struct WsListener {
    listener: TcpListener,
}

impl WsListener {
    /// Binds to `addr`.
    pub async fn bind(addr: impl ToSocketAddrs) -> io::Result<WsListener> {
        Ok(WsListener {
            listener: TcpListener::bind(addr).await?,
        })
    }

    /// The bound address (with the real port when bound to port 0).
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// The next incoming connection, before its WebSocket handshake.
    pub async fn accept(&self) -> io::Result<WsIncoming> {
        let (stream, peer) = self.listener.accept().await?;
        Ok(WsIncoming { stream, peer })
    }
}

/// An accepted TCP connection; [`WsIncoming::open`] runs the handshake.
#[derive(Debug)]
pub struct WsIncoming {
    stream: TcpStream,
    peer: SocketAddr,
}

impl WsIncoming {
    /// The client's address.
    pub fn peer(&self) -> SocketAddr {
        self.peer
    }

    /// Runs the WebSocket handshake, refusing (HTTP 403) a browser origin
    /// that `config` doesn't allow.
    pub async fn open(self, config: &WsConfig) -> Result<WsTransport, TransportError> {
        // Small frames are latency-sensitive; never wait to coalesce them.
        let _ = self.stream.set_nodelay(true);
        let ws_config = WebSocketConfig::default()
            .read_buffer_size(READ_BUFFER)
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let origins = config.origins.clone();
        // The error type is tungstenite's HTTP response.
        #[allow(clippy::result_large_err)]
        let check = move |request: &Request, response: Response| {
            let Some(origin) = request.headers().get("origin") else {
                return Ok(response);
            };
            let origin = origin.to_str().unwrap_or("(not text)");
            if origins.allows(Some(origin)) {
                return Ok(response);
            }
            origins.log_refused(origin);
            let mut refused = ErrorResponse::new(Some(
                "pages from this origin may not connect (see the server's --allow-origin)".into(),
            ));
            *refused.status_mut() = StatusCode::FORBIDDEN;
            Err(refused)
        };
        let stream =
            tokio_tungstenite::accept_hdr_async_with_config(self.stream, check, Some(ws_config))
                .await
                .map_err(|e| TransportError::new(format!("websocket handshake: {e}")))?;
        Ok(WsTransport {
            stream,
            peer: self.peer,
            ping_interval: config.ping_interval,
            pong_timeout: config.pong_timeout,
            last_heard: Instant::now(),
            last_ping: None,
            unanswered_since: None,
        })
    }
}

/// A WebSocket connection; one binary message is one frame.
#[derive(Debug)]
pub struct WsTransport {
    stream: WebSocketStream<TcpStream>,
    peer: SocketAddr,
    ping_interval: Duration,
    pong_timeout: Duration,
    /// When the last frame of any kind arrived (or the connection opened).
    last_heard: Instant,
    /// When the last ping went out.
    last_ping: Option<Instant>,
    /// When the first ping since `last_heard` went out.
    unanswered_since: Option<Instant>,
}

impl WsTransport {
    /// When the next ping is due: `ping_interval` after the later of the
    /// last frame heard and the last ping.
    fn next_ping(&self) -> Instant {
        let last = self
            .last_ping
            .map_or(self.last_heard, |p| p.max(self.last_heard));
        last + self.ping_interval
    }

    fn silent(&self) -> TransportError {
        TransportError::new(format!(
            "no answer to pings for {} s",
            self.pong_timeout.as_secs_f32()
        ))
    }
}

impl Transport for WsTransport {
    async fn feed(&mut self, frame: Frame) -> Result<(), TransportError> {
        // tungstenite keeps what is fed in its write buffer and writes it
        // out once that holds `write_buffer_size` (128 KiB), or on a flush.
        self.stream
            .feed(Message::Binary(frame))
            .await
            .map_err(|e| TransportError::new(e.to_string()))
    }

    async fn flush(&mut self) -> Result<(), TransportError> {
        self.stream
            .flush()
            .await
            .map_err(|e| TransportError::new(e.to_string()))
    }

    async fn recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        loop {
            // A ping counts as unanswered only once it was sent, so a
            // session busy writing (not polling here) never times out.
            let dead_at = self.unanswered_since.map(|t| t + self.pong_timeout);
            let wake = dead_at.map_or(self.next_ping(), |d| d.min(self.next_ping()));
            tokio::select! {
                biased;
                // `next` keeps all state in the stream, so this is cancel-safe.
                next = self.stream.next() => {
                    if let Some(Ok(_)) = &next {
                        self.last_heard = Instant::now();
                        self.unanswered_since = None;
                    }
                    match next {
                        None => return Ok(None),
                        Some(Ok(Message::Binary(bytes))) => return Ok(Some(bytes.to_vec())),
                        Some(Ok(Message::Close(_))) => return Ok(None),
                        Some(Ok(Message::Text(_))) => {
                            return Err(TransportError::new(
                                "text frames are not part of the protocol",
                            ));
                        }
                        // Pings are answered by tungstenite itself; pongs
                        // only show the client is there.
                        Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                        Some(Err(WsError::ConnectionClosed | WsError::AlreadyClosed)) => {
                            return Ok(None);
                        }
                        Some(Err(e)) => return Err(TransportError::new(e.to_string())),
                    }
                }
                () = tokio::time::sleep_until(wake) => {
                    let now = Instant::now();
                    if dead_at.is_some_and(|d| now >= d) {
                        info!(peer = %self.peer, "dropping a connection that stopped answering pings");
                        return Err(self.silent());
                    }
                    self.last_ping = Some(now);
                    let since = *self.unanswered_since.get_or_insert(now);
                    // If this future is dropped mid-send, the ping stays
                    // queued and goes out with the next frame. A client
                    // that isn't reading can't hold it up past the timeout.
                    let ping = self.stream.send(Message::Ping(Default::default()));
                    match tokio::time::timeout_at(since + self.pong_timeout, ping).await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => return Err(TransportError::new(e.to_string())),
                        Err(_) => return Err(self.silent()),
                    }
                }
            }
        }
    }

    async fn close(&mut self) {
        let close = async {
            if self.stream.close(None).await.is_err() {
                return;
            }
            while let Some(Ok(_)) = self.stream.next().await {}
        };
        // A client that stopped reading can't hold the session open.
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, close).await;
    }
}
