# ThunderClap's Rust crates

The server side of `@thunderclap-engine/engine/net`: a Cargo workspace
(root `Cargo.toml`, toolchain in `rust-toolchain.toml`). No game nouns live
here; a game depends on these crates by path or git and fills the protocol
with its own types.

| Crate | What it is |
| --- | --- |
| `tc-wire` | The wire format. `Wire` (encode, decode, describe) for scalars, `String`, `Bytes`, `Vec`, `Option`, `BTreeMap` and `Fixed` (32.32); `#[derive(Wire)]` for structs, newtypes and enums, type parameters included (`Page<Slot>` is named `PageSlot`). `SchemaBuilder` collects roots and queries into a `Schema`: canonical text, its stable hash (SplitMix64, the same as `src/net/schema.ts`), `diff`/`patch` of query results, strict `DecodeError`s. |
| `tc-wire-derive` | The `#[derive(Wire)]` proc macro; use it through `tc_wire::Wire`. |
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

The `tests/forge/` fixtures are data from a game, kept as a test; they are
excluded from biome.

## Checking

`pnpm check:rust` (part of `pnpm check`) runs `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets -- -D warnings` and
`cargo test --workspace`; it skips with a notice where cargo is absent.
Nothing here is platform-specific: the crates build on native Windows.
