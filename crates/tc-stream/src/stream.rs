//! [`SectionStream`]: every connection's interest, what each holds, and
//! the flush that sends what changed, what left and what is missing. See
//! the [crate docs](crate).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::time::{Duration, Instant};

use tc_net::{BulkTicket, ConnId, Protocol, ServerMsg};
use tc_wire::{Bytes, Wire};

use crate::area::{Bounds, MIN_BOXED, Offsets};
use crate::cache::{Built, Cache};
use crate::hash::{PosMap, PosSet};
use crate::lanes::Lanes;
use crate::msg::{Area, Claim, GroupClaim, SectionPos, Stamp, StreamInterest, StreamMsg};

mod layers;

use layers::{LayerHeld, Layers, Pick};

use crate::held::{Held, HeldMap};

/// The most positions one `Unload` carries.
pub const MAX_UNLOAD_BATCH: usize = 512;

/// What the stream is about to load for: given to
/// [`SectionSource::begin`], so a source sizes its own caches (meshes
/// half-built, generated land waiting for its neighbours) to the views.
/// It counts the connections [`SectionStream::loading_for`] (a view still
/// scanned, its sections still in flight, or moved since the stream last
/// had nothing loading); [`SectionStream::last_loading`] is the last one
/// given, [`SectionStream::loading_now`] the one the next pass would give.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Loading {
    /// Connections loading.
    pub views: usize,
    /// Of `views`, the ones whose area is still being scanned for
    /// sections they don't hold (what [`SectionStream::loading`] asks).
    pub scanning: usize,
    /// The sum of their areas' longest sides, in sections (`2r + 1`).
    pub sides: u64,
    /// The longest side of any of them.
    pub widest: u32,
    /// Of `views`, the different areas (connections sharing one view, as
    /// players standing together do, count once).
    pub areas: usize,
    /// The sum of those different areas' longest sides: what a cache of
    /// the land being loaded is sized by.
    pub area_sides: u64,
}

/// Where one connection's load stands
/// ([`SectionStream::view_loading`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ViewLoading {
    /// Its area, once set.
    pub area: Option<Area>,
    /// Its area is still scanned for sections it doesn't hold.
    pub scanning: bool,
    /// Sections queued for it in the bulk lane, not yet written (a load or
    /// a resend).
    pub in_flight: usize,
    /// Its area changed since the stream last had nothing loading.
    pub moved: bool,
}

/// What a client holds of a layer's state, for
/// [`SectionSource::layer_frame`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerFrom<'a> {
    /// Nothing: the frame is the whole state. Never asked with an empty
    /// state (nothing to nothing needs no frame).
    Nothing,
    /// Some state not known here (one it claimed that didn't match, or
    /// kept from an earlier copy of its section): the frame is the whole
    /// state and must replace (or, for an empty one, clear) what it holds.
    Unknown,
    /// This earlier state: the frame may be a change from it.
    State(&'a [u8]),
}

/// Where a layer's whole frame goes in the bulk lane, next to the section
/// that brings its key ([`SectionSource::layer_order`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum LayerOrder {
    /// Behind the section (the default): data on the section, that the
    /// client puts on what it holds.
    #[default]
    After,
    /// Before it: data the section's render depends on (a column's
    /// climate tinting its grass), so it never draws without it. Its
    /// changes go before a flush's section changes too.
    Before,
}

/// When a section's change goes as an `Edit` rather than whole
/// ([`StreamConfig::edit_rule`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum EditRule {
    /// While its changed cells, at 4 bytes each, are fewer than the
    /// section's encoded bytes (the default): cheap, decided as the cells
    /// are compared.
    #[default]
    Cells,
    /// While the encoded `Edit` frame is shorter than the encoded whole
    /// `Section` frame: exact, at the cost of encoding both.
    Frame,
}

/// What a build found changed besides its own section: neighbours whose
/// encoding depends on it, layer states it worked out
/// ([`SectionSource::take_marks`]). Each is told the stream as the method
/// of the same name on [`SectionStream`] would.
#[derive(Clone, Debug, Default)]
pub struct Marks {
    sections: Vec<(SectionPos, Mark)>,
    layers: Vec<(usize, SectionPos)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mark {
    Changed,
    Bulk,
    Derived,
}

impl Marks {
    /// See [`SectionStream::changed`].
    pub fn changed(&mut self, pos: SectionPos) {
        self.sections.push((pos, Mark::Changed));
    }

    /// See [`SectionStream::changed_bulk`].
    pub fn changed_bulk(&mut self, pos: SectionPos) {
        self.sections.push((pos, Mark::Bulk));
    }

    /// See [`SectionStream::changed_derived`].
    pub fn changed_derived(&mut self, pos: SectionPos) {
        self.sections.push((pos, Mark::Derived));
    }

    /// See [`SectionStream::layer_changed`].
    pub fn layer_changed(&mut self, layer: usize, key: SectionPos) {
        self.layers.push((layer, key));
    }

    /// True if nothing is marked.
    pub fn is_empty(&self) -> bool {
        self.sections.is_empty() && self.layers.is_empty()
    }
}

/// What [`SectionSource::unheld`] says of a changed section no
/// connection holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum Unheld {
    /// Drop the change (the default): the section is built again when
    /// someone wants it, and its cached encoding is let go.
    #[default]
    Forget,
    /// Build it now, as a held section's change is (within the rebuild
    /// budget; left for the next flush past it): its build's
    /// [`take_marks`](SectionSource::take_marks) reach the held sections
    /// around it, and the encoding is cached for whoever loads it next.
    Build,
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

    /// Called right after each [`build`](Self::build): adds to `marks`
    /// what that build found changed besides its section (a neighbour's
    /// faces, a layer state worked out with it). A section marked while
    /// changed sections are rebuilt (a flush, a
    /// [`flush_conn`](SectionStream::flush_conn)) is rebuilt in the same
    /// pass, within its budget (never twice a pass); one marked by a load
    /// waits for the next flush. A layer marked is read again at once.
    /// Nothing by default.
    fn take_marks(&mut self, _marks: &mut Marks) {}

    /// A section marked changed that no connection holds, as a flush
    /// rebuilds changes: build it ([`Unheld::Build`]) or drop the change
    /// ([`Unheld::Forget`], the default). Without a build its
    /// [`take_marks`](Self::take_marks) never runs, so a source whose
    /// sections depend on their neighbours (faces hidden by the one next
    /// door) marks what it must here, into `marks` (applied as
    /// `take_marks`' are, rebuilt in the same pass); or answers `Build`
    /// to have its build do it. `near`: the section is within the
    /// hysteresis and one of some connection's area (what is likely loaded
    /// soon, or held next door); a section far from every area can
    /// usually be forgotten.
    fn unheld(&mut self, _pos: SectionPos, _near: bool, _marks: &mut Marks) -> Unheld {
        Unheld::Forget
    }

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
    /// what it holds ([`LayerFrom`]) to `to`, into `out` (cleared first).
    /// Left empty, nothing is sent. The frame is the game's own message,
    /// encoded. Asked once a pass for each change, whatever the holders.
    fn layer_frame(
        &self,
        _layer: usize,
        _key: SectionPos,
        _from: LayerFrom<'_>,
        _to: &[u8],
        out: &mut Vec<u8>,
    ) {
        out.clear();
    }

    /// Where layer `layer`'s whole frame goes next to the section that
    /// brings its key: [`LayerOrder::After`] by default. Read at each pass;
    /// keep it fixed.
    fn layer_order(&self, _layer: usize) -> LayerOrder {
        LayerOrder::After
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
    /// Time a flush's load spends, besides `build_budget` (whichever runs
    /// out first): sections built and sections sent from the cache alike.
    /// At least one section is sent (or kept). `None` (the default):
    /// counted only.
    pub load_time: Option<Duration>,
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
    /// When a change goes as an `Edit` rather than whole.
    pub edit_rule: EditRule,
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
            load_time: None,
            rebuild_time: None,
            unload_boxes: false,
            idle: IdleBudget::default(),
            edit_rule: EditRule::Cells,
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
    /// Claims never looked at (past the area's size, overlapping, outside
    /// the area, or left when a load finished), sections (each of a group)
    /// and layers.
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
    /// Queued frames withdrawn before they were written (a section that
    /// left, a change folded in, a connection closed), sections and layers.
    pub withdrawn: u64,
    /// Their bytes.
    pub withdrawn_bytes: u64,
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
    #[non_exhaustive]
    Queued {
        /// The connection.
        conn: ConnId,
        /// What it carries.
        kind: FrameKind,
        /// Its length.
        bytes: usize,
        /// The section it carries, or the layer key (`None` for unloads).
        pos: Option<SectionPos>,
        /// The layer, for a layer frame.
        layer: Option<usize>,
    },
    /// A frame queued for `conn` was withdrawn before it was written.
    #[non_exhaustive]
    Withdrawn {
        /// The connection.
        conn: ConnId,
        /// The section it carried, or the layer key.
        pos: SectionPos,
        /// The layer, for a layer frame.
        layer: Option<usize>,
        /// Its length.
        bytes: usize,
    },
    /// A section was built, taking `nanos`.
    #[non_exhaustive]
    Built {
        /// The section.
        pos: SectionPos,
        /// The time it took.
        nanos: u64,
    },
    /// A claim was checked: `kept` if it matched.
    #[non_exhaustive]
    Claimed {
        /// The connection.
        conn: ConnId,
        /// The section.
        pos: SectionPos,
        /// It matched: not sent again.
        kept: bool,
    },
    /// A group claim was checked: `kept` if it matched.
    #[non_exhaustive]
    Group {
        /// The connection.
        conn: ConnId,
        /// Its first section.
        start: SectionPos,
        /// It matched: none of its sections sent again.
        kept: bool,
    },
    /// A group claim's digest of layer `layer` was checked: `kept` if it
    /// matched (its states are claimed, kept as their sections are held).
    #[non_exhaustive]
    LayerGroup {
        /// The connection.
        conn: ConnId,
        /// The group's first section.
        start: SectionPos,
        /// The layer.
        layer: usize,
        /// It matched.
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

#[derive(Default)]
struct Viewer {
    area: Option<Area>,
    /// Its area changed since the stream last had nothing loading: it
    /// counts as loading ([`SectionStream::loading_for`]) while any view
    /// does, as a moving view moves again soon.
    moved: bool,
    held: HeldMap,
    /// The next offset to look at, and where the area's offsets end.
    cursor: usize,
    end: usize,
    /// Positions to unload, with the stamp the client holds there (0:
    /// unknown): one back in the area before its unload is sent is
    /// claimed again instead.
    unloads: BTreeMap<SectionPos, u64>,
    /// Claims put back from `unloads`: the client may hold their layer
    /// states, unknown, if it keeps them.
    restored: PosSet<SectionPos>,
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
    /// Returns the sections unloaded (claims dropped).
    fn split_group(&mut self, i: usize, area: &Area) -> u64 {
        let Some(g) = self.groups.get_mut(i).and_then(Option::take) else {
            return 0;
        };
        let mut dropped = 0;
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
                self.unloads.insert(p, 0);
                dropped += 1;
            }
        }
        dropped
    }

    /// The load reached its end: whatever is still claimed was never
    /// looked at, so is unloaded. Returns the claims dropped.
    fn finish_claims(&mut self) -> u64 {
        let mut dropped = 0;
        for (p, stamp) in std::mem::take(&mut self.claims) {
            dropped += 1;
            if !self.held.contains_key(&p) {
                self.unloads.insert(p, stamp);
            }
        }
        for (p, _) in std::mem::take(&mut self.grouped) {
            dropped += 1;
            if !self.held.contains_key(&p) {
                self.unloads.insert(p, 0);
            }
        }
        self.groups = Vec::new();
        self.restored = PosSet::default();
        dropped + self.layers.drop_claims() as u64
    }

    /// Still loading: its area scanned for sections it doesn't hold, or
    /// sections (or their layers' whole frames) queued and not yet written.
    fn active(&self) -> bool {
        self.cursor < self.end || self.held.any_in_flight() || self.layers.in_flight()
    }

    fn busy(&self) -> bool {
        !self.stale.is_empty()
            || !self.resend.is_empty()
            || !self.unloads.is_empty()
            || !self.released.is_empty()
            || self.layers.busy()
            || self.cursor < self.end
    }

    /// Bytes its tables take, roughly (by capacity).
    fn bytes(&self) -> usize {
        let pos = size_of::<SectionPos>();
        // A B-tree entry, with its share of the node.
        let tree = |n: usize, entry: usize| n * (entry + entry / 2 + 8);
        self.held.bytes()
            + self.claims.capacity() * (size_of::<(SectionPos, u64)>() + 1)
            + self.grouped.capacity() * (size_of::<(SectionPos, usize)>() + 1)
            + self.restored.capacity() * (pos + 1)
            + self.groups.capacity() * size_of::<Option<GroupClaim>>()
            + self
                .groups
                .iter()
                .flatten()
                .map(|g| g.layers.capacity() * size_of::<Option<Stamp>>())
                .sum::<usize>()
            + tree(self.unloads.len(), pos + 8)
            + tree(
                self.stale.len() + self.resend.len() + self.released.len(),
                pos,
            )
            + self.layers.bytes()
    }
}

/// Where a load stops: a count of builds, a time, or the caller.
struct Budget<'a> {
    /// Builds left.
    left: usize,
    until: Option<Instant>,
    interrupted: &'a mut dyn FnMut() -> bool,
    /// Send one section whatever the time and the caller (a flush, or an
    /// idle call, always makes progress).
    one: bool,
    built: usize,
    /// Sections sent or kept, built or from the cache.
    placed: usize,
}

impl Budget<'_> {
    /// True if no more may be sent (`build`: built first).
    fn out(&mut self, build: bool) -> bool {
        if build && self.left == 0 {
            return true;
        }
        if self.one && self.placed == 0 {
            return false;
        }
        self.until.is_some_and(|u| Instant::now() >= u) || (self.interrupted)()
    }

    /// One section sent (or kept); `build`: built for it.
    fn spend(&mut self, build: bool) {
        self.placed += 1;
        if build {
            self.left = self.left.saturating_sub(1);
            self.built += 1;
        }
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
    /// Of `changed`, the ones changed only as a consequence of another
    /// change ([`changed_derived`](SectionStream::changed_derived)).
    derived: PosSet<SectionPos>,
    /// What the last pass gave [`SectionSource::begin`].
    last_loading: Loading,
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
    /// What builds marked ([`SectionSource::take_marks`]), and the
    /// sections they marked changed this pass, for a rebuild to take.
    marks: Marks,
    marked: Vec<SectionPos>,
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
            derived: PosSet::default(),
            last_loading: Loading::default(),
            last_served: None,
            encode: Box::new(encode),
            stats: StreamStats::default(),
            buf: Vec::new(),
            cells: (Vec::new(), Vec::new()),
            edits: PosMap::default(),
            layers: Layers::default(),
            marks: Marks::default(),
            marked: Vec::new(),
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
            for (p, h) in v.held.drain() {
                if let Some(b) = h.take_back() {
                    withdrew(&mut self.stats, &mut self.observer, conn, p, None, b);
                }
            }
            self.layers.drop_viewer(&mut v.layers);
            self.layer_withdrawals(conn);
        }
    }

    /// Sets a connection's area, with what it holds when it resumes.
    /// Sections it holds that are now past the area (with hysteresis) are
    /// unloaded; claims outside the area are unloaded too, never checked
    /// (counted in [`StreamStats::claims_dropped`]). A section back in the
    /// area before its unload was sent is claimed again with what the
    /// client holds there, so it is kept if unchanged. The unloads go at
    /// the next flush, or at once with [`send_unloads`](Self::send_unloads).
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
            leaving.extend(v.held.keys().filter(|p| !area.contains(*p, h)));
        }
        for p in leaving {
            v.stale.remove(&p);
            v.resend.remove(&p);
            if let Some(held) = v.held.remove(&p) {
                v.released.insert(p);
                match held.take_back() {
                    // Never written: it holds what it held before, if any.
                    Some(b) => {
                        withdrew(&mut self.stats, &mut self.observer, conn, p, None, b);
                        if held.replaces {
                            v.unloads.insert(p, 0);
                        }
                    }
                    None => {
                        v.unloads.insert(p, held.stamp);
                    }
                }
            }
        }
        let stats = &mut self.stats;
        // Unloads not yet sent of sections back in the area: claimed again.
        let back: Vec<(SectionPos, u64)> = v
            .unloads
            .iter()
            .filter(|(p, _)| area.contains(**p, 0))
            .map(|(p, s)| (*p, *s))
            .collect();
        for (p, stamp) in back {
            v.unloads.remove(&p);
            v.claims.insert(p, stamp);
            v.restored.insert(p);
        }
        // Groups still waiting with a section now outside are taken apart.
        for i in 0..v.groups.len() {
            if v.groups[i]
                .as_ref()
                .is_some_and(|g| g.members().any(|(p, _)| !area.contains(p, 0)))
            {
                stats.claims_dropped += v.split_group(i, &area);
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
                v.unloads.insert(c.pos, c.stamp.get());
                stats.claims_dropped += 1;
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
                stats.claims_dropped += v.split_group(i, &area);
                v.groups.pop();
            } else {
                for p in &members {
                    v.unloads.remove(p);
                }
            }
        }
        v.claims.retain(|p, stamp| {
            let keep = area.contains(*p, 0);
            if !keep {
                v.unloads.insert(*p, *stamp);
                v.restored.remove(p);
                stats.claims_dropped += 1;
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
        if v.area != Some(area) {
            v.moved = true;
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
        self.start_pass(src);
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
                v.unloads.insert(pos, claim);
                v.restored.remove(&pos);
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

    /// True if `conn` holds the section at `pos` (or will once its queued
    /// frame is written).
    pub fn holds(&self, conn: ConnId, pos: SectionPos) -> bool {
        self.viewers
            .get(&conn)
            .is_some_and(|v| v.held.contains_key(&pos))
    }

    /// Connections holding the section at `pos` (or that will once their
    /// queued frames are written): 0 if no one would see a change to it.
    pub fn holders(&self, pos: SectionPos) -> usize {
        self.viewers
            .values()
            .filter(|v| v.held.contains_key(&pos))
            .count()
    }

    /// Sections marked changed and not yet rebuilt.
    pub fn changes_pending(&self) -> usize {
        self.changed.len()
    }

    /// True if a connection is loading: its area is still scanned for
    /// sections it doesn't hold, or sections it was sent are still queued
    /// (not yet written), or its area moved since the stream last had
    /// nothing loading and some view still loads (a moving view moves
    /// again soon: what a source reads ahead for it stays wanted). See
    /// [`view_loading`](Self::view_loading) for the parts.
    ///
    /// For sizing what a source reads ahead, not for holding a
    /// connection's writes back: it stays true while its sections wait
    /// unwritten, so a session that lingers over its bulk frames while it
    /// holds waits on frames only its writing ends. Use
    /// [`more_coming`](Self::more_coming) for that.
    pub fn loading_for(&self, conn: ConnId) -> bool {
        self.viewers
            .get(&conn)
            .is_some_and(|v| v.active() || (v.moved && self.any_active()))
    }

    /// True if more sections are coming for a connection soon: its area is
    /// still scanned, or it moved while some view still is (a moving view
    /// moves again soon). What a host lingers on before waking a session
    /// to write its bulk frames (a tc-net `wake_lingering`): unlike
    /// [`loading_for`](Self::loading_for) it doesn't count the sections
    /// already queued, which wait on that write.
    pub fn more_coming(&self, conn: ConnId) -> bool {
        self.viewers
            .get(&conn)
            .is_some_and(|v| v.cursor < v.end || (v.moved && self.loading()))
    }

    /// Some connection is scanning or has sections in flight.
    fn any_active(&self) -> bool {
        self.viewers.values().any(Viewer::active)
    }

    /// Where a connection's load stands, for a host to make its own rule
    /// of: `None` for a connection not connected.
    pub fn view_loading(&self, conn: ConnId) -> Option<ViewLoading> {
        let v = self.viewers.get(&conn)?;
        Some(ViewLoading {
            area: v.area,
            scanning: v.cursor < v.end,
            in_flight: v.held.in_flight(),
            moved: v.moved,
        })
    }

    /// What the last pass (a flush, a load, a claims check) gave
    /// [`SectionSource::begin`].
    pub fn last_loading(&self) -> Loading {
        self.last_loading
    }

    /// What the next pass would give [`SectionSource::begin`], as things
    /// stand (a host sizing its caches right after
    /// [`set_interest`](Self::set_interest)).
    pub fn loading_now(&self) -> Loading {
        let wave = self.any_active();
        let mut loading = Loading::default();
        let mut areas = Vec::new();
        for v in self.viewers.values() {
            let Some(a) = v.area else {
                continue;
            };
            let scanning = v.cursor < v.end;
            if !(scanning || v.active() || (v.moved && wave)) {
                continue;
            }
            let side = 2 * u32::from(a.rx.max(a.ry).max(a.rz)) + 1;
            loading.views += 1;
            loading.scanning += usize::from(scanning);
            loading.sides += u64::from(side);
            loading.widest = loading.widest.max(side);
            areas.push((a.center, [a.rx, a.ry, a.rz], side));
        }
        areas.sort_unstable();
        areas.dedup();
        loading.areas = areas.len();
        loading.area_sides = areas.iter().map(|a| u64::from(a.2)).sum();
        loading
    }

    /// Positions a connection has to unload, not yet sent.
    pub fn unloads_pending(&self, conn: ConnId) -> usize {
        self.viewers.get(&conn).map_or(0, |v| v.unloads.len())
    }

    /// The bytes the stream keeps for a connection (what it holds, claims,
    /// changes and unloads waiting, its layer keys), roughly: its tables by
    /// capacity. The section cache ([`StreamStats::cache_bytes`]) and the
    /// layer states ([`layer_bytes`](Self::layer_bytes)) are shared, not
    /// counted.
    pub fn held_bytes(&self, conn: ConnId) -> usize {
        self.viewers.get(&conn).map_or(0, Viewer::bytes)
    }

    /// The bytes of the layer states held, shared by every connection,
    /// roughly.
    pub fn layer_bytes(&self) -> usize {
        self.layers.bytes()
    }

    /// The section at `pos` changed: holders get the change on a later
    /// flush (an `Edit` or the whole section, on the priority lane), and
    /// its cached encoding is rebuilt.
    pub fn changed(&mut self, pos: SectionPos) {
        self.changed.insert(pos);
        self.bulk.remove(&pos);
        self.derived.remove(&pos);
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

    /// The section at `pos` changed as a consequence of another change (a
    /// neighbour's edit changed its faces): as [`changed`](Self::changed),
    /// but joining a change already marked rather than overriding it, so
    /// a section marked [`changed_bulk`](Self::changed_bulk) stays in the
    /// bulk lane; and a holder whose bulk resend of it is still to be
    /// queued gets the new encoding in that resend, not on the priority
    /// lane.
    pub fn changed_derived(&mut self, pos: SectionPos) {
        if self.changed.insert(pos) {
            self.derived.insert(pos);
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
        self.derived.clear();
        for (&conn, v) in &mut self.viewers {
            self.layers.forget_viewer(&mut v.layers);
            for (p, h) in v.held.drain() {
                let stamp = if let Some(b) = h.take_back() {
                    withdrew(&mut self.stats, &mut self.observer, conn, p, None, b);
                    if !h.replaces {
                        continue;
                    }
                    0 // an earlier copy, unknown: never matches
                } else {
                    h.stamp
                };
                v.claims.insert(p, stamp);
            }
            for (layer, key, b) in self.layers.withdrawn.drain(..) {
                withdrew(
                    &mut self.stats,
                    &mut self.observer,
                    conn,
                    key,
                    Some(layer),
                    b,
                );
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
        self.start_pass(src);
        self.rebuild_changed(src);
        // After the rebuilds: the layers they marked go with them.
        self.settle_layers(src);
        let conns: Vec<ConnId> = self.viewers.keys().copied().collect();
        for &conn in &conns {
            self.send_layers(conn, src, lanes, Pick::Before);
            self.send_stale(conn, src, lanes);
            self.send_layers(conn, src, lanes, Pick::All);
            self.send_unloads(conn, lanes);
        }
        lanes.edits_queued();
        self.spread_spent = Duration::ZERO;
        self.extra_spent = Duration::ZERO;
        let mut never = || false;
        let start = Instant::now();
        let mut budget = Budget {
            left: self.config.build_budget.max(1),
            until: self.config.load_time.map(|t| start + t),
            interrupted: &mut never,
            one: true,
            built: 0,
            placed: 0,
        };
        self.load(&conns, src, lanes, &mut budget);
        if budget.built > 0 {
            self.stats.flush_builds += 1;
            self.stats.flush_nanos += nanos(start.elapsed());
        }
        src.end();
    }

    /// Starts a pass: calls the source's [`begin`](SectionSource::begin)
    /// with the views loading, and lets go of the layer keys of sections
    /// no longer held.
    fn start_pass<S: SectionSource + ?Sized>(&mut self, src: &mut S) {
        for v in self.viewers.values_mut() {
            v.held.prune();
            v.layers.prune();
        }
        if !self.any_active() {
            // The wave is over: views that moved count as loading again
            // only once they move again.
            for v in self.viewers.values_mut() {
                v.moved = false;
            }
        }
        let loading = self.loading_now();
        self.last_loading = loading;
        src.begin(&loading);
        self.edits.clear();
        self.marked.clear();
        self.layers.resize(&*src);
        self.layers.new_pass();
        for (&conn, v) in &mut self.viewers {
            for p in std::mem::take(&mut v.released) {
                if !v.held.contains_key(&p) {
                    self.layers.release(&mut v.layers, &*src, p);
                }
            }
            for (layer, key, b) in self.layers.withdrawn.drain(..) {
                withdrew(
                    &mut self.stats,
                    &mut self.observer,
                    conn,
                    key,
                    Some(layer),
                    b,
                );
            }
        }
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
    /// (checked after each section), or until this flush interval's
    /// [`IdleBudget`] is spent (spread time first, then extra unless
    /// [held](Self::hold_idle); counted from the last flush). With any time
    /// left at all, at least one section is sent, however long it takes.
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
        let built = self.load_for(src, lanes, until.min(start + left), &mut interrupted, true);
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
    /// its change first. A changed section nobody holds next to its area
    /// (within the hysteresis and one) is put to
    /// [`SectionSource::unheld`] first, as a flush does: what that marks
    /// (or, with [`Unheld::Build`], what its build marks) of what this
    /// connection holds is rebuilt and sent too. The next
    /// [`flush`](Self::flush) sends the rest as usual.
    pub fn flush_conn<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        src: &mut S,
        lanes: &mut impl Lanes,
    ) {
        let Some(v) = self.viewers.get(&conn) else {
            return;
        };
        let (area, h) = (v.area, i64::from(self.config.hysteresis) + 1);
        let next_door = move |p: &SectionPos| area.is_some_and(|a| a.contains(*p, h));
        // The unheld first: what they mark is rebuilt after them, once.
        let mut work: VecDeque<SectionPos> = self
            .changed
            .iter()
            .filter(|p| next_door(p) && !self.viewers.values().any(|v| v.held.contains_key(p)))
            .copied()
            .collect();
        work.extend(
            self.changed
                .iter()
                .filter(|p| v.held.contains_key(p))
                .copied(),
        );
        self.start_pass(src);
        let mut done = PosSet::default();
        while let Some(pos) = work.pop_front() {
            if !self.changed.contains(&pos) || done.contains(&pos) {
                continue;
            }
            let ours = self
                .viewers
                .get(&conn)
                .is_some_and(|v| v.held.contains_key(&pos));
            if !ours {
                // Another's, or too far to reach what it holds: the flush's.
                if !next_door(&pos) || self.viewers.values().any(|v| v.held.contains_key(&pos)) {
                    continue;
                }
                done.insert(pos);
                let near = self.near(pos);
                if src.unheld(pos, near, &mut self.marks) == Unheld::Forget {
                    self.forget_change(pos);
                    self.apply_marks(src);
                    work.extend(self.marked.drain(..));
                    continue;
                }
            }
            done.insert(pos);
            self.build(src, pos);
            work.extend(self.marked.drain(..));
        }
        self.settle_layers(src);
        self.send_layers(conn, src, lanes, Pick::Before);
        self.send_stale(conn, src, lanes);
        self.send_layers(conn, src, lanes, Pick::All);
        src.end();
    }

    /// Builds and queues new sections as a flush's load does (round robin
    /// from where the last one stopped, nearest first, within each bulk
    /// lane's high water) in time the caller's thread would otherwise wait:
    /// until `until`, or until `interrupted` says something else is
    /// waiting (checked before each section, sent from the cache or
    /// built). Changes and unloads wait for the next flush. Returns the
    /// sections built.
    pub fn load_until<S: SectionSource + ?Sized>(
        &mut self,
        src: &mut S,
        lanes: &mut impl Lanes,
        until: Instant,
        mut interrupted: impl FnMut() -> bool,
    ) -> usize {
        self.load_for(src, lanes, until, &mut interrupted, false)
    }

    /// A load until `until` or `interrupted`; `one`: at least one section
    /// whatever either says. Returns the sections built.
    fn load_for<S: SectionSource + ?Sized>(
        &mut self,
        src: &mut S,
        lanes: &mut impl Lanes,
        until: Instant,
        interrupted: &mut dyn FnMut() -> bool,
        one: bool,
    ) -> usize {
        if !self.loading() {
            return 0;
        }
        self.start_pass(src);
        self.settle_layers(src);
        let conns: Vec<ConnId> = self.viewers.keys().copied().collect();
        let mut budget = Budget {
            left: usize::MAX,
            until: Some(until),
            interrupted,
            one,
            built: 0,
            placed: 0,
        };
        self.load(&conns, src, lanes, &mut budget);
        src.end();
        budget.built
    }

    /// Reads the layers that changed (and marks their holders).
    fn settle_layers<S: SectionSource + ?Sized>(&mut self, src: &mut S) {
        self.layers
            .settle(&*src, self.viewers.values_mut().map(|v| &mut v.layers));
    }

    /// Counts the layer frames withdrawn for `conn`.
    fn layer_withdrawals(&mut self, conn: ConnId) {
        for (layer, key, b) in self.layers.withdrawn.drain(..) {
            withdrew(
                &mut self.stats,
                &mut self.observer,
                conn,
                key,
                Some(layer),
                b,
            );
        }
    }

    /// Takes what the build just done marked
    /// ([`SectionSource::take_marks`]): sections changed (noted in
    /// `marked` too), and layers changed, read at once.
    fn take_marks<S: SectionSource + ?Sized>(&mut self, src: &mut S) {
        src.take_marks(&mut self.marks);
        self.apply_marks(src);
    }

    /// Applies what is in `marks` (see [`take_marks`](Self::take_marks)).
    fn apply_marks<S: SectionSource + ?Sized>(&mut self, src: &mut S) {
        if self.marks.is_empty() {
            return;
        }
        let mut marks = std::mem::take(&mut self.marks);
        for (pos, mark) in marks.sections.drain(..) {
            match mark {
                Mark::Changed => self.changed(pos),
                Mark::Bulk => self.changed_bulk(pos),
                Mark::Derived => self.changed_derived(pos),
            }
            self.marked.push(pos);
        }
        let layers = !marks.layers.is_empty();
        for (layer, key) in marks.layers.drain(..) {
            self.layers.changed(layer, key);
        }
        self.marks = marks;
        if layers {
            self.settle_layers(src);
        }
    }

    /// Records a section newly held by `conn`: its layer keys. `copy`: the
    /// client held an earlier copy of it (and may hold its layer states).
    fn hold<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        pos: SectionPos,
        held: Held,
        copy: bool,
        src: &mut S,
    ) {
        let Some(v) = self.viewers.get_mut(&conn) else {
            return;
        };
        if v.held.insert(pos, held).is_none() && !v.released.remove(&pos) {
            // (A section let go of and held again keeps its layer keys.)
            self.stats.layer_resumed += self.layers.hold(&mut v.layers, &*src, pos, copy);
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
            self.layer_withdrawals(conn);
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
            self.layer_withdrawals(conn);
        }
    }

    /// Sends `conn` the layer frames waiting (`pick` of them): whole ones in
    /// the bulk lane, changes on the priority lane. False if the lane
    /// refused one.
    fn send_layers<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        src: &mut S,
        lanes: &mut impl Lanes,
        pick: Pick,
    ) -> bool {
        let Some(v) = self.viewers.get_mut(&conn) else {
            return true;
        };
        let (stats, observer) = (&mut self.stats, &mut self.observer);
        let mut note = |layer: usize, key: SectionPos, bytes: usize, ok: bool| {
            let at = (Some(key), Some(layer));
            note(stats, observer, conn, FrameKind::Layer, bytes, at, ok);
        };
        let (sent, ok) = self
            .layers
            .send(conn, &mut v.layers, &*src, lanes, pick, &mut note);
        self.stats.layer_frames += sent;
        self.layer_withdrawals(conn);
        ok
    }

    /// Builds `pos` into the cache, and marks it stale (or to send again
    /// in the bulk lane, after a background change) for holders of an
    /// older encoding.
    fn build<S: SectionSource + ?Sized>(&mut self, src: &mut S, pos: SectionPos) -> Built {
        self.changed.remove(&pos);
        let background = self.bulk.remove(&pos);
        let derived = self.derived.remove(&pos);
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
            if v.held.stamp(&pos).is_some_and(|s| s != built.stamp) {
                if background && !v.stale.contains(&pos) {
                    v.resend.insert(pos);
                } else if derived && v.resend.contains(&pos) {
                    // Its resend, still to be queued, takes this change.
                } else {
                    v.resend.remove(&pos);
                    v.stale.insert(pos);
                }
            }
        }
        self.take_marks(src);
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
        let mut work: VecDeque<SectionPos> = self.changed.iter().copied().collect();
        // Sections the builds mark are rebuilt in the same pass, once each.
        let mut done = PosSet::default();
        while let Some(pos) = work.pop_front() {
            if !self.changed.contains(&pos) || !done.insert(pos) {
                continue;
            }
            let out = budget == 0 || (built > 0 && until.is_some_and(|u| Instant::now() >= u));
            if !self.viewers.values().any(|v| v.held.contains_key(&pos)) {
                let near = self.near(pos);
                if src.unheld(pos, near, &mut self.marks) == Unheld::Forget {
                    self.forget_change(pos);
                    self.apply_marks(src);
                    work.extend(self.marked.drain(..));
                    continue;
                }
                if out {
                    // Asked again next flush.
                    self.apply_marks(src);
                    self.marked.clear();
                    break;
                }
            } else if out {
                break;
            }
            budget -= 1;
            built += 1;
            self.build(src, pos);
            work.extend(self.marked.drain(..));
        }
    }

    /// Drops a change nobody holds: built again when someone wants it.
    fn forget_change(&mut self, pos: SectionPos) {
        self.changed.remove(&pos);
        self.bulk.remove(&pos);
        self.derived.remove(&pos);
        self.cache.remove(pos);
    }

    /// True if `pos` is within the hysteresis and one of some area.
    fn near(&self, pos: SectionPos) -> bool {
        let h = i64::from(self.config.hysteresis) + 1;
        self.viewers
            .values()
            .any(|v| v.area.is_some_and(|a| a.contains(pos, h)))
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
        let cells = self.config.edit_rule == EditRule::Cells;
        let mut changes = Vec::new();
        for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
            if x != y {
                changes.extend([u32::try_from(i).ok()?, *y]);
                if cells && changes.len() * 4 >= to.bytes.len() {
                    return None;
                }
            }
        }
        let edit = (self.encode)(&StreamMsg::Edit {
            pos,
            changes,
            stamp: Stamp::of(to.stamp),
        });
        if !cells && edit.len() >= self.section_frame(pos, to).len() {
            return None;
        }
        Some(edit)
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
            let took = h.take_back();
            if let Some(b) = took {
                withdrew(&mut self.stats, &mut self.observer, conn, pos, None, b);
            }
            let queued = took.is_some();
            let at = Some(pos);
            let (sent, ticket, bytes) = if queued {
                // Queued again at the back, its layers' whole frames with
                // it (those that go before it first).
                self.requeue_layers(conn, pos, src);
                let ticket = BulkTicket::new();
                let frame = self.section_frame(pos, &built);
                let n = frame.len();
                self.stats.folded += 1;
                let sent = self.send_layers(conn, src, lanes, Pick::BeforeOf(pos))
                    && self.send_bulk(conn, lanes, FrameKind::Folded, at, frame, ticket.clone());
                (sent, Some(ticket), n)
            } else if let Some(frame) = self.edit_frame(src, pos, from, &built) {
                self.stats.edits += 1;
                (self.send(conn, lanes, FrameKind::Edit, at, frame), None, 0)
            } else {
                let frame = self.section_frame(pos, &built);
                self.stats.sections += 1;
                (
                    self.send(conn, lanes, FrameKind::Changed, at, frame),
                    None,
                    0,
                )
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
                        bytes: frame_len(bytes),
                        replaces,
                    },
                );
            } else if queued && replaces {
                // Its frame is gone and the lane refused the new one, but
                // it still holds its earlier copy (unknown): kept, and sent
                // again whole in the bulk lane.
                let Some(v) = self.viewers.get_mut(&conn) else {
                    return;
                };
                v.held.insert(pos, Held::kept(0));
                v.stale.remove(&pos);
                v.resend.insert(pos);
            } else if queued {
                // Its frame is gone and the lane refused the new one: the
                // load loop sends it again.
                self.release(conn, pos, src);
                let Some(v) = self.viewers.get_mut(&conn) else {
                    return;
                };
                v.cursor = 0;
            } else {
                return; // the lane is full: next flush
            }
        }
    }

    /// Sends a connection's unloads waiting now (a flush sends them too):
    /// after [`set_stream_interest`](Self::set_stream_interest), so a
    /// client that jumped frees what it left before the new area loads.
    /// What the lane refuses waits for the next flush.
    pub fn send_unloads(&mut self, conn: ConnId, lanes: &mut impl Lanes) {
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
            for b in Bounds::unload_boxes(v.unloads.keys(), &keep) {
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
                    (None, None),
                    ok,
                );
                if !ok {
                    return;
                }
                let before = v.unloads.len();
                v.unloads.retain(|p, _| !p.within(&min, &max));
                self.stats.unloads += (before - v.unloads.len()) as u64;
                self.stats.unload_boxes += 1;
            }
        }
        while !v.unloads.is_empty() {
            let positions: Vec<SectionPos> =
                v.unloads.keys().take(MAX_UNLOAD_BATCH).copied().collect();
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
                (None, None),
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
            let (stamp, replaces) = (h.stamp, h.replaces);
            let took = h.take_back();
            if let Some(b) = took {
                withdrew(&mut self.stats, &mut self.observer, conn, pos, None, b);
            }
            let holds = took.is_none() || replaces;
            if !holds {
                // Queued again at the back, its layers' whole frames with it.
                self.requeue_layers(conn, pos, src);
            }
            let ticket = BulkTicket::new();
            let frame = self.section_frame(pos, &built);
            let n = frame.len();
            let at = Some(pos);
            if (holds || self.send_layers(conn, src, lanes, Pick::BeforeOf(pos)))
                && self.send_bulk(conn, lanes, FrameKind::Resend, at, frame, ticket.clone())
            {
                self.stats.bulk_resends += 1;
                if let Some(v) = self.viewers.get_mut(&conn) {
                    v.held.insert(
                        pos,
                        Held {
                            stamp: built.stamp,
                            ticket: Some(ticket),
                            bytes: frame_len(n),
                            replaces: holds,
                        },
                    );
                }
                if !holds {
                    self.send_layers(conn, src, lanes, Pick::All);
                }
            } else if holds {
                // It keeps the copy it has (what was written, or an earlier
                // one, unknown): sent again later.
                if let Some(v) = self.viewers.get_mut(&conn) {
                    let stamp = if took.is_none() { stamp } else { 0 };
                    v.held.insert(pos, Held::kept(stamp));
                    v.resend.insert(pos);
                }
                return false;
            } else {
                // Its frame is gone: load it again.
                self.release(conn, pos, src);
                if let Some(v) = self.viewers.get_mut(&conn) {
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
                if budget.out(true) {
                    return served;
                }
                budget.spend(true);
                served = true;
                self.resolve_group(conn, group, src);
                if let Some(v) = self.viewers.get_mut(&conn) {
                    v.grouped.remove(&pos); // (looked at, whatever came of it)
                }
                continue;
            }
            if !src.exists(pos) {
                if let Some(stamp) = v.claims.remove(&pos) {
                    v.unloads.insert(pos, stamp);
                }
                v.restored.remove(&pos);
                v.cursor += 1;
                continue;
            }
            // The load's time bounds sections from the cache too.
            let cached = !self.changed.contains(&pos) && self.cache.get(pos).is_some();
            if budget.out(!cached) {
                return served;
            }
            let built = self.current(src, pos);
            if cached {
                self.stats.cache_hits += 1;
            }
            budget.spend(!cached);
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
        let restored = v.restored.remove(&pos);
        let kept = claim == Some(built.stamp);
        if claim.is_some()
            && let Some(o) = &mut self.observer
        {
            o.event(&StreamEvent::Claimed { conn, pos, kept });
        }
        if kept {
            self.stats.resumed += 1;
            self.hold(conn, pos, Held::kept(built.stamp), restored, src);
            self.send_layers(conn, src, lanes, Pick::All);
            return true;
        }
        let unloaded = v.unloads.remove(&pos);
        let replaces = claim.is_some() || unloaded.is_some();
        let ticket = BulkTicket::new();
        let frame = self.section_frame(pos, built);
        let held = Held {
            stamp: built.stamp,
            ticket: Some(ticket.clone()),
            bytes: frame_len(frame.len()),
            replaces,
        };
        // Held first, so the layers that go before it are queued before it.
        self.hold(conn, pos, held, replaces || restored, src);
        let at = Some(pos);
        if !self.send_layers(conn, src, lanes, Pick::BeforeOf(pos))
            || !self.send_bulk(conn, lanes, FrameKind::Section, at, frame, ticket)
        {
            self.release(conn, pos, src);
            if let Some(v) = self.viewers.get_mut(&conn) {
                if let Some(stamp) = claim {
                    v.claims.insert(pos, stamp);
                } else if let Some(stamp) = unloaded {
                    v.unloads.insert(pos, stamp);
                }
                if restored {
                    v.restored.insert(pos);
                }
            }
            return false;
        }
        self.stats.sections += 1;
        self.send_layers(conn, src, lanes, Pick::All);
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
        self.layers.resize(&*src);
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
            let matched =
                GroupClaim::layer_digest(pairs.iter().map(|(at, _, s)| (*at, *s))) == Some(*digest);
            if let Some(o) = &mut self.observer {
                o.event(&StreamEvent::LayerGroup {
                    conn,
                    start: g.start,
                    layer,
                    kept: matched,
                });
            }
            if let Some(v) = self.viewers.get_mut(&conn) {
                for (_, key, stamp) in pairs {
                    if matched {
                        v.layers.claim(layer, key, stamp);
                    } else {
                        // It holds some states there, not these.
                        v.layers.claim_unknown(layer, key);
                    }
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
                self.hold(conn, p, Held::kept(b.stamp), false, src);
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
                    v.unloads.insert(p, 0);
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
        pos: Option<SectionPos>,
        frame: Vec<u8>,
    ) -> bool {
        let bytes = frame.len();
        let ok = lanes.send(conn, frame);
        let at = (pos, None);
        note(
            &mut self.stats,
            &mut self.observer,
            conn,
            kind,
            bytes,
            at,
            ok,
        );
        ok
    }

    /// Queues a frame in `conn`'s bulk lane under `ticket`, counted.
    fn send_bulk(
        &mut self,
        conn: ConnId,
        lanes: &mut impl Lanes,
        kind: FrameKind,
        pos: Option<SectionPos>,
        frame: Vec<u8>,
        ticket: BulkTicket,
    ) -> bool {
        let bytes = frame.len();
        let ok = lanes.send_bulk(conn, frame, Some(ticket));
        let at = (pos, None);
        note(
            &mut self.stats,
            &mut self.observer,
            conn,
            kind,
            bytes,
            at,
            ok,
        );
        ok
    }

    /// Sets the observer told each [`StreamEvent`] (replacing any), or
    /// none. Without one, nothing is made to tell it.
    pub fn set_observer(&mut self, observer: Option<Box<dyn StreamObserver>>) {
        self.observer = observer;
    }
}

/// Counts a frame queued (or refused), and tells the observer. `at`: the
/// section (or layer key) and layer it carries.
fn note(
    stats: &mut StreamStats,
    observer: &mut Option<Box<dyn StreamObserver>>,
    conn: ConnId,
    kind: FrameKind,
    bytes: usize,
    at: (Option<SectionPos>, Option<usize>),
    ok: bool,
) {
    if !ok {
        stats.refused += 1;
        return;
    }
    stats.bytes += bytes as u64;
    if let Some(o) = observer {
        let (pos, layer) = at;
        o.event(&StreamEvent::Queued {
            conn,
            kind,
            bytes,
            pos,
            layer,
        });
    }
}

/// Counts a frame withdrawn, and tells the observer.
fn withdrew(
    stats: &mut StreamStats,
    observer: &mut Option<Box<dyn StreamObserver>>,
    conn: ConnId,
    pos: SectionPos,
    layer: Option<usize>,
    bytes: u32,
) {
    stats.withdrawn += 1;
    stats.withdrawn_bytes += u64::from(bytes);
    if let Some(o) = observer {
        o.event(&StreamEvent::Withdrawn {
            conn,
            pos,
            layer,
            bytes: bytes as usize,
        });
    }
}

/// A frame's length, as [`Held`] keeps it.
fn frame_len(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// A duration in nanoseconds, saturating.
fn nanos(d: Duration) -> u64 {
    u64::try_from(d.as_nanos()).unwrap_or(u64::MAX)
}
