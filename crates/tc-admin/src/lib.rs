//! The admin side of a ThunderClap game server.
//!
//! - **The control channel** ([`AdminChannel`]): a loopback TCP listener
//!   (Windows-native, no Unix socket) whose port and 256-bit token are in
//!   an endpoint file ([`ENDPOINT_FILE`]) only the server's user can read.
//!   One JSON line in ([`Request`]), one out ([`Reply`]): status, stop,
//!   pause and resume (the game's clock), reload (the game's data, through
//!   tc-sim's hot reload), backup (tc-store's online copy, keeping the
//!   newest few: [`Backups`]), revoke (a name's tokens, through tc-auth),
//!   reports, and the game's own requests ([`GameRequests`]). [`ask`] is
//!   the blocking client a CLI calls.
//! - **Reports** ([`Reports`]): players' error reports, notes and samples,
//!   written by a thread of their own into a directory that keeps to an
//!   age and a byte budget by itself.

mod ask;
mod backups;
mod endpoint;
mod listen;
pub mod proto;
pub mod reports;

pub use ask::{AdminError, CONNECT_TIMEOUT, REPLY_TIMEOUT, ask, ask_endpoint};
pub use backups::{BackedUp, Backups, KEEP_BACKUPS};
pub use endpoint::{ENDPOINT_FILE, Endpoint, new_token, same_token};
pub use listen::{
    AdminChannel, ControlError, DataLoader, EXCHANGE_TIMEOUT, GameRequests, GameStatus, Live,
    MAX_OPEN, NEWEST_REPORTS, READ_TIMEOUT, REVOKE_WAIT, Revoke, SessionRevoke, SimControl,
    SimControls,
};
pub use proto::{ADMIN_VERSION, PlayerBrief, Reply, ReportBrief, ReportsReply, Request, Status};
pub use reports::{Report, ReportCounts, ReportRate, Reports, ReportsConfig, ReportsSource};
pub use tc_auth::Revoked;
