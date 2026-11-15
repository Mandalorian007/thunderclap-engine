//! The loop driven by hand ([`Driver`]): the clock, inputs and one driver
//! per player, the store failing, a reload, and a log replayed to the same
//! state hash.

mod tally;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tally::Tally;
use tc_net::{ClientMsg, Empty, ServerMsg};
use tc_sim::{Core, Driver, MAX_TIME, Sim, SimConfig};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-sim-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn paused() -> SimConfig {
    SimConfig {
        paused: true,
        ..SimConfig::default()
    }
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

#[test]
fn no_step_timer_at_the_end_of_time() {
    let mut core = Core::new(Tally::new(false));
    core.advance_to(MAX_TIME);
    assert_eq!(core.time(), MAX_TIME);
    let sim = Sim::new(core, None, SimConfig::default());
    let deadline = sim.deadline().expect("the clock push");
    assert!(
        deadline > Instant::now() + Duration::from_secs(1),
        "no step is due at the end of time"
    );
}

#[test]
fn a_long_advance_stops_at_its_budget() {
    let mut sim = Sim::new(Core::new(Tally::new(true)), None, paused());
    sim.set_advance_budget(Duration::from_millis(100));
    let started = Instant::now();
    let reached = sim.advance(MAX_TIME - 1).expect("in range");
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(
        reached > 0 && reached < MAX_TIME - 1,
        "stopped at {reached}"
    );
    assert_eq!(sim.core().game().steps, reached, "stepped every step");
    assert!(sim.advance(MAX_TIME).is_err(), "past the end of time");
}

#[test]
fn a_stop_ends_a_long_advance() {
    let mut sim = Sim::new(Core::new(Tally::new(true)), None, paused());
    let stopping = sim.stopping();
    let flag = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        stopping.store(true, Ordering::Relaxed);
    });
    let started = Instant::now();
    sim.advance(MAX_TIME - 1).expect("in range");
    assert!(started.elapsed() < Duration::from_secs(2), "stopped early");
    flag.join().unwrap();
}

#[test]
fn an_event_the_log_cant_write_is_refused_and_the_loop_runs_on() {
    let dir = temp_dir("refused");
    let sim = Sim::create(&dir, Tally::new(false), b"tally", SimConfig::default()).unwrap();
    let mut d = Driver::new(sim);
    let (ada, mut rx) = d.connect("ada", Empty);
    Driver::<Tally>::received(&mut rx);
    let version = d.core().version();
    command(&mut d, ada, 1, "unlucky");
    command(&mut d, ada, 2, "unlucky");
    command(&mut d, ada, 3, "add 2");
    let msgs = Driver::<Tally>::received(&mut rx);
    let results: Vec<_> = msgs
        .iter()
        .filter_map(|m| match m {
            ServerMsg::CommandResult { result, .. } => Some(result.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        results,
        ["error: refused: unlucky", "error: refused: unlucky", "2"]
    );
    assert!(
        !msgs.iter().any(|m| matches!(m, ServerMsg::Clock { .. })),
        "the clock runs on: {msgs:?}"
    );
    assert_eq!(d.core().version(), version + 1, "only the add was logged");
    assert!(!d.sim().clock().paused());
    let status = d.sim().status().get();
    assert_eq!(status.refused, 2, "{status}");
    assert!(status.store_error.is_none());
    drop(d);
    let read = tc_store::read(&dir, &tally::TallyLog).unwrap();
    assert_eq!(read.entries.len() as u64, version + 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn one_body_one_driver() {
    let mut d = Driver::new(Sim::new(Core::new(Tally::new(false)), None, paused()));
    let (first, mut rx1) = d.connect("ada", Empty);
    let welcome = Driver::<Tally>::received(&mut rx1);
    assert!(matches!(welcome[0], ServerMsg::Welcome { player: 1, .. }));
    assert!(welcome.contains(&ServerMsg::Control { driving: true }));
    let (second, mut rx2) = d.connect("ada", Empty);
    assert!(Driver::<Tally>::received(&mut rx1).contains(&ServerMsg::Control { driving: false }));
    assert!(Driver::<Tally>::received(&mut rx2).contains(&ServerMsg::Control { driving: true }));
    assert_eq!(d.sim().status().get().players, vec![1]);

    // The old connection's inputs are dropped; the driver's are taken.
    d.client(first, ClientMsg::Input { seq: 1, input: 7 });
    d.client(second, ClientMsg::Input { seq: 1, input: 2 });
    d.client(second, ClientMsg::Input { seq: 2, input: 3 });
    d.tick(Instant::now());
    assert_eq!(d.sim().body(1), Some(&5));
    assert_eq!(d.core().game().players[&1].at, 0, "a body isn't logged");
    let states: Vec<_> = Driver::<Tally>::received(&mut rx1)
        .into_iter()
        .filter(|m| matches!(m, ServerMsg::PlayerState { .. }))
        .collect();
    assert!(matches!(
        states[..],
        [ServerMsg::PlayerState {
            seq: 2,
            state: 5,
            ..
        }]
    ));

    // Control back to the first; the second's queued input is dropped.
    d.client(second, ClientMsg::Input { seq: 3, input: 100 });
    d.client(first, ClientMsg::TakeControl);
    d.tick(Instant::now() + Duration::from_millis(60));
    assert_eq!(d.sim().body(1), Some(&5));
    // The driver leaving hands control to the one left.
    d.disconnect(first);
    assert!(Driver::<Tally>::received(&mut rx2).contains(&ServerMsg::Control { driving: true }));
    assert!(d.core().game().players[&1].present);
    d.disconnect(second);
    assert!(!d.core().game().players[&1].present);
    assert_eq!(d.sim().body(1), None);
    assert_eq!(d.core().game().players[&1].at, 5, "where it left is logged");
    assert!(d.sim().status().get().players.is_empty());
}

#[test]
fn commands_flush_before_their_result() {
    let mut d = Driver::new(Sim::new(Core::new(Tally::new(false)), None, paused()));
    let (ada, mut rx) = d.connect("ada", Empty);
    Driver::<Tally>::received(&mut rx);
    command(&mut d, ada, 1, "add 4");
    let msgs = Driver::<Tally>::received(&mut rx);
    assert_eq!(
        msgs,
        vec![
            ServerMsg::Game("ada 4".into()),
            ServerMsg::CommandResult {
                seq: 1,
                result: "4".into()
            }
        ]
    );
    d.client(ada, ClientMsg::Ping { client_time: 9 });
    assert!(matches!(
        Driver::<Tally>::received(&mut rx)[..],
        [ServerMsg::Pong {
            client_time: 9,
            paused: true,
            ..
        }]
    ));
}

#[test]
fn a_reload_replays_the_log_into_the_new_game() {
    let mut d = Driver::new(Sim::new(Core::new(Tally::new(false)), None, paused()));
    let (ada, mut rx) = d.connect("ada", Empty);
    command(&mut d, ada, 1, "add 2");
    command(&mut d, ada, 2, "add 3");
    let (reply, outcome) = std::sync::mpsc::channel();
    d.sim_mut().reload(Arc::new(0), Some(reply.clone()));
    assert!(
        outcome.recv().unwrap().is_err(),
        "the game refused the data"
    );
    // Held until the command is logged: a command ticks the sim first, so
    // a replay already done would swap before it (the report one version
    // behind).
    let hold = d.core().game().hold.clone();
    hold.store(true, Ordering::Relaxed);
    d.sim_mut().reload(Arc::new(10), Some(reply));
    // Logged while the replay runs: caught up before the swap.
    command(&mut d, ada, 3, "add 1");
    hold.store(false, Ordering::Relaxed);
    let report = loop {
        d.tick(Instant::now());
        if let Ok(report) = outcome.try_recv() {
            break report.expect("reloaded");
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    assert_eq!(report.version, d.core().version());
    assert_eq!(report.clients, 1);
    assert_eq!(report.caught_up, 1, "{report:?}");
    assert_eq!(d.core().game().tally_of("ada"), Some(60));
    assert!(Driver::<Tally>::received(&mut rx).contains(&ServerMsg::Game("reloaded x10".into())));
    assert!(!d.sim().status().get().reloading);
}

#[test]
fn a_log_replays_to_the_same_state_hash() {
    let dir = temp_dir("replay");
    let sim = Sim::create(&dir, Tally::new(true), b"tally", paused()).unwrap();
    let mut d = Driver::new(sim);
    let (ada, _rx1) = d.connect("ada", Empty);
    let (bo, _rx2) = d.connect("bo", Empty);
    command(&mut d, ada, 1, "add 2");
    command(&mut d, bo, 1, "later 7");
    d.advance(3).unwrap();
    command(&mut d, ada, 2, "later 1");
    d.client(bo, ClientMsg::Input { seq: 1, input: -4 });
    d.tick(Instant::now());
    d.advance(10).unwrap();
    command(&mut d, bo, 2, "add 5");
    d.disconnect(ada);
    let live = d.stop();
    assert_eq!(live.game().tally_of("bo"), Some(12));
    assert_eq!(live.game().tally_of("ada"), Some(3));

    // The log, read back and replayed, then brought to the same time.
    let read = tc_store::read(&dir, &tally::TallyLog).unwrap();
    let (mut replayed, done) = Core::replayed(Tally::new(true), &read.entries).unwrap();
    assert_eq!(done.skipped, 0);
    assert_eq!(replayed.version(), live.version());
    replayed.advance_to(live.time());
    assert_eq!(
        tc_sim::hash_hex(replayed.state_hash()),
        tc_sim::hash_hex(live.state_hash())
    );
    // And opening the store resumes from there.
    let (sim, meta) = Sim::open(&dir, Tally::new(true), paused()).unwrap();
    assert_eq!(meta, b"tally");
    assert_eq!(sim.core().state_hash(), live.state_hash());
    drop(sim);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Ticks until the reload answers.
fn reloaded(
    d: &mut Driver<Tally>,
    outcome: &std::sync::mpsc::Receiver<Result<tc_sim::ReloadReport, String>>,
) -> tc_sim::ReloadReport {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        d.tick(Instant::now());
        if let Ok(report) = outcome.try_recv() {
            break report.expect("reloaded");
        }
        assert!(Instant::now() < deadline, "the reload never finished");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn a_reload_far_behind_takes_another_round() {
    let mut d = Driver::new(Sim::new(Core::new(Tally::new(false)), None, paused()));
    let (ada, mut rx) = d.connect("ada", Empty);
    d.client(ada, ClientMsg::Input { seq: 1, input: 9 });
    d.tick(Instant::now());
    d.client(
        ada,
        ClientMsg::Subscribe {
            sub: 1,
            query: "mine".into(),
            args: tc_wire::Bytes(Vec::new()),
            resume: None,
        },
    );
    command(&mut d, ada, 1, "add 1");
    let hold = d.core().game().hold.clone();
    hold.store(true, Ordering::Relaxed);
    let (reply, outcome) = std::sync::mpsc::channel();
    d.sim_mut().reload(Arc::new(2), Some(reply));
    // Logged while the replay is held: more than one pause should take.
    let behind = tc_sim::SWAP_BEHIND as u32 + 50;
    for seq in 0..behind {
        command(&mut d, ada, seq + 2, "add 1");
    }
    Driver::<Tally>::received(&mut rx);
    hold.store(false, Ordering::Relaxed);
    let report = reloaded(&mut d, &outcome);
    assert_eq!(report.rounds, 2, "{report:?}");
    assert_eq!(report.caught_up, behind as usize);
    let total = u64::from(behind + 1) * 2;
    assert_eq!(d.core().game().tally_of("ada"), Some(total));
    assert_eq!(d.sim().body(1), Some(&9), "a body outlives a reload");
    // The query reruns against the new game.
    d.tick(Instant::now() + Duration::from_millis(100));
    let msgs = Driver::<Tally>::received(&mut rx);
    assert!(
        msgs.iter()
            .any(|m| matches!(m, ServerMsg::Resync { sub: 1, result, .. }
            if *result.0 == tc_wire::Wire::to_bytes(&total)[..])),
        "{msgs:?}"
    );
}

#[test]
fn a_reload_asked_for_during_one_waits_its_turn() {
    let mut d = Driver::new(Sim::new(Core::new(Tally::new(false)), None, paused()));
    let (ada, _rx) = d.connect("ada", Empty);
    command(&mut d, ada, 1, "add 1");
    let (reply, outcome) = std::sync::mpsc::channel();
    d.sim_mut().reload(Arc::new(2), Some(reply.clone()));
    d.sim_mut().reload(Arc::new(0), Some(reply.clone()));
    d.sim_mut().reload(Arc::new(3), Some(reply));
    assert_eq!(reloaded(&mut d, &outcome).rounds, 1);
    assert!(
        outcome.recv().unwrap().is_err(),
        "the zero is refused in turn"
    );
    reloaded(&mut d, &outcome);
    assert_eq!(d.core().game().tally_of("ada"), Some(3));
    assert!(!d.sim().status().get().reloading);
}

#[test]
fn rules_read_bodies_after_an_input_tick_and_log_only_what_they_decide() {
    let dir = temp_dir("moved");
    let sim = Sim::create(&dir, Tally::new(false), b"tally", paused()).unwrap();
    let mut d = Driver::new(sim);
    let (ada, _rx) = d.connect("ada", Empty);
    // Its join is applied before its body is made: a new player has one.
    assert_eq!(d.sim().body(1), Some(&0));
    let version = d.core().version();
    // Inputs on the driver's clock: no wall time.
    let start = d.now();
    d.push_input(ada, 400);
    d.input_tick();
    assert_eq!(d.sim().body(1), Some(&400));
    assert_eq!(d.core().version(), version, "a move is not logged");
    d.push_input(ada, tally::FAR);
    d.input_tick();
    assert!(d.now() > start);
    assert_eq!(d.core().version(), version + 1, "the rule's event is");
    assert_eq!(d.core().game().tally_of("ada"), Some(1));
    let live = d.stop();
    // The replay has no bodies, and needs none: the event is logged.
    let read = tc_store::read(&dir, &tally::TallyLog).unwrap();
    let (replayed, _) = Core::replayed(Tally::new(false), &read.entries).unwrap();
    assert_eq!(replayed.game().tally_of("ada"), Some(1));
    assert_eq!(replayed.state_hash(), live.state_hash());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn opening_after_a_crash_runs_on_open() {
    let dir = temp_dir("on-open");
    let sim = Sim::create(&dir, Tally::new(false), b"tally", paused()).unwrap();
    let mut d = Driver::new(sim);
    let (_ada, _rx) = d.connect("ada", Empty);
    assert!(d.core().game().players[&1].present);
    // A crash: dropped, never stopped, so nobody was logged leaving.
    drop(d);
    let (sim, _) = Sim::open(&dir, Tally::new(false), paused()).unwrap();
    assert!(!sim.core().game().players[&1].present, "on_open cleared it");
    drop(sim);
    // It was logged: a replay passes through it too.
    let read = tc_store::read(&dir, &tally::TallyLog).unwrap();
    let (replayed, _) = Core::replayed(Tally::new(false), &read.entries).unwrap();
    assert!(!replayed.game().players[&1].present);
    let _ = std::fs::remove_dir_all(&dir);
}
