//! ThunderClap's game server in one crate.
//!
//! [`Server::builder`] takes a [`Game`] (tc-sim) and wires the rest with
//! dev defaults: the store (tc-store) under a data directory, created the
//! first time and its archive kept tidy; the loop on its own thread; the
//! network (tc-net) on loopback; session tokens with guests (tc-auth,
//! [`AuthMode::DevGuests`]); and the admin channel (tc-admin) that status,
//! pause, resume, reload, backup, revoke and stop go through. [`gen`]
//! writes a game's TypeScript (tc-tsgen); [`cli::main`] is the command
//! line a game's binary hands its arguments to:
//!
//! ```no_run
//! # use thunderclap_server::{Builder, Game, Server};
//! # fn game<G: Game>(make: impl Fn() -> G) {
//! std::process::exit(thunderclap_server::cli::main(std::env::args(), || {
//!     Server::builder(make()).build("my-game 1.0")
//! }));
//! # }
//! ```
//!
//! The crates are re-exported, for a game that needs more of one.

pub mod cli;
mod server;
mod typescript;

pub use server::{
    ACCOUNTS_DIR, AuthMode, BACKUPS_DIR, Builder, DEV_NAMES, Running, SECRET_FILE, STORE_DIR,
    Server,
};
pub use tc_sim::{Game, SimConfig};
pub use typescript::generate_ts;

pub use tc_admin as admin;
pub use tc_auth as auth;
pub use tc_net as net;
pub use tc_sim as sim;
pub use tc_store as store;
pub use tc_tsgen as tsgen;
pub use tc_wire as wire;
