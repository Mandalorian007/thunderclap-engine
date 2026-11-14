# Write a server game

## What you'll build

This guide puts a game on a server you own. The server runs the rules in Rust; every player's page connects over a WebSocket, sends what the player does, and draws what the server says. Nobody can cheat by editing their page, everyone sees the same game, and a player who drops and comes back carries on where they were.

Two games in the engine repo use everything here, so open them next to this page:

- `templates/arena-2d-server`: real-time tag for two to eight players. Each page moves its own player at once (prediction) and draws the others smoothly a moment in the past.
- `crates/tc-sim/tests/turns_game`: tic-tac-toe. Turns are commands, a turn times out, and the whole game can be replayed, rolled back and resumed. `src/net/turns-interop.test.ts` plays it from TypeScript.

## The pieces

| Side | Crate or module | What it does |
| --- | --- | --- |
| Server | `thunderclap-server` | The facade: serves a game from a data directory (store, loop, WebSocket server, sign-in, admin channel) and gives it a CLI. Re-exports the crates below. |
| Server | `tc-wire` | Binary encoding (`#[derive(Wire)]`, re-exported by the facade) and the schema both sides hash. |
| Server | `tc-sim` | Your game: the `Game` trait, the fixed-step loop (`Sim`), the log, queries, the entity stream. |
| Server | `tc-net` | The WebSocket server, sessions, the hello and reconnect handshake. |
| Server | `tc-store` | The log on disk, snapshots, replay and rollback. |
| Client | `@thunderclap-engine/engine/net` | `createNet`: the session, queries, commands, inputs, the predictor and the snapshot buffer. |

The server's crates live in this repo under `crates/`; a game names only `thunderclap-server` in its `Cargo.toml`: by path inside this repo (the arena's `server/Cargo.toml`), or by git tag `server-v<major>.<minor>` in a game made with `pnpm create-game` from the arena. It reaches the others through it: `thunderclap_server::sim`, `::net`, `::store`, `::wire`. `#[derive(Wire)]` comes from `thunderclap_server::Wire`; in a crate that names only the facade the derive's code goes through `thunderclap_server::wire`, and `#[wire(crate = "path")]` names another path.

## Everything that happens is an event

A `tc-sim` game is a state plus the events that change it. Players never change the state directly. A command, an input, a join or a timer produces events; the loop logs each one and then calls your `apply` with it. Because the log holds every change, the loop can replay it to the same state hash, roll it back to any point, and tell each client exactly what changed.

```rust
#[derive(Wire, Clone, Debug, PartialEq)]
pub enum Event {
    Joined { name: String },
    Placed { mark: u8, cell: u8 },
    Resigned { mark: u8 },
    Rematch,
}

impl Game for Turns {
    fn apply(&mut self, ev: &Event, cx: &mut Cx<'_, Turns>) -> Result<(), String> {
        match ev {
            Event::Placed { mark, cell } => {
                self.cells[*cell as usize] = *mark;
                // ...check for a win, pass the turn...
                cx.mark(Change::Board); // queries that read the board rerun
            }
            // ...
        }
        Ok(())
    }
}
```

`apply` must be deterministic: no clock, no random numbers, no I/O. `cx.time()` is the loop's step count, and `cx.schedule(at, scheduled)` asks the loop to call `fire` at a later step (tic-tac-toe's turn timer).

## The protocol

`Game::Protocol` names your message types. Anything you don't use is `Empty`.

```rust
impl Protocol for ArenaProto {
    type Hello = Empty;     // extra fields in the client's hello
    type Welcome = Empty;   // what a joining player is told (tic-tac-toe: its mark)
    type Command = Empty;   // a request with a reply (tic-tac-toe: Move)
    type Result = Empty;    // the reply
    type Interest = Empty;  // what a client wants streamed (a region, a room)
    type Input = u8;        // a real-time input: here the held keys
    type State = Pos;       // what a player hears back after its inputs
    type Client = Empty;    // free-form client messages
    type Server = Empty;    // free-form server messages
}
```

Use **commands** for things that happen once and need an answer: place a mark, buy an item, start a round. `command` returns events and a result; if `apply` refuses an event, `command_error` turns the error into the result.

Use **inputs** for things held over time: movement keys, a stick, an aim. The loop takes each player's inputs once per step and calls `input` with the player's **body**, its unlogged per-player state (here its position). `input` moves the body; `player_state` says what to send back (`PlayerState { seq, state }`). Bodies are not logged. After an input tick in which some player took an input, the loop calls `moved(bodies, events)` once: the rules read every body there (`bodies.get(player)`, `bodies.moved()` for who took an input) and push only the events they decide on. The arena checks for a tag there and pushes `Tagged { by, who }`; a step of movement is never logged, so the log grows with what happens, not with time. The events `moved` pushes are logged, so a replay applies them and never needs a body. `apply` and `Cx` still cannot read bodies.

## Seats

`join(identity, hello, events)` returns `Seat::Player(id)` or `Seat::Observer`. A returning name gets its old seat back; a new one pushes a `Joined` event. Past eight players, the arena seats newcomers as observers, who watch but cannot act. `presence(player, present, body, events)` hears a player come and go. `body(player)` makes a seated player's body after its `Joined` event is applied, so it can read the seat from the state. A seat's `PlayerId` is stable: a name keeps its seat for the life of the store, across restarts and reconnects, and ids are never reused.

`on_open(time, events)` runs once each time the store is opened, after recovery and before any connection: its events are logged like any other. Nobody is connected then, so the arena marks every seat that was present when the last run stopped (or crashed) as gone.

`save()` and `restore(bytes)` keep the store bounded. `save` returns the state as bytes (everything `hash_state` covers; the arena derives `Wire` on its state and returns `self.to_bytes()`), and `restore` sets a new game from them. A game that saves gets a **base** every `SimConfig::base_every` entries (100,000 by default): the loop starts a new log generation, writes the state through the last entry before it to the store's `base/` (off the loop's thread), keeps the newest two bases, and moves the log behind the older one to the archive (`SimConfig::archive`, or the facade's `.archive(policy)`: a week and 1 GiB by default). Opening restores the newest base that reads back whole, checks its state hash, and replays only the log after it; a damaged base falls back to the one before. A game that returns `None` (the default) keeps no bases and replays its whole log, as before. The arena's `a_long_run_keeps_its_log_bounded_and_a_restart_restores_its_base` test runs thousands of entries with a base every 40 and restarts mid-run.

## What clients see

There are two ways to send state to pages.

**Queries** are named, typed reads, each one a function of the state:

```rust
fn queries() -> Vec<Query<Arena>> {
    vec![Query::<Arena>::new("score", "Who is it, and everyone's tags.", false,
        |cx: &QueryCtx<'_, Arena>, _: Empty| {
            cx.read(Change::Roster); // rerun when the roster changes
            Ok(cx.game().score())
        })]
}
```

A client subscribes with `net.query('score', {}, fn)`. The loop reruns a query only when a `Change` it read was marked, and it sends a patch when the patch is smaller than the whole result. Mark `player: true` (the third argument) for a per-player answer; `cx.player()` says whose.

**The entity stream** is for many moving things. `entities(cx, interest, out)` lists `(id, View)` pairs for what a connection's interest covers. The client keeps them in `net.entities` and gets `entities` events with what changed and what went away.

## Serving it

```rust
pub fn server() -> Builder<Arena> {
    Server::builder(Arena::new())
        .data_dir("data/arena")
        .port(4711)
        .build(concat!("arena ", env!("CARGO_PKG_VERSION")))
}

fn main() {
    std::process::exit(thunderclap_server::cli::main(std::env::args(), arena_server::server));
}
```

That `main` is the whole server binary. `cargo run -- serve` opens the store in the data directory (or creates it), runs the loop at `SimConfig::default()`'s 20 steps a second, serves WebSockets and listens for its admin channel. While it runs, `status`, `pause`, `resume`, `reload` and `stop` from a second shell ask it; `backup` and `rollback` work on the data directory while it is stopped. Every command takes `--data DIR`. A test calls `server().data_dir(dir).port(0).start().await` instead and gets the address, the loop and, from `stop().await`, the final state.

The builder's port defaults to 0: the OS picks a free one, which suits tests. A game that pages connect to names its port with `.port(n)`, as above, and `serve --port N` overrides it.

`AuthMode::DevGuests` (the default) is for development: it issues guest tokens, and a page can also pick its own name with the token `guest:<name>` (lower_snake, 2 to 24 characters; a name held by an account is refused). `Open` takes the token as the name. Neither belongs on a server on the internet.

## The client

The page describes the same types with `defineSchema`. Its hash must equal the server's, or the server refuses the connection with a "schema mismatch" message. You don't write it by hand: `thunderclap_server::generate_ts(&schema, dir)` writes `schema.ts` (the `defineSchema` call and `SCHEMA_HASH`) beside `generated.ts` (the TypeScript types). The arena's test `the_client_schema_is_generated` compares `src/schema.ts` with it, and `TC_BLESS=1 cargo test` rewrites it. It looks like this:

```ts
import { type Connect, createNet, defineSchema, EMPTY } from '@thunderclap-engine/engine/net';

const schema = defineSchema({
  types: {
    Pos: { struct: { x: 'i32', y: 'i32' } },
    Player: { struct: { name: 'String', x: 'i32', y: 'i32', vx: 'i32', vy: 'i32', it: 'bool' } },
    Entry: { struct: { id: 'u64', name: 'String', tags: 'u32', present: 'bool' } },
    Score: { struct: { it: 'u64', players: { vec: 'Entry' } } },
  },
  roles: { input: 'u8', state: 'Pos' },
  roots: ['Player'],
  queries: { score: { result: 'Score' } },
});

const connect: Connect = (events) => {
  const ws = new WebSocket('ws://127.0.0.1:4711');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => events.open();
  ws.onmessage = (e) => events.message(new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = (e) => events.close(e.code, e.reason);
  return { send: (frame) => ws.send(frame as Uint8Array<ArrayBuffer>), close: () => ws.close() };
};

const net = createNet({ schema, connect, hello: { token: 'guest:ada' }, entities: 'Player' });
net.setInterest(EMPTY);
const welcome = await net.ready;
console.log('seated as player', welcome.player);
```

The arena also writes the server's hash to `shared/schema-hash.txt`, which the client's tests compare against.

A resent query result carries its hash, which the client checks. A client that resumes with a result the server still holds unchanged is sent nothing for it.

## Prediction

Waiting a round trip before your own player moves feels sluggish. Instead, run the server's rule on the page too:

```ts no-check
const predictor = net.predict<Pos, number>({
  step,                                   // the same rule as the server's `step`
  equal: (a, b) => a.x === b.x && a.y === b.y,
  distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  start: { seq: 0, state: { x: 640, y: 360 } },
  stepMs: 50,
});
net.on('welcome', () => predictor.expectReset()); // the first PlayerState is not a misprediction
setInterval(() => { if (keys) net.input(keys); }, 50); // one input a step
```

`net.input(keys)` applies the input at once and sends it. When `PlayerState { seq, state }` arrives, the predictor starts from the server's state and replays the inputs the server hasn't seen yet. Draw the player between `predictor.previous` and `predictor.state` with `predictor.alpha()`.

The rule must give exactly the same answer on both sides, so keep it in integers. The arena writes it twice (`server/src/game.rs` and `src/rules.ts`) and tests both against the cases in `shared/rules.json`.

Draw everyone else from the entity stream, a little in the past, through the snapshot buffer: `push` each change into `net.snapshots` as it arrives, call `net.snapshots.frame(now)` once per frame, and `at(id, out)` gives where to draw each one.

## Reconnects

`createNet` reconnects by itself. A query the page held is resumed: the client sends the version and hash it has, and the server sends a patch from there rather than the whole result. Tic-tac-toe's interop test drops a player mid-game and checks the board comes back as a patch.

## Testing

- **Rules, from Rust.** `Driver` runs a game with no network: `connect(name, hello)`, `client(conn, msg)`, `push_input(conn, input)` (queues an input like a client's, returns its seq), `input_tick()` (runs the input tick now), `tick(now)`, `wait(duration)` and `now()` on the driver's own clock, which starts at its creation and moves only when told, `advance(steps)`, and `received(rx)` for what a connection was sent. See `templates/arena-2d-server/server/tests/arena.rs`.
- **Replay and rollback.** Play a game into a store, reopen it, and compare `hash_state`. See `crates/tc-sim/tests/turns.rs`.
- **The real client.** Start the server on port 0 in a Rust test and run a Vitest file against it with `createNet` (`crates/thunderclap-server/tests/turns.rs` serves tic-tac-toe through the facade and runs `src/net/turns-interop.test.ts`). The engine's own interop tests share the Rust test game with these runs through `#[path = "..."] mod game;` in each test crate, and that is the pattern to copy: one module, built into each test that serves it, with no extra crate, or start both in Playwright (`e2e/arena-2d-server.spec.ts`).

## Known rough edges

- A reload with bases restores the newest base (the old game's state, through `restore`) and replays only the log after it into the new game: new data changes what happens from the base on, not what came before it. A game without bases replays its whole log, as before.
- A rollback can reach back as far as the archive keeps (a week by default); a rollback or repair in place moves the bases aside with the old log, and the next open replays the new log from its start, then writes bases again.
