//! The sync layer: live queries ([`crate::Query`]) kept current with
//! keyed diffs.
//!
//! - **Shared computation.** Subscriptions are shared by `(query,
//!   arguments, player, view)`, where the player counts only for per-player
//!   queries and the view only for a query with a view function
//!   ([`Query::with_view`](crate::Query::with_view)). Each shared entry runs, encodes and hashes its result once
//!   per flush; a subscriber keeps only a reference to the last value it
//!   was sent.
//! - **Views.** When a connection's interest changes, each of its
//!   subscriptions whose view changed moves to the entry for its new view
//!   and gets a patch from what it was last sent.
//! - **Dependency tracking.** A run records what it read
//!   ([`Reads`](crate::Reads)); after a batch of changes only entries
//!   whose reads intersect them, whose results expired (`valid_until`), or
//!   that are volatile (after anything changed) run again. An unchanged
//!   result sends nothing.
//! - **Diffs.** A changed result goes to each subscriber as an `Update`
//!   patching the last value that subscriber was sent
//!   ([`tc_wire::diff`]), or as a `Resync` when the patch would not be
//!   smaller. Both carry the result's hash, so a small result is patched
//!   whenever its patch is smaller. Subscribers holding the same old value share one diff.
//! - **Flushes.** The loop flushes at most every
//!   [`FLUSH_INTERVAL`](crate::FLUSH_INTERVAL) for everyone, and at once
//!   for a client whose command or subscription needs it. A client over
//!   its byte budget is skipped and keeps its subscriptions pending; its
//!   next flush diffs from what it last received, skipping intermediate
//!   states.
//! - **Resume.** Each entry keeps its last [`HISTORY`] results. An entry
//!   nobody subscribes to is kept idle for [`RESUME_GRACE`] if it has a
//!   result to resume from (at most [`MAX_IDLE_PER_CONNECTION`] left
//!   behind per connection and [`MAX_IDLE`] in all, oldest dropped
//!   first); idle entries are out of every index. A `Subscribe` that names
//!   a result by hash gets a patch from it if the entry still has it, and
//!   nothing at all if the result has not changed since.
//! - **Verification.** With [`SyncConfig::verify`] (on in debug builds),
//!   every flush also reruns clean entries and counts any whose result
//!   changed without a tracked change (a missing mark or read):
//!   [`SyncStats::tracking_misses`]. Time-dependent results are compared
//!   only at the time they ran. The new result is sent, so clients stay
//!   correct.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tc_net::{ConnId, Resume};
use tc_wire::diff;
use tc_wire::schema::{Schema, TypeRef};

use crate::game::{Game, PlayerId};
use crate::query::{Key, Query, Reads, Registry};

mod flush;

/// A subscription id, the client's choice.
pub(crate) type SubId = u32;

/// Results each shared entry keeps for resuming.
pub const HISTORY: usize = 8;

/// How long an entry nobody subscribes to is kept, so a client that
/// reconnects can resume from it.
pub const RESUME_GRACE: Duration = Duration::from_secs(60);

/// Live queries one connection may hold.
pub const MAX_SUBSCRIPTIONS: usize = 256;

/// Idle entries one connection's unsubscribes and disconnect may leave
/// behind (as many as it may hold, so a client that drops can resume them
/// all); past it, its oldest are dropped.
pub const MAX_IDLE_PER_CONNECTION: usize = MAX_SUBSCRIPTIONS;

/// Idle entries kept in all; past it, the oldest are dropped.
pub const MAX_IDLE: usize = 16 * 1024;

/// How the sync layer runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncConfig {
    /// Rerun clean entries on every flush and count results that changed
    /// without a tracked change. Costs a full recompute per flush.
    pub verify: bool,
}

// Not derived: debug builds verify by default.
#[cfg_attr(not(debug_assertions), allow(clippy::derivable_impls))]
impl Default for SyncConfig {
    fn default() -> SyncConfig {
        SyncConfig {
            verify: cfg!(debug_assertions),
        }
    }
}

/// The sync layer's counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncStats {
    /// Query runs (verification reruns not counted).
    pub computes: u64,
    /// Verification reruns.
    pub verifications: u64,
    /// Results that changed without a tracked change (should stay 0).
    pub tracking_misses: u64,
    /// `Update` messages made.
    pub updates: u64,
    /// `Resync` messages made.
    pub resyncs: u64,
    /// Resumed subscriptions whose result had not changed (nothing sent).
    pub resumed: u64,
    /// Shared entries, idle ones included.
    pub entries: usize,
    /// Idle entries, kept for resuming.
    pub idle: usize,
}

/// One computed result.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Value {
    Ok {
        bytes: Vec<u8>,
        hash: u64,
    },
    /// The query failed; sent as `QueryFailed`.
    Failed(String),
}

impl Value {
    fn hash(&self) -> Option<u64> {
        match self {
            Value::Ok { hash, .. } => Some(*hash),
            Value::Failed(_) => None,
        }
    }
}

type EntryId = u64;

/// What makes two subscriptions share one computation.
type EntryKey = (&'static str, Vec<u8>, Option<PlayerId>, u32);

struct Entry<G: Game> {
    query: Arc<Query<G>>,
    result_ty: TypeRef,
    args: Vec<u8>,
    player: Option<PlayerId>,
    view: u32,
    value: Option<Arc<Value>>,
    /// What the last run read; empty (and out of the index) while idle.
    reads: Reads<G::Change>,
    computed_at: u64,
    computed_version: u64,
    /// Recent results, oldest first.
    history: VecDeque<Arc<Value>>,
    subscribers: BTreeSet<(ConnId, SubId)>,
    idle: Option<Idle>,
}

#[derive(Clone, Copy)]
struct Idle {
    /// Its place in [`SyncLayer::idle`].
    seq: u64,
    /// The connection that left it idle.
    conn: ConnId,
    since: Instant,
}

struct Client {
    /// `None` for an observer.
    player: Option<PlayerId>,
    subs: BTreeMap<SubId, ClientSub>,
    /// Subscriptions whose entry's value may differ from what was sent.
    pending: BTreeSet<SubId>,
}

struct ClientSub {
    entry: EntryId,
    /// The last value sent.
    sent: Option<Arc<Value>>,
    /// Before the first send: the hash of the result the client holds.
    resume: Option<u64>,
}

/// What the queries run against at a flush.
pub(crate) struct World<'a, G: Game> {
    pub(crate) game: &'a G,
    pub(crate) time: u64,
    pub(crate) version: u64,
    pub(crate) bodies: &'a BTreeMap<PlayerId, G::Body>,
}

/// Every connection's live queries and the shared entries behind them.
pub(crate) struct SyncLayer<G: Game> {
    config: SyncConfig,
    schema: Arc<Schema>,
    queries: Registry<G>,
    entries: BTreeMap<EntryId, Entry<G>>,
    by_key: HashMap<EntryKey, EntryId>,
    by_read: BTreeMap<Key<G::Change>, BTreeSet<EntryId>>,
    volatile: BTreeSet<EntryId>,
    expiring: BTreeSet<(u64, EntryId)>,
    /// Subscribed entries to run on the next flush.
    dirty: BTreeSet<EntryId>,
    /// Idle entries, oldest first, by [`Idle::seq`].
    idle: BTreeMap<u64, EntryId>,
    idle_by_conn: HashMap<ConnId, BTreeSet<u64>>,
    next_idle: u64,
    next_id: EntryId,
    clients: BTreeMap<ConnId, Client>,
    stats: SyncStats,
    /// Some query has a view function.
    views: bool,
}

impl<G: Game> SyncLayer<G> {
    pub(crate) fn new(config: SyncConfig, schema: Arc<Schema>, queries: Registry<G>) -> Self {
        let views = queries.values().any(|q| q.view.is_some());
        SyncLayer {
            views,
            config,
            schema,
            queries,
            entries: BTreeMap::new(),
            by_key: HashMap::new(),
            by_read: BTreeMap::new(),
            volatile: BTreeSet::new(),
            expiring: BTreeSet::new(),
            dirty: BTreeSet::new(),
            idle: BTreeMap::new(),
            idle_by_conn: HashMap::new(),
            next_idle: 0,
            next_id: 0,
            clients: BTreeMap::new(),
            stats: SyncStats::default(),
        }
    }

    /// The query named `name`, if the game serves one.
    pub(crate) fn query(&self, name: &str) -> Option<&Arc<Query<G>>> {
        self.queries.get(name)
    }

    pub(crate) fn stats(&self) -> SyncStats {
        SyncStats {
            entries: self.entries.len(),
            idle: self.idle.len(),
            ..self.stats
        }
    }

    /// Adds a connection: `player`'s, or an observer's (`None`).
    pub(crate) fn connect(&mut self, conn: ConnId, player: Option<PlayerId>) {
        self.clients.insert(
            conn,
            Client {
                player,
                subs: BTreeMap::new(),
                pending: BTreeSet::new(),
            },
        );
    }

    /// Removes a connection; entries only it subscribed to go idle.
    pub(crate) fn disconnect(&mut self, conn: ConnId, now: Instant) {
        if let Some(client) = self.clients.remove(&conn) {
            for (sub, cs) in client.subs {
                self.detach(conn, sub, cs.entry, now);
            }
        }
    }

    /// True if `conn` has subscriptions waiting to be sent.
    pub(crate) fn pending(&self, conn: ConnId) -> bool {
        self.clients
            .get(&conn)
            .is_some_and(|c| !c.pending.is_empty())
    }

    /// True if some query has a view function.
    pub(crate) fn has_views(&self) -> bool {
        self.views
    }

    /// Adds subscription `sub` to `query` with `args`, replacing any of
    /// that id, in the view
    /// `view` gives it (0 without a view function); its first
    /// message goes out on the connection's next flush. Fails for an
    /// unknown query, arguments that don't decode exactly, a per-player
    /// query from an observer, or one subscription too many. A replacement
    /// that fails still ends the subscription it replaced.
    pub(crate) fn subscribe(
        &mut self,
        conn: ConnId,
        sub: SubId,
        (query, args): (&str, Vec<u8>),
        resume: Option<&Resume>,
        now: Instant,
        view: impl FnOnce(&Query<G>, &[u8]) -> u32,
    ) -> Result<(), String> {
        let player = self.clients.get(&conn).ok_or("not connected")?.player;
        self.unsubscribe(conn, sub, now);
        let query = self
            .queries
            .get(query)
            .cloned()
            .ok_or_else(|| format!("no query {query:?}"))?;
        (query.check)(&args)?;
        let player = match (query.player, player) {
            (false, _) => None,
            (true, Some(player)) => Some(player),
            (true, None) => return Err(format!("{}: an observer asks as no one", query.name)),
        };
        if self.clients[&conn].subs.len() >= MAX_SUBSCRIPTIONS {
            return Err(format!("at most {MAX_SUBSCRIPTIONS} subscriptions"));
        }
        let view = view(&query, &args);
        let key = (query.name, args, player, view);
        let id = self.entry_for(query, key);
        self.entries
            .get_mut(&id)
            .expect("just found or made")
            .subscribers
            .insert((conn, sub));
        let client = self.clients.get_mut(&conn).expect("checked above");
        client.subs.insert(
            sub,
            ClientSub {
                entry: id,
                sent: None,
                resume: resume.and_then(|r| diff::parse_hash_hex(&r.hash)),
            },
        );
        client.pending.insert(sub);
        Ok(())
    }

    /// Works out the view of each of `conn`'s subscriptions to a query
    /// with a view function again (`view`): one whose view changed moves
    /// to the entry for its new view, and gets a patch from what it was
    /// last sent at its next flush. True if any moved.
    pub(crate) fn review(
        &mut self,
        conn: ConnId,
        now: Instant,
        mut view: impl FnMut(&Query<G>, &[u8]) -> u32,
    ) -> bool {
        let Some(client) = self.clients.get(&conn) else {
            return false;
        };
        let moves: Vec<(SubId, EntryId, EntryKey, Arc<Query<G>>)> = client
            .subs
            .iter()
            .filter_map(|(sub, cs)| {
                let e = self.entries.get(&cs.entry)?;
                e.query.view.as_ref()?;
                let new = view(&e.query, &e.args);
                (new != e.view).then(|| {
                    let key = (e.query.name, e.args.clone(), e.player, new);
                    (*sub, cs.entry, key, e.query.clone())
                })
            })
            .collect();
        let moved = !moves.is_empty();
        for (sub, old, key, query) in moves {
            let id = self.entry_for(query, key);
            self.entries
                .get_mut(&id)
                .expect("just found or made")
                .subscribers
                .insert((conn, sub));
            let client = self.clients.get_mut(&conn).expect("found above");
            if let Some(cs) = client.subs.get_mut(&sub) {
                cs.entry = id;
                cs.resume = None;
            }
            client.pending.insert(sub);
            self.detach(conn, sub, old, now);
        }
        moved
    }

    /// Removes subscription `sub`; false if there was none.
    pub(crate) fn unsubscribe(&mut self, conn: ConnId, sub: SubId, now: Instant) -> bool {
        let Some(cs) = self.clients.get_mut(&conn).and_then(|c| {
            c.pending.remove(&sub);
            c.subs.remove(&sub)
        }) else {
            return false;
        };
        self.detach(conn, sub, cs.entry, now);
        true
    }

    /// The entry for `key`, made (to run on the next flush) if there is
    /// none, and back from idle if it was idle.
    fn entry_for(&mut self, query: Arc<Query<G>>, key: EntryKey) -> EntryId {
        let id = match self.by_key.get(&key) {
            Some(id) => *id,
            None => {
                let id = self.next_id;
                self.next_id += 1;
                let result_ty = self
                    .schema
                    .query(query.name)
                    .map_or(TypeRef::Bytes, |q| q.result.clone());
                self.entries.insert(
                    id,
                    Entry {
                        query,
                        result_ty,
                        args: key.1.clone(),
                        player: key.2,
                        view: key.3,
                        value: None,
                        reads: Reads::default(),
                        computed_at: 0,
                        computed_version: 0,
                        history: VecDeque::new(),
                        subscribers: BTreeSet::new(),
                        idle: None,
                    },
                );
                self.by_key.insert(key, id);
                self.dirty.insert(id);
                id
            }
        };
        if let Some(idle) = self.entries.get_mut(&id).and_then(|e| e.idle.take()) {
            // Back from idle: nothing tracked its reads meanwhile.
            self.unqueue_idle(idle);
            self.dirty.insert(id);
        }
        id
    }

    /// Removes one subscriber from entry `id`; an entry left with none is
    /// kept idle if it has a result to resume from, else dropped.
    fn detach(&mut self, conn: ConnId, sub: SubId, id: EntryId, now: Instant) {
        let Some(entry) = self.entries.get_mut(&id) else {
            return;
        };
        entry.subscribers.remove(&(conn, sub));
        if !entry.subscribers.is_empty() {
            return;
        }
        if entry.history.is_empty() {
            self.remove(id);
            return;
        }
        let reads = std::mem::take(&mut entry.reads);
        let seq = self.next_idle;
        self.next_idle += 1;
        entry.idle = Some(Idle {
            seq,
            conn,
            since: now,
        });
        self.dirty.remove(&id);
        self.reindex(id, &reads);
        self.idle.insert(seq, id);
        let mine = self.idle_by_conn.entry(conn).or_default();
        mine.insert(seq);
        let evict = mine.len().saturating_sub(MAX_IDLE_PER_CONNECTION);
        let oldest: Vec<u64> = mine.iter().take(evict).copied().collect();
        for seq in oldest {
            self.remove(self.idle[&seq]);
        }
        while self.idle.len() > MAX_IDLE {
            let id = *self.idle.first_key_value().expect("over the cap").1;
            self.remove(id);
        }
    }

    fn unqueue_idle(&mut self, idle: Idle) {
        self.idle.remove(&idle.seq);
        if let Some(mine) = self.idle_by_conn.get_mut(&idle.conn) {
            mine.remove(&idle.seq);
            if mine.is_empty() {
                self.idle_by_conn.remove(&idle.conn);
            }
        }
    }

    /// Drops entry `id` and every index entry for it.
    fn remove(&mut self, id: EntryId) {
        let Some(entry) = self.entries.get_mut(&id) else {
            return;
        };
        let reads = std::mem::take(&mut entry.reads);
        let idle = entry.idle.take();
        self.reindex(id, &reads);
        if let Some(idle) = idle {
            self.unqueue_idle(idle);
        }
        self.dirty.remove(&id);
        let entry = self.entries.remove(&id).expect("found above");
        self.by_key
            .remove(&(entry.query.name, entry.args, entry.player, entry.view));
    }
}
