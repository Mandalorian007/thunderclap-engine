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

/// A layer's state a reconnecting client says it holds at a key
/// ([`SectionSource::layer_key`](crate::SectionSource::layer_key)), with
/// the state's stamp
/// ([`SectionSource::layer_stamp`](crate::SectionSource::layer_stamp)). A
/// matching claim is kept when a held section first brings the key, so the
/// state is not sent again.
#[derive(Wire, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayerClaim {
    /// The layer.
    pub layer: u32,
    /// The key its state is under.
    pub key: SectionPos,
    /// The stamp of the state held.
    pub stamp: Stamp,
}

/// The most sections one [`GroupClaim`] covers: the bits of `held`.
pub const GROUP_MAX: usize = 32;

/// A run of sections a reconnecting client says it holds, claimed with one
/// digest: up to [`GROUP_MAX`] sections along one axis from `start` (a
/// voxel world's column, a tile map's row), so a client resumes a large
/// view cheaply. Bit `i` of `held` is the section `i` steps from `start`
/// along `axis` (0: x, 1: y, 2: z).
///
/// `digest` is [`tc_wire::stamp::pairs_digest`] of `(coordinate, stamp)`
/// for each held section, the coordinate along `axis`, ascending
/// ([`GroupClaim::digest_of`]). `layers[l]` is the digest of layer `l`'s
/// states those sections bring ([`GroupClaim::layer_digest`]); `None` (or
/// past the end): it holds none.
///
/// The stream checks a group when its load reaches the group's first
/// section (or on [`check_claims`](crate::SectionStream::check_claims)):
/// all or nothing. Matching, every section is kept and nothing is sent;
/// otherwise every section is sent again whole. Each layer's digest is
/// checked on its own.
#[derive(Wire, Clone, Debug, PartialEq, Eq)]
pub struct GroupClaim {
    /// The section bit 0 stands for.
    pub start: SectionPos,
    /// The axis the run follows: 0 x, 1 y, 2 z.
    pub axis: u8,
    /// The sections held, a bit each from `start`.
    pub held: u32,
    /// The digest of the held sections' stamps.
    pub digest: Stamp,
    /// Each layer's digest over the states the held sections bring.
    pub layers: Vec<Option<Stamp>>,
}

impl GroupClaim {
    /// The held sections, each with its coordinate along the axis, in
    /// order (none for an axis past 2; a section past the `i32`
    /// coordinates is left out).
    pub fn members(&self) -> impl Iterator<Item = (SectionPos, i32)> + '_ {
        let axis = usize::from(self.axis);
        (0..GROUP_MAX as u32)
            .filter(move |i| axis < 3 && self.held & (1 << i) != 0)
            .filter_map(move |i| {
                let mut c = [self.start.x, self.start.y, self.start.z];
                c[axis] = c[axis].checked_add(i32::try_from(i).ok()?)?;
                Some((SectionPos::new(c[0], c[1], c[2]), c[axis]))
            })
    }

    /// The digest of `(coordinate, stamp)` pairs, coordinates ascending:
    /// a group's `digest`.
    pub fn digest_of(pairs: impl IntoIterator<Item = (i32, u64)>) -> Stamp {
        Stamp::of(tc_wire::stamp::pairs_digest(pairs))
    }

    /// A layer's digest over a group: for each held section in order, the
    /// layer's key for it, taken once (the first section under it), and
    /// paired with that section's coordinate and the key's state stamp,
    /// keys with no state left out. `None` when none has a state.
    pub fn layer_digest(pairs: impl IntoIterator<Item = (i32, u64)>) -> Option<Stamp> {
        let mut pairs = pairs.into_iter().filter(|p| p.1 != 0).peekable();
        pairs.peek()?;
        Some(Stamp::of(tc_wire::stamp::pairs_digest(pairs)))
    }

    /// Groups held sections and their stamps into claims along `axis`
    /// (0 to 2): one run per line of the other two coordinates, split every
    /// [`GROUP_MAX`] from its lowest section. Layers are left empty for the
    /// caller to fill.
    pub fn group(axis: u8, held: impl IntoIterator<Item = (SectionPos, u64)>) -> Vec<GroupClaim> {
        let a = usize::from(axis.min(2));
        let mut lines: std::collections::BTreeMap<([i32; 2], i32), u64> =
            std::collections::BTreeMap::new();
        for (p, s) in held {
            let c = [p.x, p.y, p.z];
            let rest = match a {
                0 => [c[1], c[2]],
                1 => [c[0], c[2]],
                _ => [c[0], c[1]],
            };
            lines.insert((rest, c[a]), s);
        }
        let mut out: Vec<GroupClaim> = Vec::new();
        let mut pairs: Vec<(i32, u64)> = Vec::new();
        let mut current: Option<([i32; 2], i32)> = None;
        let mut held = 0u32;
        let finish =
            |out: &mut Vec<GroupClaim>, line: ([i32; 2], i32), held: u32, pairs: &[(i32, u64)]| {
                let (rest, at) = line;
                let mut c = [0; 3];
                c[a] = at;
                let others: Vec<usize> = (0..3).filter(|i| *i != a).collect();
                c[others[0]] = rest[0];
                c[others[1]] = rest[1];
                out.push(GroupClaim {
                    start: SectionPos::new(c[0], c[1], c[2]),
                    axis: a as u8,
                    held,
                    digest: GroupClaim::digest_of(pairs.iter().copied()),
                    layers: Vec::new(),
                });
            };
        for ((rest, at), s) in lines {
            let fits = current.is_some_and(|(r, start)| {
                r == rest && i64::from(at) - i64::from(start) < GROUP_MAX as i64
            });
            if !fits {
                if let Some(line) = current {
                    finish(&mut out, line, held, &pairs);
                }
                current = Some((rest, at));
                held = 0;
                pairs.clear();
            }
            let start = current.map_or(at, |c| c.1);
            held |= 1 << (i64::from(at) - i64::from(start));
            pairs.push((at, s));
        }
        if let Some(line) = current {
            finish(&mut out, line, held, &pairs);
        }
        out
    }
}

/// The interest a client sets: its area, and on a reconnect what it still
/// holds, so only what changed is sent again: sections one by one
/// (`holding`), in runs under one digest (`groups`), and layer states
/// (`layers`). A client sets it again with its claims when its connection
/// drops (`net.setInterest` while down sends it first thing on the next
/// connection).
#[derive(Wire, Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamInterest {
    /// The area.
    pub area: Area,
    /// Sections it holds already; empty unless resuming.
    pub holding: Vec<Claim>,
    /// Runs of sections it holds, each under one digest.
    pub groups: Vec<GroupClaim>,
    /// Layer states it holds.
    pub layers: Vec<LayerClaim>,
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
