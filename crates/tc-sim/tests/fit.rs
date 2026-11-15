//! The live side of the loop, on a busy real-time test game ([`Field`]):
//! live stepping only while the game is live, outcomes logged and replayed
//! to the same hash, wall-clock wakes (even paused), `act` with cooldowns
//! and news before the result, a stream that follows the body, entity
//! frames at the input rate, `verify_live`, one-shot queries, counters,
//! a rule that joins the batch it judges, query views that follow the
//! interest, a slow sender closed at its command's flush, entity views
//! split once for every stream,
//! and a steady live tick that does nothing but step (the workspace forbids
//! unsafe code, so allocations aren't counted here: the loop's live path
//! reuses its buffers, and an empty batch or outbox allocates nothing).

mod fit_game;

use std::path::PathBuf;
use std::time::Duration;

use fit_game::{At, CHANNEL, COOLDOWN, Field, HIDDEN, Move, Pos};
use tc_net::outbound::OutboundRx;
use tc_net::{ClientMsg, Empty, ServerMsg};
use tc_sim::{Core, Driver, OUTBOUND_BUDGET, Sim, SimConfig};
use tc_wire::{Bytes, Wire};

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

fn subscribe(d: &mut Driver<Field>, conn: u64, sub: u32, query: &str, args: Vec<u8>) {
    d.client(
        conn,
        ClientMsg::Subscribe {
            sub,
            query: query.into(),
            args: Bytes(args),
            resume: None,
        },
    );
}

/// The `i64` results resent whole to `sub`.
fn spots(msgs: &[ServerMsg<fit_game::FieldProto>], sub: u32) -> Vec<i64> {
    msgs.iter()
        .filter_map(|m| match m {
            ServerMsg::Resync { sub: s, result, .. } if *s == sub => {
                Some(i64::from_bytes(&result.0).unwrap())
            }
            _ => None,
        })
        .collect()
}

#[test]
fn a_rule_joins_the_batch_it_judges() {
    let dir = temp_dir("rules");
    let paused = SimConfig {
        paused: true,
        ..running()
    };
    let sim = Sim::create(&dir, Field::new(), b"", paused).unwrap();
    let mut d = Driver::new(sim);
    let (conn, mut rx) = d.connect("ada", Empty);
    command(&mut d, conn, 1, "place 0 0");
    command(&mut d, conn, 2, "take");
    command(&mut d, conn, 3, "place 0 0");
    d.wait(COOLDOWN);
    received(&mut rx);
    let before = d.sim().counters();
    let version = d.core().version();

    command(&mut d, conn, 4, "take");
    let msgs = received(&mut rx);
    assert_eq!(result_of(&msgs, 4), "took 1");
    let told = msgs
        .iter()
        .position(|m| *m == ServerMsg::Game("rank 1".into()))
        .expect("told of the rank");
    let result = msgs
        .iter()
        .position(|m| matches!(m, ServerMsg::CommandResult { seq: 4, .. }))
        .unwrap();
    assert!(told < result, "the rule's news before the result: {msgs:?}");
    assert_eq!(d.core().game().players[&1].rank, 1);
    assert_eq!(d.core().version(), version + 2, "the take, then its rank");
    let c = d.sim().counters().since(&before);
    assert_eq!((c.batches, c.rule_batches, c.events), (2, 1, 2), "{c:?}");

    // A take that doesn't reach the next rank: no rule batch.
    command(&mut d, conn, 5, "place 0 0");
    d.wait(COOLDOWN);
    command(&mut d, conn, 6, "take");
    assert_eq!(d.sim().counters().rule_batches, 1);

    // The rank is logged: a replay applies it, the rule doesn't rerun.
    d.disconnect(conn);
    let hash = d.core().state_hash();
    drop(d.stop());
    let (sim, _) = Sim::open(&dir, Field::new(), paused).unwrap();
    assert_eq!(sim.core().state_hash(), hash);
    assert_eq!(sim.core().game().players[&1].rank, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_query_view_follows_the_interest() {
    let mut d = driver(SimConfig {
        paused: true,
        ..running()
    });
    let (ada, mut rx) = d.connect("ada", Empty);
    command(&mut d, ada, 1, "place 3 0");
    let spot = At { x: 3, y: 0 }.to_bytes();
    subscribe(&mut d, ada, 7, "spot", spot.clone());
    d.wait(STEP * 2);
    assert_eq!(spots(&received(&mut rx), 7), [0], "in view: the token");

    // Out of her watch: hidden, without the token changing.
    walk(&mut d, ada, &vec![Move { dx: -1, dy: 0 }; 12]);
    d.wait(STEP * 2);
    assert_eq!(spots(&received(&mut rx), 7), [HIDDEN]);
    let one = |d: &Driver<Field>| {
        d.sim()
            .query_as::<At, i64>("spot", &At { x: 3, y: 0 }, Some(1))
            .unwrap()
    };
    assert_eq!(one(&d), HIDDEN, "a one-shot query asks in her view too");

    // Bob, at home, sees it; the token taken shows to him, not to her.
    let (bob, mut bob_rx) = d.connect("bob", Empty);
    subscribe(&mut d, bob, 1, "spot", spot.clone());
    d.wait(STEP * 2);
    assert_eq!(spots(&received(&mut bob_rx), 1), [0]);
    command(&mut d, bob, 2, "place 3 0");
    walk(&mut d, bob, &vec![Move { dx: 1, dy: 0 }; 3]);
    command(&mut d, bob, 3, "take");
    d.wait(STEP * 2);
    assert_eq!(spots(&received(&mut bob_rx), 1), [1], "the second token");
    assert!(
        spots(&received(&mut rx), 7).is_empty(),
        "nothing new to her"
    );

    // Back in view: she shares bob's entry and gets the difference.
    let entries = d.sim().sync_stats().entries;
    walk(&mut d, ada, &vec![Move { dx: 1, dy: 0 }; 12]);
    d.wait(STEP * 2);
    assert_eq!(spots(&received(&mut rx), 7), [1]);
    assert_eq!(one(&d), 1);
    assert_eq!(d.sim().sync_stats().entries, entries, "no new entry");
}

#[test]
fn a_slow_sender_is_closed_at_its_command_flush() {
    for close in [false, true] {
        let mut d = driver(SimConfig {
            paused: true,
            close_slow_senders: close,
            ..running()
        });
        let (conn, mut rx) = d.connect("ada", Empty);
        subscribe(&mut d, conn, 1, "tokens", Empty.to_bytes());
        d.wait(STEP * 2);
        received(&mut rx);
        // Her queue fills past the budget, and she doesn't read it.
        command(&mut d, conn, 1, &format!("bulk {}", OUTBOUND_BUDGET + 1024));
        command(&mut d, conn, 2, "place 1 1");
        let msgs = received(&mut rx);
        let answered = msgs
            .iter()
            .any(|m| matches!(m, ServerMsg::CommandResult { seq: 2, .. }));
        assert_eq!(answered, !close, "close {close}");
        assert_eq!(d.sim().counters().closed_slow, u64::from(close));
        assert_eq!(d.sim().present().is_empty(), close);
        // Placed either way: the command applied.
        assert_eq!(d.core().game().tokens.len(), 1);
    }
}

#[test]
fn entity_views_are_split_once_for_every_stream() {
    let mut d = driver(SimConfig {
        paused: true,
        ..running()
    });
    let (ada, mut rx) = d.connect("ada", Empty);
    let (_bob, mut bob_rx) = d.connect("bob", Empty);
    d.wait(STEP * 2);
    received(&mut rx);
    received(&mut bob_rx);
    let before = d.sim().counters();
    command(&mut d, ada, 1, "place 2 2");
    d.wait(STEP * 2);
    let c = d.sim().counters().since(&before);
    assert_eq!(c.entity_frames, 2, "{c:?}");
    assert_eq!(c.entity_splits, 1, "one new token, split once: {c:?}");
    assert_eq!(entity_frames(&received(&mut rx)), 1);
    assert_eq!(entity_frames(&received(&mut bob_rx)), 1);
}
