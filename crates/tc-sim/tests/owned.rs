//! A game that keeps its own record ([`Record`]: its time, schedule, log
//! and hash), idle work streaming bulk frames, inputs a knockout stops,
//! and wall-clock timers: what a game with its own world (Forge Wilds)
//! runs its loop on.

mod tally;

use std::collections::BTreeMap;
use std::ops::ControlFlow;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tally::{Bump, Dot, Event, TallyLog, TallyProto};
use tc_net::{ClientMsg, ConnId, Empty, Identity, ServerMsg};
use tc_sim::{
    Changes, Core, Cx, Driver, Game, IdleCx, LiveCx, PlayerId, Record, RecordError, Scheduler,
    Seat, Sim, SimConfig, Stop,
};
use tc_wire::Wire;
use tc_wire::hash::StableHasher;

/// The world: everything that is state, with its own clock, schedule and
/// log (in memory), and a switch that makes its store fail.
#[derive(Default)]
struct World {
    time: u64,
    version: u64,
    scheduler: Scheduler<Bump>,
    tallies: BTreeMap<u64, (String, u64)>,
    log: Vec<(u64, Event)>,
    marks: Vec<(u64, bool)>,
    fail: Arc<AtomicBool>,
    /// A failure noticed off the loop's writes (an I/O thread's).
    noticed: Option<String>,
}

impl World {
    fn apply(&mut self, event: &Event, changes: &mut Changes<PlayerId>) {
        match event {
            Event::Joined { name } => {
                let id = self.tallies.len() as u64 + 1;
                self.tallies.insert(id, (name.clone(), 0));
                changes.mark(id);
            }
            Event::Add { player, n } => {
                if let Some((_, t)) = self.tallies.get_mut(player) {
                    *t += u64::from(*n);
                    changes.mark(*player);
                }
            }
            Event::Later { player, n, steps } => {
                self.scheduler.schedule(
                    self.time + u64::from(*steps),
                    Bump {
                        player: *player,
                        n: *n,
                    },
                );
            }
            Event::Present { .. } | Event::Parked { .. } | Event::Unlucky => {}
        }
    }

    /// A new world with `log` replayed into it.
    fn replayed(log: &[(u64, Event)]) -> World {
        let mut world = World::default();
        let mut changes = Changes::new();
        for (time, event) in log {
            world.advance(*time, &mut changes, &mut || true);
            world.version += 1;
            world.apply(event, &mut changes);
        }
        world
    }

    fn tally(&self, name: &str) -> u64 {
        self.tallies
            .values()
            .find(|(n, _)| n == name)
            .map_or(0, |(_, t)| *t)
    }
}

impl Record<Ledger> for World {
    fn time(&self) -> u64 {
        self.time
    }

    fn version(&self) -> u64 {
        self.version
    }

    fn next_event(&self) -> Option<u64> {
        self.scheduler.next_time()
    }

    fn advance(
        &mut self,
        target: u64,
        changes: &mut Changes<PlayerId>,
        go_on: &mut dyn FnMut() -> bool,
    ) -> u64 {
        let mut fired = 0;
        while self.scheduler.next_time().is_some_and(|t| t <= target) && go_on() {
            let (key, bump) = self.scheduler.pop_due(target).expect("due");
            self.time = self.time.max(key.time);
            self.apply(
                &Event::Add {
                    player: bump.player,
                    n: bump.n,
                },
                changes,
            );
            fired += 1;
        }
        if self.scheduler.next_time().is_none_or(|t| t > target) {
            self.time = self.time.max(target);
        }
        fired
    }

    fn commit(
        &mut self,
        time: u64,
        events: Vec<Event>,
        changes: &mut Changes<PlayerId>,
    ) -> Result<(), RecordError> {
        if events.contains(&Event::Unlucky) {
            return Err(RecordError::Refused("unlucky".into()));
        }
        if self.fail.load(Ordering::Relaxed) {
            return Err(RecordError::Store("the disk is full".into()));
        }
        for event in events {
            self.version += 1;
            self.apply(&event, changes);
            self.log.push((time, event));
        }
        Ok(())
    }

    fn state_hash(&self) -> u64 {
        let mut h = StableHasher::new();
        h.write_u64(self.time);
        h.write_u64(self.version);
        for (key, bump) in self.scheduler.iter() {
            h.write_u64(key.time);
            h.write_u64(key.seq);
            h.write_bytes(&bump.to_bytes());
        }
        for (id, (name, tally)) in &self.tallies {
            h.write_u64(*id);
            h.write_str(name);
            h.write_u64(*tally);
        }
        h.finish()
    }

    fn mark(&mut self, time: u64, wait: bool) -> Result<(), String> {
        if self.fail.load(Ordering::Relaxed) {
            return Err("the disk is full".into());
        }
        self.marks.push((time, wait));
        Ok(())
    }

    fn take_error(&mut self) -> Option<String> {
        self.noticed.take()
    }
}

/// The game: the world, and live fields (unhashed).
#[derive(Default)]
struct Ledger {
    world: World,
    /// Bulk frames left to stream in idle time.
    to_stream: u32,
    streamed: u32,
    /// The most bulk bytes a connection may have queued.
    high_water: usize,
    /// Each idle pass, and whether it was interrupted.
    idles: Vec<bool>,
    /// Timers run, by kind, in order.
    timers: Vec<u32>,
    /// Lingers bulk frames for every connection.
    lingers: bool,
}

/// A bulk frame: a `Game` message the test can read.
fn chunk(n: u32) -> Vec<u8> {
    ServerMsg::<TallyProto>::Game(format!("chunk {n:04}")).to_bytes()
}

impl Game for Ledger {
    type Protocol = TallyProto;
    type Codec = TallyLog;
    type Scheduled = Bump;
    type Change = PlayerId;
    type Data = u64;
    type Body = i32;
    type View = Dot;

    fn codec(&self) -> TallyLog {
        TallyLog
    }

    fn apply(&mut self, _: &Event, _: &mut Cx<'_, Ledger>) -> Result<(), String> {
        unreachable!("the world applies its own events")
    }

    fn hash_state(&self, h: &mut StableHasher) {
        h.write_u64(self.world.state_hash());
    }

    fn record(&self) -> Option<&dyn Record<Ledger>> {
        Some(&self.world)
    }

    fn record_mut(&mut self) -> Option<&mut dyn Record<Ledger>> {
        Some(&mut self.world)
    }

    fn join(&self, who: &Identity, _: &Empty, events: &mut Vec<Event>) -> Result<Seat, String> {
        if let Some((id, _)) = self.world.tallies.iter().find(|(_, t)| t.0 == who.name) {
            return Ok(Seat::Player(*id));
        }
        events.push(Event::Joined {
            name: who.name.clone(),
        });
        Ok(Seat::Player(self.world.tallies.len() as u64 + 1))
    }

    fn welcome(&self, _: PlayerId) -> u64 {
        0
    }

    fn body(&self, _: PlayerId) -> Option<i32> {
        Some(0)
    }

    fn command_error(&self, reason: String) -> String {
        format!("error: {reason}")
    }

    /// `add N`, `later N` (5 steps on), `unlucky`, `timer KIND MS`,
    /// `stream N` (bulk frames in idle time), `high BYTES` (the bulk
    /// lane's high water).
    fn act(&mut self, cx: &mut LiveCx<'_, Ledger>, player: PlayerId, command: String) -> String {
        let words: Vec<&str> = command.split_whitespace().collect();
        let n = |i: usize| {
            words
                .get(i)
                .and_then(|w| w.parse::<u32>().ok())
                .unwrap_or(0)
        };
        match words.first().copied() {
            Some("add") => cx.push(Event::Add { player, n: n(1) }),
            Some("later") => cx.push(Event::Later {
                player,
                n: n(1),
                steps: 5,
            }),
            Some("unlucky") => cx.push(Event::Unlucky),
            Some("timer") => {
                let at = cx.now() + Duration::from_millis(u64::from(n(2)));
                cx.set_timer(n(1), at);
            }
            Some("stream") => self.to_stream += n(1),
            Some("high") => self.high_water = n(1) as usize,
            Some("linger") => self.lingers = n(1) == 1,
            _ => return format!("error: {command:?}?"),
        }
        "ok".into()
    }

    /// An input of 0 is a knockout: it scores 100 and the rest of the
    /// player's inputs no longer apply.
    fn input_flow(
        &self,
        player: PlayerId,
        body: &mut i32,
        by: i32,
        events: &mut Vec<Event>,
    ) -> ControlFlow<Stop> {
        if by == 0 {
            events.push(Event::Add { player, n: 100 });
            return ControlFlow::Break(Stop::AckAll);
        }
        *body += by;
        ControlFlow::Continue(())
    }

    fn player_state(&self, _: PlayerId, body: &i32) -> Option<i32> {
        Some(*body)
    }

    fn timer(&mut self, cx: &mut LiveCx<'_, Ledger>, kind: u32) {
        self.timers.push(kind);
        // Kind 3 is periodic, and logs a point each time.
        if kind == 3 {
            cx.push(Event::Add { player: 1, n: 1 });
            cx.set_timer(3, cx.now() + Duration::from_millis(30));
        }
    }

    fn idle_work(&self) -> bool {
        self.to_stream > 0
    }

    fn idle(&mut self, cx: &mut IdleCx<'_, Ledger>) {
        let mut interrupted = false;
        while self.to_stream > 0 && Instant::now() < cx.until() {
            if cx.interrupted() {
                interrupted = true;
                break;
            }
            let conns: Vec<ConnId> = cx.conns().iter().map(|(id, _)| id).collect();
            let room = |conn| {
                let high = cx.conns().bulk_high_water(conn).unwrap_or(self.high_water);
                cx.conns().bulk_queued(conn) < high
            };
            if conns.is_empty() || !conns.iter().all(|c| room(*c)) {
                break;
            }
            for conn in conns {
                assert!(cx.conns().send_bulk(conn, chunk(self.streamed), None));
            }
            self.streamed += 1;
            self.to_stream -= 1;
        }
        self.idles.push(interrupted);
    }

    fn bulk_lingers(&self, _: ConnId) -> bool {
        self.lingers
    }

    fn reload(&self, _: Arc<u64>) -> Result<Ledger, String> {
        Err("the ledger reloads itself".into())
    }
}

fn paused() -> SimConfig {
    SimConfig {
        paused: true,
        ..SimConfig::default()
    }
}

fn command(d: &mut Driver<Ledger>, conn: ConnId, seq: u32, text: &str) {
    d.client(
        conn,
        ClientMsg::Command {
            seq,
            command: text.into(),
        },
    );
}

fn results(msgs: &[ServerMsg<TallyProto>]) -> Vec<String> {
    msgs.iter()
        .filter_map(|m| match m {
            ServerMsg::CommandResult { result, .. } => Some(result.clone()),
            _ => None,
        })
        .collect()
}

fn ledger(config: SimConfig) -> Driver<Ledger> {
    Driver::new(Sim::new(Core::new(Ledger::default()), None, config))
}

/// The same commands and waits: the hash the run reaches.
fn play() -> (u64, Driver<Ledger>) {
    let mut d = ledger(SimConfig::default());
    let (ada, mut rx) = d.connect("ada", Empty);
    let (bo, _) = d.connect("bo", Empty);
    command(&mut d, ada, 1, "add 2");
    command(&mut d, bo, 1, "later 3");
    d.wait(Duration::from_millis(120));
    command(&mut d, ada, 2, "later 4");
    command(&mut d, ada, 3, "unlucky");
    d.wait(Duration::from_millis(400));
    command(&mut d, bo, 2, "add 1");
    let msgs = Driver::<Ledger>::received(&mut rx);
    assert_eq!(results(&msgs), ["ok", "ok", "error: refused: unlucky"]);
    (d.core().state_hash(), d)
}

#[test]
fn the_core_delegates_to_the_games_record_and_a_replay_hashes_alike() {
    let (hash, d) = play();
    let world = &d.core().game().world;
    assert_eq!((world.tally("ada"), world.tally("bo")), (6, 4));
    // The time, version, schedule and hash are the world's.
    assert!(d.core().owns_record());
    assert_eq!(d.core().time(), world.time);
    assert!(world.time >= 10, "the clock ran: {}", world.time);
    assert_eq!(d.core().version(), world.version);
    assert_eq!(world.version, world.log.len() as u64);
    assert!(
        d.core().scheduler().is_empty(),
        "the core keeps no schedule"
    );
    assert_eq!(hash, world.state_hash());
    assert_eq!(d.sim().status().get().refused, 1);
    assert!(d.core().to_base().is_none());

    // Same inputs, same hash; and the log replayed reaches it too.
    let (again, _) = play();
    assert_eq!(hash, again, "deterministic");
    let mut replayed = World::replayed(&world.log);
    replayed.advance(world.time, &mut Changes::new(), &mut || true);
    assert_eq!(replayed.state_hash(), hash, "a replay of the log");

    // A replay through the core, a reload, a base: the game's own.
    let mut core = Core::new(Ledger::default());
    let entry = tc_store::LogEntry {
        seq: 1,
        time: 0,
        event: Event::Unlucky,
    };
    assert!(core.apply(&entry).is_err());

    // Stopping marks the clock durably in the world.
    let core = d.stop();
    assert_eq!(core.game().world.marks.last(), Some(&(core.time(), true)));
}

#[test]
fn a_store_failure_in_the_record_pauses_the_clock_and_says_so() {
    let mut d = ledger(SimConfig::default());
    let (ada, mut rx) = d.connect("ada", Empty);
    command(&mut d, ada, 1, "add 2");
    Driver::<Ledger>::received(&mut rx);
    let fail = d.core().game().world.fail.clone();
    fail.store(true, Ordering::Relaxed);
    command(&mut d, ada, 2, "add 5");
    let msgs = Driver::<Ledger>::received(&mut rx);
    assert_eq!(
        results(&msgs),
        ["error: the server can't save: the disk is full"]
    );
    assert!(msgs.contains(&ServerMsg::Clock {
        time: d.core().time(),
        paused: true
    }));
    assert!(d.sim().clock().paused());
    assert_eq!(d.sim().store_error(), Some("the disk is full"));
    let status = d.sim().status().get();
    assert_eq!(status.store_error.as_deref(), Some("the disk is full"));
    assert_eq!(
        d.core().game().world.tally("ada"),
        2,
        "nothing more changed"
    );
    assert!(!d.sim_mut().resume(), "no resuming a failed store");
    let time = d.core().time();
    d.wait(Duration::from_secs(1));
    assert_eq!(d.core().time(), time, "the clock stays paused");
}

#[test]
fn a_failure_the_record_notices_later_pauses_at_the_next_tick() {
    let mut d = ledger(SimConfig::default());
    let (_, mut rx) = d.connect("ada", Empty);
    Driver::<Ledger>::received(&mut rx);
    // The game's store failed outside the loop's writes.
    assert!(d.sim().store_error().is_none());
    d.sim_mut().fail_store("a write failed on its thread");
    assert!(d.sim().clock().paused());
    assert!(
        Driver::<Ledger>::received(&mut rx)
            .iter()
            .any(|m| matches!(m, ServerMsg::Clock { paused: true, .. }))
    );
    // The first reason stays.
    d.sim_mut().fail_store("another");
    assert_eq!(d.sim().store_error(), Some("a write failed on its thread"));

    // Through the record: polled each tick.
    let mut game = Ledger::default();
    game.world.noticed = Some("a mark failed".into());
    let mut d2 = Driver::new(Sim::new(Core::new(game), None, SimConfig::default()));
    d2.wait(Duration::from_millis(60));
    assert_eq!(d2.sim().store_error(), Some("a mark failed"));
    assert!(d2.sim().clock().paused());
}

#[test]
fn a_knockout_stops_the_tick_and_acknowledges_the_rest() {
    let mut d = ledger(paused());
    let (ada, mut rx) = d.connect("ada", Empty);
    Driver::<Ledger>::received(&mut rx);
    for (seq, input) in [(1, 5), (2, 0), (3, 7), (4, 9)] {
        d.client(ada, ClientMsg::Input { seq, input });
    }
    d.wait(Duration::from_millis(1));
    assert_eq!(
        d.sim().body(1),
        Some(&5),
        "the inputs after it didn't move it"
    );
    assert_eq!(
        d.core().game().world.tally("ada"),
        100,
        "logged before the rest"
    );
    let states: Vec<u32> = Driver::<Ledger>::received(&mut rx)
        .iter()
        .filter_map(|m| match m {
            ServerMsg::PlayerState { seq, .. } => Some(*seq),
            _ => None,
        })
        .collect();
    assert_eq!(states, [4], "the newest acknowledged");
    // What it sends next applies.
    d.client(ada, ClientMsg::Input { seq: 5, input: 2 });
    d.wait(Duration::from_millis(60));
    assert_eq!(d.sim().body(1), Some(&7));
}

#[test]
fn idle_time_streams_bulk_frames_under_the_high_water() {
    let mut d = ledger(paused());
    let (ada, mut rx) = d.connect("ada", Empty);
    Driver::<Ledger>::received(&mut rx);
    let frame = chunk(0).len();
    command(&mut d, ada, 1, "stream 10");
    Driver::<Ledger>::received(&mut rx);
    // Room for three frames on the bulk lane: three go, the rest wait.
    command(&mut d, ada, 2, &format!("high {}", 3 * frame));
    d.idle(Duration::from_millis(50));
    assert_eq!(d.core().game().streamed, 3);
    assert!(d.core().game().idle_work());
    let got: Vec<_> = Driver::<Ledger>::received(&mut rx)
        .into_iter()
        .filter(|m| matches!(m, ServerMsg::Game(_)))
        .collect();
    assert_eq!(got.len(), 3);
    assert_eq!(got[0], ServerMsg::Game("chunk 0000".into()));
    // As the client reads, the rest.
    for _ in 0..3 {
        d.idle(Duration::from_millis(50));
        Driver::<Ledger>::received(&mut rx);
    }
    assert_eq!(d.core().game().streamed, 10);
    assert!(!d.core().game().idle_work());
    let spent = d.idle(Duration::from_millis(50));
    assert_eq!(spent, Duration::ZERO, "no idle work: no pass");
    assert_eq!(d.sim().counters().idles, 4);

    // A waiting message cuts a pass short.
    command(&mut d, ada, 3, "stream 5");
    let until = Instant::now() + Duration::from_millis(50);
    d.sim_mut().idle(until, &mut || true);
    assert_eq!(d.core().game().idles.last(), Some(&true));
    assert_eq!(d.core().game().streamed, 10);
}

#[test]
fn lingering_bulk_frames_wake_by_a_deadline() {
    let mut d = ledger(paused());
    let (ada, _rx) = d.connect("ada", Empty);
    command(&mut d, ada, 1, "stream 2");
    command(&mut d, ada, 2, "high 1000000");
    let before = d.sim().deadline();
    d.idle(Duration::from_millis(10));
    assert_eq!(d.sim().deadline(), before, "nothing lingers");
    // While its view fills, a connection's bulk frames linger, for a
    // while at most: the loop wakes by then.
    command(&mut d, ada, 3, "stream 1");
    linger(&mut d, true);
    d.idle(Duration::from_millis(10));
    let now = d.now();
    let deadline = d.sim().deadline().expect("the linger");
    assert!(deadline <= now + tc_net::outbound::BULK_LINGER);
    linger(&mut d, false);
    d.sim_mut().wake_outbound(now);
    assert_eq!(d.sim().deadline(), before, "woken: nothing lingers");
}

/// Sets whether bulk frames linger, through a command.
fn linger(d: &mut Driver<Ledger>, on: bool) {
    command(
        d,
        1,
        50 + u32::from(on),
        if on { "linger 1" } else { "linger 0" },
    );
}

#[test]
fn timers_run_by_kind_on_their_own_deadlines_while_paused() {
    let mut d = ledger(paused());
    let (ada, mut rx) = d.connect("ada", Empty);
    command(&mut d, ada, 1, "timer 1 100");
    command(&mut d, ada, 2, "timer 2 30");
    command(&mut d, ada, 3, "timer 3 50");
    Driver::<Ledger>::received(&mut rx);
    let now = d.now();
    let deadline = d.sim().deadline().expect("a timer");
    assert!(
        deadline <= now + Duration::from_millis(30),
        "the earliest kind"
    );
    d.wait(Duration::from_millis(40));
    assert_eq!(d.core().game().timers, [2]);
    d.wait(Duration::from_millis(20));
    assert_eq!(d.core().game().timers, [2, 3]);
    assert_eq!(d.core().game().world.tally("ada"), 1, "its events logged");
    d.wait(Duration::from_millis(50));
    // Kind 3 re-armed itself; kind 1 came due.
    assert_eq!(d.core().game().timers, [2, 3, 3, 1]);
    assert_eq!(d.sim().counters().timers, 4);
    assert!(d.sim().clock().paused());

    // A store failure stops them.
    d.sim_mut().fail_store("gone");
    d.wait(Duration::from_millis(200));
    assert_eq!(d.core().game().timers.len(), 4);
}

#[test]
fn the_loop_gives_idle_time_and_answers_requests() {
    let game = Ledger {
        to_stream: 20,
        high_water: 1 << 20,
        ..Ledger::default()
    };
    let running = Sim::new(Core::new(game), None, paused()).spawn().unwrap();
    let (out, mut rx) = tc_net::outbound::outbound();
    running
        .requests
        .send(tc_net::Request::Connect {
            conn: 1,
            identity: Identity {
                name: "ada".into(),
                permissions: Vec::new(),
            },
            hello: Empty,
            out,
        })
        .unwrap();
    let started = Instant::now();
    let mut chunks = 0;
    while chunks < 20 && started.elapsed() < Duration::from_secs(5) {
        for m in Driver::<Ledger>::received(&mut rx) {
            if matches!(m, ServerMsg::Game(_)) {
                chunks += 1;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(chunks, 20, "streamed in idle time");
    let core = running.stop();
    assert_eq!(core.game().streamed, 20);
    assert!(!core.game().idles.is_empty());
}
