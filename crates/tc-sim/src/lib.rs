//! ThunderClap's authoritative game loop: what a networked game's Rust
//! server runs, real-time or turn-based, knowing nothing of the game.
//!
//! - A [`Game`] names its protocol (tc-net's [`Protocol`]), its log
//!   events (a tc-store [`LogCodec`]), its scheduled events and its change
//!   marks. It changes only by applying logged events ([`Game::apply`]),
//!   firing scheduled ones ([`Game::fire`]) and stepping
//!   ([`Game::step`]); everything a client sends (commands, inputs, game
//!   messages, joins) only reads the game and returns events to log.
//! - [`Core`] is the deterministic part: the game, its time, its version
//!   (the last log entry applied), its [`Scheduler`] (a hierarchical
//!   [`TimingWheel`]) and its [`Changes`]. A replay of the log rebuilds
//!   it exactly; [`Core::state_hash`] proves it.
//! - [`Sim`] serves a core to tc-net connections on the wall clock
//!   ([`tc_net::WallClock`]): it logs events through tc-store, flushes
//!   change marks to the game ([`FLUSH_INTERVAL`]), takes inputs through
//!   [`InputQueue`]s, keeps one driver per player, pushes and marks the
//!   clock, drops clients that don't read, reloads the game's data while
//!   connections stay open ([`Sim::reload`]) and publishes a
//!   [`SimStatus`]. [`Sim::spawn`] runs it on its own thread;
//!   [`SimHandle`] controls it. [`Driver`] runs one in-process, with no
//!   sockets, for tests and tools.
//!
//! **Determinism.** Time is an integer count of steps, at most
//! [`MAX_TIME`]. Everything is ordered: scheduled events by time then by
//! when they were scheduled, players and connections by id, change marks
//! by key. Live play and a replay of its log reach the same
//! [`Core::state_hash`]; nothing outside the log (wall time, connection
//! ids, input credit) reaches the game's state.

mod changes;
mod conn;
mod core;
mod driver;
mod game;
mod input;
mod reload;
mod run;
mod scheduler;
mod sim;
mod status;
mod wheel;

pub use changes::Changes;
pub use core::{ApplyError, Core, Replayed, STATE_HASH_VERSION};
pub use driver::Driver;
pub use game::{Cx, EventOf, Game, Outbox, PlayerId, To};
pub use input::{InputConfig, InputQueue, Taken};
pub use reload::{RELOAD_POLL, ReloadReply, ReloadReport};
pub use run::{Control, Running, SimHandle};
pub use scheduler::{EventKey, Scheduler};
pub use sim::{
    ADVANCE_BUDGET, ADVANCE_SLICE, CLOCK_MARK_INTERVAL, CLOCK_PUSH_INTERVAL, FLUSH_INTERVAL,
    OUTBOUND_BUDGET, SLOW_CLIENT_GRACE, Sim, SimConfig,
};
pub use status::{MarkStatus, STATUS_PUBLISH, SimStatus, StatusHandle};
pub use tc_wire::diff::hash_hex;
pub use wheel::TimingWheel;

#[doc(no_inline)]
pub use tc_net::Protocol;
#[doc(no_inline)]
pub use tc_store::LogCodec;

/// The last time there is: 2^53 - 1 steps, the largest a JavaScript
/// number holds exactly (so clients read every time the server sends).
pub const MAX_TIME: u64 = (1 << 53) - 1;
