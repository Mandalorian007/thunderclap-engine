# Brief: ws/server-store (E3a)

Read:
- `common.md`
- `wave-2.0-1.md`
- E-042
- `docs/design/2.0/server.md` (the E3 row and the store sections)
- `crates/README.md` and tc-wire (E1)

Forge sources, read only: `/Users/matthewfontana/repos/forgewilds/crates/forge-sim/src/store` and the related parts of `forge-core`.

## Goal

`tc-store`, the event-log store for any game: an append-only log with game-defined codecs. No Forge nouns.

This step is E3a: `Log<C: LogCodec>`, framing with engine-reserved tags (the ones Forge's framing uses today; game tags keep their numbers), marks, generations, crash recovery, the lock, and a flush that works on native Windows (through writable handles).

Repair, rollback, archive and backup are E3b, later.

Saves don't matter (the user's ruling), so existing Forge worlds don't need to open unchanged. Port Forge's store tests anyway, with fresh fixtures.

## Done when

- Forge's store tests for these parts are ported and green.
- A crash-recovery test passes: truncate mid-frame, reopen, the tail is dropped, and a mark survives.
- A non-Forge example codec (a turn log of a board game) is round-tripped in a test.
- `check:rust` is green.

## Files owned

`crates/tc-store/**` and the workspace member line.

## Size

About 4k lines.
