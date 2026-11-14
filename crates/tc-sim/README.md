# tc-sim

ThunderClap's authoritative game loop: what a networked game's Rust server
runs, real-time or turn-based. The game brings its rules; tc-sim brings the
clock, the schedule, the log (through `tc-store`) and the connections
(through `tc-net`). A port of Forge Wilds' sim loop, scheduler, timing
wheel, change marks, connection handling, input credit, hot reload,
status (E4a), unlogged bodies, live queries, the entity stream, observers,
rate lanes and multi-round reload (E4b), with the game taken out.

## API

- `Game`: the game's side.
  - Types: `Protocol` (tc-net roles), `Codec` (a tc-store `LogCodec`; its
    `Event` is what the log records), `Scheduled` (a `Wire` event the game
    schedules), `Change` (an ordered change-mark key), `Data` (what a
    reload rebuilds it from), `Body` (a present player's unlogged state),
    `View` (one thing in the entity stream, a schema struct).
  - State changes only in `apply(event, cx)`, `fire(scheduled, cx)` and
    `step(cx)` (when `steps()`); `Cx` gives the time, the schedule and the
    change marks.
  - Clients only read it: `join` (a `Seat`: a player or an observer),
    `presence`, `command`, `message` return events to log; `input` moves
    the body (unlogged); `welcome`, `greet`, `player_state`,
    `flush(changes, outbox)` and `reloaded` say what to send.
  - What clients watch: `queries()` (`Query::new(name, doc, player, run)`,
    `run(&QueryCtx, args)`), `interest` (may a connection watch it) and
    `entities(cx, interest, out)`. A `QueryCtx` records what a run read:
    `read(change)`, `body(player)`, `valid_until(time)`, `volatile()`.
    `schema()` (default `schema_of`) is the envelope, the view and the
    queries.
  - `lanes()` and `lane(msg)`: rate lanes for game messages.
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
  control, and queued inputs from the old driver are dropped. Bodies are
  never logged and not in `state_hash`: `presence(false, body)` logs what
  should last; a reload keeps them.
- Live queries (ported from Forge's sync layer): one run per (query,
  arguments, player if `player`), shared by every subscriber; rerun at a
  flush only when a key or body it read changed, it expired, or (volatile)
  anything changed; an unchanged result sends nothing. Each client gets an
  `Update` (patch, when smaller than the result) or a `Resync`, at the
  latest version: a client over 1 MiB behind is skipped and caught up
  later. Unsubscribed results stay idle `RESUME_GRACE` (60 s) for a
  `resume`. A query that fails sends `QueryFailed` and stays subscribed.
  At most `MAX_SUBSCRIPTIONS` (256) per connection. Debug builds rerun
  clean queries each flush and count `tracking_misses`.
- The entity stream: `SetInterest` (checked by `Game::interest`) makes a
  per-connection `EntityEncoder`; it reruns when its interest or reads
  changed, sending only changed fields; `EntityResync` gets a key frame.
- Observers: welcomed as player 0, never present; commands get
  `command_error`, inputs and game messages are dropped, per-player
  queries refused.
- Lanes: a per-player GCRA budget per lane (`burst`, then one per
  `every`); over it, the message is dropped and `SimStatus.limited` counts
  it.
- The clock is pushed every 5 s and marked in the log every 10 s; clients
  over 1 MiB behind for 30 s are dropped.
- A reload replays the log into the new game on another thread, catches
  up what was logged meanwhile (in another round off the thread when over
  `SWAP_BEHIND` = 256 entries, up to `MAX_ROUNDS` = 8) and swaps it in;
  one at a time, later ones queued. Queries and streams rerun after it.
- Live play and a replay of its log reach the same `state_hash`.

## Tests

- Unit tests: the wheel (against a `BTreeMap`), scheduler order and
  restore, change marks, input credit, the status line.
- `tests/sim.rs` (the tally game in `tests/tally/`, driven by hand): the
  clock at the end of time, a budgeted and a stopped advance, a refused
  event, one driver per body (unlogged), flush before result, a reload, a
  reload in two rounds (a body and a query across it), queued reloads, a
  log replayed to the same hash.
- `tests/sync.rs` (ported from Forge's sync, observe and unlogged tests):
  refused queries and the cap, one run shared by a hundred clients and
  reruns only for what was read, effects before a command's result,
  replacing and idle subscriptions, a resume patched, a slow client
  skipping to the latest, body, volatile and expiring results, the entity
  stream following interest and key frames, observers, lanes.
- `tests/net.rs`: two tc-net clients over WebSockets, the log replayed to
  the live hash; and `createNet` through vitest, including a live query's
  patch and the entity stream (`src/net/sim-interop.test.ts`,
  `pnpm test:sim-interop`), skipped where node or `node_modules` is
  missing.
