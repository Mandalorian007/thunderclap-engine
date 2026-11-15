//! Shared by the stream tests: fake lanes that queue frames as a session
//! would (priority first, bulk frames skipped once withdrawn), a client
//! model that applies what arrives, and a toy raw-cell world.

#![allow(dead_code)]

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, VecDeque};

use tc_net::{BulkTicket, ConnId};
use tc_stream::{
    Claim, Lanes, SectionPos, SectionSource, SectionStream, Stamp, StreamConfig, StreamMsg,
    decode_raw, encode_raw,
};
use tc_wire::Wire;

/// One connection's lanes.
#[derive(Default)]
pub struct Lane {
    pub priority: VecDeque<Vec<u8>>,
    pub bulk: VecDeque<(Vec<u8>, Option<BulkTicket>)>,
    /// Refuse priority frames.
    pub refuse: bool,
    /// Refuse bulk frames.
    pub refuse_bulk: bool,
    pub behind: bool,
    pub high_water: Option<usize>,
}

#[derive(Default)]
pub struct FakeLanes(pub BTreeMap<ConnId, Lane>);

impl FakeLanes {
    pub fn lane(&mut self, conn: ConnId) -> &mut Lane {
        self.0.entry(conn).or_default()
    }

    /// Writes what is queued, as the session would: priority frames, then
    /// bulk frames whose tickets it can take.
    pub fn drain(&mut self, conn: ConnId) -> Vec<StreamMsg> {
        let lane = self.lane(conn);
        let mut out: Vec<StreamMsg> = lane
            .priority
            .drain(..)
            .map(|f| StreamMsg::from_bytes(&f).unwrap())
            .collect();
        for (f, t) in lane.bulk.drain(..) {
            if t.is_none_or(|t| t.take()) {
                out.push(StreamMsg::from_bytes(&f).unwrap());
            }
        }
        out
    }
}

impl Lanes for FakeLanes {
    fn send(&mut self, conn: ConnId, frame: Vec<u8>) -> bool {
        let lane = self.lane(conn);
        if lane.refuse {
            return false;
        }
        lane.priority.push_back(frame);
        true
    }

    fn send_bulk(&mut self, conn: ConnId, frame: Vec<u8>, ticket: Option<BulkTicket>) -> bool {
        let lane = self.lane(conn);
        if lane.refuse_bulk {
            return false;
        }
        lane.bulk.push_back((frame, ticket));
        true
    }

    fn bulk_queued(&self, conn: ConnId) -> usize {
        self.0.get(&conn).map_or(0, |l| {
            l.bulk
                .iter()
                .filter(|(_, t)| !t.as_ref().is_some_and(BulkTicket::withdrawn))
                .map(|(f, _)| f.len())
                .sum()
        })
    }

    fn bulk_high_water(&self, conn: ConnId) -> usize {
        self.0
            .get(&conn)
            .and_then(|l| l.high_water)
            .unwrap_or(tc_net::flow::BULK_HIGH_WATER)
    }

    fn behind(&self, conn: ConnId) -> bool {
        self.0.get(&conn).is_some_and(|l| l.behind)
    }
}

/// What a client holds: each section's stamp and cells.
#[derive(Default, Debug)]
pub struct Client {
    pub cells: usize,
    pub held: BTreeMap<SectionPos, (u64, Vec<u32>)>,
    pub sections: usize,
    pub edits: usize,
    pub unloaded: usize,
    /// `UnloadBox`es applied.
    pub boxes: usize,
}

impl Client {
    pub fn new(cells: usize) -> Client {
        Client {
            cells,
            ..Client::default()
        }
    }

    pub fn apply(&mut self, msgs: Vec<StreamMsg>) {
        for m in msgs {
            match m {
                StreamMsg::Section { pos, stamp, data } => {
                    assert_eq!(stamp.get(), tc_wire::stamp::bytes_stamp(&data.0));
                    let mut cells = Vec::new();
                    assert!(decode_raw(&data.0, self.cells, &mut cells));
                    self.held.insert(pos, (stamp.get(), cells));
                    self.sections += 1;
                }
                StreamMsg::Edit {
                    pos,
                    changes,
                    stamp,
                } => {
                    let (s, cells) = self.held.get_mut(&pos).expect("an edit to a held section");
                    for pair in changes.as_chunks::<2>().0 {
                        cells[pair[0] as usize] = pair[1];
                    }
                    *s = stamp.get();
                    self.edits += 1;
                }
                StreamMsg::Unload { positions } => {
                    for p in positions {
                        self.held.remove(&p);
                        self.unloaded += 1;
                    }
                }
                StreamMsg::UnloadBox { min, max } => {
                    let before = self.held.len();
                    self.held.retain(|p, _| !p.within(&min, &max));
                    self.unloaded += before - self.held.len();
                    self.boxes += 1;
                }
            }
        }
    }

    pub fn claims(&self) -> Vec<Claim> {
        self.held
            .iter()
            .map(|(pos, (s, _))| Claim {
                pos: *pos,
                stamp: Stamp::of(*s),
            })
            .collect()
    }

    pub fn reset_counts(&mut self) {
        self.sections = 0;
        self.edits = 0;
        self.unloaded = 0;
        self.boxes = 0;
    }
}

/// A toy world of raw cells: sections below y = 0 are solid (uniform),
/// y = 0 has a pattern, above is empty; |y| > `depth` doesn't exist.
pub struct World {
    pub size: usize,
    pub depth: i32,
    pub edits: RefCell<HashMap<SectionPos, Vec<u32>>>,
    pub builds: Cell<usize>,
}

impl World {
    pub fn new(size: usize) -> World {
        World {
            size,
            depth: 4,
            edits: RefCell::default(),
            builds: Cell::new(0),
        }
    }

    pub fn len(&self) -> usize {
        self.size.pow(3)
    }

    pub fn cells_of(&self, pos: SectionPos) -> Vec<u32> {
        if let Some(c) = self.edits.borrow().get(&pos) {
            return c.clone();
        }
        let n = self.len();
        match pos.y {
            y if y < 0 => vec![1; n],
            0 => (0..n)
                .map(|i| ((i as i64 + i64::from(pos.x) * 7 + i64::from(pos.z) * 13) % 5) as u32)
                .collect(),
            _ => vec![0; n],
        }
    }

    /// Sets one cell and tells the stream.
    pub fn set(&self, stream: &mut SectionStream, pos: SectionPos, index: usize, cell: u32) {
        let mut cells = self.cells_of(pos);
        cells[index] = cell;
        self.edits.borrow_mut().insert(pos, cells);
        stream.changed(pos);
    }

    /// Asserts the client holds exactly what the world has now.
    pub fn check(&self, client: &Client) {
        let mut bytes = Vec::new();
        for (pos, (stamp, cells)) in &client.held {
            let want = self.cells_of(*pos);
            assert_eq!(cells, &want, "cells of {pos:?}");
            encode_raw(&want, &mut bytes);
            assert_eq!(
                *stamp,
                tc_wire::stamp::bytes_stamp(&bytes),
                "stamp of {pos:?}"
            );
        }
    }
}

impl SectionSource for World {
    fn build(&self, pos: SectionPos, out: &mut Vec<u8>) {
        self.builds.set(self.builds.get() + 1);
        encode_raw(&self.cells_of(pos), out);
    }

    fn exists(&self, pos: SectionPos) -> bool {
        pos.y.abs() <= self.depth
    }

    fn cells(&self, bytes: &[u8], out: &mut Vec<u32>) -> bool {
        decode_raw(bytes, self.len(), out)
    }
}

pub fn stream(config: StreamConfig) -> SectionStream {
    SectionStream::new(config, |m: &StreamMsg| m.to_bytes())
}

/// Flushes and delivers until nothing is left to do (at most `max` flushes);
/// returns how many it took.
pub fn settle(
    stream: &mut SectionStream,
    world: &dyn SectionSource,
    lanes: &mut FakeLanes,
    clients: &mut BTreeMap<ConnId, Client>,
    max: usize,
) -> usize {
    for i in 1..=max {
        stream.flush(world, lanes);
        for (conn, c) in clients.iter_mut() {
            c.apply(lanes.drain(*conn));
        }
        if !stream.has_work() {
            return i;
        }
    }
    panic!("still busy after {max} flushes");
}
