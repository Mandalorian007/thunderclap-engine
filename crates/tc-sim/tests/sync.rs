//! What clients watch, driven by hand ([`Driver`]): live queries shared
//! and rerun only for what they read, entity streams following interest,
//! observers, rate lanes and unlogged bodies.

mod tally;

use std::cell::Cell;
use std::time::{Duration, Instant};

use tally::{ByName, ByPlayer, Every, Span, Tally};
use tc_net::outbound::OutboundRx;
use tc_net::{ClientMsg, Empty, ServerMsg};
use tc_sim::{Core, Driver, MAX_SUBSCRIPTIONS, STATUS_PUBLISH, Sim, SimConfig};
use tc_wire::{Bytes, Wire};

type Msg = ServerMsg<tally::TallyProto>;

fn driver(stepping: bool) -> Driver<Tally> {
    let config = SimConfig {
        paused: true,
        ..SimConfig::default()
    };
    Driver::new(Sim::new(Core::new(Tally::new(stepping)), None, config))
}

fn recv(rx: &mut OutboundRx) -> Vec<Msg> {
    Driver::<Tally>::received(rx)
}

fn subscribe(d: &mut Driver<Tally>, conn: u64, sub: u32, query: &str, args: Vec<u8>) {
    let msg = ClientMsg::Subscribe {
        sub,
        query: query.into(),
        args: Bytes(args),
        resume: None,
    };
    d.client(conn, msg);
}

fn command(d: &mut Driver<Tally>, conn: u64, text: &str) {
    d.client(
        conn,
        ClientMsg::Command {
            seq: 1,
            command: text.into(),
        },
    );
}

fn by_name(name: &str) -> Vec<u8> {
    ByName { name: name.into() }.to_bytes()
}

/// The u64 results resynced, by subscription.
fn resynced(msgs: &[Msg]) -> Vec<(u32, u64)> {
    msgs.iter()
        .filter_map(|m| match m {
            ServerMsg::Resync { sub, result, .. } => {
                Some((*sub, u64::from_bytes(&result.0).unwrap()))
            }
            _ => None,
        })
        .collect()
}

/// The versions patched, by subscription.
fn updated(msgs: &[Msg]) -> Vec<(u32, u64)> {
    msgs.iter()
        .filter_map(|m| match m {
            ServerMsg::Update { sub, version, .. } => Some((*sub, *version)),
            _ => None,
        })
        .collect()
}

/// The versions sent, patched or whole (a small result is resent whole:
/// smaller than a patch and its hash), by subscription.
fn sent(msgs: &[Msg]) -> Vec<(u32, u64)> {
    msgs.iter()
        .filter_map(|m| match m {
            ServerMsg::Update { sub, version, .. } | ServerMsg::Resync { sub, version, .. } => {
                Some((*sub, *version))
            }
            _ => None,
        })
        .collect()
}

fn failed(msgs: &[Msg]) -> Vec<String> {
    msgs.iter()
        .filter_map(|m| match m {
            ServerMsg::QueryFailed { reason, .. } => Some(reason.clone()),
            _ => None,
        })
        .collect()
}

fn frames(msgs: &[Msg]) -> usize {
    msgs.iter()
        .filter(|m| matches!(m, ServerMsg::EntityStream { .. }))
        .count()
}

thread_local! {
    static NOW: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// The test's clock, 100 ms on at each call: past the next flush and the
/// next input tick.
fn later() -> Instant {
    NOW.with(|now| {
        let t = now.get().unwrap_or_else(Instant::now) + Duration::from_millis(100);
        now.set(Some(t));
        t
    })
}

/// Takes the inputs and runs the flush that are due.
fn flush(d: &mut Driver<Tally>) {
    d.tick(later());
    d.tick(later());
}

#[test]
fn a_query_is_refused_for_what_it_cant_answer() {
    let mut d = driver(false);
    let (ada, mut rx) = d.connect("ada", Empty);
    recv(&mut rx);
    subscribe(&mut d, ada, 1, "nothing", Vec::new());
    subscribe(&mut d, ada, 2, "tally", vec![0xff]);
    subscribe(&mut d, ada, 3, "tally", by_name("nobody"));
    subscribe(&mut d, ada, 4, "tick", Every { every: 0 }.to_bytes());
    let msgs = recv(&mut rx);
    let reasons = failed(&msgs);
    assert_eq!(reasons.len(), 4, "{msgs:?}");
    assert!(reasons[0].contains("nothing"), "{reasons:?}");
    assert!(reasons[1].starts_with("bad arguments"), "{reasons:?}");
    assert_eq!(reasons[2], "no player \"nobody\"");

    // Past the cap, refused; under it, fine.
    for sub in 10..10 + MAX_SUBSCRIPTIONS as u32 {
        subscribe(&mut d, ada, sub, "mine", Empty.to_bytes());
    }
    let msgs = recv(&mut rx);
    // A query that ran and failed stays subscribed (it reruns when what it
    // read changes): subs 3 and 4 count.
    assert_eq!(resynced(&msgs).len(), MAX_SUBSCRIPTIONS - 2);
    assert_eq!(failed(&msgs).len(), 2, "the last two are over the cap");
}

#[test]
fn a_change_reruns_only_what_read_it_and_clients_share_one_run() {
    let mut d = driver(false);
    let (ada, mut rx_ada) = d.connect("ada", Empty);
    let (bo, mut rx_bo) = d.connect("bo", Empty);
    let mut watchers: Vec<_> = (0..100)
        .map(|i| d.connect(&format!("watch{i}"), Empty))
        .collect();
    for (conn, _) in &watchers {
        subscribe(&mut d, *conn, 1, "tally", by_name("ada"));
    }
    let stats = d.sim().sync_stats();
    assert_eq!(
        (stats.computes, stats.entries),
        (1, 1),
        "one run for a hundred"
    );
    for (_, rx) in &mut watchers {
        assert_eq!(resynced(&recv(rx)), [(1, 0)]);
    }

    // bo's change isn't read by it: nothing reruns, nothing is sent.
    command(&mut d, bo, "add 3");
    flush(&mut d);
    assert_eq!(d.sim().sync_stats().computes, 1);
    assert!(sent(&recv(&mut watchers[0].1)).is_empty());

    // ada's is: one rerun, a patch to each.
    command(&mut d, ada, "add 4");
    flush(&mut d);
    assert_eq!(d.sim().sync_stats().computes, 2);
    let version = d.core().version();
    for (_, rx) in &mut watchers {
        assert_eq!(sent(&recv(rx)), [(1, version)]);
    }
    // Per-player queries are per player.
    subscribe(&mut d, ada, 7, "mine", Empty.to_bytes());
    subscribe(&mut d, bo, 7, "mine", Empty.to_bytes());
    assert!(resynced(&recv(&mut rx_ada)).contains(&(7, 4)));
    assert!(resynced(&recv(&mut rx_bo)).contains(&(7, 3)));
    assert_eq!(d.sim().sync_stats().tracking_misses, 0);
}

#[test]
fn a_commands_effects_arrive_before_its_result() {
    let mut d = driver(false);
    let (ada, mut rx) = d.connect("ada", Empty);
    subscribe(&mut d, ada, 1, "mine", Empty.to_bytes());
    recv(&mut rx);
    command(&mut d, ada, "add 4");
    let msgs = recv(&mut rx);
    assert!(
        matches!(
            msgs[..],
            [
                ServerMsg::Game(_),
                ServerMsg::Resync { sub: 1, .. },
                ServerMsg::CommandResult { .. }
            ]
        ),
        "{msgs:?}"
    );
}

#[test]
fn a_resubscribe_replaces_and_a_failed_one_ends_the_old() {
    let mut d = driver(false);
    let (ada, mut rx) = d.connect("ada", Empty);
    subscribe(&mut d, ada, 1, "mine", Empty.to_bytes());
    subscribe(&mut d, ada, 1, "tally", by_name("nobody"));
    command(&mut d, ada, "add 1");
    let msgs = recv(&mut rx);
    assert_eq!(failed(&msgs).len(), 1);
    assert!(sent(&msgs).len() == 1, "the old one ended: {msgs:?}");
    // Unsubscribed and idle: kept a while for a resume.
    subscribe(&mut d, ada, 2, "mine", Empty.to_bytes());
    d.client(ada, ClientMsg::Unsubscribe { sub: 2 });
    let stats = d.sim().sync_stats();
    assert_eq!((stats.entries, stats.idle), (2, 1), "{stats:?}");
}

#[test]
fn a_returning_client_resumes_with_a_patch() {
    let mut d = driver(false);
    let (ada, mut rx) = d.connect("ada-of-the-long-name", Empty);
    let (_bo, _rx_bo) = d.connect("bo-of-the-long-name", Empty);
    subscribe(&mut d, ada, 1, "board", Empty.to_bytes());
    command(&mut d, ada, "add 1");
    let (version, hash) = recv(&mut rx)
        .into_iter()
        .find_map(|m| match m {
            ServerMsg::Update { version, hash, .. } => Some((version, hash)),
            _ => None,
        })
        .expect("a patch");
    d.disconnect(ada);
    let (ada, mut rx) = d.connect("ada-of-the-long-name", Empty);
    command(&mut d, ada, "add 2");
    recv(&mut rx);
    d.client(
        ada,
        ClientMsg::Subscribe {
            sub: 1,
            query: "board".into(),
            args: Bytes(Empty.to_bytes()),
            resume: Some(tc_net::Resume { version, hash }),
        },
    );
    let msgs = recv(&mut rx);
    assert!(resynced(&msgs).is_empty(), "patched, not resent: {msgs:?}");
    assert_eq!(updated(&msgs).len(), 1, "{msgs:?}");
}

#[test]
fn a_slow_client_skips_to_the_latest() {
    let mut d = driver(false);
    let (ada, mut rx_ada) = d.connect("ada", Empty);
    let (slow, mut rx_slow) = d.connect("slow", Empty);
    subscribe(&mut d, ada, 1, "mine", Empty.to_bytes());
    subscribe(&mut d, slow, 1, "tally", by_name("ada"));
    recv(&mut rx_slow);
    // Over a megabyte waits for the slow client, which isn't reading.
    d.client(ada, ClientMsg::Game("x".repeat(1 << 21)));
    recv(&mut rx_ada);
    for _ in 0..3 {
        command(&mut d, ada, "add 1");
        flush(&mut d);
    }
    assert_eq!(sent(&recv(&mut rx_ada)).len(), 3);
    let msgs = recv(&mut rx_slow);
    assert!(sent(&msgs).is_empty(), "skipped while behind");
    // It read: the next flush brings it straight to the latest.
    flush(&mut d);
    let msgs = recv(&mut rx_slow);
    assert_eq!(sent(&msgs), [(1, d.core().version())], "{msgs:?}");
}

#[test]
fn bodies_volatile_and_expiring_results_rerun_when_due() {
    let mut d = driver(true);
    let (ada, mut rx) = d.connect("ada", Empty);
    subscribe(&mut d, ada, 1, "where", ByPlayer { player: 1 }.to_bytes());
    subscribe(&mut d, ada, 2, "steps", Empty.to_bytes());
    subscribe(&mut d, ada, 3, "tick", Every { every: 5 }.to_bytes());
    let msgs = recv(&mut rx);
    assert_eq!(resynced(&msgs).len(), 3, "{msgs:?}");
    let version = d.core().version();

    // An input moves the body, unlogged: `where` follows.
    d.client(ada, ClientMsg::Input { seq: 1, input: 3 });
    flush(&mut d);
    assert_eq!(d.core().version(), version, "nothing logged");
    let subs: Vec<u32> = sent(&recv(&mut rx)).iter().map(|u| u.0).collect();
    assert!(subs.contains(&1), "{subs:?}");
    assert!(!subs.contains(&3), "tick holds until step 5");

    // Steps mark nothing: `tick` (expired) reruns, `steps` (volatile) only
    // once something changes.
    d.advance(6).unwrap();
    flush(&mut d);
    let subs: Vec<u32> = sent(&recv(&mut rx)).iter().map(|u| u.0).collect();
    assert_eq!(subs, [3]);
    command(&mut d, ada, "add 1");
    let subs: Vec<u32> = sent(&recv(&mut rx)).iter().map(|u| u.0).collect();
    assert_eq!(subs, [2]);
    assert_eq!(d.sim().sync_stats().tracking_misses, 0);
}

#[test]
fn the_entity_stream_follows_interest() {
    let mut d = driver(false);
    let (ada, mut rx) = d.connect("ada", Empty);
    let (bo, _rx_bo) = d.connect("bo", Empty);
    d.client(
        ada,
        ClientMsg::SetInterest {
            interest: Span { from: 0, to: 500 },
        },
    );
    assert!(
        recv(&mut rx)
            .iter()
            .any(|m| matches!(m, ServerMsg::InterestRejected { .. }))
    );
    d.client(
        ada,
        ClientMsg::SetInterest {
            interest: Span { from: -5, to: 5 },
        },
    );
    assert_eq!(frames(&recv(&mut rx)), 1, "a key frame at once");

    // bo walks within the span: a frame; out of it: one more (it went);
    // further out: none.
    for (seq, by) in [(1, 2), (2, 10), (3, 10)] {
        d.client(bo, ClientMsg::Input { seq, input: by });
        flush(&mut d);
        let n = frames(&recv(&mut rx));
        assert_eq!(n, usize::from(seq < 3), "step {seq}");
    }
    // A key frame asked for comes even with nothing changed.
    d.client(ada, ClientMsg::EntityResync);
    assert_eq!(frames(&recv(&mut rx)), 1);
}

#[test]
fn an_observer_watches_and_never_acts() {
    let mut d = driver(false);
    let (ada, _rx_ada) = d.connect("ada", Empty);
    let (eye, mut rx) = d.connect("watcher", Empty);
    let msgs = recv(&mut rx);
    assert!(
        matches!(msgs[..], [ServerMsg::Welcome { player: 0, .. }]),
        "{msgs:?}"
    );
    assert_eq!(d.sim().status().get().players, vec![1]);
    command(&mut d, eye, "add 1");
    subscribe(&mut d, eye, 1, "mine", Empty.to_bytes());
    subscribe(&mut d, eye, 2, "tally", by_name("ada"));
    d.client(eye, ClientMsg::Input { seq: 1, input: 1 });
    d.client(
        eye,
        ClientMsg::SetInterest {
            interest: Span { from: -1, to: 1 },
        },
    );
    let msgs = recv(&mut rx);
    assert!(msgs.contains(&ServerMsg::CommandResult {
        seq: 1,
        result: "error: an observer can't act".into()
    }));
    assert_eq!(failed(&msgs).len(), 1, "a per-player query: {msgs:?}");
    assert_eq!(resynced(&msgs), [(2, 0)]);
    assert_eq!(frames(&msgs), 1);
    command(&mut d, ada, "add 2");
    flush(&mut d);
    assert_eq!(sent(&recv(&mut rx)).len(), 1);
    d.disconnect(eye);
    assert_eq!(d.sim().status().get().players, vec![1]);
}

#[test]
fn a_lane_drops_messages_over_its_budget() {
    let mut d = driver(false);
    let (ada, mut rx) = d.connect("ada", Empty);
    recv(&mut rx);
    for _ in 0..4 {
        d.client(ada, ClientMsg::Game("wave".into()));
    }
    d.client(ada, ClientMsg::Game("hi".into()));
    let msgs = recv(&mut rx);
    let waves = msgs
        .iter()
        .filter(|m| **m == ServerMsg::Game("ada: wave".into()))
        .count();
    assert_eq!(waves, 2, "a burst of two");
    assert!(
        msgs.contains(&ServerMsg::Game("ada: hi".into())),
        "no lane, no limit"
    );
    d.tick(Instant::now() + STATUS_PUBLISH * 2);
    assert_eq!(d.sim().status().get().limited, 2);
}
