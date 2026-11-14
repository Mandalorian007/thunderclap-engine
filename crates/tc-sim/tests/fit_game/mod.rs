//! Field: a test game shaped like a busy real-time world, for the live
//! side of tc-sim (`tests/fit.rs`).
//!
//! Players walk a grid (unlogged bodies, moved by inputs). Drifters, live
//! things outside the log, step toward the nearest player every step while
//! anyone is present, and take any token they land on: the take is logged
//! as an outcome (`Took`), so a replay applies it instead of re-running the
//! drifters. Tokens are placed and taken by commands too.
//!
//! - `take` (a wall-clock cooldown of [`COOLDOWN`]): takes the token under
//!   the player's body; tells the player before the result.
//! - `recall`: a channel of [`CHANNEL`] on the wall clock; when it ends
//!   (a wake) the body goes home to (0, 0) and `Recalled` is logged.
//! - `place X Y`: logs a token at (X, Y).
//! - `bad`: from then on each live step changes hashed state directly (a
//!   game bug the loop's `verify_live` counts).
//!
//! Each player's entity stream follows its body ([`WATCH`] cells around
//! it): players, drifters and tokens in it.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tc_net::{Empty, Identity, Protocol};
use tc_sim::{Cx, EventOf, Game, LiveCx, PlayerId, Query, QueryCtx, Seat, To};
use tc_store::format::{Reader, Writer};
use tc_store::{LogCodec, NameTable, Names};
use tc_wire::Wire;
use tc_wire::hash::StableHasher;

/// How long `take` waits between two uses, on the wall clock.
pub const COOLDOWN: Duration = Duration::from_secs(1);
/// How long `recall` channels.
pub const CHANNEL: Duration = Duration::from_secs(2);
/// How far around its body a player's stream reaches.
pub const WATCH: i32 = 8;
/// The widest interest a client may ask for.
pub const MAX_WATCH: i32 = 16;

/// Change keys: who is present, each player (by id), the drifters, the
/// tokens.
pub const ROSTER: u64 = 0;
pub const DRIFT: u64 = 1 << 40;
pub const TOKENS: u64 = (1 << 40) + 1;

/// Entity ids: players by id, drifters and tokens offset.
pub const DRIFTER_IDS: u64 = 1 << 32;
pub const TOKEN_IDS: u64 = 1 << 33;

#[derive(Debug, Clone, PartialEq)]
pub struct FieldProto;

impl Protocol for FieldProto {
    type Hello = Empty;
    type Welcome = u64;
    type Command = String;
    type Result = String;
    type Interest = Area;
    type Input = Move;
    type State = Pos;
    type Client = String;
    type Server = String;
}

#[derive(Wire, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

impl Pos {
    fn dist(self, o: Pos) -> i32 {
        (self.x - o.x).abs().max((self.y - o.y).abs())
    }
}

/// A square around a point.
#[derive(Wire, Clone, Debug, Default, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub r: i32,
}

impl Area {
    fn holds(&self, p: Pos) -> bool {
        (p.x - self.x).abs() <= self.r && (p.y - self.y).abs() <= self.r
    }
}

/// One input: a step of at most one cell each way.
#[derive(Wire, Clone, Debug, Default, PartialEq)]
pub struct Move {
    pub dx: i32,
    pub dy: i32,
}

/// One thing in the entity stream.
#[derive(Wire, Clone, Debug, PartialEq)]
pub struct Thing {
    /// 0 a player, 1 a drifter, 2 a token.
    pub kind: u8,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Joined {
        name: String,
    },
    Present {
        player: u64,
        present: bool,
    },
    Placed {
        token: u32,
        at: Pos,
    },
    /// `by` took `token` (0: a drifter).
    Took {
        by: u64,
        token: u32,
    },
    Recalled {
        player: u64,
    },
    Parked {
        player: u64,
        at: Pos,
    },
}

#[derive(Clone)]
pub struct FieldLog;

impl LogCodec for FieldLog {
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
        let mut w = Writer::default();
        match ev {
            Event::Joined { name } => {
                w.u8(1);
                w.str(name);
            }
            Event::Present { player, present } => {
                w.u8(2);
                w.u64(*player);
                w.u8(u8::from(*present));
            }
            Event::Placed { token, at } => {
                w.u8(3);
                w.u32(*token);
                w.i32(at.x);
                w.i32(at.y);
            }
            Event::Took { by, token } => {
                w.u8(4);
                w.u64(*by);
                w.u32(*token);
            }
            Event::Recalled { player } => {
                w.u8(5);
                w.u64(*player);
            }
            Event::Parked { player, at } => {
                w.u8(6);
                w.u64(*player);
                w.i32(at.x);
                w.i32(at.y);
            }
        }
        out.extend_from_slice(&w.0);
        Ok(())
    }

    fn decode(&self, bytes: &[u8], _: &NameTable) -> Result<Event, String> {
        let mut r = Reader::new(bytes);
        let ev = match r.u8()? {
            1 => Event::Joined { name: r.str()? },
            2 => Event::Present {
                player: r.u64()?,
                present: r.u8()? != 0,
            },
            3 => Event::Placed {
                token: r.u32()?,
                at: Pos {
                    x: r.i32()?,
                    y: r.i32()?,
                },
            },
            4 => Event::Took {
                by: r.u64()?,
                token: r.u32()?,
            },
            5 => Event::Recalled { player: r.u64()? },
            6 => Event::Parked {
                player: r.u64()?,
                at: Pos {
                    x: r.i32()?,
                    y: r.i32()?,
                },
            },
            tag => return Err(format!("unknown event {tag}")),
        };
        r.finish()?;
        Ok(ev)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Player {
    pub name: String,
    pub present: bool,
    pub score: u64,
    pub recalls: u64,
    pub parked: Pos,
}

#[derive(Default)]
pub struct Field {
    // Logged state: in the hash.
    pub players: BTreeMap<u64, Player>,
    pub tokens: BTreeMap<u32, Pos>,
    pub next_token: u32,
    /// Tokens drifters took.
    pub drifted: u64,
    // Live state: out of the hash, rebuilt from nothing.
    pub drifters: Vec<Pos>,
    pub cooldowns: BTreeMap<u64, Instant>,
    pub channels: BTreeMap<u64, Instant>,
    pub bad: bool,
    pub live_steps: u64,
    /// The largest catch-up a live step saw ([`LiveCx::skipped`]).
    pub most_skipped: u64,
}

/// Where drifters start.
pub const DRIFTERS: [Pos; 3] = [
    Pos { x: 6, y: 0 },
    Pos { x: -6, y: 4 },
    Pos { x: 0, y: -40 },
];

impl Field {
    pub fn new() -> Field {
        Field::default()
    }

    fn token_at(&self, at: Pos) -> Option<u32> {
        self.tokens.iter().find(|(_, p)| **p == at).map(|(t, _)| *t)
    }

    fn present(&self) -> bool {
        self.players.values().any(|p| p.present)
    }
}

/// One cell toward `to`.
fn toward(from: Pos, to: Pos) -> Pos {
    Pos {
        x: from.x + (to.x - from.x).signum(),
        y: from.y + (to.y - from.y).signum(),
    }
}

impl Game for Field {
    type Protocol = FieldProto;
    type Codec = FieldLog;
    type Scheduled = Empty;
    type Change = u64;
    type Data = ();
    type Body = Pos;
    type View = Thing;

    fn queries() -> Vec<Query<Field>> {
        vec![
            Query::<Field>::new("tokens", "Tokens on the field.", false, |cx, _: Empty| {
                cx.read(TOKENS);
                Ok(cx.game().tokens.len() as u64)
            }),
            Query::<Field>::new("score", "The asker's score.", true, |cx, _: Empty| {
                let me = cx.player().ok_or("no player")?;
                cx.read(me);
                Ok(cx.game().players.get(&me).map_or(0, |p| p.score))
            }),
        ]
    }

    fn codec(&self) -> FieldLog {
        FieldLog
    }

    fn apply(&mut self, ev: &Event, cx: &mut Cx<'_, Field>) -> Result<(), String> {
        match ev {
            Event::Joined { name } => {
                let id = self.players.len() as u64 + 1;
                let player = Player {
                    name: name.clone(),
                    ..Player::default()
                };
                self.players.insert(id, player);
                cx.mark(ROSTER);
            }
            Event::Present { player, present } => {
                self.players.get_mut(player).ok_or("no player")?.present = *present;
                cx.mark(*player);
                cx.mark(ROSTER);
            }
            Event::Placed { token, at } => {
                self.tokens.insert(*token, *at);
                self.next_token = self.next_token.max(token + 1);
                cx.mark(TOKENS);
            }
            Event::Took { by, token } => {
                // Two takers in one step: the second finds it gone.
                if self.tokens.remove(token).is_none() {
                    return Ok(());
                }
                cx.mark(TOKENS);
                if *by == 0 {
                    self.drifted += 1;
                } else if let Some(p) = self.players.get_mut(by) {
                    p.score += 1;
                    cx.mark(*by);
                }
            }
            Event::Recalled { player } => {
                self.players.get_mut(player).ok_or("no player")?.recalls += 1;
                cx.mark(*player);
            }
            Event::Parked { player, at } => {
                self.players.get_mut(player).ok_or("no player")?.parked = *at;
            }
        }
        Ok(())
    }

    fn hash_state(&self, h: &mut StableHasher) {
        h.write_u64(self.players.len() as u64);
        for (id, p) in &self.players {
            h.write_u64(*id);
            h.write_str(&p.name);
            h.write_bool(p.present);
            h.write_u64(p.score);
            h.write_u64(p.recalls);
            h.write_i32(p.parked.x);
            h.write_i32(p.parked.y);
        }
        h.write_u64(self.tokens.len() as u64);
        for (t, p) in &self.tokens {
            h.write_u32(*t);
            h.write_i32(p.x);
            h.write_i32(p.y);
        }
        h.write_u32(self.next_token);
        h.write_u64(self.drifted);
    }

    fn join(&self, who: &Identity, _: &Empty, events: &mut Vec<Event>) -> Result<Seat, String> {
        if let Some((id, _)) = self.players.iter().find(|(_, p)| p.name == who.name) {
            return Ok(Seat::Player(*id));
        }
        events.push(Event::Joined {
            name: who.name.clone(),
        });
        Ok(Seat::Player(self.players.len() as u64 + 1))
    }

    fn welcome(&self, player: u64) -> u64 {
        self.players.get(&player).map_or(0, |p| p.score)
    }

    fn body(&self, player: u64) -> Option<Pos> {
        self.players.get(&player).map(|p| p.parked)
    }

    fn presence(&self, player: u64, present: bool, body: Option<&Pos>, events: &mut Vec<Event>) {
        if let (false, Some(&at)) = (present, body) {
            events.push(Event::Parked { player, at });
        }
        events.push(Event::Present { player, present });
    }

    fn act(&mut self, cx: &mut LiveCx<'_, Field>, player: u64, command: String) -> String {
        let now = cx.now();
        let mut words = command.split_whitespace();
        match words.next() {
            Some("take") => {
                if self
                    .cooldowns
                    .get(&player)
                    .is_some_and(|until| now < *until)
                {
                    return "error: wait".into();
                }
                self.cooldowns.insert(player, now + COOLDOWN);
                let Some(at) = cx.body(player).copied() else {
                    return "error: not here".into();
                };
                let Some(token) = self.token_at(at) else {
                    return "error: nothing here".into();
                };
                cx.push(Event::Took { by: player, token });
                cx.out()
                    .game(To::Player(player), format!("you took token {token}"));
                format!("took {token}")
            }
            Some("recall") => {
                let until = now + CHANNEL;
                self.channels.insert(player, until);
                cx.wake_at(until);
                "channeling".into()
            }
            Some("place") => {
                let mut n = || words.next().and_then(|w| w.parse::<i32>().ok());
                let (Some(x), Some(y)) = (n(), n()) else {
                    return "error: place where?".into();
                };
                let token = self.next_token;
                cx.push(Event::Placed {
                    token,
                    at: Pos { x, y },
                });
                format!("placed {token}")
            }
            Some("bad") => {
                self.bad = true;
                "ok".into()
            }
            _ => format!("error: {command:?}?"),
        }
    }

    fn command_error(&self, reason: String) -> String {
        format!("error: {reason}")
    }

    fn live(&self) -> bool {
        self.present()
    }

    fn live_step(&mut self, cx: &mut LiveCx<'_, Field>) {
        self.live_steps += 1;
        self.most_skipped = self.most_skipped.max(cx.skipped());
        if self.drifters.is_empty() {
            self.drifters.extend_from_slice(&DRIFTERS);
        }
        let mut moved = false;
        for d in &mut self.drifters {
            let nearest = cx
                .bodies()
                .map(|(_, b)| *b)
                .min_by_key(|b| (b.dist(*d), *b));
            let Some(to) = nearest else {
                continue;
            };
            if to.dist(*d) <= 1 {
                continue;
            }
            *d = toward(*d, to);
            moved = true;
            if let Some((token, _)) = self.tokens.iter().find(|(_, p)| **p == *d) {
                cx.push(Event::Took {
                    by: 0,
                    token: *token,
                });
            }
        }
        if moved {
            cx.mark(DRIFT);
        }
        if self.bad {
            self.drifted += 1;
        }
    }

    fn wake(&mut self, cx: &mut LiveCx<'_, Field>) {
        let now = cx.now();
        let due: Vec<u64> = self
            .channels
            .iter()
            .filter(|(_, at)| now >= **at)
            .map(|(p, _)| *p)
            .collect();
        for player in due {
            self.channels.remove(&player);
            if let Some(body) = cx.body_mut(player) {
                *body = Pos::default();
                cx.push(Event::Recalled { player });
                cx.out().game(To::Player(player), "recalled".into());
            }
        }
        if let Some(next) = self.channels.values().min() {
            cx.wake_at(*next);
        }
    }

    fn follow(&self, _: u64, body: &Pos) -> Option<Area> {
        Some(Area {
            x: body.x,
            y: body.y,
            r: WATCH,
        })
    }

    fn interest(&self, _: Option<PlayerId>, area: &Area) -> Result<(), String> {
        if !(0..=MAX_WATCH).contains(&area.r) {
            return Err("too wide".into());
        }
        Ok(())
    }

    fn entities(&self, cx: &QueryCtx<'_, Field>, area: &Area, out: &mut Vec<(u64, Thing)>) {
        cx.read(ROSTER);
        for id in self.players.keys() {
            let Some(at) = cx.body(*id).copied() else {
                continue;
            };
            if area.holds(at) {
                out.push((*id, thing(0, at)));
            }
        }
        cx.read(DRIFT);
        for (i, d) in self.drifters.iter().enumerate() {
            if area.holds(*d) {
                out.push((DRIFTER_IDS + i as u64, thing(1, *d)));
            }
        }
        cx.read(TOKENS);
        for (t, at) in &self.tokens {
            if area.holds(*at) {
                out.push((TOKEN_IDS + u64::from(*t), thing(2, *at)));
            }
        }
    }

    fn input(&self, _: u64, body: &mut Pos, m: Move, _: &mut Vec<Event>) {
        body.x += m.dx.clamp(-1, 1);
        body.y += m.dy.clamp(-1, 1);
    }

    fn player_state(&self, _: u64, body: &Pos) -> Option<Pos> {
        Some(*body)
    }

    fn reload(&self, _: Arc<()>) -> Result<Field, String> {
        Ok(Field::new())
    }
}

fn thing(kind: u8, at: Pos) -> Thing {
    Thing {
        kind,
        x: at.x,
        y: at.y,
    }
}

/// `Field`'s events, for asserting on.
pub type FieldEvent = EventOf<Field>;
