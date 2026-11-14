# Write a server game

## What you'll build

This guide puts a game on a server you own. The server runs the rules in Rust; every player's page connects over a WebSocket, sends what the player does, and draws what the server says. Nobody can cheat by editing their page, everyone sees the same game, and a player who drops and comes back carries on where they were.

Two games in the engine repo use everything here, so open them next to this page:

- `templates/arena-2d-server`: real-time tag for two to eight players. Each page moves its own player at once (prediction) and draws the others smoothly a moment in the past.
- `crates/tc-sim/tests/turns_game`: tic-tac-toe. Turns are commands, a turn times out, and the whole game can be replayed, rolled back and resumed. `src/net/turns-interop.test.ts` plays it from TypeScript.

## The pieces

| Side | Crate or module | What it does |
| --- | --- | --- |
| Server | `tc-wire` | Binary encoding (`#[derive(Wire)]`) and the schema both sides hash. |
| Server | `tc-sim` | Your game: the `Game` trait, the fixed-step loop (`Sim`), the log, queries, the entity stream. |
| Server | `tc-net` | The WebSocket server, sessions, the hello and reconnect handshake. |
| Server | `tc-store` | The log on disk, snapshots, replay and rollback (optional: a `Sim` can keep its log in memory). |
| Client | `@thunderclap-engine/engine/net` | `createNet`: the session, queries, commands, inputs, the predictor and the snapshot buffer. |

The server's crates live in this repo under `crates/`; a game names them by path in its `Cargo.toml` (see the arena's `server/Cargo.toml`).

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

Use **inputs** for things held over time: movement keys, a stick, an aim. The loop takes each player's inputs once per step and calls `input` with the player's **body**, its unlogged per-player state (here its position). `input` moves the body; `player_state` says what to send back (`PlayerState { seq, state }`). Bodies are not logged, so a body change that the other players or the rules need must also push an event. The arena pushes `Moved { player, to }`, and its `apply` checks for a tag.

## Seats

`join(identity, hello, events)` returns `Seat::Player(id)` or `Seat::Observer`. A returning name gets its old seat back; a new one pushes a `Joined` event. Past eight players, the arena seats newcomers as observers, who watch but cannot act. `presence(player, present, body, events)` hears a player come and go.

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
let sim = Sim::new(Core::new(Arena::new()), None, SimConfig::default()); // log in memory
let running = sim.spawn()?;
let mut config = ServerConfig::new(Arena::schema().hash());
config.host = "127.0.0.1".into();
config.port = 4711;
let server = Server::<ArenaProto>::start(config, running.requests.clone()).await?;
```

`SimConfig::default()` steps 20 times a second. For a world you keep, use `Sim::create` or `Sim::open` with a directory: the log and snapshots go to disk, and `tc_store::rollback` can take the world back to an earlier version.

## The client

The page describes the same types with `defineSchema`. Its hash must equal the server's, or the server refuses the connection with a "schema mismatch" message.

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

const net = createNet({ schema, connect, hello: { token: 'ada' }, entities: 'Player' });
net.setInterest(EMPTY);
const welcome = await net.ready;
console.log('seated as player', welcome.player);
```

Keep the two schemas in step with a test on each side. The arena writes the server's hash to `shared/schema-hash.txt` (`TC_BLESS=1 cargo test` rewrites it) and both test suites compare against it.

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

- **Rules, from Rust.** `Driver` runs a game with no network: `connect(name, hello)`, `client(conn, msg)`, `tick(now)` (takes inputs at the input tick), `advance(steps)`, and `received(rx)` for what a connection was sent. See `templates/arena-2d-server/server/tests/arena.rs`.
- **Replay and rollback.** Play a game into a store, reopen it, and compare `hash_state`. See `crates/tc-sim/tests/turns.rs`.
- **The real client.** Start the server on port 0 in a Rust test and run a Vitest file against it with `createNet` (`turns.rs` runs `src/net/turns-interop.test.ts`), or start both in Playwright (`e2e/arena-2d-server.spec.ts`).

## Known rough edges

- The rules (`apply`, `Cx`) cannot read players' bodies, so a body change that matters to others must be copied into the state with an event.
- A `Sim` with its log in memory keeps the whole history, so a long-lived real-time server grows without bound. Use a store for anything that runs for days.
- The client's schema is written by hand. Compare its hash in tests.
- A small query result is resent whole instead of patched, so resuming it saves nothing.
- `Driver` takes inputs only in `tick(now)`, so a test needs wall-clock instants to drive inputs.
