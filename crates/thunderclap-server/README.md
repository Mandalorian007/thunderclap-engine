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

The game is served by tc-net on loopback and a free port unless
`host`/`port` say otherwise (`net(|config| …)` changes the rest). `run`
makes its own runtime and serves until the admin channel's `stop` or
Ctrl-C, then closes the channel, the sessions, the loop (its log flushed)
and the reports. `start` is the same inside a caller's runtime, returning
`Running` (`addr`, `store_dir`, `auth`, `sim`, `stopped`, `stop`).

`generate_ts::<G>(out, &config)` writes the client TypeScript from
`G::schema()` (tc-tsgen), leaving unchanged files alone. A protocol with
its own `Protocol::ENVELOPE` gets the matching `envelope` in `schema.ts`
(`define_schema_ts_with(schema, net_import, envelope)`).

## The CLI

`cli::main(args, make)` returns an exit code (0 done, 1 failed or refused,
2 usage). Every command takes `--data DIR`.

| Command | |
| --- | --- |
| `serve [--host H] [--port N]` | `run` |
| `status`, `stop`, `pause`, `resume`, `reload` | asks the running server |
| `revoke NAME` | ends NAME's tokens; its sessions close with 4001 |
| `reports [--kind K] [--since UNIX]` | the reports it holds |
| `backup [--out DIR]` | through the server if one runs, else offline |
| `rollback (--seq N \| --time T \| --wall UNIX) [--copy DIR]` | the stopped store, in place unless `--copy` |
| `gen OUT` | `generate_ts` with the default config |
