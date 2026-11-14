//! The section stream over a toy voxel world and fake lanes: loads,
//! limits and budgets, edits and resume. Ported from Forge Wilds' chunk
//! streaming tests (`chunk_limits`, `chunk_resume`).

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{Client, FakeLanes, World, settle, stream};
use tc_stream::{
    Area, Claim, SectionPos, SectionSource, SectionStream, Stamp, StreamConfig, StreamError,
    StreamMsg,
};

const A: u64 = 1;
const B: u64 = 2;

fn at(x: i32, y: i32, z: i32) -> SectionPos {
    SectionPos::new(x, y, z)
}

fn area(x: i32, y: i32, z: i32, r: u8) -> Area {
    Area::new(at(x, y, z), r, r, r)
}

struct Setup {
    world: World,
    stream: SectionStream,
    lanes: FakeLanes,
    clients: BTreeMap<u64, Client>,
}

impl Setup {
    fn new(config: StreamConfig) -> Setup {
        let world = World::new(4);
        Setup {
            clients: BTreeMap::new(),
            stream: stream(config),
            lanes: FakeLanes::default(),
            world,
        }
    }

    fn join(&mut self, conn: u64, a: Area, holding: &[Claim]) {
        self.stream.connect(conn);
        self.stream.set_interest(conn, a, holding).unwrap();
        self.clients.insert(conn, Client::new(self.world.len()));
    }

    fn settle(&mut self) -> usize {
        settle(
            &mut self.stream,
            &self.world,
            &mut self.lanes,
            &mut self.clients,
            200,
        )
    }

    fn client(&mut self, conn: u64) -> &mut Client {
        self.clients.get_mut(&conn).unwrap()
    }

    fn held(&self, conn: u64) -> BTreeSet<SectionPos> {
        self.clients[&conn].held.keys().copied().collect()
    }
}

fn existing(world: &World, a: &Area, extra: i64) -> BTreeSet<SectionPos> {
    let mut out = BTreeSet::new();
    a.bounds(extra).for_each(|p| {
        if world.exists(p) {
            out.insert(p);
        }
    });
    out
}

#[test]
fn loads_the_area_nearest_first() {
    let mut s = Setup::new(StreamConfig::default());
    let a = area(0, 3, 0, 2);
    s.join(A, a, &[]);
    s.stream.flush(&s.world, &mut s.lanes);
    let first = s.lanes.drain(A);
    let d2 = |m: &StreamMsg| match m {
        StreamMsg::Section { pos, .. } => pos.x.pow(2) + (pos.y - 3).pow(2) + pos.z.pow(2),
        other => panic!("{other:?}"),
    };
    assert!(
        first.windows(2).all(|w| d2(&w[0]) <= d2(&w[1])),
        "nearest first"
    );
    s.client(A).apply(first);
    s.settle();
    let want = existing(&s.world, &a, 0);
    assert!(
        want.len() < a.bounds(0).volume() as usize,
        "the world ends at y = 4"
    );
    assert_eq!(s.held(A), want);
    s.world.check(&s.clients[&A]);
    assert!(!s.stream.has_work());
}

#[test]
fn rising_past_hysteresis_unloads_in_a_few_frames() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, -2, 0, 1), &[]);
    s.settle();
    let a = area(0, 2, 0, 1);
    s.stream.set_interest(A, a, &[]).unwrap();
    assert!(s.settle() <= 3);
    // Below y = 2 - 1 - 2 = -1 is gone; the y = -1 layer stays held.
    let mut want = existing(&s.world, &a, 0);
    want.extend((-1..=1).flat_map(|x| (-1..=1).map(move |z| at(x, -1, z))));
    assert_eq!(s.held(A), want);
    assert_eq!(s.client(A).unloaded, 18);
}

#[test]
fn set_interest_unloads_only_what_leaves() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, 0, 0, 2), &[]);
    s.settle();
    let before = s.held(A);
    s.client(A).reset_counts();
    // One step: within hysteresis, nothing leaves.
    s.stream.set_interest(A, area(1, 0, 0, 2), &[]).unwrap();
    s.settle();
    assert_eq!(s.client(A).unloaded, 0);
    assert_eq!(s.client(A).sections, 5 * 5, "the new face only");
    // Three more: the x = -2 face is past x = 4 - 2 - 2.
    s.stream.set_interest(A, area(4, 0, 0, 2), &[]).unwrap();
    s.settle();
    let gone: BTreeSet<_> = before.iter().filter(|p| p.x < 0).copied().collect();
    assert_eq!(s.client(A).unloaded, gone.len());
    assert!(s.held(A).is_disjoint(&gone));
    s.world.check(&s.clients[&A]);
}

#[test]
fn build_budget_is_shared_across_flushes_and_connections() {
    let config = StreamConfig {
        build_budget: 6,
        ..StreamConfig::default()
    };
    let mut s = Setup::new(config);
    s.join(A, area(0, 0, 0, 2), &[]);
    s.join(B, area(0, 0, 0, 2), &[]);
    let mut served = BTreeSet::new();
    for _ in 0..4 {
        let builds = s.world.builds.get();
        s.stream.flush(&s.world, &mut s.lanes);
        assert!(s.world.builds.get() - builds <= 6, "within the budget");
        for conn in [A, B] {
            let got = s.lanes.drain(conn);
            if !got.is_empty() {
                served.insert(conn);
            }
            s.client(conn).apply(got);
        }
    }
    assert_eq!(served.len(), 2, "round robin serves both");
    s.settle();
    assert_eq!(s.held(A), s.held(B));
    let n = s.held(A).len();
    assert_eq!(
        s.world.builds.get(),
        n,
        "the second connection is served from the cache"
    );
}

#[test]
fn a_flush_into_a_fresh_area_stays_near_budget() {
    let config = StreamConfig {
        build_budget: 8,
        ..StreamConfig::default()
    };
    let mut s = Setup::new(config);
    s.join(A, area(0, 0, 0, 2), &[]);
    s.settle();
    s.stream.set_interest(A, area(50, 0, 0, 2), &[]).unwrap();
    let builds = s.world.builds.get();
    s.stream.flush(&s.world, &mut s.lanes);
    assert_eq!(s.world.builds.get() - builds, 8);
    s.settle();
    s.world.check(&s.clients[&A]);
}

#[test]
fn the_bulk_high_water_holds_loads_back() {
    let mut s = Setup::new(StreamConfig::default());
    s.lanes.lane(A).high_water = Some(1000);
    s.join(A, area(0, 0, 0, 2), &[]);
    s.stream.flush(&s.world, &mut s.lanes);
    let queued: usize = s.lanes.0[&A].bulk.iter().map(|(f, _)| f.len()).sum();
    assert!(
        (1000..1300).contains(&queued),
        "stops past the high water: {queued}"
    );
    s.settle();
    s.world.check(&s.clients[&A]);
}

#[test]
fn an_edit_is_sent_as_its_changed_cells() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, 0, 0, 1), &[]);
    s.join(B, area(0, 0, 0, 1), &[]);
    s.settle();
    s.client(A).reset_counts();
    s.world.set(&mut s.stream, at(0, 0, 0), 5, 99);
    s.world.set(&mut s.stream, at(0, -1, 0), 0, 7); // uniform before
    s.world.set(&mut s.stream, at(0, 3, 0), 0, 7); // held by nobody
    s.settle();
    assert_eq!((s.client(A).edits, s.client(A).sections), (2, 0));
    for conn in [A, B] {
        s.world.check(&s.clients[&conn]);
    }
    // Every cell changes: the whole section is smaller.
    let pos = at(1, 0, 0);
    let cells: Vec<u32> = (0..64).map(|i| 1000 + i).collect();
    s.world.edits.borrow_mut().insert(pos, cells);
    s.stream.changed(pos);
    s.settle();
    assert_eq!((s.client(A).edits, s.client(A).sections), (2, 1));
    s.world.check(&s.clients[&A]);
}

#[test]
fn a_change_refused_by_its_lane_is_retried() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, 0, 0, 1), &[]);
    s.settle();
    s.client(A).reset_counts();
    s.lanes.lane(A).refuse = true;
    s.world.set(&mut s.stream, at(0, 0, 0), 1, 42);
    s.stream.flush(&s.world, &mut s.lanes);
    assert!(s.stream.has_work());
    s.lanes.lane(A).refuse = false;
    s.settle();
    assert_eq!(s.client(A).edits, 1);
    s.world.check(&s.clients[&A]);
}

#[test]
fn changes_wait_while_a_connection_is_behind() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, 0, 0, 1), &[]);
    s.settle();
    s.lanes.lane(A).behind = true;
    s.world.set(&mut s.stream, at(0, 0, 0), 1, 42);
    s.stream.flush(&s.world, &mut s.lanes);
    assert!(s.lanes.drain(A).is_empty());
    s.lanes.lane(A).behind = false;
    s.settle();
    s.world.check(&s.clients[&A]);
}

#[test]
fn refused_unloads_are_retried_in_batches() {
    let config = StreamConfig {
        max_radius: [8, 4, 8],
        build_budget: 10_000,
        ..StreamConfig::default()
    };
    let mut s = Setup::new(config);
    s.join(A, Area::new(at(0, 0, 0), 8, 4, 8), &[]);
    s.settle();
    let held = s.held(A).len();
    assert!(held > tc_stream::MAX_UNLOAD_BATCH);
    s.lanes.lane(A).refuse = true;
    s.stream.set_interest(A, area(1000, 0, 0, 1), &[]).unwrap();
    s.stream.flush(&s.world, &mut s.lanes);
    assert!(
        s.lanes
            .drain(A)
            .iter()
            .all(|m| matches!(m, StreamMsg::Section { .. }))
    );
    s.lanes.lane(A).refuse = false;
    s.stream.flush(&s.world, &mut s.lanes);
    let unloads: Vec<usize> = s
        .lanes
        .drain(A)
        .iter()
        .filter_map(|m| match m {
            StreamMsg::Unload { positions } => Some(positions.len()),
            _ => None,
        })
        .collect();
    assert_eq!(unloads.iter().sum::<usize>(), held);
    assert!(unloads.iter().all(|n| *n <= tc_stream::MAX_UNLOAD_BATCH));
    assert!(unloads.len() >= 2);
}

#[test]
fn an_edit_to_a_still_queued_section_is_folded_into_it() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, 0, 0, 1), &[]);
    s.stream.flush(&s.world, &mut s.lanes);
    let queued = s.lanes.0[&A].bulk.len();
    s.world.set(&mut s.stream, at(0, 0, 0), 3, 77);
    s.stream.flush(&s.world, &mut s.lanes);
    assert_eq!(s.stream.stats().folded, 1);
    s.settle();
    let c = &s.clients[&A];
    assert_eq!(
        (c.sections, c.edits),
        (queued, 0),
        "sent once, with the change"
    );
    s.world.check(c);
}

#[test]
fn an_unchanged_world_resumes_with_nothing_sent() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, 0, 0, 2), &[]);
    s.settle();
    let claims = s.client(A).claims();
    s.stream.disconnect(A);
    let builds = s.world.builds.get();
    s.join(B, area(0, 0, 0, 2), &claims);
    s.settle();
    assert_eq!(s.client(B).sections, 0);
    assert_eq!(s.stream.stats().resumed, claims.len() as u64);
    assert_eq!(s.world.builds.get(), builds, "checked from the cache");
}

#[test]
fn after_an_edit_only_the_edited_section_comes() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, 0, 0, 2), &[]);
    s.settle();
    let claims = s.client(A).claims();
    let mut b = std::mem::take(s.client(A));
    s.stream.disconnect(A);
    s.world.set(&mut s.stream, at(1, 0, -1), 0, 55);
    s.stream.flush(&s.world, &mut s.lanes);
    b.reset_counts();
    s.clients.insert(B, b);
    s.stream.connect(B);
    s.stream.set_interest(B, area(0, 0, 0, 2), &claims).unwrap();
    s.settle();
    assert_eq!((s.client(B).sections, s.client(B).edits), (1, 0));
    s.world.check(&s.clients[&B]);
}

#[test]
fn claims_outside_the_area_are_unloaded_and_wrong_ones_resent() {
    let mut s = Setup::new(StreamConfig::default());
    s.world.depth = 1;
    s.join(A, area(0, 0, 0, 2), &[]);
    s.settle();
    let mut b = std::mem::take(s.client(A));
    s.stream.disconnect(A);
    let builds = s.world.builds.get();
    // A wrong stamp, one far away, and one past the world's end.
    let mut claims = b.claims();
    claims[0].stamp = Stamp { hi: 1, lo: 2 };
    let far = Claim {
        pos: at(500, 0, 0),
        stamp: Stamp { hi: 3, lo: 4 },
    };
    let gone = Claim {
        pos: at(0, 2, 0),
        stamp: Stamp { hi: 5, lo: 6 },
    };
    claims.extend([far, gone]);
    for c in [far, gone] {
        b.held.insert(c.pos, (c.stamp.get(), vec![0; 64]));
    }
    b.reset_counts();
    s.clients.insert(B, b);
    s.stream.connect(B);
    s.stream.set_interest(B, area(0, 0, 0, 2), &claims).unwrap();
    s.settle();
    assert!(!s.held(B).contains(&far.pos), "the far claim was unloaded");
    assert!(
        !s.held(B).contains(&gone.pos),
        "so was the one past the end"
    );
    assert_eq!(s.client(B).unloaded, 2);
    assert_eq!(s.client(B).sections, 1, "the wrong stamp was resent");
    assert_eq!(s.world.builds.get(), builds, "nothing built");
    s.world.check(&s.clients[&B]);
}

#[test]
fn a_reload_resends_only_what_the_new_world_changed() {
    let mut s = Setup::new(StreamConfig::default());
    s.join(A, area(0, 0, 0, 2), &[]);
    s.settle();
    s.client(A).reset_counts();
    s.world.edits.borrow_mut().insert(at(0, 0, 0), vec![9; 64]);
    s.stream.reload();
    s.settle();
    assert_eq!((s.client(A).sections, s.client(A).edits), (1, 0));
    s.world.check(&s.clients[&A]);
}

#[test]
fn bad_areas_are_refused() {
    let mut s = stream(StreamConfig::default());
    assert_eq!(
        s.set_interest(A, area(0, 0, 0, 1), &[]),
        Err(StreamError::UnknownConn)
    );
    s.connect(A);
    assert_eq!(
        s.set_interest(A, area(0, 0, 0, 9), &[]),
        Err(StreamError::TooLarge)
    );
    let edge = Area::new(at(i32::MAX - 2, 0, 0), 1, 1, 1);
    assert_eq!(s.set_interest(A, edge, &[]), Err(StreamError::OutOfRange));
    assert_eq!(s.set_interest(A, area(0, 0, 0, 8), &[]), Ok(()));
}
