//! The arena: 2 to 8 players move around a box, and whoever is "it" tags
//! someone by touching them. The whole game is this file.
//!
//! - A player's position is its body (`Game::Body`): moved by its inputs
//!   at each input tick, unlogged, and predicted by its own client with
//!   the same [`step`] (the TypeScript twin is `src/rules.ts`; both are
//!   checked against `shared/rules.json`).
//! - Tagging needs everyone's position, and the rules only see the
//!   state, so each move is also an event ([`Event::Moved`]) that copies
//!   the position into the state, where [`Arena::apply`] checks for a tag.
//! - Everyone sees everyone through the entity stream ([`Player`] views),
//!   and the scoreboard through the `score {}` query.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;

use tc_wire::Wire;
use tc_wire::hash::StableHasher;
use thunderclap_server::net::{Empty, Identity, Protocol};
use thunderclap_server::sim::{Cx, Game, PlayerId, Query, QueryCtx, Seat};
use thunderclap_server::store::{LogCodec, NameTable, Names};

/// The box's size, in arena units.
pub const WIDTH: i32 = 1280;
/// The box's height.
pub const HEIGHT: i32 = 720;
/// A player's radius: the closest its centre gets to a wall.
pub const RADIUS: i32 = 22;
/// Units a step a held key moves.
pub const SPEED: i32 = 12;
/// How close "it" must be to tag (centre to centre).
pub const REACH: i32 = 50;
/// Steps after a tag before the next can happen (no instant tag-backs).
pub const IMMUNE_STEPS: u64 = 20;
/// Seats; anyone after these watches.
pub const MAX_PLAYERS: usize = 8;

/// Input keys, one bit each.
pub const LEFT: u8 = 1;
/// Right.
pub const RIGHT: u8 = 2;
/// Up (towards y = 0).
pub const UP: u8 = 4;
/// Down.
pub const DOWN: u8 = 8;

/// A position in arena units: a player's body, and its `PlayerState`.
#[derive(Wire, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pos {
    /// Across.
    pub x: i32,
    /// Down.
    pub y: i32,
}

/// The one rule a client predicts: where `keys` held for a step take a
/// player from `p`.
pub fn step(p: Pos, keys: u8) -> Pos {
    let axis = |minus: u8, plus: u8| i32::from(keys & plus != 0) - i32::from(keys & minus != 0);
    Pos {
        x: (p.x + axis(LEFT, RIGHT) * SPEED).clamp(RADIUS, WIDTH - RADIUS),
        y: (p.y + axis(UP, DOWN) * SPEED).clamp(RADIUS, HEIGHT - RADIUS),
    }
}

/// Where seat `player` starts: spread round the middle.
pub fn spawn(player: PlayerId) -> Pos {
    let i = (player.saturating_sub(1) % MAX_PLAYERS as u64) as i32;
    Pos {
        x: WIDTH / 2 + [-1, 1, 0, 0, -1, 1, -1, 1][i as usize] * 240,
        y: HEIGHT / 2 + [0, 0, -1, 1, -1, 1, 1, -1][i as usize] * 180,
    }
}

/// The game's roles on the wire. Inputs are key bits; a player's state
/// is its position.
#[derive(Debug, Clone, PartialEq)]
pub struct ArenaProto;

impl Protocol for ArenaProto {
    type Hello = Empty;
    type Welcome = Empty;
    type Command = Empty;
    type Result = Empty;
    type Interest = Empty;
    type Input = u8;
    type State = Pos;
    type Client = Empty;
    type Server = Empty;
}

/// One player in the entity stream.
#[derive(Wire, Clone, Debug, PartialEq)]
pub struct Player {
    /// Its name.
    pub name: String,
    /// Where it is.
    pub x: i32,
    /// Where it is.
    pub y: i32,
    /// Units a step it last moved (for drawing between snapshots).
    pub vx: i32,
    /// Units a step it last moved.
    pub vy: i32,
    /// Whether it is "it".
    pub it: bool,
}

/// The scoreboard.
#[derive(Wire, Clone, Debug, Default, PartialEq)]
pub struct Score {
    /// Who is "it" (0: nobody, under two players).
    pub it: u64,
    /// Every seat, present or not.
    pub players: Vec<Entry>,
}

/// One seat on the scoreboard.
#[derive(Wire, Clone, Debug, Default, PartialEq)]
pub struct Entry {
    /// Its player id.
    pub id: u64,
    /// Its name.
    pub name: String,
    /// Tags made.
    pub tags: u32,
    /// Whether it is here.
    pub present: bool,
}

/// What the log records.
#[derive(Wire, Clone, Debug, PartialEq)]
pub enum Event {
    /// A new name took the next seat.
    Joined {
        /// The name.
        name: String,
    },
    /// A player arrived or left.
    Present {
        /// Who.
        player: u64,
        /// Here or not.
        present: bool,
        /// Where it is (arriving) or was (leaving).
        at: Pos,
    },
    /// A player's body moved: its new position.
    Moved {
        /// Who.
        player: u64,
        /// Where to.
        to: Pos,
    },
}

/// The log codec: the events' wire bytes. (This server keeps its log in
/// memory; a game that keeps its world uses `Sim::create` and a store.)
#[derive(Clone)]
pub struct ArenaLog;

impl LogCodec for ArenaLog {
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

/// What queries and the entity stream key on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Change {
    /// Who is here, who is it, the tag counts.
    Roster,
    /// One player's position.
    Moved(PlayerId),
}

/// One seat's state.
#[derive(Clone, Debug, Default)]
pub struct Seated {
    /// The name.
    pub name: String,
    /// Here or not.
    pub present: bool,
    /// Its last position (a copy of its body, from [`Event::Moved`]).
    pub at: Pos,
    /// Its last move.
    pub vel: Pos,
    /// Tags made.
    pub tags: u32,
}

/// The game state.
#[derive(Clone, Debug, Default)]
pub struct Arena {
    /// The seats, by player id (1..=8).
    pub seats: BTreeMap<PlayerId, Seated>,
    /// Who is it (0: nobody).
    pub it: PlayerId,
    /// No tag before this time.
    pub calm_until: u64,
}

impl Arena {
    /// An empty arena.
    pub fn new() -> Arena {
        Arena::default()
    }

    /// The scoreboard.
    pub fn score(&self) -> Score {
        Score {
            it: self.it,
            players: self
                .seats
                .iter()
                .map(|(id, s)| Entry {
                    id: *id,
                    name: s.name.clone(),
                    tags: s.tags,
                    present: s.present,
                })
                .collect(),
        }
    }

    /// Someone must be it while two are here, and nobody when fewer.
    fn settle_it(&mut self) {
        let here: Vec<PlayerId> = self
            .seats
            .iter()
            .filter(|(_, s)| s.present)
            .map(|(id, _)| *id)
            .collect();
        if here.len() < 2 {
            self.it = 0;
        } else if !here.contains(&self.it) {
            self.it = here[0];
        }
    }

    /// If "it" touches anyone, the nearest (then the lowest id) is it now.
    fn check_tag(&mut self, now: u64) -> bool {
        if self.it == 0 || now < self.calm_until {
            return false;
        }
        let Some(tagger) = self.seats.get(&self.it).map(|s| s.at) else {
            return false;
        };
        let reach = i64::from(REACH) * i64::from(REACH);
        let near = self
            .seats
            .iter()
            .filter(|(id, s)| **id != self.it && s.present)
            .map(|(id, s)| {
                let (dx, dy) = (i64::from(s.at.x - tagger.x), i64::from(s.at.y - tagger.y));
                (dx * dx + dy * dy, *id)
            })
            .filter(|(d, _)| *d <= reach)
            .min();
        let Some((_, tagged)) = near else {
            return false;
        };
        if let Some(s) = self.seats.get_mut(&self.it) {
            s.tags += 1;
        }
        self.it = tagged;
        self.calm_until = now + IMMUNE_STEPS;
        true
    }
}

impl Game for Arena {
    type Protocol = ArenaProto;
    type Codec = ArenaLog;
    type Scheduled = Empty;
    type Change = Change;
    type Data = ();
    type Body = Pos;
    type View = Player;

    fn queries() -> Vec<Query<Arena>> {
        vec![Query::<Arena>::new(
            "score",
            "Who is it, and everyone's tags.",
            false,
            |cx: &QueryCtx<'_, Arena>, _: Empty| {
                cx.read(Change::Roster);
                Ok(cx.game().score())
            },
        )]
    }

    fn codec(&self) -> ArenaLog {
        ArenaLog
    }

    fn apply(&mut self, ev: &Event, cx: &mut Cx<'_, Arena>) -> Result<(), String> {
        match ev {
            Event::Joined { name } => {
                if self.seats.len() >= MAX_PLAYERS {
                    return Err("the arena is full".into());
                }
                let id = self.seats.len() as PlayerId + 1;
                self.seats.insert(
                    id,
                    Seated {
                        name: name.clone(),
                        at: spawn(id),
                        ..Seated::default()
                    },
                );
            }
            Event::Present {
                player,
                present,
                at,
            } => {
                let s = self.seats.get_mut(player).ok_or("no such seat")?;
                s.present = *present;
                s.at = *at;
                s.vel = Pos::default();
                self.settle_it();
            }
            Event::Moved { player, to } => {
                let s = self.seats.get_mut(player).ok_or("no such seat")?;
                s.vel = Pos {
                    x: to.x - s.at.x,
                    y: to.y - s.at.y,
                };
                s.at = *to;
                cx.mark(Change::Moved(*player));
                if !self.check_tag(cx.time()) {
                    return Ok(());
                }
            }
        }
        cx.mark(Change::Roster);
        Ok(())
    }

    fn hash_state(&self, h: &mut StableHasher) {
        h.write_u64(self.seats.len() as u64);
        for (id, s) in &self.seats {
            h.write_u64(*id);
            h.write_str(&s.name);
            h.write_bool(s.present);
            for v in [s.at.x, s.at.y, s.vel.x, s.vel.y] {
                h.write_i32(v);
            }
            h.write_u32(s.tags);
        }
        h.write_u64(self.it);
        h.write_u64(self.calm_until);
    }

    fn join(&self, who: &Identity, _: &Empty, events: &mut Vec<Event>) -> Result<Seat, String> {
        if who.name.is_empty() {
            return Err("no name".into());
        }
        if let Some((id, _)) = self.seats.iter().find(|(_, s)| s.name == who.name) {
            return Ok(Seat::Player(*id));
        }
        if self.seats.len() >= MAX_PLAYERS {
            return Ok(Seat::Observer);
        }
        events.push(Event::Joined {
            name: who.name.clone(),
        });
        Ok(Seat::Player(self.seats.len() as PlayerId + 1))
    }

    fn welcome(&self, _: PlayerId) -> Empty {
        Empty
    }

    fn body(&self, player: PlayerId) -> Option<Pos> {
        // A seat taken in this same join isn't in the state yet.
        Some(
            self.seats
                .get(&player)
                .map_or_else(|| spawn(player), |s| s.at),
        )
    }

    fn presence(
        &self,
        player: PlayerId,
        present: bool,
        body: Option<&Pos>,
        events: &mut Vec<Event>,
    ) {
        let at = body.copied().unwrap_or_else(|| spawn(player));
        events.push(Event::Present {
            player,
            present,
            at,
        });
    }

    fn command(&self, _: PlayerId, _: Empty, _: &mut Vec<Event>) -> Empty {
        Empty
    }

    fn command_error(&self, _: String) -> Empty {
        Empty
    }

    fn input(&self, player: PlayerId, body: &mut Pos, keys: u8, events: &mut Vec<Event>) {
        let to = step(*body, keys);
        if to != *body {
            *body = to;
            events.push(Event::Moved { player, to });
        }
    }

    fn player_state(&self, _: PlayerId, body: &Pos) -> Option<Pos> {
        Some(*body)
    }

    fn entities(&self, cx: &QueryCtx<'_, Arena>, _: &Empty, out: &mut Vec<(u64, Player)>) {
        cx.read(Change::Roster);
        for (id, s) in &self.seats {
            if !s.present {
                continue;
            }
            cx.read(Change::Moved(*id));
            out.push((
                *id,
                Player {
                    name: s.name.clone(),
                    x: s.at.x,
                    y: s.at.y,
                    vx: s.vel.x,
                    vy: s.vel.y,
                    it: *id == self.it,
                },
            ));
        }
    }

    fn reload(&self, _: Arc<()>) -> Result<Arena, String> {
        Ok(self.clone())
    }
}
