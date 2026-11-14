# Arena: the 2D server template

Tag, for two to eight players on one server. Everyone moves in a box; one player is "it" and
passes it on by touching someone. The server (Rust, served by the engine's `thunderclap-server`)
decides every move; each page moves its own player at once by running the same rules, and draws
the others a little in the past, smoothly. Start here for any real-time game a server owns: an
arena, a racer, a co-op room.

## Run

```sh
pnpm install
pnpm dev        # the server (cargo, ws://127.0.0.1:4711) and the client (http://127.0.0.1:4710)
pnpm server serve      # the server alone; `pnpm server status` (stop, pause, backup, ...) asks it
pnpm test       # Vitest: the client's copy of the rules, and the schema hash
pnpm check      # tsc, Biome, Vitest, then cargo test for the server
pnpm build      # the static client in dist/; pnpm build:server for the server binary
```

Open the client in two windows (`?name=ada`, `?name=bo` to choose names: lower_snake, 2 to 24
characters; the page signs in as the dev guest `guest:<name>`). `?server=ws://host:port`
points a page at another server; `pnpm dev` passes the server's address to the page for you
(`CLIENT_PORT` and `SERVER_PORT` change the ports).

The server needs Rust. A copy made by `pnpm create-game` names `thunderclap-server` by git tag
(`server-v<major>.<minor>`) in `server/Cargo.toml`, so it builds on its own; the template inside
the engine names it by path (`../../../crates`).

In the engine repo: `pnpm template:arena-2d-server` from the root.

## Edit these first

- `shared/rules.json`: the numbers both sides read (arena size, speed, reach) and the step cases
  both sides test against.
- `server/src/game.rs`: the game. `step` moves a player; `Arena` (a `tc_sim::Game`) seats
  players, keeps the score, passes "it" on, and says what each page sees.
- `src/rules.ts`: the client's copy of `step`. It must give the same answer as the server's
  (`src/rules.test.ts` and `server/tests/arena.rs` both check the shared cases).
- `src/schema.ts`: the messages, generated from `game.rs`'s types (`TC_BLESS=1 cargo test` in
  `server/` rewrites it and `shared/schema-hash.txt`); never edit it by hand. `src/types.ts` holds
  the TypeScript shapes the page reads.
- `src/main.ts`: the page: connect, predict, draw.
- `CLAUDE.md`: the whole template and every engine noun it uses, for you or an agent.

## Engine guides

- [Getting started](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/getting-started.md)
- [Write a server game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/server-game.md)
- [Make a 2D game](https://github.com/Mandalorian007/thunderclap-engine/blob/main/docs/guide/2d-game.md)
