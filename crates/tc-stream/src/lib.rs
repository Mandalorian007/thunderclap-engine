//! ThunderClap's section stream: a game's world sent to each connection
//! in sections, by interest area.
//!
//! The game supplies a [`SectionSource`] (how a section is encoded, and
//! optionally how its cells decode, for small `Edit`s) and calls
//! [`SectionStream`] from its one writer thread: [`connect`] and
//! [`disconnect`] as connections come and go, [`set_interest`] when a
//! client sets its [`StreamInterest`], [`changed`] when a section's
//! content changes, and [`flush`] once a tick with the connections'
//! [`Lanes`] (tc-net's `Outbound`s are lanes). Each flush:
//!
//! - rebuilds changed sections someone holds (up to a budget) and sends
//!   holders an `Edit` (the changed cells, when smaller) or the whole
//!   section on the priority lane, or folds the change into a section
//!   still waiting in the bulk lane by withdrawing it;
//! - sends `Unload`s, in batches, for sections that left an area (with
//!   hysteresis, so walking back and forth across an edge costs nothing);
//! - sends sections in the area nearest first in the bulk lane, through a
//!   shared LRU cache, round robin across connections, within a build
//!   budget and each bulk lane's high water.
//!
//! Every section carries a stamp of its encoding. A client that
//! reconnects sets its interest with what it holds and their stamps
//! ([`Claim`]s); matching sections are not sent again. [`reload`] (a new
//! world under the same connections) does the same server side.
//!
//! Positions are three `i32`s; a 2D world keeps `z` at 0 and its areas'
//! `rz` at 0. Nothing here knows what a cell is.
//!
//! [`connect`]: SectionStream::connect
//! [`disconnect`]: SectionStream::disconnect
//! [`set_interest`]: SectionStream::set_interest
//! [`changed`]: SectionStream::changed
//! [`flush`]: SectionStream::flush
//! [`reload`]: SectionStream::reload

mod area;
mod cache;
mod hash;
mod lanes;
mod msg;
mod raw;
mod stream;

pub use area::{Bounds, MIN_BOXED};
pub use cache::{MAX_CACHED_SECTIONS, SLOT_OVERHEAD};
pub use lanes::{BEHIND_BYTES, Lanes};
pub use msg::{
    Area, Claim, GROUP_MAX, GroupClaim, LayerClaim, SectionPos, Stamp, StreamInterest, StreamMsg,
};
pub use raw::{decode_raw, encode_raw};
pub use stream::{
    FrameKind, IdleBudget, Loading, MAX_UNLOAD_BATCH, SectionSource, SectionStream, StreamConfig,
    StreamError, StreamEvent, StreamObserver, StreamStats, game_frame,
};
