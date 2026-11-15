# tc-stream

ThunderClap's section stream: a game's world sent to each connection in
sections, by interest area. A port of Forge Wilds' chunk streaming
(interest box with hysteresis, nearest-first order, the shared section
cache, edits against what a client holds, stamps and resume, unload
batches, build budgets and round robin), with the voxel world taken out:
the game brings a `SectionSource`, and a 2D tilemap fits as well as a voxel
world.

## API

- `SectionSource` (the game's side, taken `&mut` so it can keep caches of
  its own): `build(&mut self, pos, out)` encodes a section
  (the same content, the same bytes); `exists(pos)` (default true);
  `cells(bytes, out)` decodes an encoding into `u32` cells (default: can't,
  so changes go as whole sections; a raw source returns `decode_raw`).
  Layers (all default to none): `layers()` counts the data streamed beside
  sections (what lies on the ground, a column's climate, timers);
  `layer_key(layer, pos)` is the key a section's layer data is under (the
  section, or a coarser one such as its column, sent once to a client
  holding any section under it); `layer_state(layer, key, out)` encodes
  the state (empty: none); `layer_frame(layer, key, from, to, out)` is the
  game's own frame taking a client from `from` to `to` (an empty `out`:
  nothing sent). `from` is a `LayerFrom`: `Nothing` (the client holds no
  state there: a whole frame, and none at all when `to` is empty too),
  `Unknown` (it may hold an earlier state, from before a reconnect or a
  reload: a whole frame that replaces it, sent even when `to` is empty, so
  it clears what it held) or `State(bytes)` (exactly that state: a
  delta). It is asked once a flush for each key, `from` and `to`, however
  many connections need it. `layer_order(layer)` (`LayerOrder::After`, the
  default, or `Before`): whether a whole frame goes behind the section
  that brings its key or ahead of it, and a change after or before the
  flush's section changes. `layer_stamp(layer, key, state)` the state's
  stamp for layer claims (default `bytes_stamp`). `take_marks(&mut
  Marks)` (default nothing) is called right after each `build`, for what
  the build found changed besides its section (`Marks::changed`,
  `changed_bulk`, `changed_derived`, `layer_changed`, as the stream's
  methods): marked sections held by anyone are rebuilt in the same pass
  (once each), and marked layers are read at once, so they go with the
  build that changed them. `unheld(pos, near, &mut Marks) -> Unheld`
  (default `Unheld::Forget`) is asked of a changed section no connection
  holds as a flush rebuilds: `Forget` drops the change (the marks it adds
  are applied as `take_marks`' are, so a source marks the held
  neighbours a change next door affects), `Build` builds it within the
  rebuild budget (its `take_marks` run; past the budget it is asked again
  next flush); `near` says it is within the hysteresis and one of some
  area. `begin(&Loading)` and `end()` (default
  nothing) bracket each pass that may build (a flush, `flush_conn`,
  `load_until`, `idle`, `check_claims`): `Loading {views, scanning, sides,
  widest, areas, area_sides}` counts the views loading (as `loading_for`
  says) and their sides, how many are still scanned, and the distinct
  areas among them (views sharing an area count once), so a source sizes
  or drops its caches.
- `SectionStream::new(StreamConfig, encode)`: `encode` turns a `StreamMsg`
  into a frame; `game_frame::<P>()` does it for a game whose
  `P::Server: From<StreamMsg>`. Called from the game's one writer thread:
  `connect`, `disconnect`, `set_interest(conn, Area, &[Claim])`
  (`StreamError`: `UnknownConn`, `TooLarge`, `OutOfRange`),
  `set_stream_interest(conn, &StreamInterest)` (the same with group and
  layer claims), `check_claims(conn, within, &mut source, &mut lanes)`
  (looks at a connection's claims now, all or those within a box, before
  a command acts on them), `claims_pending(conn)`, `held(conn)`,
  `holds(conn, pos)`, `loading_for(conn)` (its area still scanned, its
  sections or their layers' whole frames still queued unwritten, or its
  area moved since the stream last had nothing loading while any view
  still loads; for sizing what a source reads ahead: never for holding a
  session's writes back, see below), `more_coming(conn)` (its area still
  scanned, or it moved while some view still is: what a host passes
  tc-net's `wake_lingering`), `view_loading(conn)` (`ViewLoading {area, scanning,
  in_flight, moved}`, `#[non_exhaustive]`, the parts, for a host's own
  rule), `last_loading()` (the `Loading` the last pass gave `begin`),
  `loading_now()` (the one the next pass would give: a host sizing its
  caches right after `set_interest`), `unloads_pending(conn)`,
  `holders(pos)` (the
  connections holding a section: 0, and no one sees a change to it),
  `changes_pending()`, `held_bytes(conn)` and `layer_bytes()` (the
  stream's memory, roughly), `changed(pos)`,
  `changed_bulk(pos)` (a change re-sent whole in the bulk lane, for a
  reveal: a queued frame is replaced, a held one sent again behind the
  loads), `changed_derived(pos)` (a change following from another, such
  as a neighbour's faces: as `changed`, but a `changed_bulk` of the same
  section stays in the bulk lane, where a `changed` would win, and a
  holder whose bulk resend of it is still to be queued gets the new
  encoding in that resend, not on the priority lane),
  `layer_changed(layer, key)`, `send_unloads(conn, &mut lanes)` (the
  unloads waiting, now: after a jump, before the flush),
  `flush(&mut source, &mut lanes)` once
  a tick, `flush_conn(conn, &mut source, &mut lanes)` (one connection's
  changes now, past the rebuild budget: before a command's result; a
  changed section nobody holds next to its area is put to `unheld` first,
  as a flush does, so a neighbour it exposes comes before the result too),
  `load_until(&mut source, &mut lanes, until, interrupted)` (builds loads
  between flushes until the deadline or `interrupted()`, returning how
  many), the idle budget (below), `reload()`, `has_work()`, `loading()`
  (some view still scanned: what `load_until` and `idle` would send),
  `stats()` (`StreamStats`: sections, edits, unloads, `build_nanos`,
  `bulk_resends`, `layer_frames`, `bytes` and `refused` frames,
  `withdrawn` and `withdrawn_bytes` (queued bulk frames taken back unsent:
  `bytes - withdrawn_bytes` is what was written or still waits),
  `cache_hits`, claims resumed and resent, `group_claims`, `groups_held`,
  `groups_different`, `claims_dropped`, `layer_resumed`, flush and idle
  builds and nanos, `idle_holds`), `set_observer(Option<Box<dyn
  StreamObserver>>)` (any `FnMut(&StreamEvent) + Send`: `Queued {conn,
  kind: FrameKind, bytes, pos, layer}` per frame handed to the lanes (`pos`
  the section or layer key, `None` for unloads; `layer` for layer
  frames), `Withdrawn {conn, pos, layer, bytes}`, `Built {pos, nanos}`,
  `Claimed {conn, pos, kept}`, `Group {conn, start, kept}`, `LayerGroup
  {conn, start, layer, kept}` (a group's layer digest matched or not);
  both enums and every variant `#[non_exhaustive]`). The position hasher
  is public: `PosHasher`, `PosBuildHasher`, `PosMap<K, V>`, `PosSet<K>`.
- Idle building: `idle(&mut source, &mut lanes, until, interrupted)`
  builds loads in time the server's loop would wait, within
  `StreamConfig::idle` (`IdleBudget {spread: 8 ms, held: 3 ms, extra:
  5 ms}` per flush interval: spread first, then extra); `hold_idle(until)`
  spends only `held` and no extra until then (the machine is short of
  CPU); `idle_left()` says whether there is budget and a view loading.
  `interrupted()` is asked first: true, and it returns at once having
  done nothing; otherwise at least one section is sent, then it is asked
  after each.
  On tc-sim's `Host` (tc-stream doesn't depend on it): `idle_work` returns
  `stream.idle_left()`, `idle(until, interrupted)` calls `stream.idle`,
  `woke_late` calls `stream.hold_idle(now + a second or so)`.
- `StreamConfig`: `max_radius` per axis (≤ 127), `hysteresis` (2),
  `build_budget` (sections built for loads per flush, shared),
  `rebuild_budget` (changed sections rebuilt per flush), `cache_bytes`,
  `history` (earlier encodings kept per section, for edits; 3),
  `load_time` / `rebuild_time` (`Option<Duration>`, `None`: counts only;
  set, a flush's load stops sending past the time, sections from the
  cache as well as built ones, after at least one; its rebuilds stop past
  `rebuild_time`), `edit_rule` (`EditRule::Cells`, the default: an `Edit`
  while its cells' bytes are fewer than the section's; `Frame`: while the
  encoded `Edit` is shorter than the encoded `Section`),
  `unload_boxes` (`false`; set, a jump sends what it left as
  `UnloadBox`es, counted in `StreamStats::unload_boxes`), `idle`
  (`IdleBudget`).
- `Lanes`: where frames go (`send` priority, `send_bulk` with a
  `BulkTicket`, `bulk_queued`, `bulk_high_water`, `behind`,
  `edits_queued`: called once a flush when every connection's changes
  and unloads are queued, before new sections are built). A
  `BTreeMap`/`HashMap<ConnId, Outbound>` is lanes as it is; its
  `edits_queued` releases each `Outbound` the game `hold()`s for the
  flush, so a session writes its priority frames in one wake.
- Wire types (`#[derive(Wire)]`, described in the game's schema like its
  own): `SectionPos {x, y, z}` (2D: `z` = 0), `Area {center, rx, ry, rz}`,
  `Stamp {hi, lo}` (`bytes_stamp` of an encoding), `Claim {pos, stamp}`,
  `GroupClaim {start, axis, held, digest, layers}` (up to `GROUP_MAX` = 32
  sections along one axis under one `pairs_digest`, and a digest per
  layer; `GroupClaim::group(axis, held)` builds them from what a client
  holds, `digest_of`, `layer_digest`, `members`), `LayerClaim {layer, key,
  stamp}`, `StreamInterest {area, holding, groups, layers}` (the game's
  `Interest` role) and
  `StreamMsg` (`Section {pos, stamp, data}`, `Edit {pos, changes, stamp}`
  with `changes` = `[index, cell, ...]`, `Unload {positions}`,
  `UnloadBox {min, max}`: every held section in the inclusive box;
  `SectionPos::within(min, max)`).
- `encode_raw` / `decode_raw`: the voxel client's `RAW_SECTION_CODEC`
  (little-endian `u32` cells, one `u32` when uniform). `Bounds` (an
  inclusive box; `minus`, `for_each`, `volume`, `disjoint`, `corners`),
  `MIN_BOXED`.

## Behaviour

Each flush:

1. rebuilds changed sections someone holds (`rebuild_budget`, at least
   one; one nobody holds is forgotten, or built, as `unheld` says), and
   the sections their builds mark, and marks holders of an older encoding
   stale (a section whose bulk resend is still to be queued keeps it,
   unless a `changed` overrides it); then reads the layers that changed
   (those the builds marked too);
2. sends each stale section: a frame still waiting in the bulk lane is
   withdrawn and queued again with the change (folded); otherwise an
   `Edit` (the changed cells, from the earlier encoding in the cache, when
   smaller) or the whole section on the priority lane. An edit is worked
   out once per flush for every holder of the same encoding. A connection
   that is `behind` waits; a refused frame is retried next flush;
   `changed_bulk` sections go whole in the bulk lane instead;
3. sends `Unload`s in batches of `MAX_UNLOAD_BATCH`, retried when refused.
   With `unload_boxes`, `MIN_BOXED` or more first go as `UnloadBox`es on
   the priority lane: one box round them all when it stays clear of the
   area grown by the hysteresis, else one per side past that margin with
   at least `MIN_BOXED` in it; a box never covers a section still held
   inside the margin, and what no box covers goes as `Unload`s. Then
   `Lanes::edits_queued`;
4. loads: each connection's area, nearest first (an offsets table sorted
   by distance), in the bulk lane up to its high water, through the shared
   LRU cache, round robin from the connection after the one served last,
   with at most `build_budget` builds shared;
5. layers: each layer key a connection newly holds (through any section)
   is sent whole in the bulk lane right behind the section that brought
   it (`LayerOrder::Before`: right ahead of it); a changed state goes to
   its holders as the game's delta on the priority lane (`Before` layers'
   ahead of the section changes, the rest after them), or is folded into a
   whole frame still queued. When a section's queued frame is withdrawn
   and re-queued, its queued layer frames follow it. A key is let go when
   no held section is under it; `reload()` sends layers whole again.

A section frame never carries or clears layers: a section sent again
whole (a `changed` too large for an `Edit`, a `changed_bulk`, a wrong
claim) leaves the client's layer states under it as they are, and the
stream sends none again for it, since they are still current. A client
drops a key's state when it holds no section under that key (an unload,
an `UnloadBox`); the stream lets the key go at the same point, and sends
it whole when a section brings it back.

`set_interest` unloads what is past the new area grown by the
hysteresis (a section whose frame was withdrawn unsent needs none); an
unload not yet sent of a section back in the new area is undone, and the
section claimed with what the client holds there, so it is kept. On a
reconnect the client sets its interest with what it holds (`Claim`s): a
claim whose stamp matches the current encoding is kept, a wrong one is
sent again whole, one outside the area or at a position that doesn't exist
is unloaded. A client holding a large view claims it in groups: a
group is looked at when the load reaches its first section (one build
budget unit for the whole group), all or nothing: its digest matching,
every section is kept; otherwise every section is sent again (a group
reaching outside the area is split: what is outside unloaded, the rest
claimed one by one). Each layer digest is checked on its own, and a
`LayerClaim` (or a matching layer digest) keeps a state when a section
first brings its key; a layer digest that doesn't match sends each of
its keys whole from `LayerFrom::Unknown`. Claims are capped (sections at
the area's size, layer claims at eight times that); what is outside the
area, past the cap, or what the load passes without reaching is dropped
(`claims_dropped`, a section each). A bulk frame of a section the client
holds an earlier copy of that is withdrawn and refused again (a change
folded into it while the lane is full) leaves that copy held, sent again
later, not unloaded. `check_claims` looks at them
early. `reload()` turns what every connection holds, sections and layer
states, into claims, so a new world sends only what it changed.

A connection's held record is compact: the stamps of the sections it
holds are packed by 8 x 8 x 1 region behind a bitmap (8 bytes a section
and a table entry per region), as is what it holds of each layer key (16
bytes a key); the tickets of frames still queued sit in their own small
map, let go at the next pass once written. In a 16/8/16 view with two
per-section layers and one per column, `held_bytes` is about 49 bytes a
section (it was about 246 with a hash-map entry per section and key;
`tests/memory.rs` measures it).

`loading_for` is wider than `loading()`: a view counts as loading until
the sections it was sent are written, not just scanned, and a view that
moved stays loading while any view loads (a wave: `moved` clears at the
first pass with no view scanning and nothing in flight). This relies on
the `Lanes` taking a bulk frame's ticket when it writes it (as tc-net's
`Outbound` does); a view whose frames are never taken looks loading.
So `loading_for` must not decide whether a session lingers over its bulk
frames (`Outbound::wake_lingering(now, more)`): it stays true while those
frames wait, and they wait for the session to be woken. `more_coming(conn)`
is the predicate for that: the view is still scanned, or it moved while
some view still is.

The stream's maps keyed by position use a fixed multiply-rotate hasher
(deterministic, not DoS-resistant: positions come from the server's own
areas, bounded per connection). On a release build streaming 8 views of
16x8x16 sections walking 16 steps and a reload, it took 1.18 to 1.96 s
of CPU over six runs against SipHash's 1.60 to 2.60 s (best wall time
235 ms against 311 ms), so it stays.

## Tests

- `tests/stream.rs` (ported from Forge's `chunk_limits` and
  `chunk_resume`): nearest first, hysteresis, unloads only what leaves,
  budgets shared across flushes and connections, the high water, edits as
  cells, refused changes and unloads retried, changes wait while behind,
  folding into a queued frame, resume with nothing or only the edited
  section sent, wrong and outside claims, reload, bad areas; a jump
  in one `UnloadBox`, a diagonal move in one per side, claims in the
  margin as `Unload`s, and `edits_queued` called between changes and
  loads (releasing held `Outbound`s).
- `tests/fit.rs`: a voxel world shaped like Forge Wilds' (16³ sections, a
  column climate layer and a per-section ground layer with deltas, a
  client model checking each frame applies to what it holds): layers
  whole behind their sections once per key, changes on priority and
  folded, following what is held, after a reload, `changed_bulk`,
  `flush_conn`, an edit worked out once for four holders, `load_until`
  and time budgets; a reload sending only the layers that changed;
  resume by groups with their layer digests, a group reaching outside
  the area, layer claims, `check_claims` before the load, groups split
  per line and at 32, idle building within its budget and held, the
  observer, and `begin`/`end` around each pass; a layer emptied while
  away cleared from `Unknown`, a build's marks rebuilt and sent in the
  same flush (and in `flush_conn`), one `layer_frame` for three holders,
  `LayerOrder::Before`, a whole section change keeping its layers, layer
  group events and memory, `Loading`'s areas, and `Queued` positions and
  withdrawals counted; a derived change joining a bulk resend still to be
  queued, `unheld` (forgotten, marking without a build, built within the
  rebuild budget, `near`, and in `flush_conn`: a neighbour exposed
  before the result) and `holds`, and `loading_for` covering frames in
  flight and a moved view's wave (`view_loading`, `last_loading`,
  `loading_now`), and `more_coming` not.
- `tests/memory.rs`: `held_bytes` a section in a 16/8/16 view with three
  layers, at the origin and off it (under 64).
- `tests/stream.rs` also: `EditRule::Frame`, `loading_for`,
  `unloads_pending`, `send_unloads`, `holders`, `changes_pending` and the
  public hasher, a view back before its unloads went, outside claims
  counted, a refused fold keeping the copy held, `changed_derived` after
  `changed_bulk`, `load_time` bounding cached sends, and `idle` sending
  one section once past an `interrupted` check on entry (and nothing when
  interrupted on entry).
- `tests/tiles.rs`: a 2D tilemap source (8×8 `u16` chunks, its own
  encoding) streams, edits, moves and resumes.
- `tests/interop.rs`: a game loop on `tc-net` streams to `createNet`
  (`src/net/stream-interop.test.ts`, through vitest), which fills the
  voxel `SectionStore`, applies an `Edit`, and after a dropped connection
  resumes holding everything and gets only the changed section; moved
  away, it drops what it left from an `UnloadBox` (`dropBox`). `pnpm
  test:stream-interop` runs just this test; it skips where node is missing.
