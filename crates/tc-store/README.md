# tc-store

ThunderClap's event-log store: an append-only log of a game's events in a
directory. The game brings a codec; the store frames the records and makes them
durable. It also handles clock marks, log generations, crash recovery and the
directory lock. It is ported from Forge Wilds' `forge-sim/src/store`, with the
game types taken out. The crate docs (`src/lib.rs`) describe the directory
layout.

## API

- `LogCodec`: the game's side of the log.
  - `Event` and `Key` types.
  - `key(event)` picks the file an event goes in: `None` means `main.log`,
    `Some(key)` means the key's own file.
  - `file_name` and `parse_file_name`.
  - `encode` and `decode`, which can use `Names` and `NameTable` to write
    repeated strings once per file.
  - A codec with no file keys uses `std::convert::Infallible` as its `Key`.
- `Log<C>`:
  - Setup: `create(dir, codec, meta)`, `open(dir, codec)` and
    `open_from(dir, codec, from_gen, after)`. Opening returns an `Opened`
    holding `meta`, `entries`, `clock` and `report`.
  - Appends: `append` and `append_all`. Sequence numbers must follow on
    without gaps, and a batch is written all or none.
  - Marks: `mark(time)` (asynchronous), `wait`, `marks_pending`, `blocked`
    and `take_mark_error`.
  - Generations: `rotate(prepare(..), time)` returns a `LogCut`; also
    `cut`, `sync_frozen`, `note_base`, `durable_below`, `to_prepare` and
    `background()` (a thread for slow jobs).
  - Also `sync_all` and `counters`.
- `read(dir, codec)`: what opening would recover, without changing anything.
- `StoreLock` and `holder(dir)`: the lock, and who holds it.
- `format`: framing and the engine's reserved record kinds:
  - 1: name
  - 2: entry
  - 3: clock (read-only)
  - 4: mark
  - 5: batch
  - 6: wall mark

  `format` also provides `Writer` and `Reader`, which a codec can use for
  its payloads.

## Not yet (E3b)

Repair, rollback, archive and backup are not yet ported. Also missing: a
tail reader for followers and `Store::memory()`.

## Tests

- `src/tests/`: Forge's store tests, ported onto a keyed test codec. They
  cover:
  - LRU file handles
  - all-or-none and torn batches
  - the record limit
  - file names
  - marks and failed syncs
  - held appends
  - background syncs
  - generations and the one-sync batches
  - crash recovery
- `tests/board_game.rs`: a board game's turn log round-trips through the
  public API.
- Lint: `clippy.toml` refuses `File::sync_all` and `File::sync_data` outside
  `src/durable.rs`.
