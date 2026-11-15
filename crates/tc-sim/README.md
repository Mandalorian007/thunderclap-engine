# tc-sim

ThunderClap's authoritative game loop: what a networked game's Rust server
runs, real-time or turn-based. The game brings its rules; tc-sim brings the
clock, the schedule, the log (through `tc-store`) and the connections
(through `tc-net`). A port of Forge Wilds' sim loop, scheduler, timing
wheel, change marks, connection handling, input credit, hot reload,
status (E4a), unlogged bodies, live queries, the entity stream, observers,
rate lanes and multi-round reload (E4b), and the live side of its loop
(E11: live stepping, wall-clock timers, streams that follow the body),
with the game taken out.

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
  - `save()` / `restore(bytes)` (default: none): the state for a base.
  - Live play (E11; every hook defaults to nothing): `live()` (true while
    there is unlogged work every step), `live_step(&mut self, cx)` after
    each step while live, `wake(&mut self, cx)` when a wall-clock wake is
    due, `act(&mut self, cx, player, command)` (the default calls
    `command`, which now defaults to a refusal), `follow(player, body)`
    (the entity stream's interest from the body). A `LiveCx` gives
    `time`, `since`/`skipped` (the last live step, to catch up after a
    jump), `version`, `now` (the wall clock), `body`/`body_mut`/`bodies`,
    `events`/`push` (logged as one batch after the hook), `out` (sent once
    that batch applied; for `act`, before the result), `wake_at` and
    `mark(change)`.
- `Core<G>`: the deterministic part: the game, time (integer steps, at
  most `MAX_TIME` = 2^53 − 1), version (last entry applied), `Scheduler`
  (on a hierarchical `TimingWheel`) and `Changes`. `advance_to`,
  `advance_while`, `apply`, `replay`, `Core::replayed`, `state_hash`;
  `to_base()` / `Core::from_base(game, bytes, check)` (the time, version,
  schedule, state hash and the game's bytes, checksummed).
- `Sim<G>`: a core served on the wall clock. `create` / `open` (a tc-store
  directory, the log replayed) or `new(core, None, config)` (in memory).
  `handle(Request)`, `tick(now)`, `deadline()`, `pause`, `resume`,
  `advance(steps)` (sliced, within `ADVANCE_BUDGET`, stops on
  `stopping()`), `reload(data, reply)`, `stop()`. Bases:
  `SimConfig::{base_every, archive}`, `start_base`, `finish_base`,
  `base_pending`, `bases_written`, `opened_from_base`. `spawn()` runs it on a
  thread: `Running { requests, handle, thread }`; hand `requests` to
  `tc_net::Server::start`; `SimHandle` sends `Control`s.
  `query(name, args, player)` / `query_as` run a live query once;
  `counters()` (`SimCounters`: ticks, steps, live steps, wakes, commands,
  inputs, flushes, entity runs and frames, batches, events, live misses,
  microseconds per phase; `since(earlier)`), `next_wake()`,
  `live_time()`. `SimConfig::verify_live` (debug builds) hashes the game
  around every live hook; `SimConfig::entities_on_input` sends the entity
  frames of moved bodies right after the input tick;
  `SimConfig::close_slow_senders` closes a command's sender that is over
  its byte budget with query effects still to send instead of answering
  it (off by default). `Game::after_batch(&self, batch, events, out)`
  runs rules on each batch's change marks: its events join the batch
  (logged right after it, before the result, not rerun on replay).
  Counters add `entity_splits`, `rule_batches` and `closed_slow`.
- `Driver<G>`: a sim run by hand with in-process connections, for tests,
  bots and tools; `Driver::query` runs a query once.
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
  later. A query with a view (`Query::with_view`, from a `ViewCx`: the
  game, player and the connection's interest) is shared per (…, view);
  `QueryCtx::view` reads it, and a subscription whose view changes with
  the interest, the followed body or a reload moves to the new view's
  run and gets a patch. Entity views are encoded once per change for
  every stream (`tc_net::ViewCache`). Unsubscribed results stay idle `RESUME_GRACE` (60 s) for a
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
- Live play (E11): while `Game::live` holds the loop steps one step at a
  time and calls `live_step` after each; otherwise it jumps between
  scheduled events. A dev `advance` runs no live steps (the next sees the
  gap in `since`). Live hooks change only the game's unlogged, unhashed
  fields; what should last is pushed as events and logged at the hook's
  time, so a replay, a reload and a restart start with no live state and
  apply the outcomes. With `verify_live` a hook that changed the hashed
  state counts in `SimCounters::live_misses` (warned once). `wake` runs on
  the wall clock even while paused, and `deadline()` includes it and the
  next live step. No live hook runs once the store failed (a command then
  gets `command_error`). The loop's input tick, live hooks and entity runs
  reuse scratch buffers: an idle live step allocates nothing.
- A followed stream (`Game::follow` returns `Some`): each of the player's
  connections gets one at join, its interest re-derived when the body
  moves (resent only when it changed); `SetInterest` is checked but
  doesn't move it.
- Bases (E8): a game whose `save` returns bytes gets one every
  `base_every` entries (`BASE_EVERY` = 100,000). tc-store's background
  thread prepares the next generation; the loop rotates to it and encodes
  the base in the same tick; the background thread makes the old
  generations durable, writes the base and prunes to `KEEP_BASES` (2); once
  the rotation's clock mark is on disk it archives the log behind the
  older base (`tidy`, by `SimConfig::archive`). `stop` finishes a base
  under way. `open` restores the newest base whose checksum holds
  (checking its state hash) and replays the tail, falling back to the base
  before it, then the whole log; a reload restores the newest base into
  the new game and replays the tail.

## Tests

- Unit tests: the wheel (against a `BTreeMap`), scheduler order and
  restore, change marks, input credit, the status line.
- `tests/sim.rs` (the tally game in `tests/tally/`, driven by hand): the
  clock at the end of time, a budgeted and a stopped advance, a refused
  event, one driver per body (unlogged), flush before result, a reload, a
  reload in two rounds (a body and a query across it), queued reloads, a
  log replayed to the same hash.
- `tests/bases.rs`: opening from the newest base with a scheduled event
  pending, older bases pruned and the log archived, a damaged base falling
  back, a game without bases, a reload from a base.
- `tests/sync.rs` (ported from Forge's sync, observe and unlogged tests):
  refused queries and the cap, one run shared by a hundred clients and
  reruns only for what was read, effects before a command's result,
  replacing and idle subscriptions, a resume patched, a slow client
  skipping to the latest, body, volatile and expiring results, the entity
  stream following interest and key frames, observers, lanes.
- `tests/fit.rs` (the field game in `tests/fit_game/`, shaped like a busy
  real-time world: live drifters near players taking tokens, a wall-clock
  cooldown and a channel that ends in a teleport): live steps only while
  live, a jump seen in the next live step, live outcomes logged and the
  log reopened to the same hash, a wake while paused, news before a
  command's result, the stream following the body, frames at the input
  tick, `verify_live`, one-shot queries, an idle live tick that only
  steps.
- `tests/net.rs`: two tc-net clients over WebSockets, the log replayed to
  the live hash; and `createNet` through vitest, including a live query's
  patch and the entity stream (`src/net/sim-interop.test.ts`,
  `pnpm test:sim-interop`), skipped where node or `node_modules` is
  missing.
