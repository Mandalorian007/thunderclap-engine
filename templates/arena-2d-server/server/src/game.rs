//! The arena: 2 to 8 players move around a box, and whoever is "it" tags
//! someone by touching them. The whole game is this file.
//!
//! - A player's position is its body (`Game::Body`): moved by its inputs
//!   at each input tick, unlogged, and predicted by its own client with
//!   the same [`step`] (the TypeScript twin is `src/rules.ts`; both are
//!   checked against `shared/rules.json`).
//! - Tagging needs everyone's position: after each input tick
//!   [`Game::moved`] reads the bodies and, when "it" touches someone,
//!   logs [`Event::Tagged`]. Only tags, arrivals and departures are
//!   logged, never a step.
//! - Everyone sees everyone through the entity stream ([`Player`] views,
//!   read off the bodies), and the scoreboard through the `score {}`
//!   query.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;

use thunderclap_server::net::{Empty, Identity, Protocol};
use thunderclap_server::sim::{Bodies, Cx, Game, PlayerId, Query, QueryCtx, Seat};
use thunderclap_server::store::{LogCodec, NameTable, Names};
use thunderclap_server::wire::Wire;
use thunderclap_server::wire::hash::StableHasher;

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

/// A player's body: where it is and its last move. Unlogged; the
/// entity stream and the tag rule read it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Body {
    /// Where it is.
    pub at: Pos,
    /// Its last step.
    pub vel: Pos,
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
    /// "It" touched someone, who is it now.
    Tagged {
        /// Who tagged.
        by: u64,
        /// Who was tagged.
        who: u64,
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
    /// Who is here, who is it, the tag counts. (Positions are bodies,
    /// which queries read with `QueryCtx::body`.)
    Roster,
}

/// One seat's state.
#[derive(Wire, Clone, Debug, Default)]
pub struct Seated {
    /// The name.
    pub name: String,
    /// Here or not.
    pub present: bool,
    /// Where it arrived or left (from [`Event::Present`]): where it
    /// comes back to.
    pub at: Pos,
    /// Tags made.
    pub tags: u32,
}

/// The game state. It is small and all of it goes in a base
/// ([`Game::save`]), so the log stays bounded however long the server runs.
#[derive(Wire, Clone, Debug, Default)]
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

    /// Who "it" tags at `time` with everyone where `bodies` has them:
    /// the nearest present player in reach (then the lowest id), unless
    /// a tag was too recent.
    pub fn tag(&self, time: u64, bodies: &Bodies<'_, Arena>) -> Option<PlayerId> {
        if self.it == 0 || time < self.calm_until {
            return None;
        }
        let tagger = bodies.get(self.it)?.at;
        let reach = i64::from(REACH) * i64::from(REACH);
        bodies
            .iter()
            .filter(|(id, _)| *id != self.it && self.seats.get(id).is_some_and(|s| s.present))
            .map(|(id, b)| {
                let (dx, dy) = (i64::from(b.at.x - tagger.x), i64::from(b.at.y - tagger.y));
                (dx * dx + dy * dy, id)
            })
            .filter(|(d, _)| *d <= reach)
            .min()
            .map(|(_, id)| id)
    }
}

impl Game for Arena {
    type Protocol = ArenaProto;
    type Codec = ArenaLog;
    type Scheduled = Empty;
    type Change = Change;
    type Data = ();
    type Body = Body;
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
                self.settle_it();
            }
            Event::Tagged { by, who } => {
                if *by != self.it || !self.seats.get(who).is_some_and(|s| s.present) {
                    return Err("not a tag".into());
                }
                if let Some(s) = self.seats.get_mut(by) {
                    s.tags += 1;
                }
                self.it = *who;
                self.calm_until = cx.time() + IMMUNE_STEPS;
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
            for v in [s.at.x, s.at.y] {
                h.write_i32(v);
            }
            h.write_u32(s.tags);
        }
        h.write_u64(self.it);
        h.write_u64(self.calm_until);
    }

    fn save(&self) -> Option<Vec<u8>> {
        Some(self.to_bytes())
    }

    fn restore(&mut self, bytes: &[u8]) -> Result<(), String> {
        *self = Arena::from_bytes(bytes).map_err(|e| e.to_string())?;
        Ok(())
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

    fn on_open(&self, _: u64, events: &mut Vec<Event>) {
        // A crash never logged who left: everyone has.
        for (id, s) in &self.seats {
            if s.present {
                events.push(Event::Present {
                    player: *id,
                    present: false,
                    at: s.at,
                });
            }
        }
    }

    fn welcome(&self, _: PlayerId) -> Empty {
        Empty
    }

    fn body(&self, player: PlayerId) -> Option<Body> {
        // Its join is applied: a new seat is in the state at its spawn.
        let at = self.seats.get(&player)?.at;
        Some(Body {
            at,
            vel: Pos::default(),
        })
    }

    fn presence(
        &self,
        player: PlayerId,
        present: bool,
        body: Option<&Body>,
        events: &mut Vec<Event>,
    ) {
        let at = body.map_or_else(|| spawn(player), |b| b.at);
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

    fn input(&self, _: PlayerId, body: &mut Body, keys: u8, _: &mut Vec<Event>) {
        let to = step(body.at, keys);
        body.vel = Pos {
            x: to.x - body.at.x,
            y: to.y - body.at.y,
        };
        body.at = to;
    }

    fn moved(&self, bodies: &Bodies<'_, Arena>, events: &mut Vec<Event>) {
        if let Some(who) = self.tag(bodies.time(), bodies) {
            events.push(Event::Tagged { by: self.it, who });
        }
    }

    fn player_state(&self, _: PlayerId, body: &Body) -> Option<Pos> {
        Some(body.at)
    }

    fn entities(&self, cx: &QueryCtx<'_, Arena>, _: &Empty, out: &mut Vec<(u64, Player)>) {
        cx.read(Change::Roster);
        for (id, s) in &self.seats {
            if !s.present {
                continue;
            }
            let b = cx.body(*id).copied().unwrap_or(Body {
                at: s.at,
                vel: Pos::default(),
            });
            out.push((
                *id,
                Player {
                    name: s.name.clone(),
                    x: b.at.x,
                    y: b.at.y,
                    vx: b.vel.x,
                    vy: b.vel.y,
                    it: *id == self.it,
                },
            ));
        }
    }

    fn reload(&self, _: Arc<()>) -> Result<Arena, String> {
        Ok(self.clone())
    }
}
