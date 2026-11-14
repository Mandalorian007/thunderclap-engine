# Arena: a ThunderClap server template

This folder is a complete, copyable real-time 2D game with a Rust server: `server/` (a crate on
`tc-sim`, `tc-net`, `tc-wire`) owns the game; the page (`src/`, on `@thunderclap-engine/engine`)
joins it, predicts its own player and draws everyone. Everything an agent needs to extend it is in
this file and in the engine's guide `docs/guide/server-game.md`.

## Commands

- `pnpm dev`: `scripts/dev.mjs` starts the server (`cargo run --release`, port 4711) and Vite
  (port 4710) together (from the repo root: `pnpm template:arena-2d-server`).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:server`: `tsc`, Biome (the repo's `biome.json`), Vitest, `cargo test`. `pnpm check` runs all four; the repo root's `pnpm check` runs it too (`check:template-arena-2d-server`).
- The repo's `e2e/arena-2d-server.spec.ts` starts the server (`--port 0`) and the client, opens two
  pages and checks each sees the other move. It reads `window.__arena` (set in `main.ts`).

## Shape

```
shared/rules.json        the numbers and step cases both sides read and test
shared/schema-hash.txt   the schema hash both sides must agree on
server/src/game.rs       the rules (step) and the game (Arena: tc_sim::Game)
server/src/lib.rs        schema(), serve(host, port): the Sim plus its WebSocket server
server/src/main.rs       the binary: --host, --port (0 = any free port), Ctrl-C stops it
server/tests/arena.rs    the rules against rules.json, the schema hash, tagging, the stream
src/rules.ts             the client's copy of step (and the constants, from rules.json)
src/schema.ts            defineSchema: the same types and roles the server builds
src/main.ts              createNet, the predictor, snapshots, input, drawing, the HUD
scripts/dev.mjs          pnpm dev
```

## Rules of the house

1. **The server decides.** A move is an input (`u8`, the held keys); the server runs `step` and
   sends the player's position back (`PlayerState`). The page never tells the server where it is.
2. **One rule, two copies, one test.** `step` exists in Rust and TypeScript. Both are tested
   against `shared/rules.json`; change the cases with the code. Integers only, so both agree
   exactly.
3. **One schema, two copies, one hash.** `src/schema.ts` mirrors what `game.rs` builds; the hash
   in `shared/schema-hash.txt` is checked by both test suites, and a page with another hash is
   refused at connect.
4. **Zero allocations per frame.** `render` mutates pre-built `DrawParams`; snapshots are read
   into one reused `Float64Array`.
5. **Import only the public map.** `@thunderclap-engine/engine/<module>` on the page; the
   server's crates by their public API.

## The engine's nouns

Server (Rust; `docs/guide/server-game.md` walks through them):

- **`tc_sim::Game`**: the game's state and rules. `Protocol` (the message types: here `Input =
  u8`, `State = Pos`), `Change`, `Data` (the logged events: `Joined`, `Present`, `Moved`),
  `Body` (a player's unlogged state, moved by `input`: here `Pos`), `View` (what the entity
  stream sends: `Player`). `apply` changes state from a logged event; `join` seats a player or an
  observer; `presence` hears a player come and go; `input` moves a body; `player_state` is what
  the player hears back; `entities` streams what a page sees; `queries` serves `score`.
- **`Sim`, `Server`**: `Sim::new(Core::new(game), None, SimConfig::default())` runs the game in
  memory at 20 steps a second; `sim.spawn()` gives the request channel; `tc_net::Server::start`
  serves it over WebSocket.

Client (`@thunderclap-engine/engine/net`, `/kit`, `/render`):

- **`createNet({ schema, connect, hello, entities, snapshots })`**: the session. `net.welcome`
  (the player id), `net.status`, `net.entities` (the streamed `Player`s by id),
  `net.query(name, args, fn)` (here `score`), `net.input(i)`, `net.setInterest(EMPTY)`,
  `net.on('welcome' | 'entities', fn)`. It reconnects and resumes by itself.
- **`net.predict({ step, equal, distance, start, stepMs })`**: the predictor. `net.input`
  applies an input at once and replays unacknowledged ones on each `PlayerState`; `state`,
  `previous`, `alpha()` place the player between steps; `expectReset()` before a known jump.
- **`net.snapshots`** (`SnapshotBuffer`): `push(id, tick, pos, vel, now)`, `frame(now)`,
  `at(id, out)` (where to draw an entity now, a little in the past).
- **`composeGame({ root, title, design, loop })`** (`kit`): boots WebGPU and returns the context
  (or `null` without WebGPU). `ctx.stack.push({ name, render(frame) })`, `ctx.loop.start()`.
- **`frame.sprite(null, { x, y, w, h, tint, rotation })`** (`render`): a flat quad in design px.

## Extending it

- A new rule: in `game.rs` (and `step` in both copies if it moves players), with a case in
  `rules.json` or a test in `server/tests/arena.rs`.
- Something everyone sees: a field on `Player` (both schemas, then `TC_BLESS=1 cargo test` and
  copy the hash), filled in `Arena::entities`.
- Something only some players see: a query in `Arena::queries` with `player: true`, or an
  interest other than the whole box.
