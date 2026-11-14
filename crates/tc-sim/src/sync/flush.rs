//! A flush: marking entries dirty (changes, a reload, expiry), running
//! them (and verifying clean ones), and the frames that bring each
//! subscriber up to date.

use std::sync::OnceLock;

use tc_net::ServerMsg;
use tc_wire::diff::PatchOp;
use tc_wire::{Bytes, Wire, Writer};
use tracing::error;

use super::*;
use crate::query::QueryCtx;

impl<G: Game> SyncLayer<G> {
    /// Marks entries that read any of `changed` dirty, and the volatile
    /// ones if `any`thing changed.
    pub(crate) fn changed(&mut self, changed: &BTreeSet<Key<G::Change>>, any: bool) {
        for key in changed {
            if let Some(ids) = self.by_read.get(key) {
                self.dirty.extend(ids.iter().copied());
            }
        }
        if any {
            self.dirty.extend(self.volatile.iter().copied());
        }
    }

    /// Marks every subscribed entry dirty: the game was replaced (a
    /// reload), so any result may differ. Each subscriber gets a patch
    /// from what it was last sent.
    pub(crate) fn reload(&mut self) {
        let subscribed = self
            .entries
            .iter()
            .filter(|(_, e)| e.idle.is_none())
            .map(|(id, _)| *id);
        self.dirty.extend(subscribed);
    }

    /// Marks entries whose results run out by `time` dirty.
    pub(crate) fn expire(&mut self, time: u64) {
        while let Some(&(t, id)) = self.expiring.first() {
            if t > time {
                break;
            }
            self.expiring.pop_first();
            if self.entries.contains_key(&id) {
                self.dirty.insert(id);
            }
        }
    }

    /// The earliest time a result runs out.
    pub(crate) fn next_expiry(&self) -> Option<u64> {
        self.expiring.first().map(|(t, _)| *t)
    }

    /// True if a flush would do something.
    pub(crate) fn has_work(&self) -> bool {
        !self.dirty.is_empty() || self.clients.values().any(|c| !c.pending.is_empty())
    }

    /// Runs what is dirty, then returns the frames to send: to `only` if
    /// given, else to every client `skip` doesn't exclude (a skipped one
    /// stays pending). Every frame is stamped `world.version`. The caller
    /// sends every frame returned (they count as sent).
    pub(crate) fn flush(
        &mut self,
        world: &World<'_, G>,
        now: Instant,
        only: Option<ConnId>,
        mut skip: impl FnMut(ConnId) -> bool,
    ) -> Vec<(ConnId, Vec<u8>)> {
        self.recompute(world);
        self.collect_idle(now);
        let conns: Vec<ConnId> = match only {
            Some(conn) => vec![conn],
            None => self.clients.keys().copied().filter(|c| !skip(*c)).collect(),
        };
        let mut patches = HashMap::new();
        let mut frames = Vec::new();
        for conn in conns {
            let Some(client) = self.clients.get_mut(&conn) else {
                continue;
            };
            for sub in std::mem::take(&mut client.pending) {
                let Some(cs) = client.subs.get_mut(&sub) else {
                    continue;
                };
                let Some(entry) = self.entries.get(&cs.entry) else {
                    continue;
                };
                let send = Out {
                    schema: &self.schema,
                    entry,
                    id: cs.entry,
                    sub,
                    version: world.version,
                };
                if let Some(frame) = send.message(cs, &mut patches, &mut self.stats) {
                    frames.push((conn, frame));
                }
            }
        }
        frames
    }

    /// Runs every dirty entry (and, verifying, the clean ones), and marks
    /// the subscribers of changed results pending.
    fn recompute(&mut self, world: &World<'_, G>) {
        let mut runs: Vec<(EntryId, Check)> = std::mem::take(&mut self.dirty)
            .into_iter()
            .map(|id| (id, Check::No))
            .collect();
        if self.config.verify {
            let dirty: BTreeSet<EntryId> = runs.iter().map(|(id, _)| *id).collect();
            for (id, e) in &self.entries {
                if e.idle.is_some() || dirty.contains(id) || e.value.is_none() {
                    continue;
                }
                let stale = (e.reads.volatile && e.computed_version != world.version)
                    || e.reads.valid_until.is_some_and(|t| t <= world.time);
                let timed = e.reads.volatile || e.reads.valid_until.is_some();
                if stale {
                    runs.push((*id, Check::Stale));
                } else if !timed || e.computed_at == world.time {
                    runs.push((*id, Check::Compare));
                }
            }
        }
        for (id, check) in runs {
            let Some(entry) = self.entries.get_mut(&id) else {
                continue;
            };
            if entry.idle.is_some() {
                continue;
            }
            let cx = QueryCtx::new(world.game, entry.player, world.time, world.bodies);
            let result = (entry.query.run)(&cx, &entry.args);
            let reads = cx.into_reads();
            let value = match result {
                Ok(bytes) => Value::Ok {
                    hash: diff::result_hash(&bytes),
                    bytes,
                },
                Err(reason) => Value::Failed(reason),
            };
            match check {
                Check::No => self.stats.computes += 1,
                Check::Compare | Check::Stale => {
                    self.stats.verifications += 1;
                    if check == Check::Compare && entry.value.as_deref() == Some(&value) {
                        continue;
                    }
                    self.stats.tracking_misses += 1;
                    error!(
                        query = entry.query.name,
                        stale = check == Check::Stale,
                        "a query result changed without a tracked change, or was not rerun \
                         when due; a mark or a read is missing (see tc_sim::QueryCtx)"
                    );
                }
            }
            let old = std::mem::replace(&mut entry.reads, reads);
            entry.computed_at = world.time;
            entry.computed_version = world.version;
            if entry.value.as_deref() != Some(&value) {
                let value = Arc::new(value);
                if value.hash().is_some() {
                    entry.history.push_back(value.clone());
                    if entry.history.len() > HISTORY {
                        entry.history.pop_front();
                    }
                }
                entry.value = Some(value);
                for (conn, sub) in &entry.subscribers {
                    if let Some(client) = self.clients.get_mut(conn) {
                        client.pending.insert(*sub);
                    }
                }
            }
            self.reindex(id, &old);
        }
    }

    /// Moves entry `id` in the indexes from `old` to its current reads.
    pub(super) fn reindex(&mut self, id: EntryId, old: &Reads<G::Change>) {
        let new = self
            .entries
            .get(&id)
            .map(|e| e.reads.clone())
            .unwrap_or_default();
        if *old == new {
            return;
        }
        for key in old.keys.difference(&new.keys) {
            if let Some(ids) = self.by_read.get_mut(key) {
                ids.remove(&id);
                if ids.is_empty() {
                    self.by_read.remove(key);
                }
            }
        }
        for key in new.keys.difference(&old.keys) {
            self.by_read.entry(key.clone()).or_default().insert(id);
        }
        if let Some(t) = old.valid_until {
            self.expiring.remove(&(t, id));
        }
        if let Some(t) = new.valid_until {
            self.expiring.insert((t, id));
        }
        if new.volatile {
            self.volatile.insert(id);
        } else {
            self.volatile.remove(&id);
        }
    }

    /// Drops entries idle for [`RESUME_GRACE`], oldest first.
    fn collect_idle(&mut self, now: Instant) {
        while let Some((_, &id)) = self.idle.first_key_value() {
            let expired = self.entries[&id]
                .idle
                .is_some_and(|idle| now.saturating_duration_since(idle.since) >= RESUME_GRACE);
            if !expired {
                break;
            }
            self.remove(id);
        }
    }
}

/// Why an entry runs in a flush.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Check {
    /// Dirty or new.
    No,
    /// Verifying a clean entry: its result must not have changed.
    Compare,
    /// Verifying a clean entry that should have rerun: always a miss.
    Stale,
}

type Patches = HashMap<(EntryId, u64), Option<Arc<Vec<u8>>>>;

/// One subscription's message at a flush.
struct Out<'a, G: Game> {
    schema: &'a Schema,
    entry: &'a Entry<G>,
    id: EntryId,
    sub: SubId,
    version: u64,
}

impl<G: Game> Out<'_, G> {
    /// The frame (if any) that brings the subscription from what it was
    /// sent to its entry's value, recorded as sent.
    fn message(
        &self,
        cs: &mut ClientSub,
        patches: &mut Patches,
        stats: &mut SyncStats,
    ) -> Option<Vec<u8>> {
        let (sub, version) = (self.sub, self.version);
        let value = self.entry.value.clone()?;
        let first = cs.sent.is_none();
        let frame = match &*value {
            Value::Failed(reason) => {
                if cs.sent.as_deref() == Some(&*value) {
                    return None;
                }
                ServerMsg::<G::Protocol>::QueryFailed {
                    sub,
                    reason: reason.clone(),
                }
                .to_bytes()
            }
            Value::Ok { bytes, hash } => {
                // What the client holds: what it was sent, or what it
                // resumes from.
                let base = match (&cs.sent, cs.resume) {
                    (Some(sent), _) if sent.hash().is_some() => Some(sent.clone()),
                    (None, Some(resume)) => self
                        .entry
                        .history
                        .iter()
                        .rev()
                        .find(|v| v.hash() == Some(resume))
                        .cloned(),
                    _ => None,
                };
                match base {
                    Some(base) if base.hash() == Some(*hash) => {
                        // Unchanged, or resumed with the current result:
                        // the client has it, so nothing is sent.
                        if first {
                            stats.resumed += 1;
                        }
                        cs.sent = Some(value);
                        cs.resume = None;
                        return None;
                    }
                    Some(base) => {
                        let from = base.hash().expect("base is a result");
                        let patch = patches
                            .entry((self.id, from))
                            .or_insert_with(|| self.patch(&base, bytes))
                            .clone();
                        if let Some(patch) = patch {
                            stats.updates += 1;
                            update_frame::<G>(sub, version, *hash, &patch)
                        } else {
                            stats.resyncs += 1;
                            resync_frame::<G>(sub, version, *hash, bytes)
                        }
                    }
                    None => {
                        stats.resyncs += 1;
                        resync_frame::<G>(sub, version, *hash, bytes)
                    }
                }
            }
        };
        cs.sent = Some(value);
        cs.resume = None;
        Some(frame)
    }

    /// The encoded patch from `base` to `bytes`, if smaller than a resync.
    fn patch(&self, base: &Value, bytes: &[u8]) -> Option<Arc<Vec<u8>>> {
        let Value::Ok { bytes: old, .. } = base else {
            return None;
        };
        let ops = diff::diff(self.schema, &self.entry.result_ty, old, bytes).unwrap_or_else(|e| {
            error!(query = self.entry.query.name, "diff failed: {e}");
            vec![PatchOp::Set {
                path: Vec::new(),
                value: Bytes(bytes.to_vec()),
            }]
        });
        let encoded = ops.to_bytes();
        // Both carry the hash; a Resync also the result's length. A small
        // result is patched whenever its patch is smaller.
        let resync = bytes.len() + varint_len(bytes.len() as u64);
        (encoded.len() < resync).then(|| Arc::new(encoded))
    }
}

fn varint_len(mut n: u64) -> usize {
    let mut len = 1;
    while n >= 0x80 {
        n >>= 7;
        len += 1;
    }
    len
}

/// The variant tags of `Update` and `Resync`, read off encoded templates
/// so they always match the envelope (the same for every protocol).
fn tags<G: Game>() -> (u8, u8) {
    static TAGS: OnceLock<(u8, u8)> = OnceLock::new();
    *TAGS.get_or_init(|| {
        let update = ServerMsg::<G::Protocol>::Update {
            sub: 0,
            version: 0,
            hash: String::new(),
            patch: Vec::new(),
        };
        let resync = ServerMsg::<G::Protocol>::Resync {
            sub: 0,
            version: 0,
            hash: String::new(),
            result: Bytes::default(),
        };
        (update.to_bytes()[0], resync.to_bytes()[0])
    })
}

/// `ServerMsg::Update` with an already encoded patch, so subscribers
/// sharing a diff share its encoding.
fn update_frame<G: Game>(sub: SubId, version: u64, hash: u64, patch: &[u8]) -> Vec<u8> {
    let mut w = Writer::new();
    w.write_u8(tags::<G>().0);
    sub.encode(&mut w);
    version.encode(&mut w);
    w.write_str(&diff::hash_hex(hash));
    w.write_raw(patch);
    w.into_bytes()
}

/// `ServerMsg::Resync` without copying the result into a message.
fn resync_frame<G: Game>(sub: SubId, version: u64, hash: u64, result: &[u8]) -> Vec<u8> {
    let mut w = Writer::new();
    w.write_u8(tags::<G>().1);
    sub.encode(&mut w);
    version.encode(&mut w);
    w.write_str(&diff::hash_hex(hash));
    w.write_len(result.len());
    w.write_raw(result);
    w.into_bytes()
}
