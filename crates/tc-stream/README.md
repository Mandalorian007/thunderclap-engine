# tc-stream

ThunderClap's section stream: a game's world sent to each connection in
sections, by interest area. A port of Forge Wilds' chunk streaming
(interest box with hysteresis, nearest-first order, the shared section
cache, edits against what a client holds, stamps and resume, unload
batches, build budgets and round robin), with the voxel world taken out:
the game brings a `SectionSource`, and a 2D tilemap fits as well as a voxel
world.

## API

- `SectionSource` (the game's side): `build(pos, out)` encodes a section
  (the same content, the same bytes); `exists(pos)` (default true);
  `cells(bytes, out)` decodes an encoding into `u32` cells (default: can't,
  so changes go as whole sections; a raw source returns `decode_raw`).
  Layers (all default to none): `layers()` counts the data streamed beside
  sections (what lies on the ground, a column's climate, timers);
  `layer_key(layer, pos)` is the key a section's layer data is under (the
  section, or a coarser one such as its column, sent once to a client
  holding any section under it); `layer_state(layer, key, out)` encodes
  the state (empty: none); `layer_frame(layer, key, from, to, out)` is the
  game's own frame taking a client from `from` (`None`: the whole) to `to`
  (empty: nothing sent).
- `SectionStream::new(StreamConfig, encode)`: `encode` turns a `StreamMsg`
  into a frame; `game_frame::<P>()` does it for a game whose
  `P::Server: From<StreamMsg>`. Called from the game's one writer thread:
  `connect`, `disconnect`, `set_interest(conn, Area, &[Claim])`
  (`StreamError`: `UnknownConn`, `TooLarge`, `OutOfRange`), `changed(pos)`,
  `changed_bulk(pos)` (a change re-sent whole in the bulk lane, for a
  reveal: a queued frame is replaced, a held one sent again behind the
  loads), `layer_changed(layer, key)`, `flush(&source, &mut lanes)` once
  a tick, `flush_conn(conn, &source, &mut lanes)` (one connection's
  changes now, past the rebuild budget: before a command's result),
  `load_until(&source, &mut lanes, until, interrupted)` (builds loads
  between flushes until the deadline or `interrupted()`, returning how
  many), `reload()`, `has_work()`, `loading()`, `stats()` (`StreamStats`,
  with `build_nanos`, `bulk_resends`, `layer_frames`).
- `StreamConfig`: `max_radius` per axis (≤ 127), `hysteresis` (2),
  `build_budget` (sections built for loads per flush, shared),
  `rebuild_budget` (changed sections rebuilt per flush), `cache_bytes`,
  `history` (earlier encodings kept per section, for edits; 3),
  `build_time` / `rebuild_time` (`Option<Duration>`, `None`: counts only;
  set, a flush also stops building past the time, after at least one).
- `Lanes`: where frames go (`send` priority, `send_bulk` with a
  `BulkTicket`, `bulk_queued`, `bulk_high_water`, `behind`). A
  `BTreeMap`/`HashMap<ConnId, Outbound>` is lanes as it is.
- Wire types (`#[derive(Wire)]`, described in the game's schema like its
  own): `SectionPos {x, y, z}` (2D: `z` = 0), `Area {center, rx, ry, rz}`,
  `Stamp {hi, lo}` (`bytes_stamp` of an encoding), `Claim {pos, stamp}`,
  `StreamInterest {area, holding}` (the game's `Interest` role) and
  `StreamMsg` (`Section {pos, stamp, data}`, `Edit {pos, changes, stamp}`
  with `changes` = `[index, cell, ...]`, `Unload {positions}`).
- `encode_raw` / `decode_raw`: the voxel client's `RAW_SECTION_CODEC`
  (little-endian `u32` cells, one `u32` when uniform). `Bounds` (an
  inclusive box; `minus`, `for_each`, `volume`).

## Behaviour

Each flush:

1. rebuilds changed sections someone holds (`rebuild_budget`, at least
   one; one nobody holds is just forgotten) and marks holders of an older
   encoding stale;
2. sends each stale section: a frame still waiting in the bulk lane is
   withdrawn and queued again with the change (folded); otherwise an
   `Edit` (the changed cells, from the earlier encoding in the cache, when
   smaller) or the whole section on the priority lane. An edit is worked
   out once per flush for every holder of the same encoding. A connection
   that is `behind` waits; a refused frame is retried next flush;
   `changed_bulk` sections go whole in the bulk lane instead;
3. sends `Unload`s in batches of `MAX_UNLOAD_BATCH`, retried when refused;
4. loads: each connection's area, nearest first (an offsets table sorted
   by distance), in the bulk lane up to its high water, through the shared
   LRU cache, round robin from the connection after the one served last,
   with at most `build_budget` builds shared;
5. layers: each layer key a connection newly holds (through any section)
   is sent whole in the bulk lane right behind the section that brought
   it; a changed state goes to its holders as the game's delta on the
   priority lane, or is folded into a whole frame still queued. When a
   section's queued frame is withdrawn and re-queued, its queued layer
   frames follow behind it. A key is let go when no held section is under
   it; `reload()` sends layers whole again.

`set_interest` unloads what is past the new area grown by the
hysteresis (a section whose frame was withdrawn unsent needs none). On a
reconnect the client sets its interest with what it holds (`Claim`s): a
claim whose stamp matches the current encoding is kept, a wrong one is
sent again whole, one outside the area or at a position that doesn't exist
is unloaded. `reload()` turns what every connection holds into claims, so
a new world sends only what it changed.

## Tests

- `tests/stream.rs` (ported from Forge's `chunk_limits` and
  `chunk_resume`): nearest first, hysteresis, unloads only what leaves,
  budgets shared across flushes and connections, the high water, edits as
  cells, refused changes and unloads retried, changes wait while behind,
  folding into a queued frame, resume with nothing or only the edited
  section sent, wrong and outside claims, reload, bad areas.
- `tests/fit.rs`: a voxel world shaped like Forge Wilds' (16³ sections, a
  column climate layer and a per-section ground layer with deltas, a
  client model checking each frame applies to what it holds): layers
  whole behind their sections once per key, changes on priority and
  folded, following what is held, after a reload, `changed_bulk`,
  `flush_conn`, an edit worked out once for four holders, `load_until`
  and time budgets.
- `tests/tiles.rs`: a 2D tilemap source (8×8 `u16` chunks, its own
  encoding) streams, edits, moves and resumes.
- `tests/interop.rs`: a game loop on `tc-net` streams to `createNet`
  (`src/net/stream-interop.test.ts`, through vitest), which fills the
  voxel `SectionStore`, applies an `Edit`, and after a dropped connection
  resumes holding everything and gets only the changed section. `pnpm
  test:stream-interop` runs just this test; it skips where node is missing.
