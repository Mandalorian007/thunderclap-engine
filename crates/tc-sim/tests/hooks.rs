//! The per-connection hooks ([`Game::connected`], [`Game::disconnected`],
//! [`Game::message_from`]) and a game's clock changes ([`ClockOp`]), on
//! the tally game driven by hand.

mod tally;

use std::time::{Duration, Instant};

use tally::Tally;
use tc_net::{ClientMsg, Empty, ServerMsg};
use tc_sim::{Core, Driver, Sim, SimConfig};

fn paused() -> SimConfig {
    SimConfig {
        paused: true,
        ..SimConfig::default()
    }
}

fn games(msgs: &[ServerMsg<tally::TallyProto>]) -> Vec<String> {
    msgs.iter()
        .filter_map(|m| match m {
            ServerMsg::Game(text) => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn say(d: &mut Driver<Tally>, conn: u64, text: &str) {
    d.client(conn, ClientMsg::Game(text.into()));
}

#[test]
fn each_connection_is_greeted_and_forgotten() {
    let mut game = Tally::new(false);
    game.greets = true;
    let mut d = Driver::new(Sim::new(Core::new(game), None, paused()));
    let (ann, mut ann_rx) = d.connect("ann", Empty);
    let (ann2, mut ann2_rx) = d.connect("ann", Empty);
    let (watch, mut watch_rx) = d.connect("watcher", Empty);

    // Its own greeting, after its Welcome, to that connection only.
    let first = Driver::<Tally>::received(&mut ann_rx);
    assert!(matches!(first[0], ServerMsg::Welcome { .. }));
    assert_eq!(games(&first), ["hi ann"]);
    assert_eq!(games(&Driver::<Tally>::received(&mut ann2_rx)), ["hi ann"]);
    // An observer, by its name.
    assert_eq!(
        games(&Driver::<Tally>::received(&mut watch_rx)),
        ["hi watcher"]
    );
    let conns: Vec<_> = d.core().game().conns.clone().into_iter().collect();
    assert_eq!(
        conns,
        [
            (ann, "ann".to_string()),
            (ann2, "ann".to_string()),
            (watch, "watcher".to_string())
        ]
    );

    // A game message through `message_from`'s default: `message`.
    say(&mut d, ann, "hello");
    assert_eq!(
        games(&Driver::<Tally>::received(&mut watch_rx)),
        ["ann: hello"]
    );

    // One connection closes; the player stays present on the other.
    d.disconnect(ann);
    assert!(!d.core().game().conns.contains_key(&ann));
    assert_eq!(d.sim().present(), [1]);

    // A reload carries the live per-connection state (the game's own
    // `reload` moves it).
    let rx = {
        let (reply, rx) = std::sync::mpsc::channel();
        d.sim_mut().reload(std::sync::Arc::new(2), Some(reply));
        rx
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        d.tick(Instant::now());
        if let Ok(done) = rx.try_recv() {
            done.expect("reloaded");
            break;
        }
        assert!(Instant::now() < deadline, "the reload never finished");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(d.core().game().multiplier, 2, "the reload swapped in");
    assert_eq!(d.core().game().conns.len(), 2);

    // Stopping forgets every connection left.
    let core = d.stop();
    assert!(core.game().conns.is_empty());
}

#[test]
fn a_game_message_changes_the_clock() {
    let mut d = Driver::new(Sim::new(Core::new(Tally::new(true)), None, paused()));
    let (ann, mut rx) = d.connect("ann", Empty);
    Driver::<Tally>::received(&mut rx);

    say(&mut d, ann, "clock step");
    assert_eq!(d.core().time(), 1, "one step while paused");
    assert_eq!(d.core().game().steps, 1);
    assert_eq!(
        games(&Driver::<Tally>::received(&mut rx)),
        ["ann: Advance(1)"]
    );

    say(&mut d, ann, "clock to 40");
    assert_eq!(d.core().time(), 40);
    say(&mut d, ann, "clock to 10");
    assert_eq!(d.core().time(), 40, "never back");

    say(&mut d, ann, "clock resume");
    assert!(!d.sim().clock().paused());
    say(&mut d, ann, "clock pause");
    assert!(d.sim().clock().paused());
    let clocks = Driver::<Tally>::received(&mut rx)
        .into_iter()
        .filter(|m| matches!(m, ServerMsg::Clock { .. }))
        .count();
    // The step's was read above; the refused jump tells nothing.
    assert_eq!(clocks, 3, "every change told");

    // The owner's jump to a time.
    assert_eq!(d.sim_mut().advance_to(100), Ok(100));
    assert!(d.sim_mut().advance_to(99).is_err());
    assert_eq!(d.core().game().steps, 100, "every step stepped");
}
