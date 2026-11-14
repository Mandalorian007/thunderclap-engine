//! The arena-2d-server template's server: the game ([`game`]) and how it
//! is served ([`serve`]).

pub mod game;

use tc_net::{Server, ServerConfig};
use tc_sim::{Core, Running, Sim, SimConfig};
use tc_wire::schema::Schema;

pub use game::{Arena, ArenaProto};

/// The schema the client's `defineSchema` must hash to (`src/schema.ts`;
/// both are checked against `shared/schema-hash.txt`).
pub fn schema() -> Schema {
    use tc_sim::Game;
    Arena::schema()
}

/// The running game and its WebSocket server.
pub struct Served {
    /// The game loop.
    pub running: Running<Arena>,
    /// The connections.
    pub server: Server<ArenaProto>,
}

/// Starts the arena on `host:port` (0: any free port). Must be called
/// inside a tokio runtime.
pub async fn serve(host: &str, port: u16) -> Result<Served, String> {
    // The log stays in memory: the arena forgets everything on restart.
    let sim = Sim::new(Core::new(Arena::new()), None, SimConfig::default());
    let running = sim.spawn().map_err(|e| e.to_string())?;
    let mut config = ServerConfig::new(schema().hash());
    config.host = host.to_string();
    config.port = port;
    let server = Server::<ArenaProto>::start(config, running.requests.clone())
        .await
        .map_err(|e| e.to_string())?;
    Ok(Served { running, server })
}
