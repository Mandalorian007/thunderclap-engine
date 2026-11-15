# tc-admin

The admin side of a ThunderClap game server: a control channel, its
client, backups and a reports directory. A port of Forge Wilds' world
control channel and reports writer, with the game taken out. Most games
get it through `thunderclap-server`, which opens it for them.

## The control channel

`AdminChannel::open(dir, live, stop)` listens on a free loopback TCP port
(no Unix socket, so it is the same on Windows) and writes
`admin.endpoint` into `dir`, the directory whose `tc_store::StoreLock` the
server holds: its pid, port, protocol version and a 256-bit token, written
through a temporary file and renamed, owner-only on Unix. Whoever can read
the file can control the server; no one else can.

Each connection carries one JSON line each way:

```text
{"admin":2,"token":"…","request":{"type":"revoke","name":"ada"}}
{"admin":2,"reply":{"type":"revoked","name":"ada","generation":2,"closed":1,"closing":0}}
```

| Request | What it does | Reply |
| --- | --- | --- |
| `status` | the loop's published status, its players (`PlayerBrief`: id, name or both), the network's counters, and the game's own (`Status.game`, from `Live.status`) | `Status` |
| `stop` | sets the server's stop signal | `Stopping { already }` |
| `pause`, `resume` | the game's clock (tc-sim) | `Clock { paused, time }` |
| `reload` | reads the game's data again and hot-reloads it (tc-sim) | `Reloaded` |
| `backup { out? }` | an online copy of the store (tc-store), into `out` or `backups/<unix>`, the newest `keep` kept | `BackedUp` |
| `revoke { name }` | ends every token the name holds (tc-auth); its sessions close with 4001 | `Revoked { generation, closed, closing }` |
| `reports { since?, kind? }` | the reports held, this run's counts, and the game's own numbers (`extra`) | `Reports` |
| `game { name, args }` | the game's own request (`GameRequests`) | `Game(value)` |

A request the game doesn't do (a loop with no clock or no data to
reload, no store to back up, no tokens to revoke) is `Unsupported {
request, why }`: nothing changed, and the CLI says so. A wrong token or
version, a garbled or overlong line (16 KiB), a stopped loop or a step
that failed is `Refused`; a request type this build doesn't know is
`Unknown`. At most
eight connections are open at once; a caller that sends nothing for five
seconds is dropped.

`Live` is what the channel drives:

- a `SimControl`: `SimControls { handle, data }` over tc-sim's
  `SimHandle` (`data` the reload's loader), or a game's own loop, which
  implements `status` and whichever of `pause`, `resume` and `reload` it
  has (the rest answer `ControlError::Unsupported`), and `players` to
  name its players (by default tc-sim's ids with `SimStatus.names`);
- the network's `IoCounters`;
- a `Revoke`: `SessionRevoke::new(session_auth, live_tokens)` moves the
  name's generation on and waits up to `REVOKE_WAIT` for the sessions
  (`tc_auth::LiveTokens`, filled by its Hello hook) to close, counting
  them; a game's own returns a `tc_auth::Revoked` too;
- `Backups`;
- a `ReportsSource`: `Reports`, or reports the game keeps its own way
  (`held`, which may refuse a kind it doesn't know; `counts`; `extra`,
  its own numbers, such as per player or per build, in the reply);
- `GameRequests`, and `GameStatus` for `Status.game`.

Each but the loop is optional; a request for a missing one is
`Unsupported` (a missing `ReportsSource` answers `kept: false`).

`ask(dir, &request)` is the blocking client a CLI calls. It asks only the
process holding `dir`'s lock, and only if the endpoint file names its pid,
so a file a crashed server left is never used (`AdminError::NoChannel`).

## Reports

`Reports::open(dir, ReportsConfig)` writes `Report`s (who, a kind the game
names, text, JSON fields, an optional JPEG) as
`<unix>-<from>-<kind>[-n].json` on a thread of its own, so the loop never
waits on the disk: at most 16 wait, larger than 256 KiB are dropped. The
directory keeps itself: reports older than two weeks go at start and daily,
and past 64 MiB the oldest go down to three quarters of it. `held(dir,
since, kind, n)` lists them by name. `ReportsConfig.rate` (`ReportRate {
burst, every }`, off by default) gives each sender a budget; reports over
it are dropped and counted as `rate_limited`. What a game keeps with a
report (its builds, the game's time and version, the client's numbers)
goes in `Report.fields`.
