# thunderclap-server

A ThunderClap game server in one crate: the game brings a `tc_sim::Game`,
this wires the rest.

```rust
fn main() {
    std::process::exit(thunderclap_server::cli::main(std::env::args(), || {
        thunderclap_server::Server::builder(MyGame::new())
            .build("my-game 1.0")
            .reload_with(|| load_data().map(std::sync::Arc::new))
    }));
}
```

`examples/tally.rs` is this for tc-sim's tally test game.

## What `start` and `run` do

Under the data directory (`./data` by default):

- `store/`: the event log (tc-store). Created the first time with the
  builder's `meta`; opened and replayed after, its archive and
  `recovered/` tidied first (`ArchivePolicy::default()`: a week, 1 GiB).
  The admin channel's `admin.endpoint` lives here, beside the lock.
- `accounts/`, `auth.secret`: under `AuthMode::DevGuests` (the default),
  session tokens (tc-auth `SessionAuth` with guests) over file accounts,
  signed with a secret made once. `Running::auth()` issues tokens;
  `AuthMode::Open` takes any token as the name; `AuthMode::Custom` brings
  the game's own.
- `backups/<unix>`: the admin channel's and the CLI's backups, the newest
  five kept (`keep_backups`).
- `backups/auto/<unix>` and `last-open` (`LAST_OPEN_FILE`): with
  `backup_on_new_build(keep)`, the store is backed up before it opens
  under a build other than the last one (`Running::open_backup()`), the
  newest `keep` kept; a failed backup is logged and the store opens
  anyway.

The game is served by tc-net on loopback and a free port unless
`host`/`port` say otherwise (`net(|config| …)` changes the rest). `run`
makes its own runtime and serves until the admin channel's `stop`, a
signal (Ctrl-C or SIGTERM on Unix; Ctrl-C, Ctrl-Break or the console
closing on Windows), a `server.stop` file (`STOP_FILE`) in the data
directory, or the loop ending (a panic, logged: `run` returns an error).
A second signal after `REPEAT_GRACE` (1 s) exits at once with
`EXIT_FORCED` (130). Then it closes the channel, the sessions, the loop
(its log flushed) and the reports. `start` is the same inside a caller's
runtime, returning `Running` (`addr`, `store_dir`, `auth`, `sim`,
`stopped`, `loop_ended`, `open_backup`, `stop`).

The game hooks in with `game_status(fn)` (its own JSON in the admin
`Status`: names, counts), `on_started(fn(&Running) -> guard)` (announce
itself, start writers; the guard is dropped at stop), and
`watch(paths, WatchConfig)` for dev: the paths are polled (`poll`, 100 ms),
and once they have been quiet for `quiet` (300 ms) the data is loaded
again through `reload_with` and hot-reloaded; each try is logged and
handed to `WatchConfig::on_reload` (`WatchEvent { changed, result }`). A
failed load leaves the game running on the data it had.

`generate_ts::<G>(out, &config)` writes the client TypeScript from
`G::schema()` (tc-tsgen), leaving unchanged files alone. A protocol with
its own `Protocol::ENVELOPE` gets the matching `envelope` in `schema.ts`
(`define_schema_ts_with(schema, net_import, envelope)`).

## The CLI

`cli::main(args, make)` returns an exit code (0 done, 1 failed or refused,
2 usage). Every command takes `--data DIR`. A game with commands of its
own builds a `cli::Cli` instead:

```rust
Cli::new(make)
    .command(Command::new("count", "count WORDS.. [--twice]", |inv| {
        Ok((inv.words().len() * if inv.flag("twice") { 2 } else { 1 }).to_string())
    }).words(1, 9).flags(&["twice"]))
    .command(Command::ask_game("where", "where NAME", "where").words(1, 1))
    .serve_options(&["seed"], &["fresh"], "[--seed N] [--fresh]", |b, given| Ok(b))
    .main(std::env::args())
```

A `Command`'s run gets an `Invocation` (the `Given` words, options and
flags; `builder()`; `ask(&Request)` and `ask_game(name, args)` of the
running server). `Command::ask_game` sends what was given (`Given::json`)
as the game's request. `serve_options` adds options and flags to `serve`,
applied to the builder before it starts. A command named like a built-in
replaces it.

| Command | |
| --- | --- |
| `serve [--host H] [--port N]` | `run` |
| `status`, `stop`, `pause`, `resume`, `reload` | asks the running server |
| `revoke NAME` | ends NAME's tokens; its sessions close with 4001 |
| `reports [--kind K] [--since UNIX]` | the reports it holds |
| `backup [--out DIR]` | through the server if one runs, else offline |
| `rollback (--seq N \| --time T \| --wall UNIX) [--copy DIR]` | the stopped store, in place unless `--copy` |
| `gen OUT` | `generate_ts` with the default config |
