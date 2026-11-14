# tc-sim

ThunderClap's authoritative game loop: what a networked game's Rust server
runs, real-time or turn-based. The game brings its rules; tc-sim brings the
clock, the schedule, the log (through `tc-store`) and the connections
(through `tc-net`). Part one (E4a) of the port of Forge Wilds' sim loop,
scheduler, timing wheel, change marks, connection handling, input credit,
hot reload and status, with the game taken out. Live queries, interest and
the entity stream follow in E4b.

## API

- `Game`: the game's side.
  - Types: `Protocol` (tc-net roles), `Codec` (a tc-store `LogCodec`; its
    `Event` is what the log records), `Scheduled` (a `Wire` event the game
    schedules), `Change` (an ordered change-mark key), `Data` (what a
    reload rebuilds it from).
  - State changes only in `apply(event, cx)`, `fire(scheduled, cx)` and
    `step(cx)` (when `steps()`); `Cx` gives the time, the schedule and the
    change marks.
  - Clients only read it: `join`, `presence`, `command`, `input`,
    `message` return events to log; `welcome`, `greet`, `player_state`,
    `flush(changes, outbox)` and `reloaded` say what to send.
  - `hash_state` feeds the determinism hash; `reload(data)` makes a new
    game at its start.
- `Core<G>`: the deterministic part: the game, time (integer steps, at
  most `MAX_TIME` = 2^53 − 1), version (last entry applied), `Scheduler`
  (on a hierarchical `TimingWheel`) and `Changes`. `advance_to`,
  `advance_while`, `apply`, `replay`, `Core::replayed`, `state_hash`.
- `Sim<G>`: a core served on the wall clock. `create` / `open` (a tc-store
  directory, the log replayed) or `new(core, None, config)` (in memory).
  `handle(Request)`, `tick(now)`, `deadline()`, `pause`, `resume`,
  `advance(steps)` (sliced, within `ADVANCE_BUDGET`, stops on
  `stopping()`), `reload(data, reply)`, `stop()`. `spawn()` runs it on a
  thread: `Running { requests, handle, thread }`; hand `requests` to
  `tc_net::Server::start`; `SimHandle` sends `Control`s.
- `Driver<G>`: a sim run by hand with in-process connections, for tests,
  bots and tools.
- `InputQueue` (`InputConfig`, `Taken`): per-player inputs, stale ones
  dropped, a short buffer, credit-paced on the wall clock.
- `StatusHandle` / `SimStatus`: the published status; `Display` is the
  one-line status.

## Behaviour

- Every client event is logged (one batch, all or none) at the current
  time, then applied. A store that fails pauses the clock, tells clients
  once (`Clock { paused: true }`), turns new connections away and changes
  nothing more. An event the codec can't encode is a game bug, not a store
  failure: its batch is refused (nothing logged or applied), a command gets
  `Game::command_error`, `SimStatus.refused` counts it, and the loop runs
  on.
- Commands flush the changes they made before their `CommandResult`;
  otherwise changes flush at most every `FLUSH_INTERVAL` (50 ms).
- One body, one driver: the newest connection drives, `TakeControl` moves
  control, and queued inputs from the old driver are dropped.
- The clock is pushed every 5 s and marked in the log every 10 s; clients
  over 1 MiB behind for 30 s are dropped.
- A reload replays the log into the new game on another thread, catches
  up what was logged meanwhile and swaps it in; one at a time.
- Live play and a replay of its log reach the same `state_hash`.

## Tests

- Unit tests: the wheel (against a `BTreeMap`), scheduler order and
  restore, change marks, input credit, the status line.
- `tests/sim.rs` (the tally game in `tests/tally/`, driven by hand): the
  clock at the end of time, a budgeted and a stopped advance, a refused
  event, one driver per body, flush before result, a reload, a log
  replayed to the same hash.
- `tests/net.rs`: two tc-net clients over WebSockets, the log replayed to
  the live hash; and `createNet` through vitest (`src/net/sim-interop.test.ts`,
  `pnpm test:sim-interop`), skipped where node or `node_modules` is
  missing.
