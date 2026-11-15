# engine/net

The client side of a networked game, for any game with an authoritative server: sessions over a
transport the game hands in, a schema whose hash both sides check, live queries kept current by
patches, an entity stream of many things' state, snapshot interpolation, prediction with rollback,
optimistic edits, and interest. No DOM and no runtime dependency, so bots and tests run in Node.

The engine opens no connection of its own (VISION rule 4). The game passes a `Connect`: a
WebSocket one is a few lines in the game or a host package. The engine ships only in-page
transports (`inPagePair`, `inPageHub`) for tests and demos, with adjustable latency, jitter and
loss. The server side of the same protocol is the server foundation's (`tc-net`, in Rust);
`ServerEnd` and `QueryFeed` are the small TypeScript half an in-page authority or a test needs.

## Quick use

<!-- snippet:check -->
```ts
import { createNet, defineSchema, inPageHub, ServerEnd } from '@thunderclap-engine/engine/net';

const schema = defineSchema({
  types: { Add: { struct: [['n', 'i32']] }, Total: { struct: [['total', 'i32']] } },
  roles: { command: 'Add', result: 'Total' },
});

let total = 0;
const hub = inPageHub((connect) => {
  const end = new ServerEnd(schema, connect, {
    message(msg) {
      if (msg.type === 'Hello') {
        end.send({ type: 'Welcome', player: 1, time: 0, paused: false, stepUs: 50_000, ext: {} });
      } else if (msg.type === 'Command') {
        total += (msg.command as { n: number }).n;
        end.send({ type: 'CommandResult', seq: msg.seq, result: { total } });
      }
    },
  });
});

const net = createNet({ schema, connect: hub.connect });
await net.ready;
await net.command({ n: 2 }); // { total: 2 }
```

## Entry points

| Name | What it is for |
| --- | --- |
| `defineSchema(desc)` | the game's types inside the engine envelope, hashed (`NetSchema`) |
| `createNet(options)` | a session (`Net`): handshake, liveness, reconnect, commands, queries |
| `net.query(name, args, listener)` | a live query, patched in place, resumed after a reconnect |
| `net.setInterest(shape)` | what the server streams to this client |
| `net.predict(options)` / `net.input(i)` | prediction with rollback against `PlayerState` |
| `net.optimistic(store)` | keyed shadow-and-rollback for predicted edits |
| `net.clock` / `net.snapshots` / `net.entities` | server time, interpolation, the entity stream |
| `inPagePair()` / `inPageHub(accept)` | in-page transports for tests and demos |
| `ServerEnd` / `QueryFeed` / `EntityEncoder` | the server half, for in-page authorities and tests |

## The schema and its hash

A schema is plain data: named types (`struct`, `newtype`, `enum`), roots and live queries. Types
are the scalars `bool u8 u16 u32 u64 i32 i64 Fixed String Bytes`, a named type by name, and the
composites `netType.vec(T)`, `netType.option(T)`, `netType.map(K, V)` (or `{ vec: T }` and so on).
Field names are the wire names in snake_case; values in TypeScript use camelCase props
(`propName`). A newtype is its inner value; an enum value is `{ type: 'Variant', ...fields }`, or
`{ type, value }` for a one-value variant; an option is the value or `null`; a map is a `Map`;
`Bytes` is a `Uint8Array`; `Fixed` is a 32.32 fixed-point `Fixed` (encoding takes any value with
its `bits`, `FixedBits`, so a game may keep a class of its own). `u64` and `i64` are numbers, read
without BigInt; a value past 2^53 is a decode error (split it in the schema, as two `u32`s).

`defineSchema` wraps the game's types in the engine envelope, `ClientMsg` and `ServerMsg`
(`ENVELOPE_TYPES` are reserved), whose roles the game fills (`Roles`: `hello`, `welcome`,
`command`, `result`, `interest`, `input`, `state`, `client`, `server`; a role left out carries
`Empty`, the value `EMPTY`). `defineTypes(desc)` builds a schema without the envelope
(`TypesDesc`).

A game with a wire of its own lays the envelope out its way with `SchemaDesc.envelope`
(`EnvelopeSpec`), the same layout a Rust game gives `Protocol::ENVELOPE`, so both build the same
text and hash. `client` and `server` list the envelope's variants in wire order
(`EnvelopeClientVariant`, `EnvelopeServerVariant`; the defaults are `ENVELOPE_CLIENT` and
`ENVELOPE_SERVER`); a variant left out is not on the wire (`Hello` and `Ping`, and `Welcome`,
`Rejected`, `Pong` and `Closed`, are required), and an entry `{ Name: fields | null }` is one of
the game's own messages inline, at its own tag, in place of `Game`: `Net.send(value)` takes
`{ type: 'Name', ...fields }` and the `game` event gives it the same way. `hello` and `welcome`
order those messages' fields (`ext` is the role's value; `Hello.bulk` may be left out, so no bulk
lane is asked for, and `Welcome.step_us`, read as 0). `ack: 'total'` acknowledges the bulk lane
with a running total per connection (`Ack { total }`) instead of each `Bulk`'s length. `close`
names an enum of unit variants and one close code for each: `Closed` carries the variant and the
session reads its code. A layout the session cannot follow throws `SchemaError`.

The schema's canonical text (`NetSchema.text`, first line `WIRE_HEADER`, format `WIRE_FORMAT`)
lists the roots, the queries, then every type in the order the roots and queries reach it. Its
hash (`NetSchema.hash`) is 16 hex digits of a SplitMix64 stable hash of the text's UTF-8 bytes
(`stableHash`, `hashHex`); `Hello` carries it and the server refuses a client whose hash differs.
`src/net/testdata/schema.json` holds descriptions with their texts and hashes for the Rust side to
check against.

Fields are written as a list of pairs, `[['x', 'i32'], ['y', 'i32']]` (`FieldList`), or as an
object, `{ x: 'i32', y: 'i32' }`: the same schema, text and hash. Prefer the list (the generated
schemas use it): an object literal of field names shares its V8 hidden class with the game's own
objects of the same names, so a game's `{ x: 0.5, y: 0.5 }` would hold its numbers boxed and
allocate on every write. Decoded structs and variants are plain objects (`Object.prototype`) built
by a constructor per type, so every value of a type has one shape of its own, in wire order, and
a field a game writes a fraction into stays unboxed (`schema-shape.test.ts`). A decode error names
the byte and, for a variant index or an integer past 2^53, the exact value.

`queryApis<Api>(schema, QUERIES)` gives one `QueryApi` per live query from tc-tsgen's types-only
module (`QUERIES` and `Api`), over a schema built on first use.

The types: `Scalar`, `TypeSpec` (as written), `TypeRef` (as data; `typeRef`, `displayType`),
`FieldSpecs`, `FieldList`, `VariantSpec`, `TypeDefSpec`, `QuerySpec`, `QueryDef`, `TypeShape` and `Types` (the
shapes `applyPatch` walks), `SchemaDesc`, and `Codec` (`NetSchema.codec(ty)`). A bad schema
throws `SchemaError`.

## Wire

Integers are varints, signed ones zigzag, `Fixed` the zigzag of its 64 bits, strings and bytes
length-prefixed, maps in key order (`compareKeys` on `MapKey`). `Writer` and `Reader` are the
low-level encoder and strict decoder (`DecodeError` names the offset).

The Rust crates' generator (`crates/tc-tsgen`) writes TypeScript that imports `Reader`, `Writer`,
`Fixed`, `invalidVariant` (the error an exhaustive enum switch throws), `TypeRef` and `Types`
from here, and types each generated query as a `QueryApi<A, R>`: its wire name, `player`, its
`result` type and its argument and result codecs.

## Sessions

`createNet({ schema, connect, hello, reconnect, liveness, inflate, entities, snapshots })` starts
at once. `NetOptions` documents each; `Hello` is the token and the game's `ext`.

- **Handshake.** `Hello` with the schema hash; `Welcome` (`net.welcome`, `net.ready`) or
  `Rejected` (the `rejected` event says whether the schema was stale; closed for good).
- **Liveness.** A `Ping` every `pingMs` (its `Pong` measures latency for the clock); nothing heard
  for `deadMs` drops the link. Call `net.wake()` when the page comes back from hidden
  (`LivenessOptions`). On a busy link, `heardBy: 'tick'` reads the clock once per liveness tick
  instead of once per message.
- **Reconnect.** A lost link reconnects with doubling waits and random jitter, giving up after
  `giveUpAfter` (`ReconnectOptions`). Commands in flight fail with `NetError`; live queries resume
  from the result they hold; interest is sent again. A server `Closed` with a code 4000 to 4999 (the
  game's: kicked, banned) closes for good; others reconnect. `net.status` is a `NetStatus`.
  `net.reconnect()` drops the link and reopens at once; `reconnect({ backoff: true })` waits the
  backoff first (`ReconnectNowOptions`).
- **Reasons.** `down` and `closed` carry the code, the reason text and a typed `NetReason`
  (`kind`, a `NetReasonKind`: `gaveUp` with the `last` reason, `dead`, `handshakeTimeout`, `serverClosed`, ...;
  `detail`, the text). A `NetError` carries its `reason` too (`commandTimeout`, `notOpen`, ...).
- **Events.** `net.on(event, listener)` for `NetEvents`: `welcome` (a `Welcome`), `rejected`, `entities`,
  `down`, `closed`, `game`, `interestRejected`, `control`, `state`, `error`. A throwing listener
  doesn't stop the others and is reported as `error`; with `listenerErrors: 'throw'` the first
  error is thrown out of the call that emitted it (the transport's message callback, say), as it is.
- **Commands.** `net.command(cmd)` resolves with its `CommandResult`, matched by seq. With
  `rawResults: true` it resolves with the result's bytes, undecoded, for a game that reads its own
  outcome type.
- **Raw game messages.** `rawServer: ['Section', ...]` names server messages (the game's own inline
  ones, or `'Game'`) that skip the decoder: each arrives as a `raw` event with its name and the
  whole frame (variant tag first, not copied), a bulk lane's frames too. Before `Welcome` one is a
  protocol error, as a decoded one is.
- **Live queries.** `net.query(name, args, listener, QueryOptions)` returns a `LiveQuery`. The
  server sends the result whole (`Resync`), then `Update`s whose `PatchOp`s (`PathStep` paths) the
  client applies (`applyPatch`) and checks against the result's hash (`resultHash`); a mismatch
  asks for the whole result again.
- **Bulk lane.** With `inflate`, `Hello` offers a codec; a `Bulk` message's inflated frames are
  handled in order and acknowledged with `Ack`. With `plainBulk: true` an uncompressed lane
  (codec 0) is handled in the same call that received it, no `inflate` needed.
- **Game messages.** `net.send(value)` and the `game` event carry the game's own messages.

`ClientMsg` and `ServerMsg` are the envelope's TypeScript value types.

## Clock, snapshots, entities

`net.clock` is a `NetClock`: the server's game time in steps, exact while paused, smoothed under a
step, never going backwards, with the step length from `Welcome`.

`net.snapshots` is a `SnapshotBuffer` (`SnapshotBufferOptions`: 2 or 3 dims, step length):
`push(id, step, pos, vel, now)` as snapshots arrive, `frame(now)` once a drawn frame, `at(id, out)`
per thing. It draws things 100 to 300 ms in the past, following the jitter, goes on one step past
the newest snapshot, fades in late corrections and starts over on a snap. No per-frame allocation.

`net.entities` (with `entities: 'ViewStruct'`) is an `EntityStream`: each frame carries only the
fields that changed (at most `MAX_VIEW_FIELDS`), `apply` returns `EntityChanges`; a frame that
doesn't fit throws `EntityStreamError`, after which the session asks for a key frame.
`EntityEncoder` writes the stream for an in-page authority.

## Prediction and optimistic edits

`net.predict({ step, equal, start })` returns a `Predictor` (`PredictorOptions`): `net.input(i)`
applies an input at once and sends it numbered; each `PlayerState` is checked against the
prediction, and a mismatch replays the inputs still in flight from the server's state and records
a `Correction`. While another connection drives (`Control`), it follows the server.

`net.optimistic(store)` returns an `Optimistic` over an `OptimisticStore`: `edit(key, value)` shows
a value at once and returns its settle function; a refused edit rolls back to the server's last
confirmed value there (`confirm`), never to another prediction.

## Transports

`Connect` opens one connection and reports through `TransportEvents`; it returns a `Transport`.
`inPagePair()` is one link's two ends; `inPageLink(options)` the same with live `LinkConditions`
(`linkConditions` fills defaults) and `drop()`, as an `InPageLink`; `inPageHub(accept)` is an
`InPageHub` handing each new connection's server end to `accept`. `InPageOptions` takes
`Timers` (default `pageTimers`) and a random source, so tests run on fake time.

## Server half

`ServerEnd` decodes a link's `ClientMsg`s and sends `ServerMsg`s (`ServerEndEvents`). `QueryFeed`
turns a query's successive results into `Resync` and `Update` messages (`diffValues` picks finer
ops only where they encode smaller than a whole `Set`; `writePatchOp` encodes one, `PatchError`
refuses one that doesn't fit). These are for tests and in-page authorities; a real server is
`tc-net`.
