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
{"admin":1,"token":"…","request":{"type":"revoke","name":"ada"}}
{"admin":1,"reply":{"type":"revoked","name":"ada","generation":2}}
```

| Request | What it does | Reply |
| --- | --- | --- |
| `status` | the loop's published status, the network's counters | `Status` |
| `stop` | sets the server's stop signal | `Stopping { already }` |
| `pause`, `resume` | the game's clock (tc-sim) | `Clock { paused, time }` |
| `reload` | reads the game's data again and hot-reloads it (tc-sim) | `Reloaded` |
| `backup { out? }` | an online copy of the store (tc-store), into `out` or `backups/<unix>`, the newest `keep` kept | `BackedUp` |
| `revoke { name }` | ends every token the name holds (tc-auth); its sessions close with 4001 | `Revoked { generation }` |
| `reports { since?, kind? }` | the reports held, and this run's counts | `Reports` |
| `game { name, args }` | the game's own request (`GameRequests`) | `Game(value)` |

A wrong token or version, a garbled or overlong line (16 KiB) is
`Refused`; a request type this build doesn't know is `Unknown`. At most
eight connections are open at once; a caller that sends nothing for five
seconds is dropped.

`Live` is what the channel drives: a `SimControl` (`SimControls { handle,
data }` over tc-sim's `SimHandle`, `data` the reload's loader), the
network's `IoCounters`, a `Revoke` (implemented for
`tc_auth::SessionAuth`), `Backups`, `Reports` and `GameRequests`. Each but
the loop is optional; a request for a missing one is refused.

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
since, kind, n)` lists them by name.
