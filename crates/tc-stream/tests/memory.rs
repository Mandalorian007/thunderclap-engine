//! What a connection's held record costs per section, in a view shaped
//! like Forge Wilds' (16/8/16 sections) with three layers: two keyed per
//! section (one mostly empty) and one per column.

mod common;

use common::FakeLanes;
use tc_stream::{Area, SectionPos, SectionSource, StreamConfig};

const CONN: tc_net::ConnId = 1;

struct Columns;

impl SectionSource for Columns {
    fn build(&mut self, pos: SectionPos, out: &mut Vec<u8>) {
        out.clear();
        out.extend(pos.x.to_le_bytes());
        out.extend(pos.y.to_le_bytes());
        out.extend(pos.z.to_le_bytes());
    }

    fn layers(&self) -> usize {
        3
    }

    fn layer_key(&self, layer: usize, pos: SectionPos) -> SectionPos {
        if layer == 1 {
            SectionPos::new(pos.x, 0, pos.z)
        } else {
            pos
        }
    }

    fn layer_state(&self, layer: usize, key: SectionPos, out: &mut Vec<u8>) {
        out.clear();
        if layer != 2 || (key.x + key.z) % 9 == 0 {
            out.push(layer as u8);
        }
    }
}

/// Flushes and writes until nothing is left, then one more pass (it lets
/// go of the written frames' tickets).
fn settle(stream: &mut tc_stream::SectionStream, lanes: &mut FakeLanes) {
    for _ in 0..1000 {
        stream.flush(&mut Columns, lanes);
        lanes.drain(CONN);
        if !stream.has_work() {
            break;
        }
    }
    assert!(!stream.has_work());
    stream.flush(&mut Columns, lanes);
}

/// Held bytes per section once a full view is held, for `area`, and
/// after walking `steps` sections along x from it.
fn per_section(area: Area, steps: i32) -> (usize, f64) {
    let mut stream = common::stream(StreamConfig {
        build_budget: 4096,
        ..StreamConfig::default()
    });
    let mut lanes = FakeLanes::default();
    stream.connect(CONN);
    stream.set_interest(CONN, area, &[]).unwrap();
    settle(&mut stream, &mut lanes);
    for i in 1..=steps {
        let mut a = area;
        a.center.x += i;
        a.center.z -= i / 2;
        stream.set_interest(CONN, a, &[]).unwrap();
        settle(&mut stream, &mut lanes);
    }
    let held = stream.held(CONN);
    (held, stream.held_bytes(CONN) as f64 / held as f64)
}

#[test]
fn a_held_section_costs_few_bytes() {
    let view = |x, y, z| Area::new(SectionPos::new(x, y, z), 16, 8, 16);
    let (held, bytes) = per_section(view(0, 0, 0), 0);
    assert_eq!(held, 33 * 17 * 33);
    println!("held {held}: {bytes:.1} bytes a section");
    assert!(bytes < 64.0, "{bytes:.1} bytes a section");
    // Off the origin, negative coordinates and unaligned regions alike.
    let (_, off) = per_section(view(-1000, -37, 523), 0);
    println!("off the origin: {off:.1} bytes a section");
    assert!(off < 64.0, "{off:.1} bytes a section");
    // Walked: sections let go of and their tables' slack.
    let (held, walked) = per_section(view(3, 0, 5), 24);
    println!("walked 24, holding {held}: {walked:.1} bytes a section");
    assert!(walked < 64.0, "{walked:.1} bytes a section");
}
