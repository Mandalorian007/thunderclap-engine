//! A game that owns its connections, its requests and its state, run on
//! the engine's loop ([`run_host`]): the hall. Its own request enum, its
//! own sessions (a channel of lines per connection), its own clock and
//! record (an event log and a state hash, replayed to the same hash), its
//! own dev clock commands, and a world it streams to each connection in
//! idle time ("sections"), cut short when a request arrives.

use std::collections::BTreeMap;
use std::ops::ControlFlow;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use tc_net::WallClock;
use tc_sim::{Host, HostExit, run_host};
use tc_wire::hash::StableHasher;

/// How many sections each connection is streamed.
const SECTIONS: u32 = 40;

/// The hall's own requests (not tc-net's).
enum Request {
    Connect {
        conn: u64,
        name: String,
        out: Sender<String>,
    },
    Say {
        conn: u64,
        text: String,
    },
    Disconnect {
        conn: u64,
    },
    /// Dev: jump the clock to a time.
    AdvanceTo(u64),
    /// Dev: run the clock.
    Resume,
    /// Dev: the world's hash, now.
    Hash(Sender<u64>),
    Shutdown,
}

/// What the hall's log records.
#[derive(Clone, Debug, PartialEq)]
enum Event {
    Joined(String),
    Said(String, String),
    Left(String),
}

/// The deterministic part: time, the log and what it built.
#[derive(Default)]
struct World {
    time: u64,
    log: Vec<(u64, Event)>,
    /// Lines said, by name.
    said: BTreeMap<String, u32>,
    /// Bells rung (one every 8 steps, never logged: it follows from time).
    bells: u64,
}

impl World {
    fn advance(&mut self, target: u64) {
        while self.time < target {
            self.time += 1;
            if self.time.is_multiple_of(8) {
                self.bells += 1;
            }
        }
    }

    fn commit(&mut self, event: Event) {
        self.apply(&event);
        self.log.push((self.time, event));
    }

    fn apply(&mut self, event: &Event) {
        if let Event::Said(name, _) = event {
            *self.said.entry(name.clone()).or_default() += 1;
        }
    }

    fn replay(log: &[(u64, Event)], to: u64) -> World {
        let mut w = World::default();
        for (time, event) in log {
            w.advance(*time);
            w.commit(event.clone());
        }
        w.advance(to);
        w
    }

    fn hash(&self) -> u64 {
        let mut h = StableHasher::new();
        h.write_u64(self.time);
        h.write_u64(self.bells);
        for (name, n) in &self.said {
            h.write_str(name);
            h.write_u64(u64::from(*n));
        }
        h.write_u64(self.log.len() as u64);
        h.finish()
    }
}

/// One connection, as the hall keeps it.
struct Conn {
    name: String,
    out: Sender<String>,
    sent: u32,
}

/// The server: the world plus everything per connection.
struct Hall {
    world: World,
    clock: WallClock,
    conns: BTreeMap<u64, Conn>,
    next_flush: Instant,
    /// Counters the test reads.
    idles: u32,
    interrupted: u32,
    lates: u32,
    wakes: u32,
}

impl Hall {
    fn new(paused: bool) -> Hall {
        let now = Instant::now();
        Hall {
            world: World::default(),
            clock: WallClock::new(Duration::from_millis(5), paused, now, 0),
            conns: BTreeMap::new(),
            next_flush: now,
            idles: 0,
            interrupted: 0,
            lates: 0,
            wakes: 0,
        }
    }

    fn broadcast(&self, line: &str) {
        for c in self.conns.values() {
            let _ = c.out.send(line.to_string());
        }
    }

    /// The hall stops: everyone leaves, on the record.
    fn stop(mut self) -> Hall {
        for c in std::mem::take(&mut self.conns).into_values() {
            self.world.commit(Event::Left(c.name));
            let _ = c.out.send("closed".into());
        }
        self
    }
}

impl Host for Hall {
    type Request = Request;

    fn tick(&mut self, now: Instant) {
        if let Some(target) = self.clock.target(now)
            && target > self.world.time
        {
            self.world.advance(target);
        }
        if now >= self.next_flush {
            self.next_flush = now + Duration::from_millis(50);
        }
    }

    fn wake_outbound(&mut self, _: Instant) {
        self.wakes += 1;
    }

    fn deadline(&self) -> Option<Instant> {
        [
            self.clock.next_step_at(self.world.time),
            Some(self.next_flush),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    fn idle_work(&self) -> bool {
        self.conns.values().any(|c| c.sent < SECTIONS)
    }

    fn idle(&mut self, until: Instant, interrupted: &mut dyn FnMut() -> bool) {
        self.idles += 1;
        for c in self.conns.values_mut() {
            while c.sent < SECTIONS {
                if Instant::now() >= until {
                    return;
                }
                if interrupted() {
                    self.interrupted += 1;
                    return;
                }
                // Building a section takes a while.
                std::thread::sleep(Duration::from_micros(200));
                let _ = c.out.send(format!("section {}", c.sent));
                c.sent += 1;
            }
        }
    }

    fn handle(&mut self, request: Request) -> ControlFlow<()> {
        // Catch up first, so the request lands at the time it is now.
        self.tick(Instant::now());
        match request {
            Request::Connect { conn, name, out } => {
                let _ = out.send(format!("welcome {name} at {}", self.world.time));
                self.world.commit(Event::Joined(name.clone()));
                self.conns.insert(conn, Conn { name, out, sent: 0 });
            }
            Request::Say { conn, text } => {
                if let Some(name) = self.conns.get(&conn).map(|c| c.name.clone()) {
                    self.broadcast(&format!("{name}: {text}"));
                    self.world.commit(Event::Said(name, text));
                }
            }
            Request::Disconnect { conn } => {
                if let Some(c) = self.conns.remove(&conn) {
                    self.world.commit(Event::Left(c.name));
                }
            }
            Request::AdvanceTo(time) => {
                self.world.advance(time);
                if !self.clock.paused() {
                    self.clock.run_from(Instant::now(), self.world.time);
                }
            }
            Request::Resume => self.clock.run_from(Instant::now(), self.world.time),
            Request::Hash(reply) => {
                let _ = reply.send(self.world.hash());
            }
            Request::Shutdown => return ControlFlow::Break(()),
        }
        ControlFlow::Continue(())
    }

    fn woke_late(&mut self, late: Duration, _: Duration) {
        if late > Duration::from_millis(1) {
            self.lates += 1;
        }
    }
}

/// Runs `hall` on a thread: its requests' sender and the thread, which
/// returns how the loop ended and the hall as it stopped.
fn spawn(mut hall: Hall) -> (Sender<Request>, std::thread::JoinHandle<(HostExit, Hall)>) {
    let (tx, rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let exit = run_host(&mut hall, &rx);
        (exit, hall.stop())
    });
    (tx, thread)
}

fn connect(tx: &Sender<Request>, conn: u64, name: &str) -> Receiver<String> {
    let (out, rx) = mpsc::channel();
    tx.send(Request::Connect {
        conn,
        name: name.into(),
        out,
    })
    .unwrap();
    rx
}

fn say(tx: &Sender<Request>, conn: u64, text: &str) {
    tx.send(Request::Say {
        conn,
        text: text.into(),
    })
    .unwrap();
}

/// Lines on `rx` until `done` says stop (or ten seconds).
fn read_until(rx: &Receiver<String>, mut done: impl FnMut(&str) -> bool) -> Vec<String> {
    let mut lines = Vec::new();
    loop {
        let line = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the hall went quiet");
        let end = done(&line);
        lines.push(line);
        if end {
            return lines;
        }
    }
}

/// The scripted session both runs of the determinism test play.
fn script(tx: &Sender<Request>) -> u64 {
    let ann = connect(tx, 1, "ann");
    let bo = connect(tx, 2, "bo");
    say(tx, 1, "hello");
    tx.send(Request::AdvanceTo(30)).unwrap();
    say(tx, 2, "hi ann");
    tx.send(Request::AdvanceTo(75)).unwrap();
    // Messages land between sections: the stream is cut short for them.
    let last = format!("section {}", SECTIONS - 1);
    let lines = read_until(&bo, |l| l == last);
    assert!(lines.contains(&"ann: hello".to_string()));
    assert!(lines.contains(&"bo: hi ann".to_string()));
    read_until(&ann, |l| l == last);
    tx.send(Request::Disconnect { conn: 1 }).unwrap();
    let (reply, hash) = mpsc::channel();
    tx.send(Request::Hash(reply)).unwrap();
    hash.recv().unwrap()
}

#[test]
fn a_game_that_owns_its_connections_runs_on_the_host_loop() {
    let (tx, thread) = spawn(Hall::new(true));
    let hash = script(&tx);
    tx.send(Request::Shutdown).unwrap();
    let (exit, hall) = thread.join().unwrap();
    assert_eq!(exit, HostExit::Stopped);
    assert_eq!(hall.world.time, 75, "paused: only the dev jumps moved it");
    assert_eq!(hall.world.bells, 9);
    assert!(hall.idles > 0, "sections were built in idle time");
    assert!(hall.wakes > 0);
    assert!(hall.conns.is_empty(), "everyone left with the hall");
    assert_eq!(hall.world.log.last(), Some(&(75, Event::Left("bo".into()))));

    // The record replays to the hash it had live, and a second run of the
    // same requests reaches it too.
    let before_stop = &hall.world.log[..hall.world.log.len() - 1];
    assert_eq!(World::replay(before_stop, 75).hash(), hash);
    assert_eq!(World::replay(&hall.world.log, 75).hash(), hall.world.hash());
    let (tx, thread) = spawn(Hall::new(true));
    assert_eq!(script(&tx), hash, "same requests, same hash");
    drop(tx);
    let (exit, _) = thread.join().unwrap();
    assert_eq!(exit, HostExit::Disconnected, "every sender gone");
}

#[test]
fn a_running_clock_steps_on_the_host_loop() {
    let (tx, thread) = spawn(Hall::new(true));
    tx.send(Request::Resume).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let (reply, rx) = mpsc::channel();
    tx.send(Request::Hash(reply)).unwrap();
    rx.recv().unwrap();
    tx.send(Request::Shutdown).unwrap();
    let (_, hall) = thread.join().unwrap();
    // 5 ms steps for at least 100 ms, woken for each by its deadline.
    assert!(hall.world.time >= 15, "stepped to {}", hall.world.time);
    assert_eq!(hall.world.bells, hall.world.time / 8);
    assert_eq!(
        World::replay(&hall.world.log, hall.world.time).hash(),
        hall.world.hash()
    );
}

#[test]
fn a_request_cuts_idle_work_short() {
    let (tx, thread) = spawn(Hall::new(true));
    let cy = connect(&tx, 1, "cy");
    read_until(&cy, |l| l == "section 1");
    say(&tx, 1, "still loading");
    let last = format!("section {}", SECTIONS - 1);
    let lines = read_until(&cy, |l| l == last);
    let said = lines.iter().position(|l| l == "cy: still loading");
    assert!(said.is_some(), "answered before the stream finished");
    tx.send(Request::Shutdown).unwrap();
    let (_, hall) = thread.join().unwrap();
    assert!(hall.interrupted > 0, "the idle pass gave way");
    assert!(hall.idles > 1, "and came back for the rest");
}
