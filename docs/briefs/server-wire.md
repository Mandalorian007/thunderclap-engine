# Brief: ws/server-wire (E1)

Read:
- `common.md`
- `wave-2.0-1.md` (worktree, size and machine rules)
- E-041 and E-042
- `docs/design/2.0/server.md`: all of it, but especially §1 (the crate table: tc-wire, tc-tsgen), §3 (protocol), §5 (E1) and the risks
- `src/net/` (C9, on ws/net head 249ff22, merging now), especially `src/net/testdata/schema.json` and how `defineSchema` hashes

Forge source to extract from (read only):
- `/Users/matthewfontana/repos/forgewilds/crates/forge-protocol`: `wire`, `schema`, `diff`, `bulk`, the stamp hash and `tsgen.rs`, plus the generic half of `tsgen/sdk.rs`
- `crates/forge-core`: `fixed`, `hash`, `wire`
- `crates/forge-macros`
- `testdata/protocol/*`

## Goal

The engine's first Rust: the wire format and TS generation that every networked game shares. server.md *E1 done when*: the TS `defineSchema` parity test passes, meaning Rust and TS produce the same canonical text and hash on C9's vectors.

1. Add a Cargo workspace at the repo root (`crates/`). Its crates:
   - `tc-wire`: `Wire` trait plus derive (with generics), `Schema`, canonical text and the stable hash (SplitMix64, as C9 implemented it), structural diff and patch, `Fixed`.
   - `tc-wire-derive`: the proc macro.
   - `tc-tsgen`: TS types, codecs, the `TYPES` table, query descriptors and event lists, with a configurable header and naming so that Forge's `generated.ts` can be reproduced byte for byte.

   No Forge nouns anywhere.
2. Parity tests:
   - Rust reads `src/net/testdata/schema.json` and matches every hash and canonical text.
   - TS-side vectors produced by Rust are checked by a vitest test.
   - Forge's `testdata/protocol/*` vectors are ported and pass.
3. A fixture test proves that tc-tsgen, configured as Forge, reproduces Forge's current `generated.ts` (byte-identical, or every difference explained). Forge's switch to these crates is a later Forge PR. Don't touch forgewilds.
4. Add a Cargo step to the local gate:
   - `pnpm check:rust` runs `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test`.
   - It is in `pnpm check` and is skipped with a notice when `cargo` is absent.
   - Rust must build on native Windows (no unix-only APIs).
5. Add a `crates/README.md`, an ARCHITECTURE line, a CHANGELOG line and an E1 row in docs/BENCH.md if you bench encode/decode.

## Files owned

- new `crates/**`
- root `Cargo.toml` and `Cargo.lock`, `rust-toolchain.toml` (match Forge's toolchain)
- `package.json`: one `check:rust` script, added to `check`
- the new vitest parity test under `src/net/`

## Size

M, about 4k lines moved. Extract and generalize; don't redesign.

## Gate

common.md, plus `pnpm check:rust` green.
