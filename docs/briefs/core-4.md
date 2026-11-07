# Brief: ws/core-4

Read `docs/briefs/common.md` first. Then read the ws/core-3 and ws/input-8 rows and notes in `docs/STATUS.md`, and the two wishes this closes: *export `seedKey`* (core-3) and *`createGame` builds and advances a tick clock* (input-8). Then read `src/core/{random,game,index}.ts` and their tests, `src/index.ts`, `src/input/README.md` *Clock*, and the `src/input` clock files that input-8 added.

## Goal

A game started with `createGame` gets deterministic input timing for free, and games can derive stable hashes from the same key the engine uses.

STATUS row, *done when*:

- **`seedKey` exported.** It is exported from `@thunderclap/engine/core` with a doc comment, and its value is unchanged (the existing FNV tests pin it). Add it to the core README types list.
- **Game tick clock.**
  - `createGame` builds one `createTickClock()` and advances it by the fixed step before each fixed update. It is exposed as `game.clock` (an `InputClock`).
  - If the game builds gestures or look through the engine's input wiring, they receive that clock. If they are user-built, the README says to pass `{ clock: game.clock }`.
  - A paused game does not advance the clock.
  - Unit test: N fixed steps advance `game.clock.now()` by exactly N × step. A pause advances it by 0.
  - Unit test: a long-press recorded under `createGame` replays on the same tick at double speed. If input-9's playback-speed fix is not on main, test at 1× only and say so.
- **No behaviour change for existing games.** The 2D harness stays pixel-identical. `game.html` and every template spec stay green.
- **Docs.** A core README section, the types list, one CHANGELOG line, and one ARCHITECTURE sentence in the core clause.

## Files owned

You own:
- `src/core/**`
- `src/index.ts` (append only)
- `CHANGELOG.md`
- the one ARCHITECTURE sentence

Do not edit:
- `src/input/**` (ws/input-9 runs alongside; consume its public exports only)
- `demos/**`
- `templates/**`

Branch from `main` (bd73c67 or later). Use `E2E_PORT_OFFSET=1040`. Gate per E-031: check, snap, and `core2`, `lifecycle`, `templates`, `replay` and `gestures` each run alone.
