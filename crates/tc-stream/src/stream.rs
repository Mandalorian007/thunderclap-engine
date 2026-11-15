//! [`SectionStream`]: every connection's interest, what each holds, and
//! the flush that sends what changed, what left and what is missing. See
//! the [crate docs](crate).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::{Duration, Instant};

use tc_net::{BulkTicket, ConnId, Protocol, ServerMsg};
use tc_wire::{Bytes, Wire};

use crate::area::{Bounds, MIN_BOXED, Offsets};
use crate::cache::{Built, Cache};
use crate::hash::PosMap;
use crate::lanes::Lanes;
use crate::msg::{Area, Claim, GroupClaim, SectionPos, Stamp, StreamInterest, StreamMsg};

mod layers;

use layers::{LayerHeld, Layers};

/// The most positions one `Unload` carries.
pub const MAX_UNLOAD_BATCH: usize = 512;

/// What the stream is about to load for: given to
/// [`SectionSource::begin`], so a source sizes its own caches (meshes
/// half-built, generated land waiting for its neighbours) to the views.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Loading {
    /// Connections still loading.
    pub views: usize,
    /// The sum of their areas' longest sides, in sections (`2r + 1`).
    pub sides: u64,
    /// The longest side of any of them.
    pub widest: u32,
}

/// The game's world, as sections. Called from the stream's thread only.
///
/// `build`, `begin` and `end` take the source mutably: a game keeps its
/// own caches of what building needs here (sections waiting on
/// neighbours, faces worked out once for several), sized from
/// [`Loading`]. The rest only read.
pub trait SectionSource {
    /// Encodes the section at `pos` into `out` (cleared first): the bytes
    /// the client's codec decodes. The same content must encode to the
    /// same bytes (stamps are of the bytes).
    fn build(&mut self, pos: SectionPos, out: &mut Vec<u8>);

    /// Called before a flush, a load or a claims check builds anything,
    /// with the views loading. Nothing by default.
    fn begin(&mut self, _loading: &Loading) {}

    /// Called after it, to let go of what only that pass needed. Nothing by
    /// default.
    fn end(&mut self) {}

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

    /// How many layers the world has: data streamed beside its sections
    /// (what lies on the ground, a column's climate, timers), each sent
    /// whole to a client right behind the first section it holds under the
    /// layer's key, then as changes ([`SectionStream::layer_changed`]).
    /// None by default. Read at each flush; keep it fixed.
    fn layers(&self) -> usize {
        0
    }

    /// The key layer `layer`'s data for section `pos` is under: the section
    /// itself (the default), or a coarser one shared by several sections
    /// (a column: `(x, 0, z)`), sent once to a client holding any of them.
    fn layer_key(&self, _layer: usize, pos: SectionPos) -> SectionPos {
        pos
    }

    /// Layer `layer`'s state at `key`, encoded into `out` (cleared first;
    /// left empty when there is none). The same state must encode to the
    /// same bytes: a change is told by them.
    fn layer_state(&self, _layer: usize, _key: SectionPos, out: &mut Vec<u8>) {
        out.clear();
    }

    /// The stamp a client claims layer `layer`'s state at `key` by
    /// ([`LayerClaim`](crate::LayerClaim), a group's layer digest): never
    /// 0, the same for the same `state` bytes (only asked for a state that
    /// isn't empty). [`tc_wire::stamp::bytes_stamp`] by default; a game
    /// whose client keeps a state in another form stamps what both sides
    /// can work out.
    fn layer_stamp(&self, _layer: usize, _key: SectionPos, state: &[u8]) -> u64 {
        tc_wire::stamp::bytes_stamp(state)
    }

    /// The game's frame taking a client of layer `layer` at `key` from
    /// `from` (an earlier state it holds; `None`: nothing, or a state no
    /// longer known, so the frame is the whole of `to` and replaces what
    /// it holds) to `to`, into `out` (cleared first). Left empty, nothing
    /// is sent. The frame is the game's own message, encoded.
    fn layer_frame(
        &self,
        _layer: usize,
        _key: SectionPos,
        _from: Option<&[u8]>,
        _to: &[u8],
        out: &mut Vec<u8>,
    ) {
        out.clear();
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
    /// Time a flush spends building sections for loads, besides
    /// `build_budget` (whichever runs out first; at least one is built).
    /// `None` (the default): counted only.
    pub build_time: Option<Duration>,
    /// Time a flush spends rebuilding changed sections, besides
    /// `rebuild_budget`. `None` (the default): counted only.
    pub rebuild_time: Option<Duration>,
    /// Unloads past the area grown by `hysteresis` go as
    /// `StreamMsg::UnloadBox`es (a view left behind in one or a few
    /// messages), the rest as `Unload`s. Off by default: a client must
    /// know the message.
    pub unload_boxes: bool,
    /// Time [`SectionStream::idle`] builds in between flushes.
    pub idle: IdleBudget,
}

/// Time spent building new sections between flushes
/// ([`SectionStream::idle`]), per flush interval (counted from the last
/// flush): first `spread`, then `extra` while the machine has time to
/// spare. Building between flushes, around the loop's other work, keeps
/// a flush short, so a command waits for one section, not a flush's load.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IdleBudget {
    /// Spent first, every interval. Default 8 ms.
    pub spread: Duration,
    /// Of `spread`, what is spent while idle building is held
    /// ([`SectionStream::hold_idle`]: the machine is short of CPU).
    /// Default 3 ms.
    pub held: Duration,
    /// Spent after `spread`, only while not held. Default 5 ms.
    pub extra: Duration,
}

impl Default for IdleBudget {
    fn default() -> IdleBudget {
        IdleBudget {
            spread: Duration::from_millis(8),
            held: Duration::from_millis(3),
            extra: Duration::from_millis(5),
        }
    }
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
            build_time: None,
            rebuild_time: None,
            unload_boxes: false,
            idle: IdleBudget::default(),
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
    /// Positions unloaded (by `Unload`s, and held ones an `UnloadBox`
    /// covered).
    pub unloads: u64,
    /// `UnloadBox`es sent.
    pub unload_boxes: u64,
    /// Claims that matched: sections a client kept, not sent again.
    pub resumed: u64,
    /// Sections built (loads and rebuilds).
    pub builds: u64,
    /// Time spent building them, in nanoseconds.
    pub build_nanos: u64,
    /// Held sections queued again whole in the bulk lane after a
    /// [`SectionStream::changed_bulk`].
    pub bulk_resends: u64,
    /// Layer frames sent (whole and changes).
    pub layer_frames: u64,
    /// Bytes of every frame queued.
    pub bytes: u64,
    /// Frames a lane refused (full or closed); sent again later.
    pub refused: u64,
    /// Loads served from the cache, not built.
    pub cache_hits: u64,
    /// Group claims received ([`GroupClaim`]).
    pub group_claims: u64,
    /// Groups that matched: every section kept.
    pub groups_held: u64,
    /// Groups that didn't: every section sent again.
    pub groups_different: u64,
    /// Claims never looked at (past the area's size, overlapping, or left
    /// when a load finished), sections and layers.
    pub claims_dropped: u64,
    /// Layer states a client claimed and kept, not sent again.
    pub layer_resumed: u64,
    /// Flushes that built a section, and the time their building took, in
    /// nanoseconds.
    pub flush_builds: u64,
    /// See `flush_builds`.
    pub flush_nanos: u64,
    /// Sections built between flushes ([`SectionStream::idle`]), and the
    /// time those calls took, in nanoseconds.
    pub idle_builds: u64,
    /// See `idle_builds`.
    pub idle_nanos: u64,
    /// Calls to [`SectionStream::hold_idle`].
    pub idle_holds: u64,
    /// Sections in the cache now.
    pub cached: usize,
    /// Bytes the cache counts now.
    pub cache_bytes: usize,
}

/// What a stream frame queued carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum FrameKind {
    /// A whole section loading, in the bulk lane.
    Section,
    /// A whole section on the priority lane (a change).
    Changed,
    /// A section queued again in place of one withdrawn.
    Folded,
    /// A section queued again whole in the bulk lane (a background change).
    Resend,
    /// An `Edit`.
    Edit,
    /// An `Unload`.
    Unload,
    /// An `UnloadBox`.
    UnloadBox,
    /// A layer frame (whole or a change).
    Layer,
}

/// Something a stream did, as it happens, for an observer
/// ([`SectionStream::set_observer`]). More may be added.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum StreamEvent {
    /// A frame was queued for `conn`, `bytes` long.
    Queued {
        /// The connection.
        conn: ConnId,
        /// What it carries.
        kind: FrameKind,
        /// Its length.
        bytes: usize,
    },
    /// A section was built, taking `nanos`.
    Built {
        /// The section.
        pos: SectionPos,
        /// The time it took.
        nanos: u64,
    },
    /// A claim was checked: `kept` if it matched.
    Claimed {
        /// The connection.
        conn: ConnId,
        /// The section.
        pos: SectionPos,
        /// It matched: not sent again.
        kept: bool,
    },
    /// A group claim was checked: `kept` if it matched.
    Group {
        /// The connection.
        conn: ConnId,
        /// Its first section.
        start: SectionPos,
        /// It matched: none of its sections sent again.
        kept: bool,
    },
}

/// Watches a stream's [`StreamEvent`]s: a game's own counters, timings or
/// traces. A closure taking `&StreamEvent` is one.
pub trait StreamObserver: Send {
    /// One event.
    fn event(&mut self, event: &StreamEvent);
}

impl<F: FnMut(&StreamEvent) + Send> StreamObserver for F {
    fn event(&mut self, event: &StreamEvent) {
        self(event);
    }
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
    held: PosMap<SectionPos, Held>,
    /// The next offset to look at, and where the area's offsets end.
    cursor: usize,
    end: usize,
    unloads: BTreeSet<SectionPos>,
    /// Held sections whose content changed since they were sent.
    stale: BTreeSet<SectionPos>,
    /// Held sections a background change ([`SectionStream::changed_bulk`])
    /// left behind: queued again whole in the bulk lane.
    resend: BTreeSet<SectionPos>,
    /// What the client says it holds, not yet looked at (0: an earlier
    /// copy, unknown, never matching).
    claims: PosMap<SectionPos, u64>,
    /// Group claims not yet looked at, by index (taken as looked at).
    groups: Vec<Option<GroupClaim>>,
    /// Each section of a group in `groups`, to its index.
    grouped: PosMap<SectionPos, usize>,
    /// Sections it stopped holding whose layer keys the next flush lets
    /// go (an interest is set without the source).
    released: BTreeSet<SectionPos>,
    /// What it holds of each layer.
    layers: LayerHeld,
}

impl Viewer {
    /// Takes group `i` apart: each section of it not held is claimed with
    /// an unknown stamp (sent again whole) if in `area`, else unloaded.
    fn split_group(&mut self, i: usize, area: &Area) {
        let Some(g) = self.groups.get_mut(i).and_then(Option::take) else {
            return;
        };
        for (p, _) in g.members() {
            if self.grouped.get(&p) != Some(&i) {
                continue;
            }
            self.grouped.remove(&p);
            if self.held.contains_key(&p) {
                continue;
            }
            if area.contains(p, 0) {
                self.unloads.remove(&p);
                self.claims.entry(p).or_insert(0);
            } else {
                self.unloads.insert(p);
            }
        }
    }

    /// The load reached its end: whatever is still claimed was never
    /// looked at, so is unloaded. Returns the claims dropped.
    fn finish_claims(&mut self) -> u64 {
        let mut dropped = 0;
        for p in self.claims.drain().map(|(p, _)| p) {
            dropped += 1;
            if !self.held.contains_key(&p) {
                self.unloads.insert(p);
            }
        }
        for (p, _) in self.grouped.drain() {
            dropped += 1;
            if !self.held.contains_key(&p) {
                self.unloads.insert(p);
            }
        }
        self.groups.clear();
        dropped + self.layers.drop_claims() as u64
    }

    fn busy(&self) -> bool {
        !self.stale.is_empty()
            || !self.resend.is_empty()
            || !self.unloads.is_empty()
            || !self.released.is_empty()
            || self.layers.busy()
            || self.cursor < self.end
    }
}

/// Where a load stops: a count of builds, a time, or the caller.
struct Budget<'a> {
    left: usize,
    until: Option<Instant>,
    interrupted: &'a mut dyn FnMut() -> bool,
    /// Build one whatever the time (a flush always makes progress).
    one: bool,
    built: usize,
}

impl Budget<'_> {
    /// True if no more may be built.
    fn out(&mut self) -> bool {
        if self.left == 0 {
            return true;
        }
        if self.one && self.built == 0 {
            return false;
        }
        self.until.is_some_and(|u| Instant::now() >= u) || (self.interrupted)()
    }

    fn spend(&mut self) {
        self.left = self.left.saturating_sub(1);
        self.built += 1;
    }
}

/// See the [crate docs](crate).
pub struct SectionStream {
    config: StreamConfig,
    offsets: Offsets,
    viewers: BTreeMap<ConnId, Viewer>,
    cache: Cache,
    changed: BTreeSet<SectionPos>,
    /// Of `changed`, the ones changed in the background only.
    bulk: BTreeSet<SectionPos>,
    last_served: Option<ConnId>,
    encode: Encode,
    stats: StreamStats,
    buf: Vec<u8>,
    cells: (Vec<u32>, Vec<u32>),
    /// This flush's `Edit`s, by section, held stamp and current stamp:
    /// every holder of a change usually holds the same encoding, so the
    /// diff is worked out once (`None`: the whole section is smaller).
    edits: PosMap<(SectionPos, u64, u64), Option<Vec<u8>>>,
    layers: Layers,
    observer: Option<Box<dyn StreamObserver>>,
    /// Of this flush interval's [`IdleBudget`]: spread and extra time
    /// spent.
    spread_spent: Duration,
    extra_spent: Duration,
    /// No extra idle time until then ([`SectionStream::hold_idle`]).
    idle_held: Option<Instant>,
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
            bulk: BTreeSet::new(),
            last_served: None,
            encode: Box::new(encode),
            stats: StreamStats::default(),
            buf: Vec::new(),
            cells: (Vec::new(), Vec::new()),
            edits: PosMap::default(),
            layers: Layers::default(),
            observer: None,
            spread_spent: Duration::ZERO,
            extra_spent: Duration::ZERO,
            idle_held: None,
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
        if let Some(mut v) = self.viewers.remove(&conn) {
            for h in v.held.values() {
                h.withdraw();
            }
            self.layers.drop_viewer(&mut v.layers);
        }
    }

    /// Sets a connection's area, with what it holds when it resumes.
    /// Sections it holds that are now past the area (with hysteresis) are
    /// unloaded; claims outside the area are unloaded too, never checked.
    /// [`set_stream_interest`](Self::set_stream_interest) with no groups or
    /// layers.
    pub fn set_interest(
        &mut self,
        conn: ConnId,
        area: Area,
        holding: &[Claim],
    ) -> Result<(), StreamError> {
        self.set_claims(conn, area, holding, &[], &[])
    }

    /// Sets a connection's [`StreamInterest`]: its area, and when it
    /// resumes what it holds, section by section, in groups and of each
    /// layer. Sections it holds that are now past the area (with
    /// hysteresis) are unloaded; claims outside the area are unloaded too,
    /// never checked. A group with a section outside the area, or one held
    /// or claimed already, is taken apart: each section of it in the area
    /// is sent again whole, the rest unloaded. Claims are looked at as the
    /// load reaches them (or on [`check_claims`](Self::check_claims));
    /// claims past the area's section count are dropped.
    pub fn set_stream_interest(
        &mut self,
        conn: ConnId,
        interest: &StreamInterest,
    ) -> Result<(), StreamError> {
        self.set_claims(
            conn,
            interest.area,
            &interest.holding,
            &interest.groups,
            &interest.layers,
        )
    }

    fn set_claims(
        &mut self,
        conn: ConnId,
        area: Area,
        holding: &[Claim],
        groups: &[GroupClaim],
        layers: &[crate::msg::LayerClaim],
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
            v.resend.remove(&p);
            if let Some(held) = v.held.remove(&p) {
                v.released.insert(p);
                if !held.withdraw() {
                    v.unloads.insert(p);
                }
            }
        }
        let stats = &mut self.stats;
        // Groups still waiting with a section now outside are taken apart.
        for i in 0..v.groups.len() {
            if v.groups[i]
                .as_ref()
                .is_some_and(|g| g.members().any(|(p, _)| !area.contains(p, 0)))
            {
                v.split_group(i, &area);
            }
        }
        let mut room = end.saturating_sub(v.claims.len() + v.grouped.len());
        for c in holding {
            if v.held.contains_key(&c.pos) || v.grouped.contains_key(&c.pos) {
                continue;
            }
            if room == 0 {
                stats.claims_dropped += 1;
                continue;
            }
            if area.contains(c.pos, 0) {
                v.unloads.remove(&c.pos);
                if v.claims.insert(c.pos, c.stamp.get()).is_none() {
                    room -= 1;
                }
            } else {
                v.unloads.insert(c.pos);
            }
        }
        for g in groups {
            stats.group_claims += 1;
            let members: Vec<SectionPos> = g.members().map(|(p, _)| p).collect();
            if members.is_empty() {
                continue;
            }
            if members.len() > room {
                stats.claims_dropped += members.len() as u64;
                continue;
            }
            room -= members.len();
            let whole = members.iter().all(|p| {
                area.contains(*p, 0)
                    && !v.held.contains_key(p)
                    && !v.claims.contains_key(p)
                    && !v.grouped.contains_key(p)
            });
            let i = v.groups.len();
            v.groups.push(Some(g.clone()));
            for p in &members {
                v.grouped.entry(*p).or_insert(i);
            }
            if !whole {
                v.split_group(i, &area);
                v.groups.pop();
            } else {
                for p in &members {
                    v.unloads.remove(p);
                }
            }
        }
        v.claims.retain(|p, _| {
            let keep = area.contains(*p, 0);
            if !keep {
                v.unloads.insert(*p);
            }
            keep
        });
        let mut room = end.saturating_mul(8).saturating_sub(v.layers.claims());
        for c in layers {
            if room == 0 {
                stats.claims_dropped += 1;
                continue;
            }
            room -= 1;
            v.layers.claim(c.layer as usize, c.key, c.stamp.get());
        }
        v.area = Some(area);
        v.cursor = 0;
        v.end = end;
        Ok(())
    }

    /// Looks now at what a connection claims (sections and groups; only
    /// those within `within`'s corners, inclusive, if given) rather than
    /// when its load reaches them: before a command, so it acts on what is
    /// there. Matching sections are kept; the others are queued whole in
    /// the bulk lane at once. Whatever the build budget.
    pub fn check_claims<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        within: Option<(SectionPos, SectionPos)>,
        src: &mut S,
        lanes: &mut impl Lanes,
    ) {
        let Some(v) = self.viewers.get(&conn) else {
            return;
        };
        let inside = |p: &SectionPos| within.is_none_or(|(min, max)| p.within(&min, &max));
        let mut groups: Vec<usize> = v
            .grouped
            .iter()
            .filter(|(p, _)| inside(p))
            .map(|(_, i)| *i)
            .collect();
        groups.sort_unstable();
        groups.dedup();
        let mut claims: Vec<SectionPos> = v.claims.keys().filter(|p| inside(p)).copied().collect();
        if groups.is_empty() && claims.is_empty() {
            return;
        }
        self.begin(src);
        self.settle_layers(src);
        for i in groups {
            claims.extend(self.resolve_group(conn, i, src));
        }
        claims.sort_unstable();
        claims.dedup();
        for pos in claims {
            let Some(v) = self.viewers.get_mut(&conn) else {
                break;
            };
            let Some(claim) = v.claims.remove(&pos) else {
                continue;
            };
            if v.held.contains_key(&pos) {
                continue;
            }
            if !src.exists(pos) {
                v.unloads.insert(pos);
                continue;
            }
            let built = self.current(src, pos);
            if !self.place(conn, pos, &built, Some(claim), src, lanes) {
                break;
            }
        }
        src.end();
    }

    /// Claims a connection has that are not yet looked at: sections, each
    /// section of a group, and layer states.
    pub fn claims_pending(&self, conn: ConnId) -> usize {
        self.viewers
            .get(&conn)
            .map_or(0, |v| v.claims.len() + v.grouped.len() + v.layers.claims())
    }

    /// Sections a connection holds (or will once their queued frames are
    /// written).
    pub fn held(&self, conn: ConnId) -> usize {
        self.viewers.get(&conn).map_or(0, |v| v.held.len())
    }

    /// The section at `pos` changed: holders get the change on a later
    /// flush (an `Edit` or the whole section, on the priority lane), and
    /// its cached encoding is rebuilt.
    pub fn changed(&mut self, pos: SectionPos) {
        self.changed.insert(pos);
        self.bulk.remove(&pos);
    }

    /// The section at `pos` changed in a way no one is waiting to see (a
    /// cave found sealed, a far-off regrowth): holders get it again whole
    /// in the bulk lane, behind what loads, not on the priority lane. A
    /// [`changed`](Self::changed) of the same section before the flush
    /// wins.
    pub fn changed_bulk(&mut self, pos: SectionPos) {
        if self.changed.insert(pos) {
            self.bulk.insert(pos);
        }
    }

    /// Layer `layer`'s state at `key` (see [`SectionSource::layer_key`])
    /// may have changed: a later flush reads it again and sends its
    /// holders the change on the priority lane (or folds it into a whole
    /// frame still waiting in the bulk lane).
    pub fn layer_changed(&mut self, layer: usize, key: SectionPos) {
        self.layers.changed(layer, key);
    }

    /// A new world under the same connections (a reload): forgets every
    /// encoding, and treats what each connection holds as claims, so a
    /// section (or layer state) the new world encodes the same is not sent
    /// again.
    pub fn reload(&mut self) {
        self.cache.clear();
        self.changed.clear();
        self.bulk.clear();
        for v in self.viewers.values_mut() {
            self.layers.forget_viewer(&mut v.layers);
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
            v.released.clear();
            v.stale.clear();
            v.resend.clear();
            v.cursor = 0;
        }
        self.layers.clear();
    }

    /// True if a flush has something to do.
    pub fn has_work(&self) -> bool {
        !self.changed.is_empty()
            || self.layers.has_work()
            || self.viewers.values().any(Viewer::busy)
    }

    /// True if a connection still wants sections it doesn't hold (what
    /// [`load_until`](Self::load_until) would send).
    pub fn loading(&self) -> bool {
        self.viewers.values().any(|v| v.cursor < v.end)
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
    pub fn flush<S: SectionSource + ?Sized>(&mut self, src: &mut S, lanes: &mut impl Lanes) {
        self.begin(src);
        self.edits.clear();
        self.settle_layers(src);
        self.rebuild_changed(src);
        let conns: Vec<ConnId> = self.viewers.keys().copied().collect();
        for &conn in &conns {
            self.send_stale(conn, src, lanes);
            self.send_layers(conn, src, lanes);
            self.send_unloads(conn, lanes);
        }
        lanes.edits_queued();
        self.spread_spent = Duration::ZERO;
        self.extra_spent = Duration::ZERO;
        let mut never = || false;
        let start = Instant::now();
        let mut budget = Budget {
            left: self.config.build_budget.max(1),
            until: self.config.build_time.map(|t| start + t),
            interrupted: &mut never,
            one: true,
            built: 0,
        };
        self.load(&conns, src, lanes, &mut budget);
        if budget.built > 0 {
            self.stats.flush_builds += 1;
            self.stats.flush_nanos += nanos(start.elapsed());
        }
        src.end();
    }

    /// Calls the source's [`begin`](SectionSource::begin) with the views
    /// loading.
    fn begin<S: SectionSource + ?Sized>(&self, src: &mut S) {
        let mut loading = Loading::default();
        for v in self.viewers.values() {
            if let Some(a) = v.area.filter(|_| v.cursor < v.end) {
                let side = 2 * u32::from(a.rx.max(a.ry).max(a.rz)) + 1;
                loading.views += 1;
                loading.sides += u64::from(side);
                loading.widest = loading.widest.max(side);
            }
        }
        src.begin(&loading);
    }

    /// True if [`idle`](Self::idle) has anything to do: time left in this
    /// flush interval's [`IdleBudget`], and a connection still loading.
    pub fn idle_left(&self) -> bool {
        !self.idle_budget_left(Instant::now()).is_zero() && self.loading()
    }

    /// True while idle building is held ([`hold_idle`](Self::hold_idle)).
    pub fn idle_held(&self, now: Instant) -> bool {
        self.idle_held.is_some_and(|t| now < t)
    }

    /// Spends only [`IdleBudget::held`] of the spread time, and none of the
    /// extra, until `until`: the caller found the machine short of CPU
    /// (its loop woke late for a deadline), so its spare time isn't spare.
    pub fn hold_idle(&mut self, until: Instant) {
        if self.idle_held.is_none_or(|t| t < until) {
            self.idle_held = Some(until);
        }
        self.stats.idle_holds += 1;
    }

    fn idle_budget_left(&self, now: Instant) -> Duration {
        let b = self.config.idle;
        let held = self.idle_held(now);
        let spread = if held { b.held.min(b.spread) } else { b.spread };
        let extra = if held {
            Duration::ZERO
        } else {
            b.extra.saturating_sub(self.extra_spent)
        };
        spread.saturating_sub(self.spread_spent) + extra
    }

    /// Builds and queues new sections as a flush's load does in time the
    /// caller's loop would otherwise wait (a tc-sim `Host::idle`): until
    /// `until`, until `interrupted` says something else is waiting
    /// (checked before the first build and after each), or until this
    /// flush interval's [`IdleBudget`] is spent (spread time first, then
    /// extra unless [held](Self::hold_idle); counted from the last flush).
    /// Changes and unloads wait for the next flush. Returns the time it
    /// took.
    pub fn idle<S: SectionSource + ?Sized>(
        &mut self,
        src: &mut S,
        lanes: &mut impl Lanes,
        until: Instant,
        mut interrupted: impl FnMut() -> bool,
    ) -> Duration {
        let start = Instant::now();
        let left = self.idle_budget_left(start);
        if left.is_zero() || start >= until || !self.loading() || interrupted() {
            return Duration::ZERO;
        }
        let built = self.load_until(src, lanes, until.min(start + left), interrupted);
        let spent = start.elapsed();
        // Spread time first: the extra is what a short machine gives up.
        let spread = spent.min(self.config.idle.spread.saturating_sub(self.spread_spent));
        self.spread_spent += spread;
        self.extra_spent += spent - spread;
        self.stats.idle_builds += built as u64;
        self.stats.idle_nanos += nanos(spent);
        spent
    }

    /// Sends one connection what changed of what it holds now, whatever
    /// the rebuild budget: before the reply to its own command, so it sees
    /// its change first. The next [`flush`](Self::flush) sends the rest
    /// as usual.
    pub fn flush_conn<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        src: &mut S,
        lanes: &mut impl Lanes,
    ) {
        let Some(v) = self.viewers.get(&conn) else {
            return;
        };
        let mine: Vec<SectionPos> = self
            .changed
            .iter()
            .filter(|p| v.held.contains_key(p))
            .copied()
            .collect();
        self.begin(src);
        self.edits.clear();
        self.settle_layers(src);
        for pos in mine {
            self.build(src, pos);
        }
        self.send_stale(conn, src, lanes);
        self.send_layers(conn, src, lanes);
        src.end();
    }

    /// Builds and queues new sections as a flush's load does (round robin
    /// from where the last one stopped, nearest first, within each bulk
    /// lane's high water) in time the caller's thread would otherwise wait:
    /// until `until`, or until `interrupted` says something else is
    /// waiting (checked before the first build and after each). Changes
    /// and unloads wait for the next flush. Returns the sections built.
    pub fn load_until<S: SectionSource + ?Sized>(
        &mut self,
        src: &mut S,
        lanes: &mut impl Lanes,
        until: Instant,
        mut interrupted: impl FnMut() -> bool,
    ) -> usize {
        if !self.loading() {
            return 0;
        }
        self.begin(src);
        self.settle_layers(src);
        let conns: Vec<ConnId> = self.viewers.keys().copied().collect();
        let mut budget = Budget {
            left: usize::MAX,
            until: Some(until),
            interrupted: &mut interrupted,
            one: false,
            built: 0,
        };
        self.load(&conns, src, lanes, &mut budget);
        src.end();
        budget.built
    }

    /// Lets go of the layer keys of sections no longer held, and reads the
    /// layers that changed.
    fn settle_layers<S: SectionSource + ?Sized>(&mut self, src: &mut S) {
        self.layers.resize(src.layers());
        for v in self.viewers.values_mut() {
            for p in std::mem::take(&mut v.released) {
                if !v.held.contains_key(&p) {
                    self.layers.release(&mut v.layers, &*src, p);
                }
            }
        }
        self.layers
            .settle(&*src, self.viewers.values_mut().map(|v| &mut v.layers));
    }

    /// Records a section newly held by `conn`: its layer keys.
    fn hold<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        pos: SectionPos,
        held: Held,
        src: &mut S,
    ) {
        let Some(v) = self.viewers.get_mut(&conn) else {
            return;
        };
        if v.held.insert(pos, held).is_none() && !v.released.remove(&pos) {
            // (A section let go of and held again keeps its layer keys.)
            self.stats.layer_resumed += self.layers.hold(&mut v.layers, &*src, pos);
        }
    }

    /// `conn` no longer holds `pos`.
    fn release<S: SectionSource + ?Sized>(&mut self, conn: ConnId, pos: SectionPos, src: &mut S) {
        let Some(v) = self.viewers.get_mut(&conn) else {
            return;
        };
        v.stale.remove(&pos);
        v.resend.remove(&pos);
        if v.held.remove(&pos).is_some() {
            self.layers.release(&mut v.layers, &*src, pos);
        }
    }

    /// `pos`'s frame was withdrawn and queued again behind: so are its
    /// layers' whole frames still queued, to stay behind it.
    fn requeue_layers<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        pos: SectionPos,
        src: &mut S,
    ) {
        if let Some(v) = self.viewers.get_mut(&conn) {
            self.layers.requeue(&mut v.layers, &*src, pos);
        }
    }

    /// Sends `conn` the layer frames waiting: whole ones in the bulk lane,
    /// changes on the priority lane.
    fn send_layers<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        src: &mut S,
        lanes: &mut impl Lanes,
    ) {
        let Some(v) = self.viewers.get_mut(&conn) else {
            return;
        };
        let (stats, observer) = (&mut self.stats, &mut self.observer);
        let mut note =
            |bytes: usize, ok: bool| note(stats, observer, conn, FrameKind::Layer, bytes, ok);
        let sent = self
            .layers
            .send(conn, &mut v.layers, &*src, lanes, &mut note);
        self.stats.layer_frames += sent;
    }

    /// Builds `pos` into the cache, and marks it stale (or to send again
    /// in the bulk lane, after a background change) for holders of an
    /// older encoding.
    fn build<S: SectionSource + ?Sized>(&mut self, src: &mut S, pos: SectionPos) -> Built {
        self.changed.remove(&pos);
        let background = self.bulk.remove(&pos);
        let mut buf = std::mem::take(&mut self.buf);
        let start = Instant::now();
        src.build(pos, &mut buf);
        let took = nanos(start.elapsed());
        self.stats.build_nanos += took;
        if let Some(o) = &mut self.observer {
            o.event(&StreamEvent::Built { pos, nanos: took });
        }
        let built = self.cache.put(pos, buf.clone());
        self.buf = buf;
        self.stats.builds += 1;
        for v in self.viewers.values_mut() {
            if v.held.get(&pos).is_some_and(|h| h.stamp != built.stamp) {
                if background && !v.stale.contains(&pos) {
                    v.resend.insert(pos);
                } else {
                    v.resend.remove(&pos);
                    v.stale.insert(pos);
                }
            }
        }
        built
    }

    /// `pos`'s current encoding, built if it changed or isn't cached.
    fn current<S: SectionSource + ?Sized>(&mut self, src: &mut S, pos: SectionPos) -> Built {
        if !self.changed.contains(&pos)
            && let Some(b) = self.cache.get(pos)
        {
            return b;
        }
        self.build(src, pos)
    }

    fn rebuild_changed<S: SectionSource + ?Sized>(&mut self, src: &mut S) {
        let mut budget = self.config.rebuild_budget.max(1);
        let until = self.config.rebuild_time.map(|t| Instant::now() + t);
        let mut built = 0;
        let changed: Vec<SectionPos> = self.changed.iter().copied().collect();
        for pos in changed {
            if !self.viewers.values().any(|v| v.held.contains_key(&pos)) {
                // Nobody holds it: built again when someone wants it.
                self.changed.remove(&pos);
                self.bulk.remove(&pos);
                self.cache.remove(pos);
                continue;
            }
            if budget == 0 || (built > 0 && until.is_some_and(|u| Instant::now() >= u)) {
                break;
            }
            budget -= 1;
            built += 1;
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
    /// decode and it is smaller than the whole section; worked out once a
    /// flush for every holder of `from`.
    fn edit_frame<S: SectionSource + ?Sized>(
        &mut self,
        src: &mut S,
        pos: SectionPos,
        from: u64,
        to: &Built,
    ) -> Option<Vec<u8>> {
        let key = (pos, from, to.stamp);
        if let Some(frame) = self.edits.get(&key) {
            return frame.clone();
        }
        let frame = self.make_edit(src, pos, from, to);
        self.edits.insert(key, frame.clone());
        frame
    }

    fn make_edit<S: SectionSource + ?Sized>(
        &mut self,
        src: &mut S,
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
        src: &mut S,
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
                    self.send_bulk(conn, lanes, FrameKind::Folded, frame, ticket.clone()),
                    Some(ticket),
                )
            } else if let Some(frame) = self.edit_frame(src, pos, from, &built) {
                self.stats.edits += 1;
                (self.send(conn, lanes, FrameKind::Edit, frame), None)
            } else {
                let frame = self.section_frame(pos, &built);
                self.stats.sections += 1;
                (self.send(conn, lanes, FrameKind::Changed, frame), None)
            };
            if sent {
                let Some(v) = self.viewers.get_mut(&conn) else {
                    return;
                };
                v.stale.remove(&pos);
                v.resend.remove(&pos);
                v.held.insert(
                    pos,
                    Held {
                        stamp: built.stamp,
                        ticket,
                        replaces,
                    },
                );
                if queued {
                    self.requeue_layers(conn, pos, src);
                }
            } else if queued {
                // Its frame is gone and the lane refused the new one: the
                // load loop sends it again.
                self.release(conn, pos, src);
                let Some(v) = self.viewers.get_mut(&conn) else {
                    return;
                };
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
        if self.config.unload_boxes
            && let Some(area) = v.area
            && v.unloads.len() >= MIN_BOXED
        {
            // Nothing is held past the area grown by the hysteresis (what
            // left it was taken out of `held`), and nothing is sent there.
            let keep = area.bounds(i64::from(self.config.hysteresis));
            for b in Bounds::unload_boxes(&v.unloads, &keep) {
                let Some((min, max)) = b.corners() else {
                    continue;
                };
                debug_assert!(
                    !v.held.keys().any(|p| p.within(&min, &max)),
                    "an UnloadBox {min:?}..{max:?} over a held section"
                );
                let frame = (self.encode)(&StreamMsg::UnloadBox { min, max });
                let n = frame.len();
                let ok = lanes.send(conn, frame);
                note(
                    &mut self.stats,
                    &mut self.observer,
                    conn,
                    FrameKind::UnloadBox,
                    n,
                    ok,
                );
                if !ok {
                    return;
                }
                let before = v.unloads.len();
                v.unloads.retain(|p| !p.within(&min, &max));
                self.stats.unloads += (before - v.unloads.len()) as u64;
                self.stats.unload_boxes += 1;
            }
        }
        while !v.unloads.is_empty() {
            let positions: Vec<SectionPos> =
                v.unloads.iter().take(MAX_UNLOAD_BATCH).copied().collect();
            let n = positions.len();
            let frame = (self.encode)(&StreamMsg::Unload { positions });
            let bytes = frame.len();
            let ok = lanes.send(conn, frame);
            note(
                &mut self.stats,
                &mut self.observer,
                conn,
                FrameKind::Unload,
                bytes,
                ok,
            );
            if !ok {
                return;
            }
            for _ in 0..n {
                v.unloads.pop_first();
            }
            self.stats.unloads += n as u64;
        }
    }

    /// Sends missing sections nearest first, round robin from the
    /// connection after the one served last, within the budget and each
    /// bulk lane's high water.
    fn load<S: SectionSource + ?Sized>(
        &mut self,
        conns: &[ConnId],
        src: &mut S,
        lanes: &mut impl Lanes,
        budget: &mut Budget<'_>,
    ) {
        let start = self
            .last_served
            .map_or(0, |l| conns.partition_point(|c| *c <= l));
        for &conn in conns[start..].iter().chain(&conns[..start]) {
            if budget.left == 0 {
                break;
            }
            if self.load_one(conn, src, lanes, budget) {
                self.last_served = Some(conn);
            }
        }
    }

    /// Queues again whole, in the bulk lane, the held sections a
    /// background change left behind; false if the lane is full.
    fn send_resends<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        src: &mut S,
        lanes: &mut impl Lanes,
    ) -> bool {
        loop {
            let Some(pos) = self
                .viewers
                .get(&conn)
                .and_then(|v| v.resend.first().copied())
            else {
                return true;
            };
            if lanes.bulk_queued(conn) >= lanes.bulk_high_water(conn) {
                return false;
            }
            let built = self.current(src, pos);
            let Some(v) = self.viewers.get_mut(&conn) else {
                return true;
            };
            v.resend.remove(&pos);
            let Some(h) = v.held.get(&pos) else {
                continue;
            };
            if h.stamp == built.stamp || v.stale.contains(&pos) {
                continue;
            }
            // A frame still queued is replaced; one written left a copy.
            let holds = !h.withdraw();
            let ticket = BulkTicket::new();
            let frame = self.section_frame(pos, &built);
            if self.send_bulk(conn, lanes, FrameKind::Resend, frame, ticket.clone()) {
                self.stats.bulk_resends += 1;
                if let Some(v) = self.viewers.get_mut(&conn) {
                    v.held.insert(
                        pos,
                        Held {
                            stamp: built.stamp,
                            ticket: Some(ticket),
                            replaces: holds,
                        },
                    );
                }
                if !holds {
                    self.requeue_layers(conn, pos, src);
                    self.send_layers(conn, src, lanes);
                }
            } else {
                // Its earlier frame may be gone: load it again.
                self.release(conn, pos, src);
                if let Some(v) = self.viewers.get_mut(&conn) {
                    if holds {
                        v.unloads.insert(pos);
                    }
                    v.cursor = 0;
                }
                return false;
            }
        }
    }

    /// Loads for one connection; true if it was served at all.
    fn load_one<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        src: &mut S,
        lanes: &mut impl Lanes,
        budget: &mut Budget<'_>,
    ) -> bool {
        if !self.send_resends(conn, src, lanes) {
            return false;
        }
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
                self.stats.claims_dropped += v.finish_claims();
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
            if let Some(&group) = v.grouped.get(&pos) {
                // A group is looked at whole, when its first section is
                // reached; its sections are then held, or claimed.
                if budget.out() {
                    return served;
                }
                budget.spend();
                served = true;
                self.resolve_group(conn, group, src);
                if let Some(v) = self.viewers.get_mut(&conn) {
                    v.grouped.remove(&pos); // (looked at, whatever came of it)
                }
                continue;
            }
            if !src.exists(pos) {
                if v.claims.remove(&pos).is_some() {
                    v.unloads.insert(pos);
                }
                v.cursor += 1;
                continue;
            }
            let cached = !self.changed.contains(&pos) && self.cache.get(pos).is_some();
            if !cached && budget.out() {
                return served;
            }
            let built = self.current(src, pos);
            if cached {
                self.stats.cache_hits += 1;
            } else {
                budget.spend();
            }
            served = true;
            let Some(v) = self.viewers.get_mut(&conn) else {
                return served;
            };
            let claim = v.claims.remove(&pos);
            if !self.place(conn, pos, &built, claim, src, lanes) {
                return served;
            }
            if let Some(v) = self.viewers.get_mut(&conn) {
                v.cursor += 1;
            }
        }
    }

    /// Gives `conn` section `pos` as `built`: kept if it claims it with the
    /// same stamp, else queued whole in the bulk lane (replacing what it
    /// claimed, or a copy an unload not yet sent would drop). False if the
    /// lane refused it (the claim is put back).
    fn place<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        pos: SectionPos,
        built: &Built,
        claim: Option<u64>,
        src: &mut S,
        lanes: &mut impl Lanes,
    ) -> bool {
        let Some(v) = self.viewers.get_mut(&conn) else {
            return false;
        };
        let kept = claim == Some(built.stamp);
        if claim.is_some()
            && let Some(o) = &mut self.observer
        {
            o.event(&StreamEvent::Claimed { conn, pos, kept });
        }
        if kept {
            self.stats.resumed += 1;
            let held = Held {
                stamp: built.stamp,
                ticket: None,
                replaces: false,
            };
            self.hold(conn, pos, held, src);
            self.send_layers(conn, src, lanes);
            return true;
        }
        let replaces = claim.is_some() || v.unloads.remove(&pos);
        let ticket = BulkTicket::new();
        let frame = self.section_frame(pos, built);
        if !self.send_bulk(conn, lanes, FrameKind::Section, frame, ticket.clone()) {
            if let Some(v) = self.viewers.get_mut(&conn) {
                if let Some(stamp) = claim {
                    v.claims.insert(pos, stamp);
                } else if replaces {
                    v.unloads.insert(pos);
                }
            }
            return false;
        }
        self.stats.sections += 1;
        let held = Held {
            stamp: built.stamp,
            ticket: Some(ticket),
            replaces,
        };
        self.hold(conn, pos, held, src);
        self.send_layers(conn, src, lanes);
        true
    }

    /// Looks at `conn`'s group `i` whole: builds its sections, and if their
    /// digest matches holds them all (nothing sent); else claims each with
    /// an unknown stamp, to be sent again whole. Each layer digest that
    /// matches claims the states it covers. Returns the sections claimed.
    fn resolve_group<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        i: usize,
        src: &mut S,
    ) -> Vec<SectionPos> {
        let Some(v) = self.viewers.get_mut(&conn) else {
            return Vec::new();
        };
        let Some(g) = v.groups.get_mut(i).and_then(Option::take) else {
            return Vec::new();
        };
        let members: Vec<(SectionPos, i32)> = g
            .members()
            .filter(|(p, _)| v.grouped.get(p) == Some(&i))
            .collect();
        for (p, _) in &members {
            v.grouped.remove(p);
        }
        // Its sections, as they are now (`None`: outside the world).
        let mut now = Vec::with_capacity(members.len());
        for &(p, at) in &members {
            let built = if src.exists(p) {
                if !self.changed.contains(&p) && self.cache.get(p).is_some() {
                    self.stats.cache_hits += 1;
                }
                Some(self.current(src, p))
            } else {
                None
            };
            now.push((p, at, built));
        }
        let kept = now.iter().all(|(_, _, b)| b.is_some())
            && GroupClaim::digest_of(
                now.iter()
                    .map(|(_, at, b)| (*at, b.as_ref().map_or(0, |b| b.stamp))),
            ) == g.digest;
        // Layers, each on its own digest.
        self.layers.resize(src.layers());
        for (layer, digest) in g.layers.iter().enumerate().take(src.layers()) {
            let Some(digest) = digest else {
                continue;
            };
            let mut seen = Vec::new();
            let mut pairs = Vec::new();
            for &(p, at) in &members {
                let key = src.layer_key(layer, p);
                if seen.contains(&key) {
                    continue;
                }
                seen.push(key);
                pairs.push((at, key, self.layers.stamp(&*src, layer, key)));
            }
            if GroupClaim::layer_digest(pairs.iter().map(|(at, _, s)| (*at, *s))) == Some(*digest)
                && let Some(v) = self.viewers.get_mut(&conn)
            {
                for (_, key, stamp) in pairs {
                    v.layers.claim(layer, key, stamp);
                }
            }
        }
        if let Some(o) = &mut self.observer {
            o.event(&StreamEvent::Group {
                conn,
                start: g.start,
                kept,
            });
        }
        let mut claimed = Vec::new();
        if kept {
            self.stats.groups_held += 1;
            for (p, _, b) in now {
                let Some(b) = b else { continue };
                self.stats.resumed += 1;
                let held = Held {
                    stamp: b.stamp,
                    ticket: None,
                    replaces: false,
                };
                self.hold(conn, p, held, src);
            }
        } else {
            self.stats.groups_different += 1;
            let Some(v) = self.viewers.get_mut(&conn) else {
                return claimed;
            };
            for (p, _, b) in now {
                if v.held.contains_key(&p) {
                    continue;
                }
                if b.is_some() {
                    v.claims.entry(p).or_insert(0);
                    claimed.push(p);
                } else {
                    v.unloads.insert(p);
                }
            }
        }
        claimed
    }

    /// Queues a frame on `conn`'s priority lane, counted.
    fn send(
        &mut self,
        conn: ConnId,
        lanes: &mut impl Lanes,
        kind: FrameKind,
        frame: Vec<u8>,
    ) -> bool {
        let bytes = frame.len();
        let ok = lanes.send(conn, frame);
        note(&mut self.stats, &mut self.observer, conn, kind, bytes, ok);
        ok
    }

    /// Queues a frame in `conn`'s bulk lane under `ticket`, counted.
    fn send_bulk(
        &mut self,
        conn: ConnId,
        lanes: &mut impl Lanes,
        kind: FrameKind,
        frame: Vec<u8>,
        ticket: BulkTicket,
    ) -> bool {
        let bytes = frame.len();
        let ok = lanes.send_bulk(conn, frame, Some(ticket));
        note(&mut self.stats, &mut self.observer, conn, kind, bytes, ok);
        ok
    }

    /// Sets the observer told each [`StreamEvent`] (replacing any), or
    /// none. Without one, nothing is made to tell it.
    pub fn set_observer(&mut self, observer: Option<Box<dyn StreamObserver>>) {
        self.observer = observer;
    }
}

/// Counts a frame queued (or refused), and tells the observer.
fn note(
    stats: &mut StreamStats,
    observer: &mut Option<Box<dyn StreamObserver>>,
    conn: ConnId,
    kind: FrameKind,
    bytes: usize,
    ok: bool,
) {
    if !ok {
        stats.refused += 1;
        return;
    }
    stats.bytes += bytes as u64;
    if let Some(o) = observer {
        o.event(&StreamEvent::Queued { conn, kind, bytes });
    }
}

/// A duration in nanoseconds, saturating.
fn nanos(d: Duration) -> u64 {
    u64::try_from(d.as_nanos()).unwrap_or(u64::MAX)
}
