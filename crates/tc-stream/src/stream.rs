//! [`SectionStream`]: every connection's interest, what each holds, and
//! the flush that sends what changed, what left and what is missing. See
//! the [crate docs](crate).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

use tc_net::{BulkTicket, ConnId, Protocol, ServerMsg};
use tc_wire::{Bytes, Wire};

use crate::area::Offsets;
use crate::cache::{Built, Cache};
use crate::lanes::Lanes;
use crate::msg::{Area, Claim, SectionPos, Stamp, StreamMsg};

/// The most positions one `Unload` carries.
pub const MAX_UNLOAD_BATCH: usize = 512;

/// The game's world, as sections. Called from the stream's thread only.
pub trait SectionSource {
    /// Encodes the section at `pos` into `out` (cleared first): the bytes
    /// the client's codec decodes. The same content must encode to the
    /// same bytes (stamps are of the bytes).
    fn build(&self, pos: SectionPos, out: &mut Vec<u8>);

    /// False for a position outside the world (never sent; unloaded if a
    /// client claims it). Every position exists by default.
    fn exists(&self, _pos: SectionPos) -> bool {
        true
    }

    /// Decodes an encoding into its cells (cleared first), for `Edit`s:
    /// true if it could. The default can't, so changes are sent as whole
    /// sections. A raw source returns [`decode_raw`](crate::decode_raw).
    fn cells(&self, _bytes: &[u8], _out: &mut Vec<u32>) -> bool {
        false
    }
}

/// How a stream is sized.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamConfig {
    /// The largest radii an area may have, per axis (at most 127).
    pub max_radius: [u8; 3],
    /// Sections left loaded past an area's edge before they're unloaded.
    pub hysteresis: u8,
    /// Sections built per flush for loads, shared by every connection (at
    /// least one is always built).
    pub build_budget: usize,
    /// Changed sections rebuilt per flush (at least one).
    pub rebuild_budget: usize,
    /// The section cache's bytes.
    pub cache_bytes: usize,
    /// Earlier encodings kept a section, to send an `Edit` from.
    pub history: usize,
}

impl Default for StreamConfig {
    fn default() -> StreamConfig {
        StreamConfig {
            max_radius: [16, 8, 16],
            hysteresis: 2,
            build_budget: 48,
            rebuild_budget: 64,
            cache_bytes: 64 << 20,
            history: 3,
        }
    }
}

/// Why an interest was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamError {
    /// No such connection: [`SectionStream::connect`] it first.
    UnknownConn,
    /// A radius is past [`StreamConfig::max_radius`].
    TooLarge,
    /// The area reaches past the `i32` coordinates.
    OutOfRange,
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            StreamError::UnknownConn => "unknown connection",
            StreamError::TooLarge => "interest area too large",
            StreamError::OutOfRange => "interest area out of range",
        })
    }
}

impl std::error::Error for StreamError {}

/// What a stream has done, since it was made.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StreamStats {
    /// Whole sections queued (loads and resends).
    pub sections: u64,
    /// `Edit`s sent.
    pub edits: u64,
    /// Sections queued again in place of a withdrawn one (a change folded
    /// in before it was written).
    pub folded: u64,
    /// Positions unloaded.
    pub unloads: u64,
    /// Claims that matched: sections a client kept, not sent again.
    pub resumed: u64,
    /// Sections built (loads and rebuilds).
    pub builds: u64,
    /// Sections in the cache now.
    pub cached: usize,
    /// Bytes the cache counts now.
    pub cache_bytes: usize,
}

/// A frame encoder for a game whose server messages hold [`StreamMsg`]:
/// `ServerMsg::<P>::Game(msg.into())`.
pub fn game_frame<P: Protocol>() -> impl Fn(&StreamMsg) -> Vec<u8> + Send + 'static
where
    P::Server: From<StreamMsg>,
{
    |m| ServerMsg::<P>::Game(m.clone().into()).to_bytes()
}

/// Encodes a stream message as a frame.
type Encode = Box<dyn Fn(&StreamMsg) -> Vec<u8> + Send>;

/// A section a connection holds, or will once its queued frame is
/// written.
struct Held {
    /// The stamp of the encoding it holds (or will).
    stamp: u64,
    /// The bulk frame that sends it, until written.
    ticket: Option<BulkTicket>,
    /// The client held an earlier copy when that frame was queued.
    replaces: bool,
}

impl Held {
    /// Withdraws its queued frame: true if the client then holds nothing.
    fn withdraw(&self) -> bool {
        self.ticket.as_ref().is_some_and(BulkTicket::withdraw) && !self.replaces
    }
}

#[derive(Default)]
struct Viewer {
    area: Option<Area>,
    held: HashMap<SectionPos, Held>,
    /// The next offset to look at, and where the area's offsets end.
    cursor: usize,
    end: usize,
    unloads: BTreeSet<SectionPos>,
    /// Held sections whose content changed since they were sent.
    stale: BTreeSet<SectionPos>,
    /// What the client says it holds, not yet looked at.
    claims: HashMap<SectionPos, u64>,
}

impl Viewer {
    fn busy(&self) -> bool {
        !self.stale.is_empty() || !self.unloads.is_empty() || self.cursor < self.end
    }
}

/// See the [crate docs](crate).
pub struct SectionStream {
    config: StreamConfig,
    offsets: Offsets,
    viewers: BTreeMap<ConnId, Viewer>,
    cache: Cache,
    changed: BTreeSet<SectionPos>,
    last_served: Option<ConnId>,
    encode: Encode,
    stats: StreamStats,
    buf: Vec<u8>,
    cells: (Vec<u32>, Vec<u32>),
}

impl fmt::Debug for SectionStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SectionStream")
            .field("config", &self.config)
            .field("viewers", &self.viewers.len())
            .field("changed", &self.changed.len())
            .field("stats", &self.stats)
            .finish_non_exhaustive()
    }
}

impl SectionStream {
    /// A stream sending frames `encode` makes (see [`game_frame`]).
    pub fn new(
        config: StreamConfig,
        encode: impl Fn(&StreamMsg) -> Vec<u8> + Send + 'static,
    ) -> SectionStream {
        let max_radius = config.max_radius.map(|r| r.min(127));
        SectionStream {
            config: StreamConfig {
                max_radius,
                ..config
            },
            offsets: Offsets::new(max_radius),
            viewers: BTreeMap::new(),
            cache: Cache::new(config.cache_bytes, config.history),
            changed: BTreeSet::new(),
            last_served: None,
            encode: Box::new(encode),
            stats: StreamStats::default(),
            buf: Vec::new(),
            cells: (Vec::new(), Vec::new()),
        }
    }

    /// Its config.
    pub fn config(&self) -> &StreamConfig {
        &self.config
    }

    /// A new connection: it holds nothing and wants nothing yet.
    pub fn connect(&mut self, conn: ConnId) {
        self.viewers.insert(conn, Viewer::default());
    }

    /// A connection closed: forgets it.
    pub fn disconnect(&mut self, conn: ConnId) {
        if let Some(v) = self.viewers.remove(&conn) {
            for h in v.held.values() {
                h.withdraw();
            }
        }
    }

    /// Sets a connection's area, with what it holds when it resumes.
    /// Sections it holds that are now past the area (with hysteresis) are
    /// unloaded; claims outside the area are unloaded too, never checked.
    pub fn set_interest(
        &mut self,
        conn: ConnId,
        area: Area,
        holding: &[Claim],
    ) -> Result<(), StreamError> {
        let max = self.config.max_radius;
        if area.rx > max[0] || area.ry > max[1] || area.rz > max[2] {
            return Err(StreamError::TooLarge);
        }
        let h = i64::from(self.config.hysteresis);
        if !area.in_range(h) {
            return Err(StreamError::OutOfRange);
        }
        let end = self.offsets.end(&area);
        let v = self
            .viewers
            .get_mut(&conn)
            .ok_or(StreamError::UnknownConn)?;
        // What leaves: the old box minus the new, or every held section
        // when that is fewer to look at (a long jump).
        let mut leaving = Vec::new();
        let old = v.area.map(|a| a.bounds(h));
        let slabs = old.map(|o| o.minus(&area.bounds(h))).unwrap_or_default();
        let volume: u64 = slabs.iter().map(|s| s.volume()).sum();
        if volume <= v.held.len() as u64 {
            for s in &slabs {
                s.for_each(|p| {
                    if v.held.contains_key(&p) {
                        leaving.push(p);
                    }
                });
            }
        } else {
            leaving.extend(v.held.keys().filter(|p| !area.contains(**p, h)));
        }
        for p in leaving {
            v.stale.remove(&p);
            if let Some(held) = v.held.remove(&p)
                && !held.withdraw()
            {
                v.unloads.insert(p);
            }
        }
        for c in holding.iter().take(end) {
            if v.held.contains_key(&c.pos) {
                continue;
            }
            if area.contains(c.pos, 0) {
                v.unloads.remove(&c.pos);
                v.claims.insert(c.pos, c.stamp.get());
            } else {
                v.unloads.insert(c.pos);
            }
        }
        v.claims.retain(|p, _| {
            let keep = area.contains(*p, 0);
            if !keep {
                v.unloads.insert(*p);
            }
            keep
        });
        v.area = Some(area);
        v.cursor = 0;
        v.end = end;
        Ok(())
    }

    /// The section at `pos` changed: holders get the change on a later
    /// flush, and its cached encoding is rebuilt.
    pub fn changed(&mut self, pos: SectionPos) {
        self.changed.insert(pos);
    }

    /// A new world under the same connections (a reload): forgets every
    /// encoding, and treats what each connection holds as claims, so a
    /// section the new world encodes the same is not sent again.
    pub fn reload(&mut self) {
        self.cache.clear();
        self.changed.clear();
        for v in self.viewers.values_mut() {
            for (p, h) in v.held.drain() {
                let stamp = if h.ticket.as_ref().is_some_and(BulkTicket::withdraw) {
                    if !h.replaces {
                        continue;
                    }
                    0 // an earlier copy, unknown: never matches
                } else {
                    h.stamp
                };
                v.claims.insert(p, stamp);
            }
            v.stale.clear();
            v.cursor = 0;
        }
    }

    /// True if a flush has something to do.
    pub fn has_work(&self) -> bool {
        !self.changed.is_empty() || self.viewers.values().any(Viewer::busy)
    }

    /// What it has done, and its cache now.
    pub fn stats(&self) -> StreamStats {
        let (cached, cache_bytes) = self.cache.usage();
        StreamStats {
            cached,
            cache_bytes,
            ..self.stats
        }
    }

    /// Sends what changed, what left and what is missing (see the [crate
    /// docs](crate)). Call it once a tick, after the tick's changes.
    pub fn flush<S: SectionSource + ?Sized>(&mut self, src: &S, lanes: &mut impl Lanes) {
        self.rebuild_changed(src);
        let conns: Vec<ConnId> = self.viewers.keys().copied().collect();
        for &conn in &conns {
            self.send_stale(conn, src, lanes);
            self.send_unloads(conn, lanes);
        }
        self.load(&conns, src, lanes);
    }

    /// Builds `pos` into the cache, and marks it stale for holders of an
    /// older encoding.
    fn build<S: SectionSource + ?Sized>(&mut self, src: &S, pos: SectionPos) -> Built {
        self.changed.remove(&pos);
        let mut buf = std::mem::take(&mut self.buf);
        src.build(pos, &mut buf);
        let built = self.cache.put(pos, buf.clone());
        self.buf = buf;
        self.stats.builds += 1;
        for v in self.viewers.values_mut() {
            if v.held.get(&pos).is_some_and(|h| h.stamp != built.stamp) {
                v.stale.insert(pos);
            }
        }
        built
    }

    /// `pos`'s current encoding, built if it changed or isn't cached.
    fn current<S: SectionSource + ?Sized>(&mut self, src: &S, pos: SectionPos) -> Built {
        if !self.changed.contains(&pos)
            && let Some(b) = self.cache.get(pos)
        {
            return b;
        }
        self.build(src, pos)
    }

    fn rebuild_changed<S: SectionSource + ?Sized>(&mut self, src: &S) {
        let mut budget = self.config.rebuild_budget.max(1);
        let changed: Vec<SectionPos> = self.changed.iter().copied().collect();
        for pos in changed {
            if !self.viewers.values().any(|v| v.held.contains_key(&pos)) {
                // Nobody holds it: built again when someone wants it.
                self.changed.remove(&pos);
                self.cache.remove(pos);
                continue;
            }
            if budget == 0 {
                break;
            }
            budget -= 1;
            self.build(src, pos);
        }
    }

    fn section_frame(&self, pos: SectionPos, b: &Built) -> Vec<u8> {
        (self.encode)(&StreamMsg::Section {
            pos,
            stamp: Stamp::of(b.stamp),
            data: Bytes(b.bytes.to_vec()),
        })
    }

    /// The `Edit` from what a client holds (`from`) to `to`, if the cells
    /// decode and it is smaller than the whole section.
    fn edit_frame<S: SectionSource + ?Sized>(
        &mut self,
        src: &S,
        pos: SectionPos,
        from: u64,
        to: &Built,
    ) -> Option<Vec<u8>> {
        let old = self.cache.earlier(pos, from)?;
        let (a, b) = &mut self.cells;
        if !src.cells(&old, a) || !src.cells(&to.bytes, b) || a.len() != b.len() {
            return None;
        }
        let mut changes = Vec::new();
        for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
            if x != y {
                changes.extend([u32::try_from(i).ok()?, *y]);
                if changes.len() * 4 >= to.bytes.len() {
                    return None;
                }
            }
        }
        Some((self.encode)(&StreamMsg::Edit {
            pos,
            changes,
            stamp: Stamp::of(to.stamp),
        }))
    }

    /// Sends a connection's stale sections: folded into a frame still
    /// queued, or an `Edit` or whole section on the priority lane.
    fn send_stale<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        src: &S,
        lanes: &mut impl Lanes,
    ) {
        let Some(v) = self.viewers.get(&conn) else {
            return;
        };
        if v.stale.is_empty() || lanes.behind(conn) {
            return;
        }
        let stale: Vec<SectionPos> = v.stale.iter().copied().collect();
        for pos in stale {
            let built = self.current(src, pos);
            let Some(h) = self.viewers.get(&conn).and_then(|v| v.held.get(&pos)) else {
                continue;
            };
            let (from, replaces) = (h.stamp, h.replaces);
            if from == built.stamp {
                // Changed back to what it holds.
                if let Some(v) = self.viewers.get_mut(&conn) {
                    v.stale.remove(&pos);
                }
                continue;
            }
            let queued = h.ticket.as_ref().is_some_and(BulkTicket::withdraw);
            let (sent, ticket) = if queued {
                let ticket = BulkTicket::new();
                let frame = self.section_frame(pos, &built);
                self.stats.folded += 1;
                (
                    lanes.send_bulk(conn, frame, Some(ticket.clone())),
                    Some(ticket),
                )
            } else if let Some(frame) = self.edit_frame(src, pos, from, &built) {
                self.stats.edits += 1;
                (lanes.send(conn, frame), None)
            } else {
                let frame = self.section_frame(pos, &built);
                self.stats.sections += 1;
                (lanes.send(conn, frame), None)
            };
            let Some(v) = self.viewers.get_mut(&conn) else {
                return;
            };
            if sent {
                v.stale.remove(&pos);
                v.held.insert(
                    pos,
                    Held {
                        stamp: built.stamp,
                        ticket,
                        replaces,
                    },
                );
            } else if queued {
                // Its frame is gone and the lane refused the new one: the
                // load loop sends it again.
                v.stale.remove(&pos);
                v.held.remove(&pos);
                if replaces {
                    v.unloads.insert(pos);
                }
                v.cursor = 0;
            } else {
                return; // the lane is full: next flush
            }
        }
    }

    fn send_unloads(&mut self, conn: ConnId, lanes: &mut impl Lanes) {
        let Some(v) = self.viewers.get_mut(&conn) else {
            return;
        };
        while !v.unloads.is_empty() {
            let positions: Vec<SectionPos> =
                v.unloads.iter().take(MAX_UNLOAD_BATCH).copied().collect();
            let n = positions.len();
            let frame = (self.encode)(&StreamMsg::Unload { positions });
            if !lanes.send(conn, frame) {
                return;
            }
            for _ in 0..n {
                v.unloads.pop_first();
            }
            self.stats.unloads += n as u64;
        }
    }

    /// Sends missing sections nearest first, round robin from the
    /// connection after the one served last, within the build budget and
    /// each bulk lane's high water.
    fn load<S: SectionSource + ?Sized>(
        &mut self,
        conns: &[ConnId],
        src: &S,
        lanes: &mut impl Lanes,
    ) {
        let mut budget = self.config.build_budget.max(1);
        let start = self
            .last_served
            .map_or(0, |l| conns.partition_point(|c| *c <= l));
        for &conn in conns[start..].iter().chain(&conns[..start]) {
            if budget == 0 {
                break;
            }
            if self.load_one(conn, src, lanes, &mut budget) {
                self.last_served = Some(conn);
            }
        }
    }

    /// Loads for one connection; true if it was served at all.
    fn load_one<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        src: &S,
        lanes: &mut impl Lanes,
        budget: &mut usize,
    ) -> bool {
        let mut served = false;
        loop {
            let Some(v) = self.viewers.get_mut(&conn) else {
                return served;
            };
            let Some(area) = v.area else {
                return served;
            };
            if v.cursor >= v.end {
                // Done: whatever is still claimed was never looked at.
                for p in v.claims.drain().map(|(p, _)| p) {
                    if !v.held.contains_key(&p) {
                        v.unloads.insert(p);
                    }
                }
                return served;
            }
            if lanes.bulk_queued(conn) >= lanes.bulk_high_water(conn) {
                return served;
            }
            let Some(o) = self.offsets.get(v.cursor) else {
                v.cursor = v.end;
                continue;
            };
            if !area.has(o) || v.held.contains_key(&area.at(o)) {
                v.cursor += 1;
                continue;
            }
            let pos = area.at(o);
            if !src.exists(pos) {
                if v.claims.remove(&pos).is_some() {
                    v.unloads.insert(pos);
                }
                v.cursor += 1;
                continue;
            }
            let cached = !self.changed.contains(&pos) && self.cache.get(pos).is_some();
            if !cached && *budget == 0 {
                return served;
            }
            let built = self.current(src, pos);
            if !cached {
                *budget -= 1;
            }
            served = true;
            let Some(v) = self.viewers.get_mut(&conn) else {
                return served;
            };
            let claim = v.claims.remove(&pos);
            if claim == Some(built.stamp) {
                self.stats.resumed += 1;
                v.held.insert(
                    pos,
                    Held {
                        stamp: built.stamp,
                        ticket: None,
                        replaces: false,
                    },
                );
                v.cursor += 1;
                continue;
            }
            let replaces = claim.is_some() || v.unloads.remove(&pos);
            let ticket = BulkTicket::new();
            let frame = self.section_frame(pos, &built);
            let Some(v) = self.viewers.get_mut(&conn) else {
                return served;
            };
            if !lanes.send_bulk(conn, frame, Some(ticket.clone())) {
                if let Some(stamp) = claim {
                    v.claims.insert(pos, stamp);
                } else if replaces {
                    v.unloads.insert(pos);
                }
                return served;
            }
            self.stats.sections += 1;
            v.held.insert(
                pos,
                Held {
                    stamp: built.stamp,
                    ticket: Some(ticket),
                    replaces,
                },
            );
            v.cursor += 1;
        }
    }
}
