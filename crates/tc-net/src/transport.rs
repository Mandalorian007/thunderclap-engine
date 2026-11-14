//! The transport interface: an ordered, reliable stream of binary frames.
//!
//! Sessions and the sync layer talk only to [`Transport`]; the WebSocket
//! implementation lives in [`crate::ws`]. One frame carries one message.

use std::fmt;
use std::future::Future;

/// One encoded frame, as the transport writes it: a reference-counted
/// byte buffer (tungstenite's `Bytes`), so cloning it for another
/// connection copies nothing. `Frame::from(Vec<u8>)` takes the vector's
/// buffer without copying it; its first clone, if any, may allocate the
/// shared count once. The simulation queues these in a connection's
/// priority lane (`outbound.rs`).
pub type Frame = tokio_tungstenite::tungstenite::Bytes;

/// A transport failure. The connection is unusable afterwards.
#[derive(Debug)]
pub struct TransportError(String);

impl TransportError {
    /// An error with this description.
    pub fn new(message: impl Into<String>) -> TransportError {
        TransportError(message.into())
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TransportError {}

/// One open connection to a client.
pub trait Transport: Send + 'static {
    /// Queues one frame to go out with the next [`Transport::flush`]; it may
    /// write some of what is queued if a lot is. Sessions feed every frame
    /// they have and then flush once, so many small frames cost one write.
    /// A frame shared with other connections is written without a copy.
    fn feed(&mut self, frame: Frame) -> impl Future<Output = Result<(), TransportError>> + Send;

    /// Writes everything fed so far.
    fn flush(&mut self) -> impl Future<Output = Result<(), TransportError>> + Send;

    /// Sends one frame: [`Transport::feed`], then [`Transport::flush`].
    fn send(&mut self, frame: Vec<u8>) -> impl Future<Output = Result<(), TransportError>> + Send {
        async move {
            self.feed(frame.into()).await?;
            self.flush().await
        }
    }

    /// The next frame, or `None` once the peer has closed the connection.
    ///
    /// Must be cancel-safe: dropping the future before it completes loses no
    /// frame, so it can be raced against other work.
    fn recv(&mut self) -> impl Future<Output = Result<Option<Vec<u8>>, TransportError>> + Send;

    /// Closes the connection gracefully. Never fails; errors mean the
    /// connection is already gone.
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}
