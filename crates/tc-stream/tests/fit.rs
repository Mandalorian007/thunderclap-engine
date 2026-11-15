//! The stream under a game shaped like Forge Wilds: a voxel world whose
//! sections carry two layers (a climate per column, sent once for every
//! section in it, and what lies on each section's ground, sent whole then
//! as changes), changes no one waits for (sealed caves found, re-sent in
//! the bulk lane), a command's sender seeing its own change first, loads
//! between ticks, and time budgets.

mod common;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Client, FakeLanes, World};
use tc_net::ConnId;
use tc_stream::{
    Area, FrameKind, GroupClaim, IdleBudget, LayerClaim, LayerFrom, LayerOrder, Loading, Marks,
    SectionPos, SectionSource, SectionStream, Stamp, StreamConfig, StreamEvent, StreamInterest,
    StreamMsg,
};
use tc_wire::Wire;

const A: ConnId = 1;
const B: ConnId = 2;
const C: ConnId = 3;
const CLIMATE: usize = 0;
const PILES: usize = 1;

fn at(x: i32, y: i32, z: i32) -> SectionPos {
    SectionPos::new(x, y, z)
}

fn area(x: i32, y: i32, z: i32, r: u8) -> Area {
    Area::new(at(x, y, z), r, r, r)
}

/// A voxel world with a climate per column and piles per section.
struct Voxels {
    world: World,
    climate: RefCell<HashMap<(i32, i32), u8>>,
    piles: RefCell<HashMap<SectionPos, Vec<u8>>>,
    /// `cells` decodes, counted (an `Edit` is worked out from two).
    decodes: Cell<usize>,
    /// `layer_frame` calls, counted.
    frames: Cell<usize>,
    /// Piles go before their sections.
    piles_before: Cell<bool>,
    /// Building the key puts a pile on the value and marks it (as faces
    /// worked out from a neighbour).
    spills: RefCell<HashMap<SectionPos, SectionPos>>,
    spilled: Vec<SectionPos>,
}

impl Voxels {
    fn new() -> Voxels {
        Voxels {
            world: World::new(4),
            climate: RefCell::default(),
            piles: RefCell::default(),
            decodes: Cell::new(0),
            frames: Cell::new(0),
            piles_before: Cell::new(false),
            spills: RefCell::default(),
            spilled: Vec::new(),
        }
    }

    fn climate_of(&self, x: i32, z: i32) -> u8 {
        self.climate
            .borrow()
            .get(&(x, z))
            .copied()
            .unwrap_or(((x * 3 + z) & 7) as u8)
    }

    fn piles_of(&self, pos: SectionPos) -> Vec<u8> {
        self.piles.borrow().get(&pos).cloned().unwrap_or_default()
    }
}

/// A layer frame: tag 1, layer, whole (0) or change (1), the key, the
/// state it changes from (empty when whole), then the state.
fn layer_bytes(layer: usize, key: SectionPos, from: Option<&[u8]>, to: &[u8], out: &mut Vec<u8>) {
    out.clear();
    out.extend([1, layer as u8, u8::from(from.is_some())]);
    for c in [key.x, key.y, key.z] {
        out.extend(c.to_le_bytes());
    }
    let from = from.unwrap_or(&[]);
    out.push(from.len() as u8);
    out.extend(from);
    out.extend(to);
}

impl SectionSource for Voxels {
    fn build(&mut self, pos: SectionPos, out: &mut Vec<u8>) {
        self.world.build(pos, out);
        if let Some(to) = self.spills.borrow().get(&pos).copied() {
            let mut piles = self.piles.borrow_mut();
            let pile = piles.entry(to).or_default();
            pile.push(pile.len() as u8 + 1);
            self.spilled.push(to);
        }
    }

    fn take_marks(&mut self, marks: &mut Marks) {
        for to in self.spilled.drain(..) {
            marks.changed_derived(to);
            marks.layer_changed(PILES, to);
        }
    }

    fn exists(&self, pos: SectionPos) -> bool {
        self.world.exists(pos)
    }

    fn cells(&self, bytes: &[u8], out: &mut Vec<u32>) -> bool {
        self.decodes.set(self.decodes.get() + 1);
        self.world.cells(bytes, out)
    }

    fn layer_order(&self, layer: usize) -> LayerOrder {
        if layer == PILES && self.piles_before.get() {
            LayerOrder::Before
        } else {
            LayerOrder::After
        }
    }

    fn layers(&self) -> usize {
        2
    }

    fn layer_key(&self, layer: usize, pos: SectionPos) -> SectionPos {
        if layer == CLIMATE {
            at(pos.x, 0, pos.z)
        } else {
            pos
        }
    }

    fn layer_state(&self, layer: usize, key: SectionPos, out: &mut Vec<u8>) {
        out.clear();
        if layer == CLIMATE {
            out.push(self.climate_of(key.x, key.z));
        } else {
            out.extend(self.piles_of(key));
        }
    }

    fn layer_frame(
        &self,
        layer: usize,
        key: SectionPos,
        from: LayerFrom<'_>,
        to: &[u8],
        out: &mut Vec<u8>,
    ) {
        self.frames.set(self.frames.get() + 1);
        match from {
            LayerFrom::Nothing if layer == PILES && to.is_empty() => {
                out.clear(); // nothing lies there: nothing to send
            }
            LayerFrom::State(from) => layer_bytes(layer, key, Some(from), to, out),
            _ => layer_bytes(layer, key, None, to, out),
        }
    }
}

/// What arrives: a stream message, or a layer frame.
#[derive(Debug)]
enum Frame {
    Stream(StreamMsg),
    Layer {
        layer: usize,
        key: SectionPos,
        from: Option<Vec<u8>>,
        to: Vec<u8>,
    },
}

fn decode(f: &[u8]) -> Frame {
    if f[0] == 0 {
        return Frame::Stream(StreamMsg::from_bytes(&f[1..]).unwrap());
    }
    let c = |i: usize| i32::from_le_bytes(f[i..i + 4].try_into().unwrap());
    let n = f[15] as usize;
    Frame::Layer {
        layer: f[1] as usize,
        key: at(c(3), c(7), c(11)),
        from: (f[2] == 1).then(|| f[16..16 + n].to_vec()),
        to: f[16 + n..].to_vec(),
    }
}

fn new_stream(config: StreamConfig) -> SectionStream {
    SectionStream::new(config, |m: &StreamMsg| {
        let mut f = vec![0];
        f.extend(m.to_bytes());
        f
    })
}

/// Delivers a lane: priority first, then bulk frames not withdrawn.
fn drain(lanes: &mut FakeLanes, conn: ConnId) -> (Vec<Frame>, Vec<Frame>) {
    let lane = lanes.lane(conn);
    let priority = lane.priority.drain(..).map(|f| decode(&f)).collect();
    let bulk = lane
        .bulk
        .drain(..)
        .filter(|(_, t)| t.as_ref().is_none_or(|t| t.take()))
        .map(|(f, _)| decode(&f))
        .collect();
    (priority, bulk)
}

/// A client: sections and the layers it holds.
struct Player {
    client: Client,
    layers: BTreeMap<(usize, SectionPos), Vec<u8>>,
    whole: usize,
    changes: usize,
}

impl Player {
    fn new() -> Player {
        Player {
            client: Client::new(64),
            layers: BTreeMap::new(),
            whole: 0,
            changes: 0,
        }
    }

    fn apply(&mut self, frames: Vec<Frame>) {
        for f in frames {
            match f {
                Frame::Stream(m) => {
                    self.client.apply(vec![m]);
                }
                Frame::Layer {
                    layer,
                    key,
                    from,
                    to,
                } => {
                    match from {
                        Some(from) => {
                            // (Nothing held is an empty state: none was sent.)
                            let held = self.layers.get(&(layer, key)).map_or(&[][..], |v| v);
                            assert_eq!(held, from, "a change from the state held");
                            self.changes += 1;
                        }
                        None => {
                            let held = self.client.held.keys();
                            let mut brought = held.filter(|p| {
                                (layer == CLIMATE && p.x == key.x && p.z == key.z) || **p == key
                            });
                            assert!(brought.next().is_some(), "{key:?} behind its section");
                            self.whole += 1;
                        }
                    }
                    self.layers.insert((layer, key), to);
                }
            }
        }
    }
}

struct Game {
    src: Voxels,
    stream: SectionStream,
    lanes: FakeLanes,
    players: BTreeMap<ConnId, Player>,
}

impl Game {
    fn new(config: StreamConfig) -> Game {
        Game {
            src: Voxels::new(),
            stream: new_stream(config),
            lanes: FakeLanes::default(),
            players: BTreeMap::new(),
        }
    }

    fn join(&mut self, conn: ConnId, a: Area) {
        self.stream.connect(conn);
        self.stream.set_interest(conn, a, &[]).unwrap();
        self.players.insert(conn, Player::new());
    }

    fn deliver(&mut self) {
        for (conn, p) in &mut self.players {
            let (priority, bulk) = drain(&mut self.lanes, *conn);
            p.apply(priority);
            p.apply(bulk);
        }
    }

    fn settle(&mut self) -> usize {
        for i in 1..=200 {
            self.stream.flush(&mut self.src, &mut self.lanes);
            self.deliver();
            if !self.stream.has_work() {
                return i;
            }
        }
        panic!("still busy");
    }

    fn player(&self, conn: ConnId) -> &Player {
        &self.players[&conn]
    }

    /// The client holds every layer of its sections as the world has them.
    fn check(&self, conn: ConnId) {
        let p = self.player(conn);
        self.src.world.check(&p.client);
        let mut want = BTreeMap::new();
        for pos in p.client.held.keys() {
            want.insert(
                (CLIMATE, at(pos.x, 0, pos.z)),
                vec![self.src.climate_of(pos.x, pos.z)],
            );
            let piles = self.src.piles_of(*pos);
            if !piles.is_empty() || p.layers.contains_key(&(PILES, *pos)) {
                want.insert((PILES, *pos), piles);
            }
        }
        let have: BTreeMap<_, _> = p
            .layers
            .iter()
            .filter(|(k, _)| want.contains_key(k))
            .map(|(k, v)| (*k, v.clone()))
            .collect();
        assert_eq!(have, want);
    }
}

#[test]
fn layers_come_whole_behind_their_sections_once_per_key() {
    let mut g = Game::new(StreamConfig::default());
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![3, 1]);
    g.src.piles.borrow_mut().insert(at(1, -1, 0), vec![9]);
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    g.check(A);
    let p = g.player(A);
    // 9 columns' climates and the two piles, each once.
    assert_eq!(p.whole, 9 + 2);
    assert_eq!(p.changes, 0);
    assert_eq!(g.stream.stats().layer_frames, 11);
}

#[test]
fn a_layer_change_is_sent_on_the_priority_lane() {
    let mut g = Game::new(StreamConfig::default());
    g.join(A, area(0, 0, 0, 1));
    g.join(B, area(5, 0, 0, 1));
    g.settle();
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![4]);
    g.stream.layer_changed(PILES, at(0, 0, 0));
    g.src.piles.borrow_mut().insert(at(1, 1, 0), vec![5]);
    g.stream.layer_changed(PILES, at(1, 1, 0));
    g.src.climate.borrow_mut().insert((1, 1), 99);
    g.stream.layer_changed(CLIMATE, at(1, 0, 1));
    assert!(g.stream.has_work());
    g.stream.flush(&mut g.src, &mut g.lanes);
    assert!(
        g.lanes.lane(A).bulk.is_empty(),
        "nothing waits behind loads"
    );
    assert_eq!(g.lanes.lane(A).priority.len(), 3);
    assert!(g.lanes.lane(B).priority.is_empty(), "B holds none of them");
    g.deliver();
    assert_eq!(g.player(A).changes, 3);
    g.check(A);
    g.check(B);
    // Nothing changed after all: nothing sent.
    g.stream.layer_changed(PILES, at(0, 0, 0));
    g.stream.flush(&mut g.src, &mut g.lanes);
    assert!(g.lanes.lane(A).priority.is_empty());
}

#[test]
fn a_layer_change_still_queued_is_folded_into_its_whole_frame() {
    let mut g = Game::new(StreamConfig::default());
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![1]);
    g.join(A, area(0, 0, 0, 1));
    g.stream.flush(&mut g.src, &mut g.lanes);
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![2]);
    g.stream.layer_changed(PILES, at(0, 0, 0));
    g.src.climate.borrow_mut().insert((0, 0), 42);
    g.stream.layer_changed(CLIMATE, at(0, 0, 0));
    g.stream.flush(&mut g.src, &mut g.lanes);
    assert!(
        g.lanes.lane(A).priority.is_empty(),
        "folded, not sent ahead"
    );
    g.deliver();
    g.settle();
    let p = g.player(A);
    assert_eq!(p.changes, 0);
    assert_eq!(p.whole, 9 + 1, "each key arrived whole once");
    g.check(A);
}

#[test]
fn layers_follow_the_sections_held() {
    let mut g = Game::new(StreamConfig {
        hysteresis: 0,
        ..StreamConfig::default()
    });
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![7]);
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    // Away and back: the column and its piles come whole again.
    g.stream.set_interest(A, area(20, 0, 0, 1), &[]).unwrap();
    g.settle();
    // A change while away is not sent (no one holds it).
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![8]);
    g.stream.layer_changed(PILES, at(0, 0, 0));
    g.settle();
    assert_eq!(g.player(A).changes, 0);
    g.stream.set_interest(A, area(0, 0, 0, 1), &[]).unwrap();
    g.settle();
    g.check(A);
    assert_eq!(g.player(A).whole, (9 + 1) + 9 + (9 + 1));
    // Moving within a column keeps its climate: rising one section sends
    // no climate again.
    let before = g.player(A).whole;
    g.stream.set_interest(A, area(0, 1, 0, 1), &[]).unwrap();
    g.settle();
    assert_eq!(g.player(A).whole, before);
    g.check(A);
}

#[test]
fn a_reload_sends_only_the_layers_that_changed() {
    let mut g = Game::new(StreamConfig::default());
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    g.src.climate.borrow_mut().insert((0, 0), 77);
    g.stream.reload();
    g.settle();
    let p = g.player(A);
    assert_eq!(p.whole, 9 + 1, "only the column that changed again");
    assert_eq!(g.stream.stats().layer_resumed, 8);
    assert_eq!(p.client.sections, 27, "no section again");
    g.check(A);
}

#[test]
fn a_background_change_is_sent_again_in_the_bulk_lane() {
    let mut g = Game::new(StreamConfig::default());
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    let pos = at(0, 0, 0);
    let mut cells = g.src.world.cells_of(pos);
    cells[5] = 3;
    g.src.world.edits.borrow_mut().insert(pos, cells);
    g.stream.changed_bulk(pos);
    g.stream.flush(&mut g.src, &mut g.lanes);
    assert!(g.lanes.lane(A).priority.is_empty());
    assert_eq!(g.lanes.lane(A).bulk.len(), 1);
    g.deliver();
    g.check(A);
    assert_eq!(g.stream.stats().bulk_resends, 1);
    assert!(!g.stream.has_work());
    // `changed` wins over `changed_bulk` before the flush.
    g.src.world.set(&mut g.stream, pos, 6, 2);
    g.stream.changed_bulk(pos);
    g.stream.flush(&mut g.src, &mut g.lanes);
    assert_eq!(g.lanes.lane(A).priority.len(), 1);
    g.deliver();
    g.check(A);
    assert_eq!(g.stream.stats().bulk_resends, 1);
}

#[test]
fn a_background_change_to_a_queued_section_replaces_it() {
    let mut g = Game::new(StreamConfig::default());
    g.join(A, area(0, 0, 0, 1));
    g.stream.flush(&mut g.src, &mut g.lanes);
    let pos = at(0, 0, 0);
    let mut cells = g.src.world.cells_of(pos);
    cells[1] = 4;
    g.src.world.edits.borrow_mut().insert(pos, cells);
    g.stream.changed_bulk(pos);
    g.settle();
    g.check(A);
    assert_eq!(g.player(A).client.sections, 27, "sent once, the new one");
}

#[test]
fn flush_conn_sends_one_connection_its_changes_past_the_budget() {
    let mut g = Game::new(StreamConfig {
        rebuild_budget: 1,
        ..StreamConfig::default()
    });
    g.join(A, area(0, 0, 0, 1));
    g.join(B, area(0, 0, 0, 1));
    g.settle();
    for x in -1..=1 {
        g.src.world.set(&mut g.stream, at(x, 0, 0), 0, 4);
    }
    g.stream.flush_conn(A, &mut g.src, &mut g.lanes);
    assert_eq!(
        g.lanes.lane(A).priority.len(),
        3,
        "all three, past the budget"
    );
    assert!(g.lanes.lane(B).priority.is_empty(), "B waits for the flush");
    g.settle();
    g.check(A);
    g.check(B);
    assert_eq!(g.player(A).client.edits, 3);
    assert_eq!(g.player(B).client.edits, 3);
}

#[test]
fn an_edit_is_worked_out_once_for_every_holder() {
    let mut g = Game::new(StreamConfig::default());
    for conn in [A, B, 3, 4] {
        g.join(conn, area(0, 0, 0, 1));
    }
    g.settle();
    g.src.decodes.set(0);
    g.src.world.set(&mut g.stream, at(0, 0, 0), 9, 7);
    g.settle();
    assert_eq!(g.src.decodes.get(), 2, "the old and the new, once");
    assert_eq!(g.stream.stats().edits, 4);
    for conn in [A, B, 3, 4] {
        g.check(conn);
    }
}

#[test]
fn load_until_builds_between_ticks_until_interrupted() {
    let mut g = Game::new(StreamConfig {
        build_budget: 1,
        ..StreamConfig::default()
    });
    g.join(A, area(0, 0, 0, 2));
    let far = Instant::now() + Duration::from_secs(5);
    assert_eq!(
        g.stream.load_until(&mut g.src, &mut g.lanes, far, || true),
        0,
        "a waiting request comes first"
    );
    let mut asked = 0;
    let built = g.stream.load_until(&mut g.src, &mut g.lanes, far, || {
        asked += 1;
        asked > 10
    });
    assert_eq!(built, 10);
    assert!(g.stream.loading());
    let rest = g.stream.load_until(&mut g.src, &mut g.lanes, far, || false);
    assert_eq!(10 + rest, 5 * 5 * 5);
    assert!(!g.stream.loading());
    assert_eq!(
        g.stream.load_until(&mut g.src, &mut g.lanes, far, || false),
        0
    );
    g.settle();
    g.check(A);
    assert_eq!(g.player(A).whole, 25, "the layers came with them");
    // A deadline passed builds nothing.
    g.stream.set_interest(A, area(30, 0, 0, 1), &[]).unwrap();
    let past = Instant::now();
    assert_eq!(
        g.stream
            .load_until(&mut g.src, &mut g.lanes, past, || false),
        0
    );
}

#[test]
fn time_budgets_bound_a_flush_but_always_build_one() {
    let mut g = Game::new(StreamConfig {
        load_time: Some(Duration::ZERO),
        rebuild_time: Some(Duration::ZERO),
        ..StreamConfig::default()
    });
    g.join(A, area(0, 0, 0, 1));
    let flushes = g.settle();
    assert_eq!(flushes, 27, "one build a flush");
    let stats = g.stream.stats();
    assert_eq!(stats.builds, 27);
    assert!(stats.build_nanos > 0);
    for x in -1..=1 {
        g.src.world.set(&mut g.stream, at(x, 0, 0), 0, 4);
    }
    g.stream.flush(&mut g.src, &mut g.lanes);
    assert_eq!(g.lanes.lane(A).priority.len(), 1, "one rebuild");
    g.settle();
    g.check(A);
}

impl Game {
    /// `conn` drops and comes back with the same view, claiming what it
    /// holds in groups along y (a column each), with its layers' digests.
    fn rejoin_grouped(&mut self, conn: ConnId, a: Area) {
        self.stream.disconnect(conn);
        drain(&mut self.lanes, conn);
        self.stream.connect(conn);
        let p = self.players.get_mut(&conn).unwrap();
        p.whole = 0;
        p.changes = 0;
        p.client.reset_counts();
        let mut groups = GroupClaim::group(1, p.client.held.iter().map(|(pos, (s, _))| (*pos, *s)));
        for g in &mut groups {
            for layer in [CLIMATE, PILES] {
                let mut seen = Vec::new();
                let mut pairs = Vec::new();
                for (pos, y) in g.members() {
                    let key = if layer == CLIMATE {
                        at(pos.x, 0, pos.z)
                    } else {
                        pos
                    };
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.push(key);
                    let state = p.layers.get(&(layer, key)).cloned().unwrap_or_default();
                    let stamp = if state.is_empty() {
                        0
                    } else {
                        tc_wire::stamp::bytes_stamp(&state)
                    };
                    pairs.push((y, stamp));
                }
                g.layers.push(GroupClaim::layer_digest(pairs));
            }
        }
        let interest = StreamInterest {
            area: a,
            holding: Vec::new(),
            groups,
            layers: Vec::new(),
        };
        self.stream.set_stream_interest(conn, &interest).unwrap();
    }
}

#[test]
fn a_client_resumes_by_groups_with_their_layers() {
    let mut g = Game::new(StreamConfig::default());
    g.src.piles.borrow_mut().insert(at(0, 1, 0), vec![5]);
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    // While it is away: a cell in column (0, 0), a pile in column (1, 1)
    // and the climate of column (-1, -1) change.
    g.src.world.set(&mut g.stream, at(0, 0, 0), 3, 9);
    g.src.piles.borrow_mut().insert(at(1, -1, 1), vec![6]);
    g.stream.layer_changed(PILES, at(1, -1, 1));
    g.src.climate.borrow_mut().insert((-1, -1), 50);
    g.stream.layer_changed(CLIMATE, at(-1, 0, -1));
    g.rejoin_grouped(A, area(0, 0, 0, 1));
    assert_eq!(g.stream.claims_pending(A), 27);
    g.settle();
    g.check(A);
    let stats = g.stream.stats();
    assert_eq!(
        (
            stats.group_claims,
            stats.groups_held,
            stats.groups_different
        ),
        (9, 8, 1)
    );
    let p = g.player(A);
    assert_eq!(p.client.sections, 3, "only the column that changed");
    // Climate (-1, -1), and column (1, 1)'s three piles: its digest no
    // longer matches, so each key is sent whole from an unknown state (the
    // two empty ones too, to clear whatever it holds). Column (0, 0)'s
    // pile was kept.
    assert_eq!(p.whole, 4);
    assert_eq!(stats.layer_resumed, 8 + 1);
    assert_eq!(g.stream.claims_pending(A), 0);
    assert_eq!(g.stream.held(A), 27);
}

#[test]
fn a_group_reaching_outside_the_area_is_sent_again() {
    let mut g = Game::new(StreamConfig::default());
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    g.stream.disconnect(A);
    g.stream.connect(A);
    let p = g.players.get_mut(&A).unwrap();
    p.client.reset_counts();
    // Claims the column at (0, 0) and one section above the view.
    let mut held: Vec<(SectionPos, u64)> = (-1..=1)
        .map(|y| (at(0, y, 0), p.client.held[&at(0, y, 0)].0))
        .collect();
    held.push((at(0, 2, 0), 1));
    let groups = GroupClaim::group(1, held);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].held, 0b1111);
    let interest = StreamInterest {
        area: area(0, 0, 0, 1),
        groups,
        ..StreamInterest::default()
    };
    g.stream.set_stream_interest(A, &interest).unwrap();
    g.settle();
    g.check(A);
    let p = g.player(A);
    assert_eq!(p.client.sections, 27, "the column too, whole");
    assert_eq!(p.client.unloaded, 1, "the section outside");
    assert_eq!(g.stream.stats().groups_held, 0);
}

#[test]
fn layer_claims_keep_states_a_client_holds() {
    let mut g = Game::new(StreamConfig::default());
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![1, 2]);
    g.join(A, area(0, 0, 0, 0));
    g.settle();
    assert_eq!(g.player(A).whole, 2);
    g.stream.disconnect(A);
    g.stream.connect(A);
    let p = g.players.get_mut(&A).unwrap();
    p.whole = 0;
    let layers = p
        .layers
        .iter()
        .map(|(&(layer, key), state)| LayerClaim {
            layer: layer as u32,
            key,
            stamp: Stamp::of(tc_wire::stamp::bytes_stamp(state)),
        })
        .collect();
    let interest = StreamInterest {
        area: area(0, 0, 0, 0),
        holding: p.client.claims(),
        layers,
        ..StreamInterest::default()
    };
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![3]);
    g.stream.set_stream_interest(A, &interest).unwrap();
    g.settle();
    g.check(A);
    // The climate kept; the piles changed, so sent again.
    assert_eq!(g.player(A).whole, 1);
    assert_eq!(g.stream.stats().layer_resumed, 1);
}

#[test]
fn check_claims_looks_at_claims_before_the_load_does() {
    let mut g = Game::new(StreamConfig {
        build_budget: 1,
        ..StreamConfig::default()
    });
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    g.src.world.set(&mut g.stream, at(1, 1, 1), 0, 2);
    g.rejoin_grouped(A, area(0, 0, 0, 1));
    let claims = g.player(A).client.claims();
    g.stream.disconnect(A);
    g.stream.connect(A);
    g.stream.set_interest(A, area(0, 0, 0, 1), &claims).unwrap();
    let sections = g.stream.stats().sections;
    // Around (1, 1, 1) only: 8 sections, whatever the build budget.
    g.stream.check_claims(
        A,
        Some((at(0, 0, 0), at(1, 1, 1))),
        &mut g.src,
        &mut g.lanes,
    );
    assert_eq!(g.stream.held(A), 8);
    assert_eq!(g.stream.claims_pending(A), 27 - 8);
    assert_eq!(
        g.stream.stats().sections - sections,
        1,
        "the one that changed, queued at once"
    );
    g.stream.check_claims(A, None, &mut g.src, &mut g.lanes);
    assert_eq!(g.stream.claims_pending(A), 0);
    g.settle();
    g.check(A);
    assert_eq!(g.player(A).client.sections, 1);
}

#[test]
fn group_claims_split_runs_per_line_and_at_the_bitmap() {
    let held = (0..40)
        .map(|y| (at(2, y, 3), y as u64 + 1))
        .chain([(at(5, 0, 3), 9)]);
    let groups = GroupClaim::group(1, held);
    assert_eq!(groups.len(), 3);
    assert_eq!((groups[0].start, groups[0].held), (at(2, 0, 3), u32::MAX));
    assert_eq!((groups[1].start, groups[1].held), (at(2, 32, 3), 0xff));
    assert_eq!((groups[2].start, groups[2].held), (at(5, 0, 3), 1));
    let members: Vec<_> = groups[1].members().collect();
    assert_eq!(members.first(), Some(&(at(2, 32, 3), 32)));
    assert_eq!(members.len(), 8);
    assert_eq!(
        groups[1].digest,
        GroupClaim::digest_of((32..40).map(|y| (y, y as u64 + 1)))
    );
    assert_eq!(GroupClaim::layer_digest([(0, 0), (1, 0)]), None);
}

#[test]
fn idle_builds_within_its_budget_and_holds() {
    let mut g = Game::new(StreamConfig {
        build_budget: 1,
        ..StreamConfig::default()
    });
    g.join(A, area(0, 0, 0, 2));
    let far = Instant::now() + Duration::from_secs(5);
    assert!(g.stream.idle_left());
    let mut asked = 0;
    g.stream.idle(&mut g.src, &mut g.lanes, far, || {
        asked += 1;
        asked > 4
    });
    let stats = g.stream.stats();
    assert_eq!(
        stats.idle_builds, 5,
        "the first whatever it says, then asked before each"
    );
    assert_eq!(asked, 5);
    assert!(stats.idle_nanos > 0);
    // Held, with no held spread: no idle time.
    let mut g = Game::new(StreamConfig {
        idle: IdleBudget {
            held: Duration::ZERO,
            ..IdleBudget::default()
        },
        ..StreamConfig::default()
    });
    g.join(A, area(0, 0, 0, 2));
    g.stream.hold_idle(far);
    assert!(g.stream.idle_held(Instant::now()));
    assert!(!g.stream.idle_left());
    assert_eq!(
        g.stream.idle(&mut g.src, &mut g.lanes, far, || false),
        Duration::ZERO
    );
    assert_eq!(g.stream.stats().idle_holds, 1);
    // No budget at all: nothing.
    let mut g = Game::new(StreamConfig {
        idle: IdleBudget {
            spread: Duration::ZERO,
            held: Duration::ZERO,
            extra: Duration::ZERO,
        },
        ..StreamConfig::default()
    });
    g.join(A, area(0, 0, 0, 2));
    assert!(!g.stream.idle_left());
    // A generous one loads the view between flushes.
    let mut g = Game::new(StreamConfig {
        idle: IdleBudget {
            spread: Duration::from_secs(5),
            ..IdleBudget::default()
        },
        ..StreamConfig::default()
    });
    g.join(A, area(0, 0, 0, 2));
    g.stream.idle(&mut g.src, &mut g.lanes, far, || false);
    assert!(!g.stream.loading());
    assert_eq!(g.stream.stats().idle_builds, 125);
    g.settle();
    g.check(A);
}

#[test]
fn an_observer_sees_builds_and_frames() {
    #[derive(Default)]
    struct Seen {
        built: u64,
        bytes: u64,
        sections: u64,
        claimed: u64,
    }
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mut g = Game::new(StreamConfig::default());
    let s = seen.clone();
    g.stream.set_observer(Some(Box::new(move |e: &StreamEvent| {
        let mut s = s.lock().unwrap();
        match *e {
            StreamEvent::Built { .. } => s.built += 1,
            StreamEvent::Queued { kind, bytes, .. } => {
                s.bytes += bytes as u64;
                s.sections += u64::from(kind == FrameKind::Section);
            }
            StreamEvent::Claimed { .. } | StreamEvent::Group { .. } => s.claimed += 1,
            _ => {}
        }
    })));
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    g.rejoin_grouped(A, area(0, 0, 0, 1));
    g.settle();
    let stats = g.stream.stats();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.built, stats.builds);
    assert_eq!(seen.bytes, stats.bytes);
    assert_eq!(seen.sections, 27);
    assert_eq!(seen.claimed, 9);
    assert_eq!(
        stats.cache_hits, 27,
        "the groups were looked at from the cache"
    );
}

/// A source that counts its passes.
struct Passes {
    world: World,
    begun: Vec<Loading>,
    ended: usize,
}

impl SectionSource for Passes {
    fn build(&mut self, pos: SectionPos, out: &mut Vec<u8>) {
        assert_eq!(self.begun.len(), self.ended + 1, "inside a pass");
        self.world.build(pos, out);
    }

    fn begin(&mut self, loading: &Loading) {
        self.begun.push(*loading);
    }

    fn end(&mut self) {
        self.ended += 1;
    }
}

#[test]
fn a_source_is_told_each_pass_and_the_views_loading() {
    let mut src = Passes {
        world: World::new(4),
        begun: Vec::new(),
        ended: 0,
    };
    let mut stream = new_stream(StreamConfig::default());
    let mut lanes = FakeLanes::default();
    stream.connect(A);
    stream.connect(B);
    stream.set_interest(A, area(0, 0, 0, 1), &[]).unwrap();
    stream
        .set_interest(B, Area::new(at(9, 0, 0), 3, 1, 2), &[])
        .unwrap();
    stream.flush(&mut src, &mut lanes);
    assert_eq!(
        src.begun[0],
        Loading {
            views: 2,
            sides: 3 + 7,
            widest: 7,
            areas: 2,
            area_sides: 3 + 7,
        }
    );
    while stream.has_work() {
        stream.flush(&mut src, &mut lanes);
    }
    assert_eq!(src.begun.len(), src.ended);
}

#[test]
fn a_layer_emptied_while_away_is_cleared_from_an_unknown_state() {
    let mut g = Game::new(StreamConfig::default());
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![5]);
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    assert_eq!(g.player(A).layers[&(PILES, at(0, 0, 0))], vec![5]);
    // While it is away the pile goes: the client still holds [5] there.
    g.src.piles.borrow_mut().remove(&at(0, 0, 0));
    g.stream.layer_changed(PILES, at(0, 0, 0));
    g.rejoin_grouped(A, area(0, 0, 0, 1));
    g.settle();
    assert_eq!(g.player(A).layers[&(PILES, at(0, 0, 0))], Vec::<u8>::new());
    g.check(A);
}

#[test]
fn a_build_marks_a_neighbour_and_a_layer_sent_in_the_same_flush() {
    let mut g = Game::new(StreamConfig::default());
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    // Building (0, 0, 0) works out a pile on (1, 0, 0), and its faces.
    g.src.spills.borrow_mut().insert(at(0, 0, 0), at(1, 0, 0));
    g.src.world.set(&mut g.stream, at(0, 0, 0), 3, 9);
    let builds = g.src.world.builds.get();
    g.stream.flush(&mut g.src, &mut g.lanes);
    g.deliver();
    assert_eq!(
        g.src.world.builds.get(),
        builds + 2,
        "the neighbour too, once"
    );
    assert_eq!(g.player(A).layers[&(PILES, at(1, 0, 0))], vec![1]);
    assert!(!g.stream.has_work(), "nothing left for a second pass");
    g.check(A);
    // Marked by a section only it holds: flush_conn rebuilds it too.
    g.src.spills.borrow_mut().insert(at(1, 0, 0), at(1, 0, 1));
    g.src.world.set(&mut g.stream, at(1, 0, 0), 3, 9);
    g.stream.flush_conn(A, &mut g.src, &mut g.lanes);
    g.deliver();
    assert_eq!(g.player(A).layers[&(PILES, at(1, 0, 1))], vec![1]);
    assert_eq!(g.stream.changes_pending(), 0);
    g.check(A);
}

#[test]
fn a_layer_frame_is_asked_once_a_flush_for_every_holder() {
    let mut g = Game::new(StreamConfig::default());
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![1]);
    for conn in [A, B, C] {
        g.join(conn, area(0, 0, 0, 1));
    }
    g.settle();
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![1, 2]);
    g.stream.layer_changed(PILES, at(0, 0, 0));
    let asked = g.src.frames.get();
    g.stream.flush(&mut g.src, &mut g.lanes);
    g.deliver();
    assert_eq!(g.src.frames.get(), asked + 1);
    for conn in [A, B, C] {
        assert_eq!(g.player(conn).changes, 1);
        g.check(conn);
    }
}

#[test]
fn a_layer_ordered_before_goes_ahead_of_its_section() {
    let mut g = Game::new(StreamConfig::default());
    g.src.piles_before.set(true);
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![7]);
    g.stream.connect(A);
    g.stream.set_interest(A, area(0, 0, 0, 0), &[]).unwrap();
    g.stream.flush(&mut g.src, &mut g.lanes);
    let (_, bulk) = drain(&mut g.lanes, A);
    let at_of = |f: &Frame| match f {
        Frame::Stream(StreamMsg::Section { .. }) => 's',
        Frame::Layer { layer, .. } if *layer == PILES => 'p',
        Frame::Layer { .. } => 'c',
        Frame::Stream(_) => '?',
    };
    let order: String = bulk.iter().map(at_of).collect();
    assert_eq!(order, "psc", "piles before, climate behind");
}

#[test]
fn a_whole_section_change_keeps_its_layers() {
    let mut g = Game::new(StreamConfig::default());
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![4]);
    g.join(A, area(0, 0, 0, 1));
    g.settle();
    let whole = g.player(A).whole;
    // Every cell changes: the section goes whole, its layers stay as held.
    g.src
        .world
        .edits
        .borrow_mut()
        .insert(at(0, 0, 0), (0..64).map(|i| i + 100).collect());
    g.stream.changed(at(0, 0, 0));
    g.settle();
    assert_eq!(g.player(A).client.sections, 27 + 1);
    assert_eq!(g.player(A).whole, whole, "no layer frame sent again");
    g.check(A);
}

#[test]
fn group_layer_matches_are_told_and_memory_is_counted() {
    let kept = Arc::new(Mutex::new(Vec::new()));
    let mut g = Game::new(StreamConfig::default());
    let k = kept.clone();
    g.stream.set_observer(Some(Box::new(move |e: &StreamEvent| {
        if let StreamEvent::LayerGroup { layer, kept, .. } = *e {
            k.lock().unwrap().push((layer, kept));
        }
    })));
    g.join(A, area(0, 0, 0, 1));
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![2]);
    g.settle();
    assert!(g.stream.held_bytes(A) > 0);
    assert!(g.stream.layer_bytes() > 0);
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![3]);
    g.stream.layer_changed(PILES, at(0, 0, 0));
    g.rejoin_grouped(A, area(0, 0, 0, 1));
    g.settle();
    let kept = kept.lock().unwrap();
    // A climate a group, and piles where any lie (no digest otherwise).
    assert_eq!(kept.len(), 9 + 1);
    assert_eq!(kept.iter().filter(|(_, k)| !k).count(), 1);
    assert!(kept.contains(&(PILES, false)));
    g.check(A);
    g.stream.disconnect(A);
    assert_eq!(g.stream.held_bytes(A), 0);
}

#[test]
fn loading_counts_the_areas_once_each() {
    let mut src = Passes {
        world: World::new(4),
        begun: Vec::new(),
        ended: 0,
    };
    let mut stream = new_stream(StreamConfig::default());
    let mut lanes = FakeLanes::default();
    for conn in [A, B] {
        stream.connect(conn);
        stream.set_interest(conn, area(0, 0, 0, 2), &[]).unwrap();
    }
    stream.flush(&mut src, &mut lanes);
    assert_eq!(
        src.begun[0],
        Loading {
            views: 2,
            sides: 10,
            widest: 5,
            areas: 1,
            area_sides: 5,
        }
    );
}

#[test]
fn queued_events_say_where_and_withdrawals_are_counted() {
    let seen = Arc::new(Mutex::new((0, 0, 0u64)));
    let mut g = Game::new(StreamConfig::default());
    g.src.piles.borrow_mut().insert(at(0, 0, 0), vec![1]);
    let s = seen.clone();
    g.stream.set_observer(Some(Box::new(move |e: &StreamEvent| {
        let mut s = s.lock().unwrap();
        match *e {
            StreamEvent::Queued {
                kind: FrameKind::Section,
                pos: Some(_),
                layer: None,
                ..
            } => s.0 += 1,
            StreamEvent::Queued {
                kind: FrameKind::Layer,
                pos: Some(_),
                layer: Some(_),
                ..
            } => s.1 += 1,
            StreamEvent::Withdrawn { bytes, .. } => s.2 += bytes as u64,
            _ => {}
        }
    })));
    g.stream.connect(A);
    g.stream.set_interest(A, area(0, 0, 0, 1), &[]).unwrap();
    g.stream.flush(&mut g.src, &mut g.lanes);
    // Gone before any of it is written: every frame queued is withdrawn.
    g.stream.disconnect(A);
    let stats = g.stream.stats();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.0, 27);
    assert_eq!(seen.1, 9 + 1, "a climate a column, and the pile");
    assert_eq!(stats.withdrawn, 27 + 9 + 1);
    assert_eq!(stats.withdrawn_bytes, stats.bytes);
    assert_eq!(seen.2, stats.bytes);
}
