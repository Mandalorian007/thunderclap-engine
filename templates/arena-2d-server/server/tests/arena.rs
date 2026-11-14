//! The arena's rules, its shared vectors and its schema hash.

use arena_server::game::{
    Arena, DOWN, HEIGHT, IMMUNE_STEPS, LEFT, MAX_PLAYERS, Pos, RADIUS, REACH, RIGHT, SPEED, UP,
    WIDTH, step,
};
use std::time::{Duration, Instant};

use tc_net::outbound::OutboundRx;
use tc_net::{ClientMsg, Empty, ServerMsg};
use tc_sim::{Core, Driver, Sim, SimConfig};

const RULES: &str = include_str!("../../shared/rules.json");
const HASH_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../shared/schema-hash.txt");

fn rules() -> serde_json::Value {
    serde_json::from_str(RULES).unwrap()
}

#[test]
fn the_constants_match_the_shared_rules() {
    let r = rules();
    let n = |k: &str| r[k].as_i64().unwrap_or_else(|| panic!("{k}"));
    assert_eq!(n("width"), i64::from(WIDTH));
    assert_eq!(n("height"), i64::from(HEIGHT));
    assert_eq!(n("radius"), i64::from(RADIUS));
    assert_eq!(n("speed"), i64::from(SPEED));
    assert_eq!(n("reach"), i64::from(REACH));
    assert_eq!(n("immuneSteps"), IMMUNE_STEPS as i64);
    assert_eq!(n("maxPlayers"), MAX_PLAYERS as i64);
    assert_eq!(
        n("stepMs") * 1000,
        SimConfig::default().step.as_micros() as i64
    );
    assert_eq!([LEFT, RIGHT, UP, DOWN], [1, 2, 4, 8]);
}

#[test]
fn the_step_matches_the_shared_cases() {
    let cases = rules()["cases"].as_array().unwrap().clone();
    assert!(!cases.is_empty());
    for c in cases {
        let p = |v: &serde_json::Value| Pos {
            x: v[0].as_i64().unwrap() as i32,
            y: v[1].as_i64().unwrap() as i32,
        };
        let keys = c["keys"].as_u64().unwrap() as u8;
        assert_eq!(step(p(&c["from"]), keys), p(&c["to"]), "{c}");
    }
}

/// The schema hash the client must send; `TC_BLESS=1` rewrites it.
#[test]
fn the_schema_hash_is_the_committed_one() {
    let hash = arena_server::schema().hash();
    if std::env::var_os("TC_BLESS").is_some() {
        std::fs::write(HASH_FILE, format!("{hash}\n")).unwrap();
    }
    let committed = std::fs::read_to_string(HASH_FILE).unwrap_or_default();
    assert_eq!(
        committed.trim(),
        hash,
        "the schema changed: update src/schema.ts to match, then rerun with TC_BLESS=1"
    );
}

type Msg = ServerMsg<arena_server::ArenaProto>;

fn recv(rx: &mut OutboundRx) -> Vec<Msg> {
    Driver::<Arena>::received(rx)
}

fn driver() -> Driver<Arena> {
    let config = SimConfig {
        paused: true,
        ..SimConfig::default()
    };
    Driver::new(Sim::new(Core::new(Arena::new()), None, config))
}

thread_local! {
    static NOW: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}

/// The next input tick's wall time.
fn later() -> Instant {
    NOW.with(|now| {
        let t = now.get().unwrap_or_else(Instant::now) + Duration::from_millis(50);
        now.set(Some(t));
        t
    })
}

/// Holds `keys` for `steps` input ticks.
fn hold(d: &mut Driver<Arena>, conn: u64, keys: u8, steps: u32, seq: &mut u32) {
    for _ in 0..steps {
        *seq += 1;
        d.client(
            conn,
            ClientMsg::Input {
                seq: *seq,
                input: keys,
            },
        );
        d.tick(later());
    }
}

#[test]
fn it_tags_the_nearest_and_the_tagged_one_is_it() {
    let mut d = driver();
    let (a, mut rx_a) = d.connect("ada", Empty);
    assert_eq!(d.core().game().it, 0, "nobody is it alone");
    let (b, _rx_b) = d.connect("bo", Empty);
    assert_eq!(d.core().game().it, 1, "the first one here is it");
    recv(&mut rx_a);

    // Ada starts 240 left of the middle, Bo 240 right: Ada runs at him.
    let mut seq = 0;
    hold(&mut d, a, RIGHT, 40, &mut seq);
    let arena = d.core().game();
    assert_eq!(arena.it, 2, "Bo was tagged");
    assert_eq!(arena.seats[&1].tags, 1);
    // Ada's position reached her client as PlayerState.
    let state = recv(&mut rx_a)
        .into_iter()
        .filter_map(|m| match m {
            ServerMsg::PlayerState { seq, state, .. } => Some((seq, state)),
            _ => None,
        })
        .next_back()
        .expect("a PlayerState");
    assert_eq!(state.1, arena.seats[&1].at);
    assert_eq!(state.0, seq);

    // No tag-back while calm, even touching.
    let mut seq_b = 0;
    hold(&mut d, b, 0, 1, &mut seq_b);
    assert_eq!(d.core().game().it, 2);
    // Ada leaves: Bo is alone, so nobody is it.
    d.disconnect(a);
    assert_eq!(d.core().game().it, 0);
    d.stop();
}

#[test]
fn everyone_sees_everyone_in_the_entity_stream() {
    let mut d = driver();
    let (a, mut rx_a) = d.connect("ada", Empty);
    let (b, _rx_b) = d.connect("bo", Empty);
    d.client(a, ClientMsg::SetInterest { interest: Empty });
    let mut seq = 0;
    hold(&mut d, b, DOWN, 3, &mut seq);
    let streamed = recv(&mut rx_a)
        .iter()
        .filter(|m| matches!(m, ServerMsg::EntityStream { .. }))
        .count();
    assert!(streamed >= 2, "the stream follows Bo: {streamed}");
    d.stop();
}

#[test]
fn a_ninth_name_watches() {
    let mut d = driver();
    let mut rxs = Vec::new();
    for i in 0..MAX_PLAYERS {
        rxs.push(d.connect(&format!("p{i}"), Empty));
    }
    let (_, mut rx) = d.connect("late", Empty);
    let player = recv(&mut rx).into_iter().find_map(|m| match m {
        ServerMsg::Welcome { player, .. } => Some(player),
        _ => None,
    });
    assert_eq!(player, Some(0));
    d.stop();
}
