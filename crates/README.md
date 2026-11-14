# ThunderClap's Rust crates

The server side of `@thunderclap-engine/engine/net`: a Cargo workspace
(root `Cargo.toml`, toolchain in `rust-toolchain.toml`). No game nouns live
here; a game depends on these crates by path or git and fills the protocol
with its own types.

| Crate | What it is |
| --- | --- |
| `tc-wire` | The wire format. `Wire` (encode, decode, describe) for scalars, `String`, `Bytes`, `Vec`, `Option`, `BTreeMap` and `Fixed` (32.32); `#[derive(Wire)]` for structs, newtypes and enums, type parameters included (`Page<Slot>` is named `PageSlot`). `SchemaBuilder` collects roots and queries into a `Schema`: canonical text, its stable hash (SplitMix64, the same as `src/net/schema.ts`), `diff`/`patch` of query results, strict `DecodeError`s. |
| `tc-wire-derive` | The `#[derive(Wire)]` proc macro; use it through `tc_wire::Wire` or `thunderclap_server::Wire`. Its code names `::tc_wire`, or `::thunderclap_server::wire` in a crate that depends on the facade and not on tc-wire; `#[wire(crate = "path")]` names another path. |
| `tc-net` | The server connection layer, generic over a game's `Protocol` (its role types). `ClientMsg<P>`/`ServerMsg<P>`, the envelope `src/net/envelope.ts` defines, with the same variants, encoding and schema text (`schema_builder::<P>()` starts a game's schema). `Server::start(ServerConfig, Sender<Request<P>>)` binds a WebSocket listener (port 0: a free one), runs a session per connection and hands the game `Connect` / `Client` / `Disconnect` requests on one channel; the game answers on each connection's `Outbound` (a priority lane and a bulk lane). A session checks `Hello` (schema hash, else `Rejected` with `stale_schema`; the token through `Auth`, `AllowAll` for dev), rate-limits messages, packs the bulk lane into `Bulk` messages (deflated over 1 KiB on a thread pool) and paces it to the link from the client's `Ack`s, and closes with `Closed` (4000–4999 final, others reconnect). Also `EntityEncoder` (the entity stream, as `src/net/entities.ts`), `WallClock`, origin checks, ping and pong timeouts. Ported from Forge Wilds' server with its nouns removed. |
| `tc-auth` | Accounts and auth on tc-net's `Auth` seam. `Accounts` (a `Record` per name: account id, generation, created and last-seen times; `claim` with one name per account, `seen`, `subscribe`) with `MemoryAccounts` and `FileAccounts` (one `names.json` with a backup, a writers' lock and recovery by itself; a log-backed store plugs in at the same trait). `SessionAuth`: signed session tokens `<prefix>.<name>.<perms>.<generation>.<hex HMAC-SHA256>` (`issue`, `check`/`verify`, `revoke`, `revisions()`, so tc-net closes sessions on a revoked token with 4001), and a dev guest mode (`with_guests`). `DevTokens`: signed tokens with no store. Name rules (`NameRules`), prefixes, permissions and the player-facing reasons are the game's (`TokenFormat`). Ported from Forge Wilds' sign-in, which is `TokenFormat` with `fw1`/`fw2`, `dev` and `observer`. |
| `tc-tsgen` | TypeScript from a `Schema`: `generate(&schema, &Config)` returns `(path, contents)` pairs, the protocol module (types, codecs, `TYPES`, query descriptors) and, with `Config::sdk`, the SDK's pass-through event files. The header, imports, hash doc, constants and event lists are the game's. |
| `tc-store` | The event-log store (E3a): `Log<C: LogCodec>` appends a game's events to `main.log` or per-key files, with batches all or none, clock marks written on an I/O thread once what they cover is durable, log generations (`prepare`, `rotate`, `open_from`), crash recovery (gap-free prefix, torn tails cut and kept in `recovered/`), a game's bases (`write_base`, `bases`, `read_from`, E8) and a directory lock. Syncs go through writable handles, so native Windows works. See `tc-store/README.md`. |
| `tc-sim` | The authoritative game loop (E4a): a `Game` trait (state changed only by logged events, scheduled events and steps), `Core` (integer time, the `Scheduler` on a `TimingWheel`, `Changes`, `state_hash`), and `Sim`, which serves a core to `tc-net` connections on the wall clock, logs through `tc-store`, flushes change marks, paces inputs, keeps one driver per player, reloads the game's data live (in rounds when far behind) and publishes a status. E4b adds unlogged player bodies, live queries (`Query`, `QueryCtx`), the entity stream per interest, observers (`Seat`) and rate lanes (`Lane`). `Driver` runs one in-process. See `tc-sim/README.md`. |
| `tc-stream` | The section stream (E5): a game's world sent per connection in sections by interest area (`Area`, radii per axis with hysteresis), nearest first, through a shared LRU cache with stamps; changes as `Edit`s of cells or whole sections, folded into a still-queued frame; `Unload` batches; build budgets and round robin; resume from a client's `Claim`s after a reconnect and after `reload`. The game supplies a `SectionSource` (voxel or 2D tiles); `Lanes` is tc-net's `Outbound`s. See `tc-stream/README.md`. |
| `tc-admin` | The admin side of a server (E6): `AdminChannel` listens on a loopback TCP port (native on Windows) whose port and 256-bit token are in `admin.endpoint` (owner-only on Unix) beside the store's lock; one JSON line in (`Request`: status, stop, pause, resume, reload, backup, revoke, reports, a game's own), one out (`Reply`). It drives tc-sim (`SimControls` over a `SimHandle`, a reload's data from a loader), tc-store (`Backups`: an online copy into `backups/<unix>`, the newest five kept) and tc-auth (`Revoke` for `SessionAuth`). `ask(dir, &request)` is the blocking client, trusting only the lock holder's file. `Reports` writes players' reports on a thread of its own into a directory kept to two weeks and 64 MiB. |
| `thunderclap-server` | The facade (E6): `Server::builder(game)...start()`/`.run()` opens or creates the store under a data directory (tidying its archive), runs the loop, serves it through tc-net and opens the admin channel, with dev defaults: loopback, `AuthMode::DevGuests` (session tokens over `FileAccounts` in `data/accounts`, a secret made once, guests), backups kept to five. `generate_ts::<G>(out, &config)` writes the client TypeScript (tc-tsgen); `cli::main(args, make)` is a game binary's command line: `serve`, `status`, `stop`, `pause`, `resume`, `reload`, `revoke`, `reports`, `backup` (through the server or offline), `rollback` and `gen`. Re-exports the crates. |

## Format

LEB128 varints, zigzag for `i32`/`i64`, `Fixed` as its zigzag `i64` bits,
one tag byte for `bool` and `Option`, a length before `String`, `Bytes`,
`Vec` and `BTreeMap` (keys strictly ascending), enums as a varint variant
index. Decoding is strict: trailing bytes, bad tags and unsorted keys fail.

## Parity

- `tc-wire/tests/net.rs` reads `src/net/testdata/` (schema texts and
  hashes, `hash.json`, `fixed.json`) and checks `src/net/testdata/wire-rust.json`,
  which it writes with `TC_BLESS=1` and `src/net/wire-rust.test.ts` decodes
  and re-encodes in TypeScript.
- `tc-wire/tests/forge.rs` runs Forge Wilds' protocol vectors (copied into
  `tests/forge/`): its schema hash, golden values, invalid messages, patches,
  `Fixed` and stamps.
- `tc-tsgen/tests/forge.rs` configures the generator as Forge
  (`tests/forge/config.json`) and reproduces Forge's committed
  `generated.ts` and SDK event files byte for byte.
- `tc-net/tests/interop.rs` runs the echo game (`tests/echo/`, also
  `cargo run -p tc-net --example echo`) on a free port and connects two
  clients over real WebSockets: a Rust one (handshake, stale schema, the
  bulk lane and its acks, shutdown), and `createNet` itself through
  vitest (`src/net/interop.test.ts`: the schema hash, handshake, a command,
  a live query's patch, the entity stream, the deflated bulk lane,
  reconnect, a final close and a stale schema). The vitest part skips with
  a notice where node or `node_modules` is missing; `pnpm test:net-interop`
  runs just this test.
- `tc-auth/tests/auth.rs` runs Forge Wilds' token tests and signature
  vectors through a Forge-configured `TokenFormat`;
  `tc-auth/tests/interop.rs` runs the echo game with `SessionAuth`: a
  session is revoked mid-game and closed with 4001 while others stay, and
  `createNet` (`src/net/auth-interop.test.ts`) ends for good without
  reconnecting.
- `tc-sim/tests/net.rs` serves the tally game (`tests/tally/`) through
  `tc-net` to two Rust clients and replays the log to the live state hash,
  then runs `createNet` against it through vitest (`src/net/sim-interop.test.ts`;
  `pnpm test:sim-interop` runs just this test), skipping where node is missing.
- `tc-stream/tests/interop.rs` streams sections from a game loop on `tc-net`
  to `createNet` filling the voxel `SectionStore` (`src/net/stream-interop.test.ts`;
  `pnpm test:stream-interop`), with resume after a dropped connection.
- `thunderclap-server/tests/admin.rs` serves the tally game through the
  facade (`examples/tally.rs` is the same game as a binary on the CLI): a
  client joins with an issued token, the admin channel's status, pause,
  resume, backup, reload, reports, revoke (the client closed with 4001) and
  stop work end to end, the store reopens, and the CLI backs up and rolls
  back offline.
- `thunderclap-server/tests/turns.rs` serves tc-sim's tic-tac-toe game
  (`tc-sim/tests/turns_game/`, E7) through the facade with dev guests (each
  page picks its name with the token `guest:<name>`);
  `createNet` (`src/net/turns-interop.test.ts`) plays a round, watches the
  board and resumes it after a dropped link, and the store replays to the
  live state hash.

The `tests/forge/` fixtures are data from a game, kept as a test; they are
excluded from biome.

## Checking

`pnpm check:rust` (part of `pnpm check`) runs `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets -- -D warnings` and
`cargo test --workspace`, then the same three for each template's server
crate (`templates/<name>/server`, its own workspace); it skips with a notice
where cargo is absent.

## Bounded stores

A game that implements `Game::save` and `Game::restore` gets a base every
`SimConfig::base_every` entries; the live log keeps about two bases' worth
and the rest goes to the archive (`ArchivePolicy`: a week, 1 GiB), so a
long-running server's store stays bounded. The arena does; see
`docs/guide/server-game.md`.

## Versions

The crates share the workspace version (0.3.0). A release is tagged
`server-v<major>.<minor>`, and a game made by `pnpm create-game` depends on
`thunderclap-server` at that tag by git; inside this repo the templates use
path dependencies.
Nothing here is platform-specific: the crates build on native Windows.
