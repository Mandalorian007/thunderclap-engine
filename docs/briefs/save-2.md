# Brief: ws/save-2

Read `docs/briefs/common.md` first, then DECISIONS E-021; `src/save/README.md` whole, `src/save/store.ts` (`createSaveStore`: load, debounce, flush, status), `src/save/codec.ts` (export envelope), `src/save/schema.ts` (`s` builders, `Schema<T>`), `src/save/storage.ts` (`StorageLike`, `MemoryStorage`, `probeStorage`, `listSlots`), `src/save/save.test.ts` (fixture pattern: `MemoryStorage`, `debounceMs: 0`, fixed `now`), `src/host/types.ts` (`host.storage` shape; read only).

## Goal

What a shipped game needs around its save store: several slots with metadata the menu can list without loading them, a settings store that is separate from progress, an undo journal for puzzle games, and a binary-safe payload for large typed arrays (tilemaps, voxel chunks) so a save does not go through JSON number arrays. No new storage backend, no network.

STATUS row, *done when*: `createSlotManager<T>({ game, version, migrations?, defaults, schema, slots?: number, host?, storage? })` → `SlotManager<T> { list(): SlotInfo[], open(slot): SaveStore<T>, copy(from, to), remove(slot), rename?(slot, label), mostRecent(): SlotInfo | null }` where `SlotInfo` is `{ slot, label, savedAt, version, playMs?, thumbnail?: string, size }` read from a sidecar key `<key>:meta` the store writes on flush (`SaveStoreOptions.meta?: (data: T) => SlotMeta` fills `label`, `playMs`, `thumbnail`); `createSettingsStore(opts)` is `createSaveStore` with `slot: 'settings'`, no migrations required, `debounceMs` 0 and a `bind(input: HTMLInputElement | { value }, key)` helper for menus; `createJournal<T>(store, { limit? })` → `Journal<T> { push(label?), undo(): boolean, redo(): boolean, canUndo, canRedo, length, clear() }` keeping structural snapshots of `store.get()` (clone via the store's own clone path) and writing through `store.set`; `s.bytes({ maxLength? })` schema for `Uint8Array` with `codec.ts` encoding typed arrays as `{ $b: base64url }` in the stored JSON and the export string, decoded on load (`s.typed('f32' | 'u16' | 'i32' | ...)` for the other typed arrays); unit tests; harness `save.html` on the matrix; documented.

## Scope

- `src/save/slots.ts`: meta sidecar written in the same `flush` as the data (one extra `setItem`; a failed meta write is not an error for the data). `list()` reads only sidecars (and falls back to reading the data key's `t`/`v` for slots saved before this change). `copy` copies both keys; `remove` removes both and the `:backup`.
- `src/save/settings.ts`: thin; `bind` writes on `input`/`change` and sets the control from the store; returns an unbind function.
- `src/save/journal.ts`: snapshots are the store's validated data; `undo` sets the previous snapshot without pushing; `limit` default 50; `push` collapses identical consecutive snapshots (structural equality on the JSON text, cached).
- `src/save/codec.ts`: a `replacer`/`reviver` pair used by the store's JSON path (one hook in `store.ts`: `JSON.stringify(data, replacer)` / `JSON.parse(text, reviver)`; keep the hook to those two call sites) and by `encodeExport`/`decodeExport`. Tag objects as `{ $b: string, $t?: 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'f32' | 'f64' }`; a plain object with a `$b` key in user data is escaped (`{ $$b }`) and documented.
- `src/save/schema.ts`: `s.bytes`, `s.typed(kind, { maxLength? })`.
- Tests: `slots.test.ts` (list without opening, mostRecent ordering, copy/remove, legacy slot without sidecar), `settings.test.ts` (bind round trip with a fake input), `journal.test.ts` (undo/redo chain, limit, collapse, interaction with `store.update`), `codec.test.ts` additions (typed arrays round trip through store and export string, `$b` escape).
- Harness `harness/save.html` + `save.ts` + `save-state.ts`: three slots with labels, a settings volume slider bound through `bind`, a 64×64 `Uint8Array` tilemap saved in slot data, undo/redo buttons; `MemoryStorage` unless `?persist`; state exposes `slots`, `mostRecent`, `volume`, `canUndo`, `canRedo`, `tileChecksum`; api `paint`, `undo`, `redo`, `save(slot)`, `setVolume`. `e2e/save.spec.ts`: `list()` after two saves, undo restores `tileChecksum`, settings bind updates `volume`.
- Docs: save README *Slots*, *Settings*, *Journal*, *Binary data* sections, the stored-format line; CHANGELOG one line; ARCHITECTURE *Save* one sentence; root README harness list item.

## Files owned

`src/save/slots.ts`, `settings.ts`, `journal.ts`, their tests, `src/save/codec.ts`, `codec.test.ts`, `src/save/schema.ts` (two builders appended), `src/save/store.ts` (replacer/reviver hook and meta sidecar only), `src/save/save.test.ts` (additions), `src/save/index.ts` (append), `src/save/README.md`, `harness/save.*`, `e2e/save.spec.ts`, root `README.md` (harness list item), `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`.

Branch from `main` (5f0ab08 or later). Nothing else in flight touches `src/save` or `src/host`. Running alongside: ws/ui-widgets (`src/ui`), ws/audio-2 (`src/audio`), ws/geom-2 (`src/geom`): do not edit those.
