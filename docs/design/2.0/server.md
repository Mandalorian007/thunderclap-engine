# S0: the server foundation and the net seam

Research for ThunderClap 2.0 step S0 (E-041 decision 2). Read-only survey of Forge Wilds at d38b72ad. Line counts are `wc -l` of `.rs`/`.ts` files and include inline tests unless noted.

**Recommendation in one line:** extract Forge's server as seven small Rust crates behind one `thunderclap-server` facade. A game implements one `Game` trait plus its message enums. The engine owns the wire format, the schema, diffs and TS generation. C9's `net` is Forge's SDK minus the game: transport, session, clock, live queries, entity stream, `SnapshotBuffer` and a generic `Predictor`. Forge moves one crate at a time, each behind byte-identical gates.

**Stale doc to fix:** `docs/design/2.0/architecture.md` §4 (line 707) still lists "net/, SDK, protocol: all of it" as staying in Forge. E-041 overrode that, so the row should be amended.

---

## 1. Forge's Rust: generic engine vs game rules

The workspace is 8 crates and about 360k lines. `forge-sim` (139k) and `forge-core` (92k) are mostly game. `forge-server` (65k, of which `sim/` is 35k and 19k of that is tests) and `forge-protocol` (21k) are mostly engine. The layering is already clean: `docs/engine/server-layers.md` sets 8 layers, enforced by `layers_test`, and `forge-sim/src/store` is the only module allowed to do I/O, enforced by `store::guard`.

### Generic now, or generic after a type parameter

| Concern | Forge path | Lines | Coupling to fix |
|---|---|---|---|
| Transport seam | `forge-server/src/transport.rs` | 64 | none; already "an ordered, reliable stream of binary frames" |
| WebSocket, origin check, ping/pong liveness | `ws.rs`, `origin.rs` | 267, 192 | none |
| Rate limits (token buckets that slow, never refuse) | `rate.rs` | 231 | limits are config |
| Bulk-lane flow control (BBR-style window from `Ack`) | `flow.rs` | 710 | none |
| Deflate pool, priority and bulk lanes, wakes | `deflate.rs`, `outbound.rs` | 286, 609 | none |
| Session (Hello, schema hash, token, forwarding) | `session.rs` | 755 | Hello carries game fields (`opening`, `content`) |
| Auth (HMAC tokens, sign-in links, revocation), accounts | `auth.rs`, `accounts/` | 662, 624 | perms `-`/`dev`/`observer` become a game-declared role set |
| Wall clock (20 Hz, anchored) | `clock.rs`, `sim/clock.rs` | 117, 179 | step length becomes config |
| Admin channel (loopback, token file, JSON lines) | `control/` | 1,084 | request enum gets a `Game(..)` arm |
| Stats, profiling, reports dir | `stats.rs`, `profile.rs`, `reports.rs` | 336, 40, 604 | report fields |
| Sim thread loop, deadlines, flush timer, slow-client budgets | `sim/run.rs`, `sim/flush.rs`, `sim/owner.rs` | 338, 264, 329 | `Sim` owns `forge_sim::World`, which becomes `G` |
| Connections, presence, one driver per body, watchers | `sim/conn.rs`, `sim/observe.rs`, `sim/unlogged.rs` | 585, 198, 92 | none of note |
| Compaction scheduling, status, hot content reload | `sim/compaction.rs`, `sim/status.rs`, `sim/reload.rs` | 581, 229, 392 | reload calls `forge_sim::Rebuild`, which needs a trait |
| Server-authoritative input queue (seq, credit, stale drop) | `movement.rs`, `movement/` | 628, 392 | the step function is the game's |
| Entity frames (who is due, per-client "shown" diffs) | `sim/entities/` | 998 | the entity set comes from `World` |
| Entity delta codec (quantized positions, field bits, key frames) | `forge-protocol/src/entity/` | about 1,700 | `EntityView`/`Pose` fields (held item, work, behaviour) are Forge's |
| Live queries and sync layer (read-tracking, shared entries, keyed diffs, views) | `query/`, `sync/` | 997, 959 | `ChangeKey` is a Forge enum; `View::Visible` is voxel hiding |
| Interest boxes, hysteresis, unload boxes | `chunks/interest.rs`, `chunks/held.rs` | 517, 339 | 3D chunk boxes, so a voxel-kind foundation |
| Section stream (LRU, stamps, resume, budgets, round robin) | `chunks/{mod,load,edits,cache,resume,frames,stats}.rs` | about 2,150 | the section *source* is the game's |
| Timing wheel, scheduler | `forge-sim/src/wheel.rs`, `scheduler.rs` | 633, 228 | event payload type |
| Change marks | `forge-sim/src/changes.rs` | 517 | key enum is the game's |
| Replay, reload-by-replay | `replay.rs`, `rebuild.rs` | 134, 144 | `World` |
| Work counters, state hash harness | `counters.rs`, `state_hash.rs` | 432, 568 | counter names and hashed state are game |
| Store framing | `forge-sim/src/store/` | 17,628 (about 2,900 tests) | see below |
| Fixed point, stable hash, varints, timelines, ordered maps, strict JSON | `forge-core/src/{fixed,hash,wire,timeline,linear,map,json}.rs` | 515, 234, 178, 80, 181, 221, 294 | none |

**The store in detail.** These parts are generic: log files with checksummed records and name tables (`format/records.rs`, `content.rs`); appends and clock marks proving durability (`writer/`, `durable.rs`, `log_file.rs`); generations and the background thread (`gens.rs`, `background.rs`); recovery, repair and rollback (`load.rs`, `tail.rs`, `recovered.rs`, `repair.rs`, `rollback.rs`); the OS world lock (`lock.rs`); archive, backup and history (`archive/`, `backup.rs`, `history.rs`); and the I/O guard (`guard.rs`). Together that is roughly 9 to 10k lines. The rest is game: entry and outcome codecs dispatching on Forge tags (`format/entry.rs` calls `hunt::codec`, `runes::codec`, `spire::codec`; `format/outcome.rs`), base fact sections (`facts/`, `exact/`), fight journals (`journal.rs`), and `meta.rs`'s seed, generator and sky fields.

**Pure game, which stays in Forge.** Everything else in `forge-core` (content packs, generators, fights, herds, dryads, the Spire) and in `forge-sim` (rules, runes, fluid, wild, floors, raid, and so on). In `forge-server`: `sim/` play families (fight, hunt, spire, tome, guardian, companions, command/*), `api.rs` (the query list), `convert/`, `terrain.rs`, `weather.rs`, `mining.rs`, `chunks/{faces,climate,piles,build}.rs` (hiding ore, climate, piles). Also all of `forge-protocol/src/msg/*` except the envelope variants, `section.rs` (the voxel section codec, which belongs to TC's voxel module, not net), and `forge-core/src/movement*` (1,063 lines, a voxel character controller).

**Tally:** about 25 to 28k lines of Forge's Rust are engine once parameterised. That is about 8% of the workspace and about 45% of `forge-server` plus `forge-protocol` excluding tests.

---

## 2. The `thunderclap-server` package

A Cargo workspace at `server/` in the thunderclap-engine repo, next to the pnpm packages. Forge depends on it by git tag (`server-v0.N`), the Rust twin of the exact `next` prereleases. The crate split follows Forge's layers so `layers_test` carries over.

| Crate | From | Owns |
|---|---|---|
| `tc-wire` | forge-protocol `wire`, `schema`, `diff`, `bulk`, `stamp` (hash part); forge-core `fixed`, `hash`, `wire`; `forge-macros` | `Wire` trait and derive, `Schema`, canonical text and hash, structural diff and patch, `Fixed`, stable hash |
| `tc-tsgen` | `tsgen.rs` (770), the generic half of `tsgen/sdk.rs` | TS types, codecs, `TYPES` table, query descriptors, event lists |
| `tc-net` | transport, ws, origin, rate, flow, deflate, outbound, session, auth, accounts, clock, stats | connections, lanes, handshake, tokens |
| `tc-store` | the generic store above | `Log<C: LogCodec>`, marks, generations, recovery, lock, archive, backup, `BaseWriter<S: BaseSections>` |
| `tc-sim` | wheel, scheduler, changes, sim loop, conn, flush, entities, input queue, query, sync | the one-writer thread, live queries, entity replication |
| `tc-stream` | chunks generic parts, interest | interest shapes, a streamed-section cache with stamps and resume over `SectionSource` |
| `tc-admin` | control, status, reports | loopback admin channel with `Game` arms |
| `thunderclap-server` | facade | re-exports, `Server::<G>::run(config)` |

All dispatch is generic and monomorphised, never `dyn` on hot paths, so Forge's step p99 and allocation budgets (`forge-bench`) carry over.

### What a game implements

```rust
pub trait Game: Sized + Send + 'static {
    type Msgs: GameMsgs;            // game ClientMsg/ServerMsg arms, Hello ext, Command
    type Event: LogEntry;           // logged source events and cached outcomes (Wire + tag)
    type Scheduled;                 // timing-wheel payload, never logged
    type Change: ChangeKey;         // Ord + Hash; what queries and frames key on
    type Entity: Replicated;        // the delta-coded view; Replicated::Key, ::Tick
    type Interest: InterestShape;   // Box3<Chunk>, Cells2, Room(u32), Whole
    type Role: RoleSet;             // perms in tokens

    fn open(store: &mut Store<Self>, cfg: &Self::Config) -> Result<Self, OpenError>;
    fn check(&self, who: PlayerId, cmd: &<Self::Msgs as GameMsgs>::Command) -> Result<(), Reject>;
    fn commit(&mut self, who: PlayerId, cmd: ..., out: &mut Commit<Self>);   // events, schedules, marks
    fn fire(&mut self, at: Time, ev: Self::Scheduled, out: &mut Commit<Self>);
    fn live_step(&mut self, step: u64, inputs: &mut Inputs<Self>, out: &mut Commit<Self>) {} // opt-in
    fn presence(&mut self, who: PlayerId, present: bool, out: &mut Commit<Self>);
    fn entities_in(&self, area: &Self::Interest, f: impl FnMut(Self::Entity));
    fn hash_state(&self, h: &mut StableHasher);        // determinism checks
}
pub trait SectionSource { type Key; fn build(&self, k: Self::Key, out: &mut Vec<u8>) -> Stamp; } // opt-in
```

Queries stay plain functions with `#[query]`, reading through `QueryCtx<G>`, which records `G::Change` keys. The sync layer is unchanged. Forge's `QUERIES` list becomes a `queries![...]` registration the facade takes.

**Opt-in layers.** `live_step` (a fixed live tick only where watched, Forge invariant 7), `SectionSource` with `tc-stream`, and `tc-store`. A game with no persistence passes `Store::memory()`. Each layer is something Forge uses today (VISION rule 6). Nothing on spec is added.

### How other games use it

- **2D co-op arena (4 players, real time).** `Interest = Whole` or `Cells2`; `Entity` = `{pos: Vec2Fixed, vel, anim: u8, hp: u16}` delta-coded by the derive; `live_step` runs at 20 to 30 Hz. The player body uses the generic input queue and `step(state, input)`, written in Rust with a TS twin checked against shared test vectors (Forge's `testdata/movement` pattern, which the engine ships as a harness). The store is in memory or keeps match results only. No sections.
- **Turn-based tactics.** No `live_step` and no entity stream. Commands go `check`/`commit` into the log (so every match is a replayable file, Forge's "every bug report is a replay"). Board state is one `#[query] fn board(ctx) -> Board` whose result the sync layer diffs to each client automatically. `Interest = Room(match_id)`; the timing wheel gives turn timers.

---

## 3. Protocol and schema generation

**What Forge does today.** Rust is the source of truth. `#[derive(Wire)]` (forge-macros, 730 lines) gives each type a codec and a `TypeDef`. `SchemaBuilder` roots at `ClientMsg` and `ServerMsg` and adds `#[query]` defs. `Schema::canonical_text()` is SHA-hashed into the `Hello.schema_hash` check, and a mismatch makes the web client reload once (`apps/web/src/net/recovery.ts`). `forge gen` runs `tsgen` to write `packages/protocol/src/generated.ts` (16,236 lines: types, byte-identical codecs, `TYPES`, `api`) and the SDK's `events.generated.ts` and `pass.generated.ts`. `diff.rs` and `patch.ts` both walk the same schema, so any `Wire` type is diffable with no hand-written code. The format is varint and zigzag, `Fixed` 32.32, strict decoding, and declaration-order enums.

**What the engine owns.** The format, the schema model, the hash, diff and patch, both codec runtimes (`wire.ts` 615 and `patch.ts` 405 move into TC's `net`), the generator, and the **envelope**: the handshake and transport messages every game needs. Of Forge's 15 `ClientMsg` variants, 11 are envelope: `Hello`, `Command{seq, cmd: G}`, `Subscribe`, `Unsubscribe`, `Ping`, `SetInterest`, `Input`, `TakeControl`, `Holding`, `EntityResync`, `Ack`. Of about 50 `ServerMsg` variants, roughly 15 are: `Welcome`, `Rejected`, `CommandResult`, `Update`, `Resync`, `QueryFailed`, `Clock`, `Pong`, `InterestRejected`, `EntityStream`, `PlayerState`, `Control`, `Closed`, `Bulk`, and the section frames under `tc-stream`.

**How game messages are declared and generated.** The game writes `enum MyClient`, `enum MyServer`, `struct MyHello` and `enum MyCommand` with `#[derive(Wire)]`. The engine's envelope is generic (`ClientMsg<G>` with a `Game(G::Client)` arm, `Hello { .., ext: G::Hello }`), and the derive gains type-parameter support. The facade's `schema::<G>()` roots the envelope at `G`, adds the queries, and hashes. `thunderclap-server gen --out <dir>` (a library function the game's CLI calls, as `forge gen` does) writes one `generated.ts` per game that imports the runtime from `thunderclap/net/wire`. A game without a Rust server, such as C9's in-page demo, gets the same schema from a TS builder (`defineSchema({ types, roots })`) that produces the identical canonical text and hash. The schema is the contract, not either language. The TS side can run interpreted (walking `TYPES`, as `patch.ts` already does) or generated, which is faster and is what Forge uses.

**Cost to Forge.** Wrapping game arms in `Game(..)` changes variant indices, so Forge takes **one planned protocol bump** at E2. The schema hash changes and clients reload by themselves, the path `recovery.ts` already handles. Log and base formats are unaffected because they are not wire messages.

---

## 4. The C9 `net` client API

Rule 4: the engine opens nothing. Forge's SDK already has the right seam (`packages/sdk/src/socket.ts`, `SocketFactory = (url, events) => Socket`, injected by tests and wrapped by `apps/web/src/net/liveness.ts`). C9 makes it the only way in.

```ts
interface Transport { send(frame: Uint8Array): void; close(): void; }
interface TransportEvents { open(): void; message(f: ArrayBuffer|Uint8Array): void; close(code: number, why: string): void; }
type Connect = (events: TransportEvents) => Transport;          // the host or game supplies it

const net = createNet({ schema, connect, hello: { token, ext }, reconnect, inflate? });
net.on('welcome' | 'closed' | 'rejected' | ...game events);
net.command(cmd): Promise<Result>;                    // seq-matched CommandResult
net.query('board', args, (value, patch) => ...);      // live query, patch applied
net.setInterest(shape);
net.clock.now();                                      // server-time estimate (Clock/Pong)
net.entities: EntityStream<View>;                     // schema-driven delta decoder, resync on error
net.snapshots: SnapshotBuffer;                        // interpolation, ~100–300 ms adaptive delay
net.predict(stepFn, equal): Predictor<State, Input>;  // send inputs, reconcile on PlayerState
net.optimistic: Optimistic<Key, Value>;               // shadow-and-rollback for predicted edits
inPagePair(): [Connect, Connect]                      // tests and the C9 two-client demo
```

The engine ships `inPagePair` and test fakes. A WebSocket `Connect` is 30 lines in the game, or in a host package (`host-pwa`, `host-electron`), never in `src/`.

**What it generalizes, file by file**

| C9 piece | Forge source | Change |
|---|---|---|
| Transport, reconnect with backoff and jitter | `sdk/src/socket.ts` (`Socket`, `reconnectDelay`), `connection/reconnect.ts` (195) | drop `url` and the default WebSocket |
| Handshake, schema-hash check | `sdk/src/handshake.ts` (141) | Hello `ext` from the game |
| Liveness (quiet ping, page-hidden check) | `apps/web/src/net/liveness.ts` (210) | moves into the session |
| Recovery policy (reload once on schema mismatch) | `apps/web/src/net/recovery.ts` (161) | becomes an event plus a helper; the reload stays the game's |
| Bulk lane, Ack flow control, inflate hook | `connection/receive.ts`, `apps/web/src/net/inflate.ts` (148) | the worker stays the game's, passed as `inflate` |
| Clock | `sdk/src/clock.ts` | step length from `Welcome` |
| Wire and patch runtime | `packages/protocol/src/wire.ts`, `patch.ts` | as is |
| Live queries | `sdk/src/live-queries.ts` (446), `queries.ts` | the generic subscribe and patch half; Forge's friendly result classes stay |
| Entity stream | `sdk/src/entity-stream.ts` (581) | field layout from the schema, not hard-coded kinds |
| SnapshotBuffer | `sdk/src/snapshots.ts` (411) | stride and dimensions configurable (2D or 3D), tick-to-time mapping as is; feeds TC actors' `setRecord` |
| Predictor and Interpolator | `sdk/src/prediction.ts` (683) | generic over `step`, `State`, `Input`; `PlayerBody` and the voxel block window stay Forge's |
| Optimistic edits | `apps/web/src/net/session.ts` (1,040), the edit shadow | extract the keyed shadow; picking, reach and the hotbar stay |
| Resume claims | `sdk/src/chunks/held.ts`, `stamp.ts` | belongs with TC voxel's streamed sections |

Forge's SDK keeps its mineflayer-style façade (`connection.ts`, `content.ts`, `spire.ts`, `fight.ts`, `packages/bot`) on top of `net`, which has no DOM dependency, so bots still run in Node.

**Interest:** `setInterest(shape)` where the shape type is generated from `G::Interest`. Forge's box with hysteresis is one shape; `Room` and `Whole` are trivial.

---

## 5. Phase E step plan

C9 lands first in 2.0 (client half, TS only, two-client demo over `inPagePair` with a scripted TS authority). Phase E is the Rust half. Every E step has the same switch gate for Forge: `forge test` replays' state hashes identical, `testdata/protocol/*` vectors identical, an existing world dir opens, `forge bench` budgets hold, `layers_test` and `store::guard` pass under their new homes, and native Windows builds.

| Step | Size | Depends | Content | Forge switches |
|---|---|---|---|---|
| **E1 tc-wire + tc-tsgen** | M (about 4k moved) | C9 | Wire, derive with generics, schema, hash, diff, Fixed, hash, tsgen; TS `defineSchema` parity test (same canonical text from Rust and TS) | `forge-protocol` re-exports tc-wire; `generated.ts` byte-identical; no wire change |
| **E2 tc-net + envelope** | L (about 6k) | E1 | transport, ws, rate, flow, deflate, outbound, session, auth, accounts, clock; `ClientMsg<G>`/`ServerMsg<G>` | the **one protocol bump**; SDK moves onto TC `net` the same day (paired PRs, one Forge deploy) |
| **E3 tc-store** | L (about 10k, the hardest) | E1 | `Log<C: LogCodec>`, marks, generations, recovery, repair, rollback, lock, archive, backup; engine-reserved tags are exactly the ones Forge's framing uses today, game tags keep their numbers | `forge-sim/store` becomes codecs plus facts over tc-store; existing worlds open unchanged (golden world dirs in testdata) |
| **E4 tc-sim** | L (about 7k) | E2, E3 | `Game` trait, the sim loop, timing wheel, scheduler, change marks, query and sync, conn and driver, input queue, entity frames, slow-client budgets, reload | `forge-server/sim` becomes play families over `Sim<ForgeGame>` |
| **E5 tc-stream** | M (about 3k) | E4 | interest shapes, section cache, stamps, resume, budgets over `SectionSource` | `chunks/` keeps faces, climate and piles as the Forge source |
| **E6 tc-admin + facade** | S | E4 | control channel, status, reports, `Server::<G>::run`, `gen` | `forge serve` and `forge world` are thin over the facade |
| **E7 second game** | M | E4 | `templates/arena-2d-server` (Rust plus TC client, real-time) and a turn-based test game in CI; docs | none; this is the rule-6 proof that the API names no Forge noun |

**Order:** E1, then E2 and E3 in parallel (separate crates, separate agents), then E4, then E5, E6 and E7 in parallel. E3 and E4 each break into two or three PRs under the 4k-line, 3-hot-file cap (store framing and writer, then recovery and archive; sim loop and conn, then sync and entities). Release `thunderclap-server 0.1` at E4, `2.1` at E7.

### Risks

1. **Store compatibility (highest).** Forge worlds on disk must open byte-for-byte. Tags interleave engine framing and game records. *Mitigation:* E3 freezes golden world dirs first; the engine reserves Forge's existing framing tags rather than renumbering.
2. **Hot-path regressions from generics.** The single scheduler holds a 25 ms step budget with a p99 around 8 ms. *Mitigation:* monomorphised generics only, `forge bench` gates every switch, and the allocator-counting bench carries over.
3. **Determinism drift.** Moving the wheel or change marks can reorder same-time events. *Mitigation:* the replay-twice state-hash check and the fidelity tests run on each switch; `(time, seq)` order moves verbatim.
4. **Over-generalising (rule 6).** The temptation is ECS-style components or a scripting layer. *Mitigation:* extract only what Forge runs today; E7's two small games are the only new shape pressure.
5. **Two-repo cadence.** Forge pins both an npm `next` and a git tag; a protocol bump needs both sides at once. *Mitigation:* E2 is one coordinated pair of PRs; the schema hash catches a mismatch at `Hello`.
6. **TS/Rust twins** (movement, entity codec, section codec) drift. *Mitigation:* shared vector files in the engine (`testdata/` pattern) run by both test suites.
7. **TC repo gains a Rust toolchain.** CI time and the Windows-native requirement now apply to TC. Budget a Cargo job in TC's local gate.

### Open calls for the PM

- Rust in the thunderclap-engine repo (recommended, since one program releases both) versus a separate `thunderclap-server` repo.
- Whether E2's protocol bump also moves `section.rs` into TC's voxel codec namespace (recommended: yes, one bump instead of two).
