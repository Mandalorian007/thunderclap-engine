//! What crosses the wire: section positions, interest areas, stamps and
//! claims (client to server), and [`StreamMsg`] (server to client). A game
//! puts [`StreamMsg`] in its server messages (`ServerMsg::Game`, usually
//! as one variant of its own enum) and [`StreamInterest`] in its interest
//! (`SetInterest`), and describes them in its schema like its own types.

use tc_wire::{Bytes, Wire};

/// A section's position, in sections. A 2D world uses `x` and `y` and
/// keeps `z` at 0.
#[derive(Wire, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SectionPos {
    /// Section x.
    pub x: i32,
    /// Section y.
    pub y: i32,
    /// Section z.
    pub z: i32,
}

impl SectionPos {
    /// The section at `(x, y, z)`.
    pub const fn new(x: i32, y: i32, z: i32) -> SectionPos {
        SectionPos { x, y, z }
    }
}

/// An interest area: the box of sections within `rx`, `ry` and `rz` of
/// `center` on each axis (a radius of 0 is one layer: a 2D world's `rz`).
#[derive(Wire, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Area {
    /// The center section.
    pub center: SectionPos,
    /// Radius along x, in sections.
    pub rx: u8,
    /// Radius along y.
    pub ry: u8,
    /// Radius along z.
    pub rz: u8,
}

/// A section's stamp on the wire ([`tc_wire::stamp::bytes_stamp`] of its
/// encoding), as two `u32` halves so a TypeScript number holds each
/// exactly ([`tc_wire::stamp::split`]).
#[derive(Wire, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Stamp {
    /// The high 32 bits.
    pub hi: u32,
    /// The low 32 bits.
    pub lo: u32,
}

impl Stamp {
    /// A stamp's wire form.
    pub fn of(stamp: u64) -> Stamp {
        let (hi, lo) = tc_wire::stamp::split(stamp);
        Stamp { hi, lo }
    }

    /// Its 64 bits.
    pub fn get(self) -> u64 {
        tc_wire::stamp::join(self.hi, self.lo)
    }
}

/// A section a reconnecting client says it holds, with the stamp it was
/// last sent for it.
#[derive(Wire, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Claim {
    /// The section.
    pub pos: SectionPos,
    /// The stamp of the encoding it holds.
    pub stamp: Stamp,
}

/// The interest a client sets: its area, and on a reconnect what it still
/// holds, so only what changed is sent again. A client sets it again with
/// its claims when its connection drops (`net.setInterest` while down
/// sends it first thing on the next connection).
#[derive(Wire, Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamInterest {
    /// The area.
    pub area: Area,
    /// What it holds already; empty unless resuming.
    pub holding: Vec<Claim>,
}

/// The section stream's messages to a client.
#[derive(Wire, Clone, Debug, PartialEq, Eq)]
pub enum StreamMsg {
    /// A whole section: the game's encoding (`SectionCodec` bytes on the
    /// client) and its stamp. Replaces any copy held.
    Section {
        /// Where.
        pos: SectionPos,
        /// [`tc_wire::stamp::bytes_stamp`] of `data`.
        stamp: Stamp,
        /// The encoding.
        data: Bytes,
    },
    /// Cells of a held section changed: `changes` is `[index, cell, index,
    /// cell, ...]` (the voxel `SectionStore.edit` layout), and `stamp` the
    /// stamp of the encoding it leaves the client holding (what it claims
    /// on a reconnect).
    Edit {
        /// Where.
        pos: SectionPos,
        /// Index and cell pairs.
        changes: Vec<u32>,
        /// The stamp the section has now.
        stamp: Stamp,
    },
    /// Sections the client should drop: they left its area.
    Unload {
        /// Where.
        positions: Vec<SectionPos>,
    },
    /// Every section the client holds from `min` to `max` (inclusive on
    /// each axis) should be dropped, as if each were in an `Unload`: a
    /// view left behind in one message. Sent only with
    /// `StreamConfig::unload_boxes`, and only for a box wholly past the
    /// area grown by its hysteresis, where nothing is held or sent.
    UnloadBox {
        /// The box's lowest corner.
        min: SectionPos,
        /// Its highest corner.
        max: SectionPos,
    },
}

impl SectionPos {
    /// True if it lies in the box from `min` to `max`, inclusive on each
    /// axis ([`StreamMsg::UnloadBox`]).
    pub fn within(&self, min: &SectionPos, max: &SectionPos) -> bool {
        (min.x..=max.x).contains(&self.x)
            && (min.y..=max.y).contains(&self.y)
            && (min.z..=max.z).contains(&self.z)
    }
}
