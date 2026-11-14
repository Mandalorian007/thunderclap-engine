//! ThunderClap's server connection layer: what a networked game's Rust
//! server needs to talk to TypeScript clients (`createNet` in `src/net/`),
//! knowing nothing of the game.
//!
//! - [`ClientMsg`] / [`ServerMsg`] are the envelope every game shares
//!   (handshake, commands, live queries, the entity stream, ping, the bulk
//!   lane), generic over a [`Protocol`] that names the game's own messages.
//!   [`schema_builder`] starts the game's schema with them; its hash is
//!   what `Hello` must carry.
//! - [`Server`] binds a WebSocket listener and runs a
//!   [session](session) per connection: the handshake, message rates
//!   ([`rate`]), the [`outbound`] queue's priority and bulk lanes, flow
//!   control on the bulk lane ([`flow`]) and its compression ([`deflate`]).
//!   The game gets every connection's [`Request`]s on one channel and
//!   answers on each connection's [`Outbound`].
//! - [`Auth`] is the seam where accounts plug in; [`AllowAll`] is the dev
//!   one.
//! - [`EntityEncoder`] writes the entity stream; [`WallClock`] steps a
//!   game's clock with the wall.
//!
//! Close codes: `Closed` with a code from 4000 to 4999 ends the client's
//! session for good; any other code, or a dropped connection, makes it
//! reconnect ([`close`]).

pub mod auth;
pub mod clock;
pub mod deflate;
pub mod entity;
pub mod envelope;
pub mod flow;
pub mod origin;
pub mod outbound;
pub mod rate;
pub mod server;
pub mod session;
pub mod stats;
pub mod ticket;
pub mod transport;
pub mod ws;

pub use auth::{AllowAll, Auth, AuthError, Identity};
pub use clock::WallClock;
pub use entity::EntityEncoder;
pub use envelope::{ClientMsg, Empty, Protocol, Resume, ServerMsg, close, codec, schema_builder};
pub use outbound::Outbound;
pub use rate::Rates;
pub use server::{Server, ServerConfig};
pub use session::{ConnId, Limits, Request};
pub use ticket::BulkTicket;
