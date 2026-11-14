//! The arena-2d-server template's server: the game ([`game`]) and how it
//! is served ([`server`], on the `thunderclap-server` facade).

pub mod game;

use thunderclap_server::wire::schema::Schema;
use thunderclap_server::{Builder, Game, Server};

pub use game::{Arena, ArenaProto};

/// The schema the client's `defineSchema` must hash to (`src/schema.ts`;
/// both are checked against `shared/schema-hash.txt`).
pub fn schema() -> Schema {
    Arena::schema()
}

/// The arena's server, with the facade's defaults but two: the data
/// lives in `data/arena`, and it serves on port 4711 (the client's
/// default). Auth is the dev default, guests
/// ([`AuthMode::DevGuests`](thunderclap_server::AuthMode::DevGuests)): a
/// page sends `guest:<name>` and plays as that name. The command line
/// (`serve`, `status`, `stop`, `backup`, ...) runs it.
pub fn server() -> Builder<Arena> {
    Server::builder(Arena::new())
        .data_dir("data/arena")
        .port(4711)
        .build(concat!("arena ", env!("CARGO_PKG_VERSION")))
}
