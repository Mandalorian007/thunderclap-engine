//! The turn-based test game (E7): tic-tac-toe on tc-sim
//! (`tests/turns_game/`), run by hand ([`Driver`]) and over real
//! WebSockets:
//!
//! - every turn is logged, and the log replays to the live state hash;
//! - a turn timer on the schedule passes a turn nobody took, and a replay
//!   does the same;
//! - the store rolls back to a mark (an entry number taken mid-round) and
//!   reopens there, at the mark's hash, to play on differently;
//! - a player who drops comes back to the same seat and resumes the board
//!   with a patch;
//!
//! TypeScript's `createNet` plays it through the facade in
//! `thunderclap-server/tests/turns.rs`.

mod turns_game;

use std::path::{Path, PathBuf};

use tc_net::outbound::OutboundRx;
use tc_net::{ClientMsg, Empty, Resume, ServerMsg};
use tc_sim::{Core, Driver, Sim, SimConfig};
use tc_store::{Output, RollbackTo};
use tc_wire::{Bytes, Wire};

use turns_game::{Board, Event, Move, Reply, TURN_STEPS, Turns, TurnsLog, TurnsProto};

type Msg = ServerMsg<TurnsProto>;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-turns-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// A paused sim on a store in `dir`: time moves only by `advance`.
fn paused() -> SimConfig {
    SimConfig {
        paused: true,
        ..SimConfig::default()
    }
}

fn create(dir: &Path) -> Driver<Turns> {
    Driver::new(Sim::create(dir, Turns::new(), b"turns", paused()).unwrap())
}

fn recv(rx: &mut OutboundRx) -> Vec<Msg> {
    Driver::<Turns>::received(rx)
}

/// Sends `mv` from `conn` and returns its reply.
fn play(d: &mut Driver<Turns>, conn: u64, rx: &mut OutboundRx, mv: Move) -> Reply {
    d.client(
        conn,
        ClientMsg::Command {
            seq: 1,
            command: mv,
        },
    );
    recv(rx)
        .into_iter()
        .find_map(|m| match m {
            ServerMsg::CommandResult { result, .. } => Some(result),
            _ => None,
        })
        .expect("a reply")
}

fn place(cell: u8) -> Move {
    Move::Place { cell }
}

fn welcomed(rx: &mut OutboundRx) -> u8 {
    recv(rx)
        .into_iter()
        .find_map(|m| match m {
            ServerMsg::Welcome { ext, .. } => Some(ext),
            _ => None,
        })
        .expect("a welcome")
}

fn subscribe_board(d: &mut Driver<Turns>, conn: u64, resume: Option<Resume>) {
    d.client(
        conn,
        ClientMsg::Subscribe {
            sub: 1,
            query: "board".into(),
            args: Bytes(Empty.to_bytes()),
            resume,
        },
    );
}

/// Replays the store in `dir` to `time` and returns its state hash.
fn replayed_hash(dir: &Path, time: u64) -> (u64, usize) {
    let read = tc_store::read(dir, &TurnsLog).unwrap();
    let (mut core, replayed) = Core::replayed(Turns::new(), &read.entries).unwrap();
    assert_eq!(replayed.skipped, 0);
    core.advance_to(time);
    (core.state_hash(), read.entries.len())
}

#[test]
fn every_turn_is_logged_and_the_log_replays_to_the_same_hash() {
    let dir = temp_dir("replay");
    let mut d = create(&dir);
    let (x, mut rx_x) = d.connect("ada", Empty);
    let (o, mut rx_o) = d.connect("bo", Empty);
    let (w, mut rx_w) = d.connect("cy", Empty);
    assert_eq!(welcomed(&mut rx_x), 1);
    assert_eq!(welcomed(&mut rx_o), 2);
    assert_eq!(welcomed(&mut rx_w), 0, "a third name watches");

    // Refusals change nothing and log nothing.
    assert_eq!(
        play(&mut d, o, &mut rx_o, place(4)),
        Reply::Refused("not your turn".into())
    );
    assert!(matches!(
        play(&mut d, w, &mut rx_w, place(4)),
        Reply::Refused(_)
    ));
    // X takes the top row, O the middle; turns some steps apart.
    for (seat, cell) in [(0, 0), (1, 3), (0, 1), (1, 4)] {
        let (conn, rx) = if seat == 0 {
            (x, &mut rx_x)
        } else {
            (o, &mut rx_o)
        };
        assert_eq!(play(&mut d, conn, rx, place(cell)), Reply::Done);
        d.advance(7).unwrap();
    }
    assert_eq!(
        play(&mut d, o, &mut rx_o, place(5)),
        Reply::Refused("not your turn".into())
    );
    assert_eq!(
        play(&mut d, x, &mut rx_x, place(1)),
        Reply::Refused("taken".into())
    );
    assert_eq!(play(&mut d, x, &mut rx_x, place(2)), Reply::Done);
    assert_eq!(d.core().game().winner, 1, "X takes the top row");
    assert_eq!(d.core().game().wins, [1, 0]);

    // Round two: O opens, then lets the clock run out; the turn passes.
    assert_eq!(play(&mut d, o, &mut rx_o, Move::Rematch), Reply::Done);
    assert_eq!(d.core().game().next, 2);
    assert_eq!(play(&mut d, o, &mut rx_o, place(4)), Reply::Done);
    assert_eq!(d.core().game().next, 1);
    d.advance(TURN_STEPS).unwrap();
    assert_eq!(d.core().game().next, 2, "X's turn ran out");
    assert_eq!(play(&mut d, o, &mut rx_o, place(0)), Reply::Done);

    let live = d.stop();
    // Two joins, five placed, a rematch, two placed: one entry each.
    let (hash, entries) = replayed_hash(&dir, live.time());
    assert_eq!(entries, 10);
    assert_eq!(hash, live.state_hash(), "the replay reaches the live state");
    let read = tc_store::read(&dir, &TurnsLog).unwrap();
    assert_eq!(read.entries[1].event, Event::Joined { name: "bo".into() });
    assert_eq!(read.entries[2].event, Event::Placed { mark: 1, cell: 0 });
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_store_rolls_back_to_a_mark_and_plays_on_from_it() {
    let dir = temp_dir("rollback");
    let mut d = create(&dir);
    let (x, mut rx_x) = d.connect("ada", Empty);
    let (o, mut rx_o) = d.connect("bo", Empty);
    for (seat, cell) in [(0, 0), (1, 3), (0, 1)] {
        let (conn, rx) = if seat == 0 {
            (x, &mut rx_x)
        } else {
            (o, &mut rx_o)
        };
        d.advance(3).unwrap();
        assert_eq!(play(&mut d, conn, rx, place(cell)), Reply::Done);
    }
    // The mark: the entry just written, and the state it leaves.
    let core = d.core();
    let (mark, at, hash) = (core.version(), core.time(), core.state_hash());
    let board = core.game().board();
    // O misses the block and X wins.
    assert_eq!(play(&mut d, o, &mut rx_o, place(4)), Reply::Done);
    assert_eq!(play(&mut d, x, &mut rx_x, place(2)), Reply::Done);
    assert_eq!(d.core().game().winner, 1);
    d.stop();

    let report = tc_store::rollback(&dir, &TurnsLog, RollbackTo::Seq(mark), Output::InPlace)
        .expect("rolls back");
    assert_eq!(report.kept, mark);
    assert!(report.was > mark);
    assert_eq!(replayed_hash(&dir, at).0, hash, "the log ends at the mark");

    // Reopened at the mark, O blocks this time.
    let (sim, meta) = Sim::open(&dir, Turns::new(), paused()).unwrap();
    assert_eq!(meta, b"turns");
    let mut d = Driver::new(sim);
    assert_eq!(d.core().time(), at);
    assert_eq!(d.core().state_hash(), hash);
    assert_eq!(d.core().game().board(), board);
    let (o, mut rx_o) = d.connect("bo", Empty);
    assert_eq!(welcomed(&mut rx_o), 2, "the same seat");
    assert_eq!(play(&mut d, o, &mut rx_o, place(2)), Reply::Done);
    assert_eq!(d.core().game().winner, 0);
    assert_eq!(d.core().game().next, 1);
    d.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_returning_player_takes_its_seat_and_resumes_the_board() {
    // Long names: the board must outweigh a patch's hash, or the server
    // resends it whole (cheaper), and a resume shows no difference.
    let (ada, bo) = ("ada-of-the-long-name", "bo-of-the-even-longer-name");
    let dir = temp_dir("resume");
    let mut d = create(&dir);
    let (x, mut rx_x) = d.connect(ada, Empty);
    let (o, mut rx_o) = d.connect(bo, Empty);
    subscribe_board(&mut d, x, None);
    // By hand, not `play`: the board's change comes with the reply.
    d.client(
        x,
        ClientMsg::Command {
            seq: 1,
            command: place(4),
        },
    );
    // What a client holds: the last result, by version and hash.
    let mut held = None;
    for m in recv(&mut rx_x) {
        match m {
            ServerMsg::Resync {
                version, result, ..
            } => {
                held = Some((version, tc_wire::diff::result_hash(&result.0)));
            }
            ServerMsg::Update { version, hash, .. } => {
                held = Some((version, tc_wire::diff::parse_hash_hex(&hash).unwrap()));
            }
            _ => {}
        }
    }
    let (version, hash) = held.expect("the board after X's move");

    // X drops; O moves meanwhile.
    d.disconnect(x);
    assert_eq!(play(&mut d, o, &mut rx_o, place(0)), Reply::Done);
    let (x, mut rx_x) = d.connect(ada, Empty);
    assert_eq!(welcomed(&mut rx_x), 1, "back in the X seat");
    let resume = Resume {
        version,
        hash: tc_wire::diff::hash_hex(hash),
    };
    subscribe_board(&mut d, x, Some(resume));
    let msgs = recv(&mut rx_x);
    assert!(
        !msgs.iter().any(|m| matches!(m, ServerMsg::Resync { .. })),
        "patched, not resent: {msgs:?}"
    );
    assert!(msgs.iter().any(|m| matches!(m, ServerMsg::Update { .. })));
    assert_eq!(play(&mut d, x, &mut rx_x, place(8)), Reply::Done);
    let b: Board = d.core().game().board();
    assert_eq!(b.cells, vec![2, 0, 0, 0, 1, 0, 0, 0, 1]);
    d.stop();
    let _ = std::fs::remove_dir_all(&dir);
}
