# ThunderClap's Rust crates

The server side of `@thunderclap-engine/engine/net`: a Cargo workspace
(root `Cargo.toml`, toolchain in `rust-toolchain.toml`). No game nouns live
here; a game depends on these crates by path or git and fills the protocol
with its own types.

| Crate | What it is |
| --- | --- |
| `tc-wire` | The wire format. `Wire` (encode, decode, describe) for scalars, `String`, `Bytes`, `Vec`, `Option`, `BTreeMap` and `Fixed` (32.32); `#[derive(Wire)]` for structs, newtypes and enums, type parameters included (`Page<Slot>` is named `PageSlot`). `SchemaBuilder` collects roots and queries into a `Schema`: canonical text, its stable hash (SplitMix64, the same as `src/net/schema.ts`), `diff`/`patch` of query results, strict `DecodeError`s. |
| `tc-wire-derive` | The `#[derive(Wire)]` proc macro; use it through `tc_wire::Wire`. |
| `tc-net` | The server connection layer, generic over a game's `Protocol` (its role types). `ClientMsg<P>`/`ServerMsg<P>`, the envelope `src/net/envelope.ts` defines, with the same variants, encoding and schema text (`schema_builder::<P>()` starts a game's schema). `Server::start(ServerConfig, Sender<Request<P>>)` binds a WebSocket listener (port 0: a free one), runs a session per connection and hands the game `Connect` / `Client` / `Disconnect` requests on one channel; the game answers on each connection's `Outbound` (a priority lane and a bulk lane). A session checks `Hello` (schema hash, else `Rejected` with `stale_schema`; the token through `Auth`, `AllowAll` for dev), rate-limits messages, packs the bulk lane into `Bulk` messages (deflated over 1 KiB on a thread pool) and paces it to the link from the client's `Ack`s, and closes with `Closed` (4000–4999 final, others reconnect). Also `EntityEncoder` (the entity stream, as `src/net/entities.ts`), `WallClock`, origin checks, ping and pong timeouts. Ported from Forge Wilds' server with its nouns removed. |
| `tc-tsgen` | TypeScript from a `Schema`: `generate(&schema, &Config)` returns `(path, contents)` pairs, the protocol module (types, codecs, `TYPES`, query descriptors) and, with `Config::sdk`, the SDK's pass-through event files. The header, imports, hash doc, constants and event lists are the game's. |

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

The `tests/forge/` fixtures are data from a game, kept as a test; they are
excluded from biome.

## Checking

`pnpm check:rust` (part of `pnpm check`) runs `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets -- -D warnings` and
`cargo test --workspace`; it skips with a notice where cargo is absent.
Nothing here is platform-specific: the crates build on native Windows.
