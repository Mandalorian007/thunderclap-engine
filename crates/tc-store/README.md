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
    repeated strings once per file. `NameTable::new`, `define` and
    `FromIterator<(u32, String)>` build a table by hand (a codec's tests).
  - A codec with no file keys uses `std::convert::Infallible` as its `Key`.
- `Log<C>`:
  - Setup: `create(dir, codec, meta)`, `open(dir, codec)` and
    `open_from(dir, codec, from_gen, after)`. Opening returns an `Opened`
    holding `meta`, `entries`, `clock` and `report`.
  - Under a lock already held (E14): `open_locked(lock, codec, from_gen,
    after)`, or `scan(&lock, &codec, from_gen, after)` then
    `open_scanned(lock, codec, scan)`, which opens without reading the log
    again. A `Scan` has `meta`, `entries` (take them if you like), `clock`,
    `report` and `leftovers`, and opens only under the lock it was read
    under.
  - Opening clears what an archiving cut short left (`.g<n>.tmp`/`.del` in
    `archive/` and `log/`, a `.store.meta.tmp`) and refuses an archive that
    isn't the log's own (it holds the generation appended to or a newer
    one, or a generation whose live copy differs) with `StoreError::Meta`.
  - Appends: `append` and `append_all`. Sequence numbers must follow on
    without gaps, and a batch is written all or none.
  - Marks: `mark(time)` (asynchronous), `wait`, `marks_pending`, `blocked`
    and `take_mark_error`. `mark_wall(time, wall)` gives the mark's wall
    time instead of the clock's now; such a mark is never folded into
    another waiting, so each is written as asked (also on `MemoryLog` and
    `Store`).
  - Generations: `rotate(prepare(..), time)` returns a `LogCut`; also
    `cut`, `sync_frozen`, `note_base`, `durable_below`, `to_prepare` and
    `background()` (a thread for slow jobs).
  - Also `sync_all` and `counters`.
- `read(dir, codec)`: what opening would recover, without changing anything;
  `read_from(dir, codec, from_gen, after)` the same for a base's tail.
- Bases (`base/`, E8): `write_base(dir, generation, after, bytes)` writes a
  game's state through entry `after`, whose tail starts in `generation`,
  durable (a temporary name, then a rename) or not at all; `bases(dir)`
  lists them newest first (`BaseFile`); `prune_bases(dir, keep)`. The bytes
  are the game's. A backup copies them before the log; a repair or
  rollback in place moves `base/` to `recovered/` with the old log.
- `StoreLock` and `holder(dir)`: the lock, and who holds it.
  `StoreLock::acquire_named(dir, name)` and `holder_named(dir, name)` lock
  a directory of the game's own under another file name (a store opens only
  under `store.lock`); `dir()` and `path()` say what a lock holds.
- `format`: framing and the engine's reserved record kinds:
  - 1: name
  - 2: entry
  - 3: clock (read-only)
  - 4: mark
  - 5: batch
  - 6: wall mark

  `format` also provides `Writer` and `Reader`, which a codec can use for
  its payloads.

- Past recovery (E3b):
  - `check(dir, codec)`: what is wrong with each file, whether it opens,
    and what a repair would keep (`CheckReport`, `Salvage`). Changes
    nothing.
  - `repair(dir, codec, output)` and `repair_with(.., accept)`: a new log
    with the longest prefix it can trust (gap-free, each entry once,
    batches whole, through no entry the game refuses).
  - `rollback(dir, codec, RollbackTo::{Seq, Time, Wall}, output)`: a new
    log through an earlier point, never inside a batch, reaching into the
    archive if need be.
  - `Output::Copy(path)` writes a new store; `Output::InPlace` writes into
    `.swap/` under the lock and swaps it in, moving the old log and archive
    to `recovered/`. Opening finishes a swap cut short.
  - `tidy(dir, codec, below, &ArchivePolicy)`: archives the generations
    below a base (deflated, `archive/g<n>/`), then prunes the archive and
    `recovered/` past `keep_days` (7) or `max_bytes` (1 GiB). Safe while the
    log is open. `summary(dir)` lists the archive, and `read_archive(dir,
    codec, generations)` reads its files back inflated (`ArchivedFile`:
    `generation`, `path` in `log/`, `key`, `bytes`).
  - `backup(dir, out, archive)`: an online copy, taken while the log is
    appended to, that opens with nothing to recover. A live log holding
    only marks (every entry archived) is copied whole.
  - `LogReader::after(dir, seq).read_to(&cut, codec)`: a tail reader that
    decodes only what each `LogCut` adds (`LogCut::since_generation` for a
    follower that starts at a base).
  - `Store::memory(codec)` / `Store::disk(log)`: one type for a log on disk
    or in memory (`MemoryLog`: same records, appends all or none,
    `rollback_to`).

Not here: when to write a base and what goes in it (`tc-sim` does both
for a game that implements `Game::save`), and a reader that polls another
process's store.

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
  - `ops.rs`: check and repair of a double-written log, repair keeping
    batches whole, the rollback to a mark, a backup while another thread
    appends, the archive and a rollback into it, the tail reader, and the
    memory store
- `src/tests/fit.rs` (E14): a scan opened under its lock, marks with a
  wall time, a backup of a log holding only marks, the archive read, a
  hand-built name table, a foreign archive refused, leftovers cleared at
  open, and a child process killed at each crash point in `tidy`
  (`TC_STORE_CRASH_AT=tidy.tmp|tidy.archived|tidy.moved|tidy.prune`), then
  reopened and tidied again.
- `tests/board_game.rs`: a board game's turn log round-trips through the
  public API.
- `tests/retention.rs`: a base copied by a backup and moved aside by a
  rollback, the archive's week and a rollback by wall time,
  with the store's clock set by hand (its own process).
- Lint: `clippy.toml` refuses `File::sync_all` and `File::sync_data` outside
  `src/durable.rs`.
