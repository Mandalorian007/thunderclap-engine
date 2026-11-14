//! Tally: a tiny game on tc-sim for its tests. Players join by name and
//! add to their tally with commands; `later N` schedules an add N steps
//! on; inputs move a player along a line. A stepping tally also counts
//! its steps. Its data is a multiplier on every add, so a reload changes
//! what the same log adds up to.
//!
//! Commands (the result is the player's tally after, or an error):
//! `add N`, `later N`, `unlucky` (an event the log refuses to write).

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;

use tc_net::{Empty, Identity, Protocol, schema_builder};
use tc_sim::{Changes, Cx, EventOf, Game, Outbox, PlayerId, To};
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
    type Interest = Empty;
    type Input = i32;
    type State = i32;
    type Client = Empty;
    type Server = String;
}

/// Tally's schema.
pub fn schema() -> Schema {
    let b = schema_builder::<TallyProto>();
    b.finish().expect("the tally schema is valid")
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
    Moved {
        player: u64,
        by: i32,
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
            Event::Moved { player, by } => {
                w.u8(5);
                w.u32(*player as u32);
                w.u32(*by as u32);
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
            5 => Event::Moved {
                player: r.u32()?.into(),
                by: r.u32()? as i32,
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

pub struct Tally {
    pub stepping: bool,
    pub multiplier: u64,
    pub players: BTreeMap<u64, Player>,
    pub steps: u64,
}

impl Tally {
    pub fn new(stepping: bool) -> Tally {
        Tally {
            stepping,
            multiplier: 1,
            players: BTreeMap::new(),
            steps: 0,
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

    fn codec(&self) -> TallyLog {
        TallyLog
    }

    fn apply(&mut self, ev: &Event, cx: &mut Cx<'_, Tally>) -> Result<(), String> {
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
            }
            Event::Present { player, present } => {
                self.players
                    .get_mut(player)
                    .ok_or("no such player")?
                    .present = *present;
                cx.mark(*player);
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
            Event::Moved { player, by } => {
                self.players.get_mut(player).ok_or("no such player")?.at += by;
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
    ) -> Result<u64, String> {
        if who.name.is_empty() {
            return Err("no name".into());
        }
        if let Some((id, _)) = self.players.iter().find(|(_, p)| p.name == who.name) {
            return Ok(*id);
        }
        events.push(Event::Joined {
            name: who.name.clone(),
        });
        Ok(self.players.len() as u64 + 1)
    }

    fn welcome(&self, player: u64) -> u64 {
        self.players.get(&player).map_or(0, |p| p.tally)
    }

    fn presence(&self, player: u64, present: bool, events: &mut Vec<Event>) {
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

    fn input(&self, player: u64, by: i32, events: &mut Vec<Event>) {
        events.push(Event::Moved { player, by });
    }

    fn player_state(&self, player: u64) -> Option<i32> {
        self.players.get(&player).map(|p| p.at)
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
        Ok(t)
    }

    fn reloaded(&self, _: &[PlayerId], out: &mut Outbox<TallyProto>) {
        out.game(To::All, format!("reloaded x{}", self.multiplier));
    }
}
