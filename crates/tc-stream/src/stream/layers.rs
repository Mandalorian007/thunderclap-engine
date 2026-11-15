//! Layers: data streamed beside sections (see [`SectionSource::layers`]).
//! Each connection holds a layer's state at a key while it holds any
//! section under that key; the state goes whole in the bulk lane behind the
//! section that brings the key, then as changes on the priority lane (or
//! folded into a whole frame still queued). A connection that claims a
//! key's state ([`LayerClaim`](crate::LayerClaim), a group's layer digest,
//! or what it held across a reload) keeps it when the claim matches.

use std::collections::BTreeSet;

use tc_net::{BulkTicket, ConnId};

use super::SectionSource;
use crate::hash::PosMap;
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

/// What a connection holds of one key.
struct Have {
    /// Sections it holds under the key.
    count: usize,
    /// The version it holds (or will once `ticket`'s frame is written).
    version: Option<u64>,
    ticket: Option<BulkTicket>,
}

/// What one connection holds of every layer.
#[derive(Default)]
pub(super) struct LayerHeld {
    keys: Vec<PosMap<SectionPos, Have>>,
    /// Keys whose state it may not hold yet.
    pending: BTreeSet<(usize, SectionPos)>,
    /// States it says it holds, by layer and key, with their stamps: kept
    /// when a section first brings the key and the stamp matches.
    claims: PosMap<(usize, SectionPos), u64>,
}

impl LayerHeld {
    pub(super) fn busy(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Claims it holds `layer`'s state at `key` with stamp `stamp` (0:
    /// none, ignored).
    pub(super) fn claim(&mut self, layer: usize, key: SectionPos, stamp: u64) {
        if stamp != 0 {
            self.claims.insert((layer, key), stamp);
        }
    }

    /// Claims not yet looked at.
    pub(super) fn claims(&self) -> usize {
        self.claims.len()
    }

    /// Drops the claims not looked at (a load reached its end).
    pub(super) fn drop_claims(&mut self) -> usize {
        let n = self.claims.len();
        self.claims.clear();
        n
    }
}

/// Every layer's states, shared by the connections.
#[derive(Default)]
pub(super) struct Layers {
    count: usize,
    states: Vec<PosMap<SectionPos, State>>,
    changed: BTreeSet<(usize, SectionPos)>,
    next: u64,
    buf: Vec<u8>,
    frame: Vec<u8>,
}

impl Layers {
    pub(super) fn resize(&mut self, count: usize) {
        self.count = count;
        if self.states.len() < count {
            self.states.resize_with(count, PosMap::default);
        }
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
    }

    /// A connection holds nothing of any layer any more (a reload: its
    /// sections are held again as they are looked at), but claims the
    /// states it has, so one the new world has the same is not sent again.
    /// Call before [`clear`](Self::clear).
    pub(super) fn forget_viewer(&self, held: &mut LayerHeld) {
        let LayerHeld { keys, claims, .. } = held;
        for (layer, keys) in keys.iter_mut().enumerate() {
            for (key, h) in keys.drain() {
                if h.ticket.as_ref().is_some_and(BulkTicket::withdraw) {
                    continue; // never written: it holds what it held before, unknown
                }
                let Some(s) = self.states.get(layer).and_then(|s| s.get(&key)) else {
                    continue;
                };
                let stamp = match (h.version, &s.prev) {
                    (Some(v), _) if v == s.version => s.stamp,
                    (Some(v), Some((pv, _, ps))) if v == *pv => *ps,
                    _ => continue,
                };
                if stamp != 0 {
                    claims.insert((layer, key), stamp);
                }
            }
        }
        held.pending.clear();
    }

    /// A connection closed.
    pub(super) fn drop_viewer(&mut self, held: &mut LayerHeld) {
        for (layer, keys) in held.keys.iter_mut().enumerate() {
            for (key, h) in keys.drain() {
                if let Some(t) = &h.ticket {
                    t.withdraw();
                }
                self.unhold(layer, key);
            }
        }
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
    /// and keeps (not sent).
    pub(super) fn hold<S: SectionSource + ?Sized>(
        &mut self,
        held: &mut LayerHeld,
        src: &S,
        pos: SectionPos,
    ) -> u64 {
        if held.keys.len() < self.count {
            held.keys.resize_with(self.count, PosMap::default);
        }
        let mut kept = 0;
        for layer in 0..self.count {
            let key = src.layer_key(layer, pos);
            let have = held.keys[layer].entry(key).or_insert_with(|| Have {
                count: 0,
                version: None,
                ticket: None,
            });
            have.count += 1;
            if have.count == 1 {
                let claim = held.claims.remove(&(layer, key));
                let state = self.state(src, layer, key);
                state.holders += 1;
                if claim.is_some_and(|c| c == state.stamp) {
                    have.version = Some(state.version);
                    kept += 1;
                } else {
                    held.pending.insert((layer, key));
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
            if let Some(t) = &have.ticket {
                t.withdraw();
            }
            held.keys[layer].remove(&key);
            held.pending.remove(&(layer, key));
            self.unhold(layer, key);
        }
    }

    /// Section `pos`'s frame was queued again: its layers' whole frames
    /// still queued are withdrawn, to be queued again behind it.
    pub(super) fn requeue<S: SectionSource + ?Sized>(
        &self,
        held: &mut LayerHeld,
        src: &S,
        pos: SectionPos,
    ) {
        for layer in 0..self.count.min(held.keys.len()) {
            let key = src.layer_key(layer, pos);
            if let Some(have) = held.keys[layer].get_mut(&key)
                && have.ticket.as_ref().is_some_and(BulkTicket::withdraw)
            {
                have.ticket = None;
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

    /// Sends a connection its pending layer frames; returns the frames sent.
    pub(super) fn send<S: SectionSource + ?Sized>(
        &mut self,
        conn: ConnId,
        held: &mut LayerHeld,
        src: &S,
        lanes: &mut impl Lanes,
        note: &mut dyn FnMut(usize, bool),
    ) -> u64 {
        let mut sent = 0;
        while let Some(&(layer, key)) = held.pending.first() {
            let Some(have) = held.keys.get_mut(layer).and_then(|k| k.get_mut(&key)) else {
                held.pending.pop_first();
                continue;
            };
            let Some(state) = self.states.get(layer).and_then(|s| s.get(&key)) else {
                held.pending.pop_first();
                continue;
            };
            if have.version == Some(state.version) {
                held.pending.pop_first();
                continue;
            }
            let queued = have.ticket.as_ref().is_some_and(BulkTicket::withdraw);
            if queued || have.version.is_none() {
                // Whole, in the bulk lane behind its section.
                have.version = None;
                have.ticket = None;
                src.layer_frame(layer, key, None, &state.bytes, &mut self.frame);
                if !self.frame.is_empty() {
                    let ticket = BulkTicket::new();
                    let frame = std::mem::take(&mut self.frame);
                    let bytes = frame.len();
                    let ok = lanes.send_bulk(conn, frame, Some(ticket.clone()));
                    note(bytes, ok);
                    if !ok {
                        return sent;
                    }
                    have.ticket = Some(ticket);
                    sent += 1;
                }
            } else {
                if lanes.behind(conn) {
                    return sent;
                }
                let from = state
                    .prev
                    .as_ref()
                    .filter(|(v, _, _)| Some(*v) == have.version)
                    .map(|(_, b, _)| b.as_slice());
                src.layer_frame(layer, key, from, &state.bytes, &mut self.frame);
                if !self.frame.is_empty() {
                    let frame = std::mem::take(&mut self.frame);
                    let bytes = frame.len();
                    let ok = lanes.send(conn, frame);
                    note(bytes, ok);
                    if !ok {
                        return sent;
                    }
                    sent += 1;
                }
                have.ticket = None;
            }
            have.version = Some(state.version);
            held.pending.pop_first();
        }
        sent
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
