//! Bases: a game that keeps them opens from the newest whole one and
//! replays only the log after it; its live log stays bounded.

mod tally;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tally::Tally;
use tc_net::{ClientMsg, Empty};
use tc_sim::{Core, Driver, Sim, SimConfig};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-sim-bases-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn config() -> SimConfig {
    SimConfig {
        paused: true,
        base_every: 5,
        ..SimConfig::default()
    }
}

fn saving() -> Tally {
    let mut t = Tally::new(false);
    t.saves = true;
    t
}

fn command(d: &mut Driver<Tally>, conn: u64, seq: u32, text: &str) {
    d.client(
        conn,
        ClientMsg::Command {
            seq,
            command: text.into(),
        },
    );
}

/// Ticks until a base due is written.
fn settle(d: &mut Driver<Tally>) {
    d.wait(Duration::from_millis(1));
    d.sim_mut().finish_base();
}

/// The store's bases, newest first.
fn bases(dir: &Path) -> Vec<tc_store::BaseFile> {
    tc_store::bases(dir).unwrap()
}

/// A run with a scheduled add pending across its bases.
fn run(dir: &Path) -> (Core<Tally>, u32) {
    let mut d = Driver::new(Sim::create(dir, saving(), b"tally", config()).unwrap());
    let (ada, _rx) = d.connect("ada", Empty);
    let mut seq = 0;
    command(&mut d, ada, 1, "later 40");
    for round in 0..30 {
        seq = round + 2;
        command(&mut d, ada, seq, "add 1");
        settle(&mut d);
    }
    assert!(d.sim().bases_written() >= 4);
    (d.stop(), seq)
}

#[test]
fn a_store_opens_from_its_newest_base_with_the_schedule_it_held() {
    let dir = temp_dir("open");
    let (live, _) = run(&dir);
    let kept = bases(&dir);
    assert_eq!(kept.len(), tc_sim::KEEP_BASES, "older bases are pruned");
    // What went behind the older base is archived.
    let archived = tc_store::summary(&dir).unwrap();
    assert!(
        archived
            .iter()
            .any(|a| a.generation + 1 < kept[1].generation)
    );

    let (sim, meta) = Sim::open(&dir, saving(), config()).unwrap();
    assert_eq!(meta, b"tally");
    assert_eq!(
        sim.opened_from_base(),
        Some((kept[0].generation, kept[0].after))
    );
    assert_eq!(sim.core().state_hash(), live.state_hash());
    assert_eq!(
        sim.core().scheduler().len(),
        1,
        "the later add is still due"
    );
    // The scheduled add fires as it would have.
    let mut d = Driver::new(sim);
    d.advance(40).unwrap();
    assert_eq!(d.core().game().tally_of("ada"), Some(30 + 40));
    d.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_damaged_base_falls_back_to_the_one_before() {
    let dir = temp_dir("damaged");
    let (live, _) = run(&dir);
    let kept = bases(&dir);
    let mut bytes = std::fs::read(&kept[0].path).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xff;
    std::fs::write(&kept[0].path, bytes).unwrap();

    let (sim, _) = Sim::open(&dir, saving(), config()).unwrap();
    assert_eq!(
        sim.opened_from_base(),
        Some((kept[1].generation, kept[1].after))
    );
    assert_eq!(sim.core().state_hash(), live.state_hash());
    drop(sim);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_game_that_keeps_no_bases_replays_its_whole_log() {
    let dir = temp_dir("none");
    let mut d = Driver::new(Sim::create(&dir, Tally::new(false), b"tally", config()).unwrap());
    let (ada, _rx) = d.connect("ada", Empty);
    for seq in 1..20 {
        command(&mut d, ada, seq, "add 1");
        settle(&mut d);
    }
    assert_eq!(d.sim().bases_written(), 0);
    let live = d.stop();
    assert!(bases(&dir).is_empty());
    let (sim, _) = Sim::open(&dir, Tally::new(false), config()).unwrap();
    assert_eq!(sim.opened_from_base(), None);
    assert_eq!(sim.core().state_hash(), live.state_hash());
    drop(sim);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_reload_restores_the_base_and_replays_the_tail_into_the_new_game() {
    let dir = temp_dir("reload");
    run(&dir);
    let (sim, _) = Sim::open(&dir, saving(), config()).unwrap();
    let mut d = Driver::new(sim);
    let (ada, _rx) = d.connect("ada", Empty);
    // A base now: only the add below is after it.
    assert!(d.sim_mut().start_base());
    d.sim_mut().finish_base();
    let after = bases(&dir)[0].after;
    assert_eq!(after, d.core().version());
    command(&mut d, ada, 100, "add 2");
    let (reply, outcome) = std::sync::mpsc::channel();
    d.sim_mut().reload(Arc::new(10), Some(reply));
    let report = loop {
        d.tick(Instant::now());
        if let Ok(report) = outcome.try_recv() {
            break report.expect("reloaded");
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    assert!(report.version > after);
    // The base's 30 stand; the add after it is replayed ten times over.
    assert_eq!(d.core().game().tally_of("ada"), Some(30 + 20));
    d.stop();
    let _ = std::fs::remove_dir_all(&dir);
}
