//! Turns: tic-tac-toe on tc-sim, the turn-based test game (E7, rule 6).
//! A second shape beside the real-time arena (`templates/arena-2d-server`):
//! no steps, no bodies, no entity stream; every move is a logged event,
//! the board is one live query, and a turn timer runs on the schedule.
//!
//! - The first two names to join sit as X (player 1) and O (player 2);
//!   anyone after them watches (an observer).
//! - Commands ([`Move`]): `Place { cell }` on your turn, `Resign`, and
//!   `Rematch` once a round is over. The result is a [`Reply`].
//! - A turn not taken within [`TURN_STEPS`] passes to the other player
//!   (a scheduled [`Timeout`], never logged: a replay schedules it again).
//! - Queries: `board {}` (everyone) and `mark {}` (per player: 1, 2, or 0
//!   for a watcher).

#![allow(dead_code)]

use std::convert::Infallible;
use std::sync::Arc;

use tc_net::{Empty, Identity, Protocol};
use tc_sim::{Cx, Game, PlayerId, Query, Seat};
use tc_store::{LogCodec, NameTable, Names};
use tc_wire::Wire;
use tc_wire::hash::StableHasher;
use tc_wire::schema::Schema;

/// Steps a player has for a turn: 30 s at the default 20 steps a second.
pub const TURN_STEPS: u64 = 600;

/// The game's roles on the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnsProto;

impl Protocol for TurnsProto {
    type Hello = Empty;
    /// The mark a connection plays (1 X, 2 O, 0 watching).
    type Welcome = u8;
    type Command = Move;
    type Result = Reply;
    type Interest = Empty;
    type Input = Empty;
    type State = Empty;
    type Client = Empty;
    type Server = Empty;
}

/// What a player asks for.
#[derive(Wire, Clone, Debug, PartialEq)]
pub enum Move {
    /// Puts the player's mark on a cell (0..9, row by row).
    Place { cell: u8 },
    /// Gives the round up.
    Resign,
    /// Starts the next round once this one is over.
    Rematch,
}

/// A command's answer.
#[derive(Wire, Clone, Debug, PartialEq)]
pub enum Reply {
    Done,
    Refused(String),
}

/// The board as everyone sees it.
#[derive(Wire, Clone, Debug, Default, PartialEq)]
pub struct Board {
    /// Nine cells, row by row: 0 empty, 1 X, 2 O.
    pub cells: Vec<u8>,
    /// Whose turn it is (1 or 2), 0 until both have joined.
    pub next: u8,
    /// 0 playing, 1 X won, 2 O won, 3 a draw.
    pub winner: u8,
    /// Moves made this round.
    pub turn: u32,
    /// Rounds started.
    pub round: u32,
    /// The time the turn passes if not taken.
    pub deadline: u64,
    pub x: String,
    pub o: String,
    pub wins_x: u32,
    pub wins_o: u32,
}

/// The turn timer: the turn `turn` of round `round` ran out.
#[derive(Wire, Clone, Debug, PartialEq)]
pub struct Timeout {
    pub round: u32,
    pub turn: u32,
}

/// What the log records: every turn, as it was taken.
#[derive(Wire, Clone, Debug, PartialEq)]
pub enum Event {
    Joined { name: String },
    Placed { mark: u8, cell: u8 },
    Resigned { mark: u8 },
    Rematch,
}

/// The log codec: the events' own wire bytes.
#[derive(Clone)]
pub struct TurnsLog;

impl LogCodec for TurnsLog {
    type Event = Event;
    type Key = Infallible;

    fn key(&self, _: &Event) -> Option<Infallible> {
        None
    }
    fn file_name(&self, key: &Infallible) -> String {
        match *key {}
    }
    fn parse_file_name(&self, _: &str) -> Option<Infallible> {
        None
    }
    fn encode(&self, ev: &Event, _: &mut Names<'_>, out: &mut Vec<u8>) -> Result<(), String> {
        out.extend_from_slice(&ev.to_bytes());
        Ok(())
    }
    fn decode(&self, bytes: &[u8], _: &NameTable) -> Result<Event, String> {
        Event::from_bytes(bytes).map_err(|e| e.to_string())
    }
}

/// What queries key on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Change {
    Board,
}

const LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

/// The game.
#[derive(Clone, Debug, Default)]
pub struct Turns {
    /// X then O.
    pub names: Vec<String>,
    pub cells: [u8; 9],
    pub next: u8,
    pub winner: u8,
    pub turn: u32,
    pub round: u32,
    pub deadline: u64,
    pub wins: [u32; 2],
}

impl Turns {
    pub fn new() -> Turns {
        Turns::default()
    }

    /// The board query's value.
    pub fn board(&self) -> Board {
        Board {
            cells: self.cells.to_vec(),
            next: self.next,
            winner: self.winner,
            turn: self.turn,
            round: self.round,
            deadline: self.deadline,
            x: self.names.first().cloned().unwrap_or_default(),
            o: self.names.get(1).cloned().unwrap_or_default(),
            wins_x: self.wins[0],
            wins_o: self.wins[1],
        }
    }

    /// Starts a turn for `next`, with its timer.
    fn start_turn(&mut self, next: u8, cx: &mut Cx<'_, Turns>) {
        self.next = next;
        self.deadline = cx.time() + TURN_STEPS;
        cx.schedule(
            self.deadline,
            Timeout {
                round: self.round,
                turn: self.turn,
            },
        );
    }

    fn new_round(&mut self, cx: &mut Cx<'_, Turns>) {
        self.cells = [0; 9];
        self.winner = 0;
        self.turn = 0;
        self.round += 1;
        // X opens odd rounds, O even ones.
        let first = if self.round % 2 == 1 { 1 } else { 2 };
        self.start_turn(first, cx);
    }

    fn finish(&mut self, winner: u8) {
        self.winner = winner;
        self.next = 0;
        self.deadline = 0;
        if winner == 1 || winner == 2 {
            self.wins[usize::from(winner - 1)] += 1;
        }
    }

    fn line_won(&self, mark: u8) -> bool {
        LINES
            .iter()
            .any(|l| l.iter().all(|&c| self.cells[c] == mark))
    }

    /// Why `mark` may not make `mv` now, if it may not.
    fn refuse(&self, mark: u8, mv: &Move) -> Option<String> {
        if mark == 0 {
            return Some("watchers don't play".into());
        }
        if self.names.len() < 2 {
            return Some("waiting for a second player".into());
        }
        match mv {
            Move::Rematch => (self.winner == 0).then(|| "the round isn't over".into()),
            Move::Resign => (self.winner != 0).then(|| "the round is over".into()),
            Move::Place { cell } => {
                if self.winner != 0 {
                    Some("the round is over".into())
                } else if self.next != mark {
                    Some("not your turn".into())
                } else if usize::from(*cell) >= 9 {
                    Some("no such cell".into())
                } else if self.cells[usize::from(*cell)] != 0 {
                    Some("taken".into())
                } else {
                    None
                }
            }
        }
    }
}

/// A seat's mark: players 1 and 2 are X and O.
fn mark_of(player: PlayerId) -> u8 {
    u8::try_from(player).ok().filter(|m| *m <= 2).unwrap_or(0)
}

impl Game for Turns {
    type Protocol = TurnsProto;
    type Codec = TurnsLog;
    type Scheduled = Timeout;
    type Change = Change;
    type Data = ();
    type Body = ();
    type View = Empty;

    fn queries() -> Vec<Query<Turns>> {
        vec![
            Query::<Turns>::new("board", "The board.", false, |cx, _: Empty| {
                cx.read(Change::Board);
                Ok(cx.game().board())
            }),
            Query::<Turns>::new("mark", "The asker's mark.", true, |cx, _: Empty| {
                Ok(cx.player().map_or(0, mark_of))
            }),
        ]
    }

    fn codec(&self) -> TurnsLog {
        TurnsLog
    }

    fn apply(&mut self, ev: &Event, cx: &mut Cx<'_, Turns>) -> Result<(), String> {
        match ev {
            Event::Joined { name } => {
                if self.names.len() >= 2 {
                    return Err("both seats are taken".into());
                }
                self.names.push(name.clone());
                if self.names.len() == 2 {
                    self.new_round(cx);
                }
            }
            Event::Placed { mark, cell } => {
                if let Some(why) = self.refuse(*mark, &Move::Place { cell: *cell }) {
                    return Err(why);
                }
                self.cells[usize::from(*cell)] = *mark;
                self.turn += 1;
                if self.line_won(*mark) {
                    self.finish(*mark);
                } else if self.turn == 9 {
                    self.finish(3);
                } else {
                    self.start_turn(3 - *mark, cx);
                }
            }
            Event::Resigned { mark } => {
                if let Some(why) = self.refuse(*mark, &Move::Resign) {
                    return Err(why);
                }
                self.finish(3 - *mark);
            }
            Event::Rematch => {
                if self.winner == 0 {
                    return Err("the round isn't over".into());
                }
                self.new_round(cx);
            }
        }
        cx.mark(Change::Board);
        Ok(())
    }

    fn fire(&mut self, t: Timeout, cx: &mut Cx<'_, Turns>) {
        // Only the timer of the turn still waiting counts.
        if t.round == self.round && t.turn == self.turn && self.winner == 0 {
            self.start_turn(3 - self.next, cx);
            cx.mark(Change::Board);
        }
    }

    fn hash_state(&self, h: &mut StableHasher) {
        h.write_u64(self.names.len() as u64);
        for n in &self.names {
            h.write_str(n);
        }
        for c in self.cells {
            h.write_u8(c);
        }
        h.write_u8(self.next);
        h.write_u8(self.winner);
        h.write_u32(self.turn);
        h.write_u32(self.round);
        h.write_u64(self.deadline);
        h.write_u32(self.wins[0]);
        h.write_u32(self.wins[1]);
    }

    fn join(&self, who: &Identity, _: &Empty, events: &mut Vec<Event>) -> Result<Seat, String> {
        if who.name.is_empty() {
            return Err("no name".into());
        }
        if let Some(i) = self.names.iter().position(|n| *n == who.name) {
            return Ok(Seat::Player(i as PlayerId + 1));
        }
        if self.names.len() >= 2 {
            return Ok(Seat::Observer);
        }
        events.push(Event::Joined {
            name: who.name.clone(),
        });
        Ok(Seat::Player(self.names.len() as PlayerId + 1))
    }

    fn welcome(&self, player: PlayerId) -> u8 {
        mark_of(player)
    }

    fn command(&self, player: PlayerId, mv: Move, events: &mut Vec<Event>) -> Reply {
        let mark = mark_of(player);
        if let Some(why) = self.refuse(mark, &mv) {
            return Reply::Refused(why);
        }
        events.push(match mv {
            Move::Place { cell } => Event::Placed { mark, cell },
            Move::Resign => Event::Resigned { mark },
            Move::Rematch => Event::Rematch,
        });
        Reply::Done
    }

    fn command_error(&self, reason: String) -> Reply {
        Reply::Refused(reason)
    }

    fn reload(&self, _: Arc<()>) -> Result<Turns, String> {
        Ok(Turns::new())
    }
}

/// The schema both ends hash.
pub fn schema() -> Schema {
    Turns::schema()
}
