//! The live side of the loop, on a busy real-time test game ([`Field`]):
//! live stepping only while the game is live, outcomes logged and replayed
//! to the same hash, wall-clock wakes (even paused), `act` with cooldowns
//! and news before the result, a stream that follows the body, entity
//! frames at the input rate, `verify_live`, one-shot queries, counters,
//! and a steady live tick that does nothing but step (the workspace forbids
//! unsafe code, so allocations aren't counted here: the loop's live path
//! reuses its buffers, and an empty batch or outbox allocates nothing).

mod fit_game;

use std::path::PathBuf;
use std::time::Duration;

use fit_game::{CHANNEL, COOLDOWN, Field, Move, Pos};
use tc_net::outbound::OutboundRx;
use tc_net::{ClientMsg, Empty, ServerMsg};
use tc_sim::{Core, Driver, Sim, SimConfig};

const STEP: Duration = Duration::from_millis(50);

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-sim-fit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn running() -> SimConfig {
    SimConfig {
        verify_live: true,
        ..SimConfig::default()
    }
}

fn driver(config: SimConfig) -> Driver<Field> {
    Driver::new(Sim::new(Core::new(Field::new()), None, config))
}

fn command(d: &mut Driver<Field>, conn: u64, seq: u32, text: &str) {
    d.client(
        conn,
        ClientMsg::Command {
            seq,
            command: text.into(),
        },
    );
}

fn received(rx: &mut OutboundRx) -> Vec<ServerMsg<fit_game::FieldProto>> {
    Driver::<Field>::received(rx)
}

fn result_of(msgs: &[ServerMsg<fit_game::FieldProto>], seq: u32) -> String {
    msgs.iter()
        .find_map(|m| match m {
            ServerMsg::CommandResult { seq: s, result } if *s == seq => Some(result.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no result for {seq} in {msgs:?}"))
}

fn entity_frames(msgs: &[ServerMsg<fit_game::FieldProto>]) -> usize {
    msgs.iter()
        .filter(|m| matches!(m, ServerMsg::EntityStream { .. }))
        .count()
}

/// Walks `conn`'s body by `moves` inputs, one per input tick.
fn walk(d: &mut Driver<Field>, conn: u64, moves: &[Move]) {
    for m in moves {
        d.push_input(conn, m.clone());
        d.input_tick();
    }
}

#[test]
fn live_steps_run_only_while_the_game_is_live() {
    let mut d = driver(running());
    d.wait(Duration::from_secs(1));
    let quiet = d.sim().counters();
    assert!(quiet.steps >= 19, "{quiet:?}");
    assert_eq!(quiet.live_steps, 0, "nobody here: the clock jumps");

    let (conn, _rx) = d.connect("ada", Empty);
    for _ in 0..20 {
        d.wait(STEP);
    }
    let busy = d.sim().counters().since(&quiet);
    assert!(busy.live_steps >= 20, "{busy:?}");
    assert_eq!(busy.live_steps, d.core().game().live_steps);
    assert!(d.sim().deadline().is_some());

    d.disconnect(conn);
    let left = d.sim().counters();
    d.wait(Duration::from_secs(1));
    let after = d.sim().counters().since(&left);
    assert_eq!(after.live_steps, 0, "{after:?}");
    assert_eq!(d.sim().counters().live_misses, 0);
}

#[test]
fn a_jump_shows_in_the_next_live_step() {
    let mut d = driver(running());
    let (_conn, _rx) = d.connect("ada", Empty);
    d.wait(STEP);
    d.advance(100).unwrap();
    d.wait(STEP * 2);
    assert!(
        d.core().game().most_skipped >= 99,
        "the jump ran no live steps"
    );
}

#[test]
fn live_outcomes_are_logged_and_replay_to_the_same_hash() {
    let dir = temp_dir("replay");
    let sim = Sim::create(&dir, Field::new(), b"", running()).unwrap();
    let mut d = Driver::new(sim);
    let (conn, mut rx) = d.connect("ada", Empty);
    // On the first drifter's path to the body at (0, 0).
    command(&mut d, conn, 1, "place 4 0");
    command(&mut d, conn, 2, "place 5 0");
    command(&mut d, conn, 3, "place 30 30");
    let msgs = received(&mut rx);
    assert_eq!(result_of(&msgs, 1), "placed 0");
    for _ in 0..60 {
        d.wait(STEP);
    }
    let game = d.core().game();
    assert_eq!(game.drifted, 2, "the drifter took both on its path");
    assert_eq!(game.tokens.len(), 1);
    assert!(game.live_steps >= 60);
    let live = d.sim().counters();
    assert_eq!(live.live_misses, 0);
    assert!(live.batches >= 5 && live.events >= 6, "{live:?}");
    let core = d.stop();
    let hash = core.state_hash();
    drop(core);

    // The drifters aren't replayed; their outcomes are.
    let (sim, _) = Sim::open(&dir, Field::new(), running()).unwrap();
    assert_eq!(sim.core().state_hash(), hash);
    assert_eq!(sim.core().game().drifted, 2);
    assert!(sim.core().game().drifters.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_wake_finishes_a_channel_even_while_paused() {
    let mut d = driver(SimConfig {
        paused: true,
        ..running()
    });
    let (conn, mut rx) = d.connect("ada", Empty);
    walk(
        &mut d,
        conn,
        &[Move { dx: 1, dy: 0 }, Move { dx: 1, dy: 1 }],
    );
    assert_eq!(d.sim().body(1), Some(&Pos { x: 2, y: 1 }));
    received(&mut rx);

    command(&mut d, conn, 1, "recall");
    assert_eq!(result_of(&received(&mut rx), 1), "channeling");
    let wake = d.sim().next_wake().expect("a wake");
    assert!(d.sim().deadline().is_some_and(|at| at <= wake));

    d.wait(CHANNEL / 2);
    assert_eq!(d.sim().body(1), Some(&Pos { x: 2, y: 1 }));
    d.wait(CHANNEL);
    assert_eq!(d.sim().body(1), Some(&Pos::default()), "home");
    assert_eq!(d.core().game().players[&1].recalls, 1);
    assert_eq!(d.sim().counters().wakes, 1);
    assert!(d.sim().next_wake().is_none());
    assert_eq!(d.core().time(), 0, "the clock stayed paused");
    d.wait(STEP * 2);
    let msgs = received(&mut rx);
    assert!(
        msgs.contains(&ServerMsg::Game("recalled".into())),
        "{msgs:?}"
    );
    assert!(
        entity_frames(&msgs) >= 1,
        "the moved body's stream followed"
    );
}

#[test]
fn act_keeps_a_wall_clock_cooldown_and_sends_news_before_the_result() {
    let mut d = driver(SimConfig {
        paused: true,
        ..running()
    });
    let (conn, mut rx) = d.connect("ada", Empty);
    command(&mut d, conn, 1, "place 0 0");
    command(&mut d, conn, 2, "take");
    let msgs = received(&mut rx);
    let news = msgs
        .iter()
        .position(|m| *m == ServerMsg::Game("you took token 0".into()))
        .expect("news");
    let result = msgs
        .iter()
        .position(|m| matches!(m, ServerMsg::CommandResult { seq: 2, .. }))
        .expect("a result");
    assert!(news < result, "{msgs:?}");
    assert_eq!(result_of(&msgs, 2), "took 0");
    assert_eq!(d.core().game().players[&1].score, 1);

    command(&mut d, conn, 3, "take");
    assert_eq!(result_of(&received(&mut rx), 3), "error: wait");
    d.wait(COOLDOWN);
    command(&mut d, conn, 4, "take");
    assert_eq!(result_of(&received(&mut rx), 4), "error: nothing here");
    assert_eq!(d.sim().counters().commands, 4);
}

#[test]
fn the_stream_follows_the_body_not_set_interest() {
    let mut d = driver(SimConfig {
        paused: true,
        entities_on_input: true,
        ..running()
    });
    let (conn, mut rx) = d.connect("ada", Empty);
    let msgs = received(&mut rx);
    assert_eq!(entity_frames(&msgs), 1, "a stream without SetInterest");

    let wide = fit_game::Area { x: 0, y: 0, r: 99 };
    d.client(conn, ClientMsg::SetInterest { interest: wide });
    let msgs = received(&mut rx);
    assert!(
        msgs.iter()
            .any(|m| matches!(m, ServerMsg::InterestRejected { .. })),
        "still checked: {msgs:?}"
    );
    let elsewhere = fit_game::Area { x: 50, y: 50, r: 2 };
    d.client(
        conn,
        ClientMsg::SetInterest {
            interest: elsewhere,
        },
    );
    assert_eq!(entity_frames(&received(&mut rx)), 0, "the body leads");

    // With entities_on_input, a move is in the stream at the input tick,
    // before any flush.
    let flushes = d.sim().counters().flushes;
    d.push_input(conn, Move { dx: 1, dy: 0 });
    d.input_tick();
    let msgs = received(&mut rx);
    assert_eq!(d.sim().counters().flushes, flushes, "no flush yet");
    assert_eq!(entity_frames(&msgs), 1, "{msgs:?}");
    assert!(
        msgs.iter()
            .any(|m| matches!(m, ServerMsg::PlayerState { .. }))
    );
}

#[test]
fn without_entities_on_input_moves_wait_for_the_flush() {
    let mut d = driver(SimConfig {
        paused: true,
        ..running()
    });
    let (conn, mut rx) = d.connect("ada", Empty);
    received(&mut rx);
    d.push_input(conn, Move { dx: 1, dy: 0 });
    d.input_tick();
    assert_eq!(entity_frames(&received(&mut rx)), 0);
    d.wait(STEP * 2);
    assert_eq!(entity_frames(&received(&mut rx)), 1);
}

#[test]
fn verify_live_counts_a_hook_that_changes_hashed_state() {
    let mut d = driver(running());
    let (conn, _rx) = d.connect("ada", Empty);
    d.wait(STEP * 4);
    assert_eq!(d.sim().counters().live_misses, 0);
    command(&mut d, conn, 1, "bad");
    d.wait(STEP * 4);
    let misses = d.sim().counters().live_misses;
    assert!(misses >= 3, "{misses}");
    assert_eq!(
        d.sim().status().get().counters.live_misses,
        0,
        "not yet published"
    );
    d.wait(Duration::from_secs(1));
    assert!(d.sim().status().get().counters.live_misses >= misses);

    // Off, nobody checks.
    let mut d = driver(SimConfig {
        verify_live: false,
        ..running()
    });
    let (conn, _rx) = d.connect("ada", Empty);
    command(&mut d, conn, 1, "bad");
    d.wait(STEP * 4);
    assert_eq!(d.sim().counters().live_misses, 0);
}

#[test]
fn a_query_runs_once_without_a_subscription() {
    let mut d = driver(SimConfig {
        paused: true,
        ..running()
    });
    let (conn, _rx) = d.connect("ada", Empty);
    command(&mut d, conn, 1, "place 0 0");
    command(&mut d, conn, 2, "place 1 0");
    assert_eq!(d.query::<Empty, u64>("tokens", &Empty, None), Ok(2));
    command(&mut d, conn, 3, "take");
    assert_eq!(d.query::<Empty, u64>("score", &Empty, Some(1)), Ok(1));
    assert!(d.query::<Empty, u64>("score", &Empty, None).is_err());
    assert!(d.query::<Empty, u64>("nothing", &Empty, None).is_err());
    assert_eq!(d.sim_mut().sync_stats().entries, 0, "nothing subscribed");
}

#[test]
fn a_steady_live_tick_only_steps() {
    let mut d = driver(running());
    let (_conn, _rx) = d.connect("ada", Empty);
    // Every drifter reaches the body and stops (the far one in 2 s).
    for _ in 0..80 {
        d.wait(STEP);
    }
    let before = d.sim().counters();
    let ticks = 40;
    for _ in 0..ticks {
        d.wait(STEP);
    }
    let done = d.sim().counters().since(&before);
    assert_eq!(done.ticks, ticks);
    assert!(done.live_steps >= ticks, "{done:?}");
    assert_eq!(done.steps, done.live_steps, "one live step per step");
    // Nothing moved or was logged: no batch, no flush, no frame.
    assert_eq!(
        (done.batches, done.flushes, done.entity_frames),
        (0, 0, 0),
        "{done:?}"
    );
}
