//! Layers: data streamed beside sections (see [`SectionSource::layers`]).
//! Each connection holds a layer's state at a key while it holds any
//! section under that key; the state goes whole in the bulk lane next to
//! the section that brings the key (behind it, or before it for a layer
//! that is [`LayerOrder::Before`]), then as changes on the priority lane
//! (or folded into a whole frame still queued). A connection that claims a
//! key's state ([`LayerClaim`](crate::LayerClaim), a group's layer digest,
//! or what it held across a reload) keeps it when the claim matches.

use std::collections::BTreeSet;
use std::num::NonZeroU64;

use tc_net::{BulkTicket, ConnId};

use super::{LayerFrom, LayerOrder, SectionSource};
use crate::hash::PosMap;
use crate::held::RegionMap;
use crate::lanes::Lanes;
use crate::msg::SectionPos;

/// A layer's state at a key, while any connection holds it.
struct State {
    version: u64,
    bytes: Vec<u8>,
    /// Its stamp ([`SectionSource::layer_stamp`]; 0: no state).
    stamp: u64,
    /// The state before, to send a change from, and its stamp.
    prev: Option<(u64, Vec<u8>, u64)>,
    /// Connections holding it.
    holders: usize,
}

/// What a connection holds of one key (its queued whole frame, if any,
/// is in [`LayerHeld::queued`]).
struct Have {
    /// Sections it holds under the key.
    count: u32,
    /// The version it holds (or will once its queued frame is written).
    version: Option<NonZeroU64>,
    /// Until a whole frame of the key is written, the client may hold a
    /// state not known here (it claimed one that didn't match, or held an
    /// earlier copy of the section that brought the key): a whole frame is
    /// then from [`LayerFrom::Unknown`], not [`LayerFrom::Nothing`].
    unknown: bool,
}

impl Have {
    fn version(&self) -> Option<u64> {
        self.version.map(NonZeroU64::get)
    }
}

/// A key's whole frame still queued: its ticket and length.
type Queued = PosMap<(usize, SectionPos), (BulkTicket, u32)>;

/// What one connection holds of every layer.
#[derive(Default)]
pub(super) struct LayerHeld {
    keys: Vec<RegionMap<Have>>,
    /// Whole frames queued, until written.
    queued: Queued,
    /// Keys whose state it may not hold yet.
    pending: BTreeSet<(usize, SectionPos)>,
    /// States it says it holds, by layer and key, with their stamps
    /// (`None`: some state, unknown, never matching): kept when a section
    /// first brings the key and the stamp matches.
    claims: PosMap<(usize, SectionPos), Option<u64>>,
}

impl LayerHeld {
    pub(super) fn busy(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Claims it holds `layer`'s state at `key` with stamp `stamp` (0:
    /// none, ignored).
    pub(super) fn claim(&mut self, layer: usize, key: SectionPos, stamp: u64) {
        if stamp != 0 {
            self.claims.insert((layer, key), Some(stamp));
        }
    }

    /// Claims it holds some state of `layer` at `key`, not known here.
    pub(super) fn claim_unknown(&mut self, layer: usize, key: SectionPos) {
        self.claims.insert((layer, key), None);
    }

    /// Claims not yet looked at.
    pub(super) fn claims(&self) -> usize {
        self.claims.len()
    }

    /// Drops the claims not looked at (a load reached its end).
    pub(super) fn drop_claims(&mut self) -> usize {
        std::mem::take(&mut self.claims).len()
    }

    /// Lets go of the tickets of whole frames written.
    pub(super) fn prune(&mut self) {
        self.queued.retain(|_, (t, _)| !t.taken());
        if self.queued.capacity() > 64 && self.queued.len() * 4 <= self.queued.capacity() {
            self.queued.shrink_to(self.queued.len() * 2);
        }
    }

    /// Its whole frames still waiting in the bulk lane.
    pub(super) fn in_flight(&self) -> bool {
        self.queued
            .values()
            .any(|(t, _)| !t.taken() && !t.withdrawn())
    }

    /// Bytes its tables take, roughly (by capacity).
    pub(super) fn bytes(&self) -> usize {
        self.keys.iter().map(RegionMap::bytes).sum::<usize>()
            + self.queued.capacity() * (size_of::<((usize, SectionPos), (BulkTicket, u32))>() + 1)
            + self.pending.len() * (size_of::<(usize, SectionPos)>() + 8)
            + self.claims.capacity() * (size_of::<((usize, SectionPos), Option<u64>)>() + 1)
    }
}

/// Which pending frames [`Layers::send`] sends.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Pick {
    /// Every one.
    All,
    /// Of layers that go before their sections only.
    Before,
    /// Of layers that go before their sections, under section `pos`'s keys.
    BeforeOf(SectionPos),
}

/// Every layer's states, shared by the connections.
#[derive(Default)]
pub(super) struct Layers {
    count: usize,
    /// Per layer: it goes before its sections ([`LayerOrder::Before`]).
    before: Vec<bool>,
    states: Vec<PosMap<SectionPos, State>>,
    changed: BTreeSet<(usize, SectionPos)>,
    next: u64,
    buf: Vec<u8>,
    /// This pass's frames, by layer, key, what they're from (0: nothing,
    /// 1: unknown, else 2 and the version) and the version they're to:
    /// every holder of a change usually holds the same state, so each is
    /// asked of the source once.
    memo: PosMap<(usize, SectionPos, u8, u64, u64), Vec<u8>>,
    /// Frames withdrawn (layer, key, length), for the stream to count.
    pub(super) withdrawn: Vec<(usize, SectionPos, u32)>,
}

/// Withdraws the key's queued frame, logged: true if it was withdrawn.
fn take_back(
    queued: &mut Queued,
    layer: usize,
    key: SectionPos,
    log: &mut Vec<(usize, SectionPos, u32)>,
) -> bool {
    match queued.get(&(layer, key)) {
        Some((t, bytes)) if t.withdraw() => {
            log.push((layer, key, *bytes));
            queued.remove(&(layer, key));
            true
        }
        _ => false,
    }
}

impl Layers {
    /// Reads the source's layers (and their order) at the start of a pass.
    pub(super) fn resize<S: SectionSource + ?Sized>(&mut self, src: &S) {
        let count = src.layers();
        self.count = count;
        if self.states.len() < count {
            self.states.resize_with(count, PosMap::default);
        }
        self.before.clear();
        self.before
            .extend((0..count).map(|l| src.layer_order(l) == LayerOrder::Before));
    }

    /// A new pass: frames are asked of the source again.
    pub(super) fn new_pass(&mut self) {
        self.memo.clear();
    }

    pub(super) fn has_work(&self) -> bool {
        !self.changed.is_empty()
    }

    pub(super) fn changed(&mut self, layer: usize, key: SectionPos) {
        self.changed.insert((layer, key));
    }

    /// A new world: every state is read again.
    pub(super) fn clear(&mut self) {
        for s in &mut self.states {
            s.clear();
        }
        self.changed.clear();
        self.memo.clear();
    }

    /// Bytes the shared states take, roughly.
    pub(super) fn bytes(&self) -> usize {
        self.states
            .iter()
            .flat_map(|s| s.values())
            .map(|s| {
                size_of::<(SectionPos, State)>()
                    + s.bytes.capacity()
                    + s.prev.as_ref().map_or(0, |p| p.1.capacity())
            })
            .sum()
    }

    /// A connection holds nothing of any layer any more (a reload: its
    /// sections are held again as they are looked at), but claims the
    /// states it has, so one the new world has the same is not sent again.
    /// Call before [`clear`](Self::clear).
    pub(super) fn forget_viewer(&mut self, held: &mut LayerHeld) {
        let LayerHeld {
            keys,
            claims,
            queued,
            ..
        } = held;
        for (layer, keys) in keys.iter_mut().enumerate() {
            for (key, h) in keys.drain() {
                if take_back(queued, layer, key, &mut self.withdrawn) || h.version.is_none() {
                    // Never written: it holds what it held before.
                    if h.unknown {
                        claims.insert((layer, key), None);
                    }
                    continue;
                }
                let s = self.states.get(layer).and_then(|s| s.get(&key));
                let stamp = match (h.version(), s) {
                    (Some(v), Some(s)) if v == s.version => Some(s.stamp),
                    (
                        Some(v),
                        Some(State {
                            prev: Some((pv, _, ps)),
                            ..
                        }),
                    ) if v == *pv => Some(*ps),
                    _ => None,
                };
                if stamp != Some(0) {
                    claims.insert((layer, key), stamp);
                }
            }
        }
        queued.clear();
        held.pending.clear();
    }

    /// A connection closed.
    pub(super) fn drop_viewer(&mut self, held: &mut LayerHeld) {
        for (layer, keys) in held.keys.iter_mut().enumerate() {
            for (key, _) in keys.drain() {
                take_back(&mut held.queued, layer, key, &mut self.withdrawn);
                self.unhold(layer, key);
            }
        }
        held.queued.clear();
        held.pending.clear();
        held.claims.clear();
    }

    fn unhold(&mut self, layer: usize, key: SectionPos) {
        let Some(states) = self.states.get_mut(layer) else {
            return;
        };
        if let Some(s) = states.get_mut(&key) {
            s.holders = s.holders.saturating_sub(1);
            if s.holders == 0 {
                states.remove(&key);
            }
        }
    }

    /// A connection now holds section `pos`; returns the keys it claimed
    /// and keeps (not sent). `copy`: it held an earlier copy of the
    /// section, so may hold its keys' states, unknown, unless it claims
    /// them.
    pub(super) fn hold<S: SectionSource + ?Sized>(
        &mut self,
        held: &mut LayerHeld,
        src: &S,
        pos: SectionPos,
        copy: bool,
    ) -> u64 {
        if held.keys.len() < self.count {
            held.keys.resize_with(self.count, RegionMap::default);
        }
        let mut kept = 0;
        for layer in 0..self.count {
            let key = src.layer_key(layer, pos);
            let have = held.keys[layer].get_or_insert_with(key, || Have {
                count: 0,
                version: None,
                unknown: false,
            });
            have.count += 1;
            if have.count == 1 {
                let claim = held.claims.remove(&(layer, key));
                let state = self.state(src, layer, key);
                state.holders += 1;
                match claim {
                    Some(Some(c)) if c == state.stamp => {
                        have.version = NonZeroU64::new(state.version);
                        kept += 1;
                    }
                    Some(_) => {
                        have.unknown = true;
                        held.pending.insert((layer, key));
                    }
                    None => {
                        have.unknown = copy;
                        held.pending.insert((layer, key));
                    }
                }
            }
        }
        kept
    }

    /// The stamp of `layer`'s state at `key` (0: none), read if no one
    /// holds it (and not kept).
    pub(super) fn stamp<S: SectionSource + ?Sized>(
        &mut self,
        src: &S,
        layer: usize,
        key: SectionPos,
    ) -> u64 {
        if let Some(s) = self.states.get(layer).and_then(|s| s.get(&key)) {
            return s.stamp;
        }
        src.layer_state(layer, key, &mut self.buf);
        stamp_of(src, layer, key, &self.buf)
    }

    /// A connection no longer holds section `pos`.
    pub(super) fn release<S: SectionSource + ?Sized>(
        &mut self,
        held: &mut LayerHeld,
        src: &S,
        pos: SectionPos,
    ) {
        for layer in 0..self.count.min(held.keys.len()) {
            let key = src.layer_key(layer, pos);
            let Some(have) = held.keys[layer].get_mut(&key) else {
                continue;
            };
            have.count -= 1;
            if have.count > 0 {
                continue;
            }
            take_back(&mut held.queued, layer, key, &mut self.withdrawn);
            held.keys[layer].remove(&key);
            held.pending.remove(&(layer, key));
            self.unhold(layer, key);
        }
    }

    /// Section `pos`'s frame is queued again: its layers' whole frames
    /// still queued are withdrawn, to be queued again next to it.
    pub(super) fn requeue<S: SectionSource + ?Sized>(
        &mut self,
        held: &mut LayerHeld,
        src: &S,
        pos: SectionPos,
    ) {
        for layer in 0..self.count.min(held.keys.len()) {
            let key = src.layer_key(layer, pos);
            if let Some(have) = held.keys[layer].get_mut(&key)
                && take_back(&mut held.queued, layer, key, &mut self.withdrawn)
            {
                have.version = None;
                held.pending.insert((layer, key));
            }
        }
    }

    /// `layer`'s state at `key`, read if no one held it yet.
    fn state<S: SectionSource + ?Sized>(
        &mut self,
        src: &S,
        layer: usize,
        key: SectionPos,
    ) -> &mut State {
        let next = &mut self.next;
        self.states[layer].entry(key).or_insert_with(|| {
            let mut bytes = Vec::new();
            src.layer_state(layer, key, &mut bytes);
            *next += 1;
            State {
                version: *next,
                stamp: stamp_of(src, layer, key, &bytes),
                bytes,
                prev: None,
                holders: 0,
            }
        })
    }

    /// Reads the states that changed, and marks their holders.
    pub(super) fn settle<'a, S: SectionSource + ?Sized>(
        &mut self,
        src: &S,
        viewers: impl Iterator<Item = &'a mut LayerHeld>,
    ) {
        if self.changed.is_empty() {
            return;
        }
        let mut moved = Vec::new();
        for (layer, key) in std::mem::take(&mut self.changed) {
            let Some(s) = self.states.get_mut(layer).and_then(|s| s.get_mut(&key)) else {
                continue; // no one holds it: read when someone does
            };
            src.layer_state(layer, key, &mut self.buf);
            if self.buf == s.bytes {
                continue;
            }
            self.next += 1;
            let old = std::mem::replace(&mut s.bytes, self.buf.clone());
            let stamp = stamp_of(src, layer, key, &s.bytes);
            s.prev = Some((s.version, old, std::mem::replace(&mut s.stamp, stamp)));
            s.version = self.next;
            moved.push((layer, key));
        }
        if moved.is_empty() {
            return;
        }
        for v in viewers {
            for &(layer, key) in &moved {
                if v.keys.get(layer).is_some_and(|k| k.contains_key(&key)) {
                    v.pending.insert((layer, key));
                }
            }
        }
    }

    /// Sends a connection its pending layer frames (`pick` of them);
    /// returns the frames sent, and false if the lane refused one (or is
    /// behind, for a change). `note` is told each frame queued or
    /// refused: its layer, key, length and whether it was queued.
    pub(super) fn send<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        held: &mut LayerHeld,
        src: &S,
        lanes: &mut impl Lanes,
        pick: Pick,
        note: &mut dyn FnMut(usize, SectionPos, usize, bool),
    ) -> (u64, bool) {
        let todo: Vec<(usize, SectionPos)> = match pick {
            Pick::All => held.pending.iter().copied().collect(),
            Pick::Before => held
                .pending
                .iter()
                .filter(|(l, _)| self.before.get(*l) == Some(&true))
                .copied()
                .collect(),
            Pick::BeforeOf(pos) => (0..self.count)
                .filter(|l| self.before[*l])
                .map(|l| (l, src.layer_key(l, pos)))
                .filter(|k| held.pending.contains(k))
                .collect(),
        };
        let mut sent = 0;
        for (layer, key) in todo {
            match self.send_one(conn, held, src, lanes, layer, key, note) {
                Some(n) => sent += n,
                None => return (sent, false),
            }
        }
        (sent, true)
    }

    /// Sends one pending key: the frames sent, or `None` if the lane
    /// refused it (or is behind, for a change).
    #[allow(clippy::too_many_arguments)]
    fn send_one<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        held: &mut LayerHeld,
        src: &S,
        lanes: &mut impl Lanes,
        layer: usize,
        key: SectionPos,
        note: &mut dyn FnMut(usize, SectionPos, usize, bool),
    ) -> Option<u64> {
        let Layers {
            states,
            memo,
            withdrawn,
            ..
        } = self;
        let have = held.keys.get_mut(layer).and_then(|k| k.get_mut(&key));
        let state = states.get(layer).and_then(|s| s.get(&key));
        let (Some(have), Some(state)) = (have, state) else {
            held.pending.remove(&(layer, key));
            return Some(0);
        };
        if have.version() == Some(state.version) {
            held.pending.remove(&(layer, key));
            return Some(0);
        }
        let mut sent = 0;
        let queued = take_back(&mut held.queued, layer, key, withdrawn);
        if queued || have.version.is_none() {
            // Whole, in the bulk lane next to its section.
            have.version = None;
            let (from, tag) = if have.unknown {
                (LayerFrom::Unknown, 1)
            } else {
                (LayerFrom::Nothing, 0)
            };
            // Nothing to nothing needs no frame.
            if have.unknown || !state.bytes.is_empty() {
                let frame = memo
                    .entry((layer, key, tag, 0, state.version))
                    .or_insert_with(|| {
                        let mut out = Vec::new();
                        src.layer_frame(layer, key, from, &state.bytes, &mut out);
                        out
                    });
                if !frame.is_empty() {
                    let ticket = BulkTicket::new();
                    let frame = frame.clone();
                    let bytes = frame.len();
                    let ok = lanes.send_bulk(conn, frame, Some(ticket.clone()));
                    note(layer, key, bytes, ok);
                    if !ok {
                        return None;
                    }
                    let bytes = u32::try_from(bytes).unwrap_or(u32::MAX);
                    held.queued.insert((layer, key), (ticket, bytes));
                    sent += 1;
                }
            }
        } else {
            if lanes.behind(conn) {
                return None;
            }
            let prev = state
                .prev
                .as_ref()
                .filter(|(v, _, _)| Some(*v) == have.version());
            let (from, tag, fv) = match prev {
                Some((v, b, _)) => (LayerFrom::State(b), 2, *v),
                None => (LayerFrom::Unknown, 1, 0),
            };
            let frame = memo
                .entry((layer, key, tag, fv, state.version))
                .or_insert_with(|| {
                    let mut out = Vec::new();
                    src.layer_frame(layer, key, from, &state.bytes, &mut out);
                    out
                });
            if !frame.is_empty() {
                let frame = frame.clone();
                let bytes = frame.len();
                let ok = lanes.send(conn, frame);
                note(layer, key, bytes, ok);
                if !ok {
                    return None;
                }
                sent += 1;
            }
            held.queued.remove(&(layer, key));
            have.unknown = false;
        }
        have.version = NonZeroU64::new(state.version);
        held.pending.remove(&(layer, key));
        Some(sent)
    }
}

/// A state's stamp: 0 when there is none (empty).
fn stamp_of<S: SectionSource + ?Sized>(
    src: &S,
    layer: usize,
    key: SectionPos,
    bytes: &[u8],
) -> u64 {
    if bytes.is_empty() {
        0
    } else {
        src.layer_stamp(layer, key, bytes)
    }
}
