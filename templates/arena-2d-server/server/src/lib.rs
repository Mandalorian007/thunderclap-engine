//! The arena-2d-server template's server: the game ([`game`]) and how it
//! is served ([`server`], on the `thunderclap-server` facade).

pub mod game;

use tc_wire::schema::Schema;
use thunderclap_server::{AuthMode, Builder, Game, Server};

pub use game::{Arena, ArenaProto};

/// The schema the client's `defineSchema` must hash to (`src/schema.ts`;
/// both are checked against `shared/schema-hash.txt`).
pub fn schema() -> Schema {
    Arena::schema()
}

/// The arena's server, with the facade's defaults but three: the data
/// lives in `data/arena`, it serves on port 4711 (the client's default),
/// and a page's token is its player's name ([`AuthMode::Open`]: a dev
/// setting, anyone can take any name). The
/// command line (`serve`, `status`, `stop`, `backup`, ...) runs it.
pub fn server() -> Builder<Arena> {
    Server::builder(Arena::new())
        .data_dir("data/arena")
        .port(4711)
        .auth(AuthMode::Open)
        .build(concat!("arena ", env!("CARGO_PKG_VERSION")))
}
