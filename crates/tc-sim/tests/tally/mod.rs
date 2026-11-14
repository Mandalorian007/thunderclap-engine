//! Tally: a tiny game on tc-sim for its tests. Players join by name and
//! add to their tally with commands; `later N` schedules an add N steps
//! on; inputs move a player's body along a line, unlogged (where it stood
//! is logged when it leaves). A stepping tally also counts its steps. Its
//! data is a multiplier on every add, so a reload changes what the same
//! log adds up to. A name starting `watch` joins as an observer.
//!
//! Commands (the result is the player's tally after, or an error):
//! `add N`, `later N`, `unlucky` (an event the log refuses to write).
//! Game messages: `wave` (in the `wave` lane, 2 at once then one a
//! second), anything else (no lane); each is echoed to everyone.
//!
//! Queries: `tally {name}` (shared), `board {}` (every player's names and total), `mine {}` (per player), `where {player}`
//! (a body), `steps {}` (volatile: nothing marks steps), `tick {every}`
//! (the time rounded down to `every`, valid until the next). The entity
//! stream shows each present player in the watched span as a [`Dot`].

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tc_net::{Empty, Identity, Protocol};
use tc_sim::{
    Bodies, Changes, Cx, EventOf, Game, Lane, Outbox, PlayerId, Query, QueryCtx, Seat, To,
};
use tc_store::format::{Reader, Writer};
use tc_store::{LogCodec, NameTable, Names};
use tc_wire::Wire;
use tc_wire::hash::StableHasher;
use tc_wire::schema::Schema;

/// Tally's roles.
#[derive(Debug, Clone, PartialEq)]
pub struct TallyProto;

impl Protocol for TallyProto {
    type Hello = Empty;
    type Welcome = u64;
    type Command = String;
    type Result = String;
    type Interest = Span;
    type Input = i32;
    type State = i32;
    type Client = String;
    type Server = String;
}

/// The change key every join and presence marks: who is there.
pub const ROSTER: PlayerId = 0;

/// A span of the line to watch.
#[derive(Wire, Clone, Debug, Default, PartialEq)]
pub struct Span {
    pub from: i32,
    pub to: i32,
}

/// One player in the entity stream.
#[derive(Wire, Clone, Debug, PartialEq)]
pub struct Dot {
    pub x: i32,
    pub tally: u64,
}

/// Every player at once.
#[derive(Wire, Clone, Debug, PartialEq)]
pub struct Board {
    pub names: Vec<String>,
    pub total: u64,
}

#[derive(Wire, Clone, Debug, PartialEq)]
pub struct ByName {
    pub name: String,
}

#[derive(Wire, Clone, Debug, PartialEq)]
pub struct ByPlayer {
    pub player: u64,
}

#[derive(Wire, Clone, Debug, PartialEq)]
pub struct Every {
    pub every: u64,
}

/// Tally's schema.
pub fn schema() -> Schema {
    Tally::schema()
}

/// What the log records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Joined {
        name: String,
    },
    Present {
        player: u64,
        present: bool,
    },
    Add {
        player: u64,
        n: u32,
    },
    Later {
        player: u64,
        n: u32,
        steps: u32,
    },
    /// Where a player stood when it left.
    Parked {
        player: u64,
        at: i32,
    },
    /// The codec refuses to write this one.
    Unlucky,
}

#[derive(Clone)]
pub struct TallyLog;

impl LogCodec for TallyLog {
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

    fn encode(&self, ev: &Event, names: &mut Names<'_>, out: &mut Vec<u8>) -> Result<(), String> {
        let mut w = Writer::default();
        match ev {
            Event::Joined { name } => {
                w.u8(1);
                w.u32(names.id(name));
            }
            Event::Present { player, present } => {
                w.u8(2);
                w.u32(*player as u32);
                w.u8(u8::from(*present));
            }
            Event::Add { player, n } => {
                w.u8(3);
                w.u32(*player as u32);
                w.u32(*n);
            }
            Event::Later { player, n, steps } => {
                w.u8(4);
                w.u32(*player as u32);
                w.u32(*n);
                w.u32(*steps);
            }
            Event::Parked { player, at } => {
                w.u8(5);
                w.u32(*player as u32);
                w.u32(*at as u32);
            }
            Event::Unlucky => return Err("unlucky".into()),
        }
        out.extend_from_slice(&w.0);
        Ok(())
    }

    fn decode(&self, bytes: &[u8], names: &NameTable) -> Result<Event, String> {
        let mut r = Reader::new(bytes);
        let ev = match r.u8()? {
            1 => {
                let id = r.u32()?;
                Event::Joined {
                    name: names.get(id).ok_or("an unnamed player")?.to_string(),
                }
            }
            2 => Event::Present {
                player: r.u32()?.into(),
                present: r.u8()? != 0,
            },
            3 => Event::Add {
                player: r.u32()?.into(),
                n: r.u32()?,
            },
            4 => Event::Later {
                player: r.u32()?.into(),
                n: r.u32()?,
                steps: r.u32()?,
            },
            5 => Event::Parked {
                player: r.u32()?.into(),
                at: r.u32()? as i32,
            },
            tag => return Err(format!("unknown event {tag}")),
        };
        r.finish()?;
        Ok(ev)
    }
}

/// A scheduled add.
#[derive(Wire, Clone, Debug, PartialEq)]
pub struct Bump {
    pub player: u64,
    pub n: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Player {
    pub name: String,
    pub tally: u64,
    pub at: i32,
    pub present: bool,
}

/// How far a body goes to score ([`Game::moved`]).
pub const FAR: i32 = 1000;

pub struct Tally {
    pub stepping: bool,
    pub multiplier: u64,
    pub players: BTreeMap<u64, Player>,
    pub steps: u64,
    /// While set, a game built by a reload waits before applying an entry
    /// (a test holds a replay back).
    pub hold: Arc<AtomicBool>,
    held: bool,
}

impl Tally {
    pub fn new(stepping: bool) -> Tally {
        Tally {
            stepping,
            multiplier: 1,
            players: BTreeMap::new(),
            steps: 0,
            hold: Arc::new(AtomicBool::new(false)),
            held: false,
        }
    }

    fn add(&mut self, player: u64, n: u32, cx: &mut Cx<'_, Tally>) -> Result<(), String> {
        let mult = self.multiplier;
        let p = self.players.get_mut(&player).ok_or("no such player")?;
        p.tally += u64::from(n) * mult;
        cx.mark(player);
        Ok(())
    }

    pub fn tally_of(&self, name: &str) -> Option<u64> {
        self.players
            .values()
            .find(|p| p.name == name)
            .map(|p| p.tally)
    }
}

impl Game for Tally {
    type Protocol = TallyProto;
    type Codec = TallyLog;
    type Scheduled = Bump;
    type Change = PlayerId;
    type Data = u64;
    type Body = i32;
    type View = Dot;

    fn queries() -> Vec<Query<Tally>> {
        vec![
            Query::<Tally>::new(
                "tally",
                "A player's tally, by name.",
                false,
                |cx, a: ByName| {
                    cx.read(ROSTER);
                    let (id, p) = cx
                        .game()
                        .players
                        .iter()
                        .find(|(_, p)| p.name == a.name)
                        .ok_or_else(|| format!("no player {:?}", a.name))?;
                    cx.read(*id);
                    Ok(p.tally)
                },
            ),
            Query::<Tally>::new(
                "board",
                "Every player, and their total.",
                false,
                |cx, _: Empty| {
                    cx.read(ROSTER);
                    let players = &cx.game().players;
                    players.keys().for_each(|id| cx.read(*id));
                    Ok(Board {
                        names: players.values().map(|p| p.name.clone()).collect(),
                        total: players.values().map(|p| p.tally).sum(),
                    })
                },
            ),
            Query::<Tally>::new("mine", "The asker's tally.", true, |cx, _: Empty| {
                let me = cx.player().ok_or("no player")?;
                cx.read(me);
                Ok(cx.game().players.get(&me).map_or(0, |p| p.tally))
            }),
            Query::<Tally>::new(
                "where",
                "Where a player stands.",
                false,
                |cx, a: ByPlayer| {
                    cx.body(a.player)
                        .copied()
                        .ok_or_else(|| "not here".to_string())
                },
            ),
            Query::<Tally>::new("steps", "Steps taken.", false, |cx, _: Empty| {
                cx.volatile();
                Ok(cx.game().steps)
            }),
            Query::<Tally>::new("tick", "The time, rounded down.", false, |cx, a: Every| {
                if a.every == 0 {
                    return Err("every 0".into());
                }
                let t = cx.time() / a.every * a.every;
                cx.valid_until(t + a.every);
                Ok(t)
            }),
        ]
    }

    fn lanes() -> Vec<Lane> {
        vec![Lane {
            name: "wave",
            burst: 2,
            every: Duration::from_secs(1),
        }]
    }

    fn lane(&self, msg: &String) -> Option<usize> {
        (msg == "wave").then_some(0)
    }

    fn message(&self, player: u64, msg: String, _: &mut Vec<Event>, out: &mut Outbox<TallyProto>) {
        let name = self.players.get(&player).map_or("?", |p| p.name.as_str());
        out.game(To::All, format!("{name}: {msg}"));
    }

    fn body(&self, player: u64) -> Option<i32> {
        self.players.get(&player).map(|p| p.at)
    }

    fn interest(&self, _: Option<PlayerId>, span: &Span) -> Result<(), String> {
        if span.to < span.from || span.to - span.from > 100 {
            return Err("too wide".into());
        }
        Ok(())
    }

    fn entities(&self, cx: &QueryCtx<'_, Tally>, span: &Span, out: &mut Vec<(u64, Dot)>) {
        cx.read(ROSTER);
        for (id, p) in &self.players {
            let Some(x) = cx.body(*id).copied() else {
                continue;
            };
            if x < span.from || x > span.to {
                continue;
            }
            cx.read(*id);
            out.push((*id, Dot { x, tally: p.tally }));
        }
    }

    fn codec(&self) -> TallyLog {
        TallyLog
    }

    fn apply(&mut self, ev: &Event, cx: &mut Cx<'_, Tally>) -> Result<(), String> {
        while self.held && self.hold.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        match ev {
            Event::Joined { name } => {
                let id = self.players.len() as u64 + 1;
                self.players.insert(
                    id,
                    Player {
                        name: name.clone(),
                        ..Player::default()
                    },
                );
                cx.mark(id);
                cx.mark(ROSTER);
            }
            Event::Present { player, present } => {
                self.players
                    .get_mut(player)
                    .ok_or("no such player")?
                    .present = *present;
                cx.mark(*player);
                cx.mark(ROSTER);
            }
            Event::Add { player, n } => self.add(*player, *n, cx)?,
            Event::Later { player, n, steps } => {
                let at = cx.time() + u64::from(*steps);
                cx.schedule(
                    at,
                    Bump {
                        player: *player,
                        n: *n,
                    },
                );
            }
            Event::Parked { player, at } => {
                self.players.get_mut(player).ok_or("no such player")?.at = *at;
            }
            Event::Unlucky => return Err("unlucky".into()),
        }
        Ok(())
    }

    fn fire(&mut self, bump: Bump, cx: &mut Cx<'_, Tally>) {
        let _ = self.add(bump.player, bump.n, cx);
    }

    fn steps(&self) -> bool {
        self.stepping
    }

    fn step(&mut self, _: &mut Cx<'_, Tally>) {
        self.steps += 1;
    }

    fn hash_state(&self, h: &mut StableHasher) {
        h.write_u64(self.multiplier);
        h.write_u64(self.steps);
        h.write_u64(self.players.len() as u64);
        for (id, p) in &self.players {
            h.write_u64(*id);
            h.write_str(&p.name);
            h.write_u64(p.tally);
            h.write_i32(p.at);
            h.write_bool(p.present);
        }
    }

    fn join(
        &self,
        who: &Identity,
        _: &Empty,
        events: &mut Vec<EventOf<Tally>>,
    ) -> Result<Seat, String> {
        if who.name.is_empty() {
            return Err("no name".into());
        }
        if who.name.starts_with("watch") {
            return Ok(Seat::Observer);
        }
        if let Some((id, _)) = self.players.iter().find(|(_, p)| p.name == who.name) {
            return Ok(Seat::Player(*id));
        }
        events.push(Event::Joined {
            name: who.name.clone(),
        });
        Ok(Seat::Player(self.players.len() as u64 + 1))
    }

    fn welcome(&self, player: u64) -> u64 {
        self.players.get(&player).map_or(0, |p| p.tally)
    }

    fn presence(&self, player: u64, present: bool, body: Option<&i32>, events: &mut Vec<Event>) {
        if let (false, Some(&at)) = (present, body) {
            events.push(Event::Parked { player, at });
        }
        events.push(Event::Present { player, present });
    }

    fn command(&self, player: u64, command: String, events: &mut Vec<Event>) -> String {
        let mut words = command.split_whitespace();
        let n = |w: Option<&str>| w.and_then(|n| n.parse::<u32>().ok());
        match words.next() {
            Some("add") => match n(words.next()) {
                Some(n) => events.push(Event::Add { player, n }),
                None => return "error: add what?".into(),
            },
            Some("later") => match n(words.next()) {
                Some(n) => events.push(Event::Later {
                    player,
                    n,
                    steps: 5,
                }),
                None => return "error: later what?".into(),
            },
            Some("unlucky") => events.push(Event::Unlucky),
            _ => return format!("error: {command:?}?"),
        }
        // The result says what the tally will be once the events apply.
        let now = self.players.get(&player).map_or(0, |p| p.tally);
        match events.last() {
            Some(Event::Add { n, .. }) => (now + u64::from(*n) * self.multiplier).to_string(),
            _ => now.to_string(),
        }
    }

    fn command_error(&self, reason: String) -> String {
        format!("error: {reason}")
    }

    fn input(&self, _: u64, body: &mut i32, by: i32, _: &mut Vec<Event>) {
        *body += by;
    }

    /// A rule on bodies: a body that went past [`FAR`] scores a point.
    fn moved(&self, bodies: &Bodies<'_, Tally>, events: &mut Vec<Event>) {
        for &player in bodies.moved() {
            if bodies.get(player).is_some_and(|&at| at >= FAR) {
                events.push(Event::Add { player, n: 1 });
            }
        }
    }

    /// After a crash, nobody is here.
    fn on_open(&self, _: u64, events: &mut Vec<Event>) {
        for (id, p) in &self.players {
            if p.present {
                events.push(Event::Present {
                    player: *id,
                    present: false,
                });
            }
        }
    }

    fn player_state(&self, _: u64, body: &i32) -> Option<i32> {
        Some(*body)
    }

    fn flush(&self, changes: &Changes<PlayerId>, out: &mut Outbox<TallyProto>) {
        for id in changes.keys() {
            if let Some(p) = self.players.get(id) {
                out.game(To::All, format!("{} {}", p.name, p.tally));
            }
        }
    }

    fn reload(&self, data: Arc<u64>) -> Result<Tally, String> {
        if *data == 0 {
            return Err("a zero multiplier".into());
        }
        let mut t = Tally::new(self.stepping);
        t.multiplier = *data;
        t.hold = self.hold.clone();
        t.held = true;
        Ok(t)
    }

    fn reloaded(&self, _: &[PlayerId], out: &mut Outbox<TallyProto>) {
        out.game(To::All, format!("reloaded x{}", self.multiplier));
    }
}
