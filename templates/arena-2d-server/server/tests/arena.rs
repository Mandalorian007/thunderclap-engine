//! The arena's rules, its shared vectors and its schema hash.

use arena_server::game::Event;
use arena_server::game::{
    Arena, DOWN, HEIGHT, IMMUNE_STEPS, LEFT, MAX_PLAYERS, Pos, RADIUS, REACH, RIGHT, SPEED, UP,
    WIDTH, step,
};
use thunderclap_server::Game;
use thunderclap_server::net::outbound::OutboundRx;
use thunderclap_server::net::{ClientMsg, Empty, ServerMsg};
use thunderclap_server::sim::{Core, Driver, Sim, SimConfig};

const RULES: &str = include_str!("../../shared/rules.json");
const HASH_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../shared/schema-hash.txt");
const SCHEMA_TS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/schema.ts");

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
        "the schema changed: rerun with TC_BLESS=1"
    );
}

/// The client's schema is generated from the server's; `TC_BLESS=1`
/// rewrites it.
#[test]
fn the_client_schema_is_generated() {
    let ts = thunderclap_server::define_schema_ts(
        &arena_server::schema(),
        thunderclap_server::NET_IMPORT,
    )
    .unwrap();
    if std::env::var_os("TC_BLESS").is_some() {
        std::fs::write(SCHEMA_TS, &ts).unwrap();
    }
    let committed = std::fs::read_to_string(SCHEMA_TS).unwrap_or_default();
    assert!(
        committed == ts,
        "src/schema.ts is stale: rerun with TC_BLESS=1"
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

/// Holds `keys` for `steps` input ticks, on the driver's own clock.
fn hold(d: &mut Driver<Arena>, conn: u64, keys: u8, steps: u32) -> u32 {
    let mut seq = 0;
    for _ in 0..steps {
        seq = d.push_input(conn, keys);
        d.input_tick();
    }
    seq
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
    // Her steps are unlogged; only the tag is.
    let version = d.core().version();
    let seq = hold(&mut d, a, RIGHT, 40);
    assert_eq!(d.core().version(), version + 1, "one event: the tag");
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
    assert_eq!(Some(state.1), d.sim().body(1).map(|b| b.at));
    assert_eq!(state.0, seq);

    // No tag-back while calm, even touching.
    hold(&mut d, b, 0, 1);
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
    hold(&mut d, b, DOWN, 3);
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

#[test]
fn opening_after_a_crash_clears_who_was_here() {
    let mut d = driver();
    let (_a, _rx_a) = d.connect("ada", Empty);
    let (_b, _rx_b) = d.connect("bo", Empty);
    // As a crash leaves it: two here, nobody logged leaving.
    let mut events = Vec::new();
    d.core().game().on_open(0, &mut events);
    let left: Vec<u64> = events
        .iter()
        .map(|e| match e {
            Event::Present {
                player,
                present: false,
                ..
            } => *player,
            e => panic!("{e:?}"),
        })
        .collect();
    assert_eq!(left, [1, 2]);
    d.stop();
}
