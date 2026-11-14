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
- `SectionStream::new(StreamConfig, encode)`: `encode` turns a `StreamMsg`
  into a frame; `game_frame::<P>()` does it for a game whose
  `P::Server: From<StreamMsg>`. Called from the game's one writer thread:
  `connect`, `disconnect`, `set_interest(conn, Area, &[Claim])`
  (`StreamError`: `UnknownConn`, `TooLarge`, `OutOfRange`), `changed(pos)`,
  `flush(&source, &mut lanes)` once a tick, `reload()`, `has_work()`,
  `stats()` (`StreamStats`).
- `StreamConfig`: `max_radius` per axis (≤ 127), `hysteresis` (2),
  `build_budget` (sections built for loads per flush, shared),
  `rebuild_budget` (changed sections rebuilt per flush), `cache_bytes`,
  `history` (earlier encodings kept per section, for edits; 3).
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
   smaller) or the whole section on the priority lane. A connection that
   is `behind` waits; a refused frame is retried next flush;
3. sends `Unload`s in batches of `MAX_UNLOAD_BATCH`, retried when refused;
4. loads: each connection's area, nearest first (an offsets table sorted
   by distance), in the bulk lane up to its high water, through the shared
   LRU cache, round robin from the connection after the one served last,
   with at most `build_budget` builds shared.

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
- `tests/tiles.rs`: a 2D tilemap source (8×8 `u16` chunks, its own
  encoding) streams, edits, moves and resumes.
- `tests/interop.rs`: a game loop on `tc-net` streams to `createNet`
  (`src/net/stream-interop.test.ts`, through vitest), which fills the
  voxel `SectionStore`, applies an `Edit`, and after a dropped connection
  resumes holding everything and gets only the changed section. `pnpm
  test:stream-interop` runs just this test; it skips where node is missing.
