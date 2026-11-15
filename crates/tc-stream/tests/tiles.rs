//! A 2D tilemap as a section source: 8×8 chunks of `u16` tiles in its own
//! encoding, one layer (`z` = 0, `rz` = 0), streamed, edited, moved and
//! resumed like a voxel world.

mod common;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

use common::FakeLanes;
use tc_stream::{Area, SectionPos, SectionSource, SectionStream, Stamp, StreamConfig, StreamMsg};
use tc_wire::Wire;

const SIDE: usize = 8;

/// Tiles by chunk: a checkerboard of grass (1) and sand (2), water (3)
/// where a chunk's x is negative, and edits.
#[derive(Default)]
struct Tilemap {
    edits: RefCell<HashMap<(i32, i32), Vec<u16>>>,
}

impl Tilemap {
    fn tiles(&self, cx: i32, cy: i32) -> Vec<u16> {
        if let Some(t) = self.edits.borrow().get(&(cx, cy)) {
            return t.clone();
        }
        (0..SIDE * SIDE)
            .map(|i| {
                if cx < 0 {
                    3
                } else {
                    1 + ((i + i / SIDE) % 2) as u16
                }
            })
            .collect()
    }
}

impl SectionSource for Tilemap {
    fn build(&mut self, pos: SectionPos, out: &mut Vec<u8>) {
        out.clear();
        for t in self.tiles(pos.x, pos.y) {
            out.extend_from_slice(&t.to_le_bytes());
        }
    }

    fn exists(&self, pos: SectionPos) -> bool {
        pos.z == 0
    }

    fn cells(&self, bytes: &[u8], out: &mut Vec<u32>) -> bool {
        out.clear();
        out.extend(
            bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u32::from(u16::from_le_bytes(*c))),
        );
        out.len() == SIDE * SIDE
    }
}

/// The client's tilemap: chunks it holds, with their stamps.
#[derive(Default)]
struct View {
    chunks: BTreeMap<(i32, i32), (Stamp, Vec<u16>)>,
    sections: usize,
    edits: usize,
}

impl View {
    fn apply(&mut self, msgs: Vec<StreamMsg>) {
        for m in msgs {
            match m {
                StreamMsg::Section { pos, stamp, data } => {
                    assert_eq!(pos.z, 0);
                    let tiles = data
                        .0
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|c| u16::from_le_bytes(*c))
                        .collect();
                    self.chunks.insert((pos.x, pos.y), (stamp, tiles));
                    self.sections += 1;
                }
                StreamMsg::Edit {
                    pos,
                    changes,
                    stamp,
                } => {
                    let (s, tiles) = self.chunks.get_mut(&(pos.x, pos.y)).unwrap();
                    for c in changes.as_chunks::<2>().0 {
                        tiles[c[0] as usize] = u16::try_from(c[1]).unwrap();
                    }
                    *s = stamp;
                    self.edits += 1;
                }
                StreamMsg::Unload { positions } => {
                    for p in positions {
                        self.chunks.remove(&(p.x, p.y));
                    }
                }
                StreamMsg::UnloadBox { min, max } => {
                    self.chunks.retain(|&(x, y), _| {
                        !tc_stream::SectionPos::new(x, y, 0).within(&min, &max)
                    });
                }
            }
        }
    }

    fn check(&self, map: &Tilemap) {
        for (&(x, y), (_, tiles)) in &self.chunks {
            assert_eq!(tiles, &map.tiles(x, y), "chunk {x},{y}");
        }
    }
}

fn run(stream: &mut SectionStream, map: &mut Tilemap, lanes: &mut FakeLanes, view: &mut View) {
    for _ in 0..50 {
        stream.flush(map, lanes);
        view.apply(lanes.drain(1));
        if !stream.has_work() {
            return;
        }
    }
    panic!("still busy");
}

fn around(x: i32, y: i32) -> Area {
    Area::new(SectionPos::new(x, y, 0), 3, 2, 0)
}

#[test]
fn a_tilemap_streams_edits_moves_and_resumes() {
    let mut map = Tilemap::default();
    let mut lanes = FakeLanes::default();
    let mut stream = SectionStream::new(StreamConfig::default(), |m: &StreamMsg| m.to_bytes());
    let mut view = View::default();
    stream.connect(1);
    stream.set_interest(1, around(0, 0), &[]).unwrap();
    run(&mut stream, &mut map, &mut lanes, &mut view);
    assert_eq!(view.chunks.len(), 7 * 5, "one layer");
    view.check(&map);

    // A tile changes: an Edit of one tile.
    let mut tiles = map.tiles(1, 1);
    tiles[10] = 9;
    map.edits.borrow_mut().insert((1, 1), tiles);
    stream.changed(SectionPos::new(1, 1, 0));
    run(&mut stream, &mut map, &mut lanes, &mut view);
    assert_eq!((view.sections, view.edits), (35, 1));
    view.check(&map);

    // Walk east past the hysteresis: the west edge goes, the east comes.
    stream.set_interest(1, around(6, 0), &[]).unwrap();
    run(&mut stream, &mut map, &mut lanes, &mut view);
    assert!(view.chunks.keys().all(|(x, _)| *x >= 1));
    assert_eq!(view.chunks.keys().filter(|(x, _)| *x >= 3).count(), 7 * 5);
    view.check(&map);

    // Reconnect holding everything, after one more change: only it comes.
    stream.disconnect(1);
    let claims: Vec<_> = view
        .chunks
        .iter()
        .map(|(&(x, y), (stamp, _))| tc_stream::Claim {
            pos: SectionPos::new(x, y, 0),
            stamp: *stamp,
        })
        .collect();
    let mut tiles = map.tiles(6, 0);
    tiles[0] = 4;
    map.edits.borrow_mut().insert((6, 0), tiles);
    stream.changed(SectionPos::new(6, 0, 0));
    lanes = FakeLanes::default();
    view.sections = 0;
    stream.connect(2);
    stream.set_interest(2, around(6, 0), &claims).unwrap();
    for _ in 0..10 {
        stream.flush(&mut map, &mut lanes);
        view.apply(lanes.drain(2));
    }
    assert_eq!(view.sections, 1);
    view.check(&map);
}
