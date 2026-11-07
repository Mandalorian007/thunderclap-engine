# engine/save

Versioned save slots in the host's storage (`host.storage`; `localStorage` on the web). Survives the itch.io iframe: storage that is missing, blocked, partitioned, full, or throws on every call. No dependencies.

## Quick use

<!-- snippet:check -->
```ts
import { createSaveStore, type Infer, s } from '@thunderclap/engine/save';

const Progress = s.object({ solved: s.array(s.string()), playMs: s.number({ min: 0 }) });
type Progress = Infer<typeof Progress>;

const save = createSaveStore<Progress>({
  game: 'my-game', // key: thunderclap:my-game:main
  version: 1,
  defaults: () => ({ solved: [], playMs: 0 }),
  schema: Progress,
});
save.update((d) => { d.solved.push('intro'); }); // validated, debounced write
```

## Entry points

| Name | What it is for |
| --- | --- |
| `createSaveStore(opts)` | one versioned, validated slot; `createGame` gives you `ctx.save` |
| `s` | the schema builder (`s.object`, `s.array`, `s.number`, ...) |
| `save.get / update / set / flush` | read, mutate a clone, replace, write now |
| `save.exportString / importString` | a checksummed text export |
| `createSlotManager(opts)` | several named slots |
| `createSettingsStore(opts)` | settings kept apart from progress |
| `MemoryStorage` | a `StorageLike` for tests |

## Usage

```ts
import { createSaveStore, s, type Infer } from '@thunderclap/engine/save';

const Progress = s.object({
  solved: s.array(s.string()),
  playMs: s.number({ min: 0 }),
  seenIntro: s.optional(s.boolean()),
});
type Progress = Infer<typeof Progress>;

export const save = createSaveStore<Progress>({
  game: 'my-game',            // key: thunderclap:my-game:main
  slot: 'main',               // optional, default 'main'
  version: 2,
  migrations: {
    1: (old) => ({ ...old, playMs: 0 }),   // v1 → v2
  },
  defaults: () => ({ solved: [], playMs: 0 }),
  schema: Progress,           // or any (v: unknown) => v is T
});

save.get().solved;                         // read (treat as read-only)
save.update((d) => { d.solved.push('a'); });  // mutate a clone → validate → debounced write
save.set(next);                            // replace wholesale
save.flush();                              // write now (also automatic on pagehide / tab hidden)

if (!save.persistent) ui.toast('Progress will not be saved in this browser.');
save.subscribe((st) => { /* st.persistent, st.error, st.loadResult, st.dirty */ });
```

### Export / import
```ts
const text = save.exportString();      // "TC1.my-game.<checksum>.<base64url>"
const res = save.importString(text);   // { ok: true, migrated } | { ok: false, error }
```
Import checks game id, checksum, envelope, migrations and schema before touching current data.

## Behaviour

| Situation | Result |
|---|---|
| No stored value | `loadResult: 'fresh'`, defaults. |
| Stored at current version | `'loaded'`. |
| Stored at older version | `'migrated'`. The original is copied to `<key>:backup`; the upgraded data is written on the next flush. |
| Corrupt JSON, no envelope, schema failure, failed migration, **newer** version than the build | `'recovered'`: raw value copied to `<key>:backup`, defaults used, `status.error` says why. |
| Host storage (`host.storage.open()`; on the web `localStorage`) missing / throws on access (sandboxed iframe, blocked third-party storage) | Memory only, `persistent: false`. Re-probed on every write. |
| Write throws (quota, Safari private mode) | Data stays in memory, `persistent: false`, `error` set. Next successful write flips it back. |
| `set`/`update` with data failing the schema | Rejected, returns `false`, `error` set, `console.warn`. Current data unchanged. |

Stored format: `{"v": <version>, "t": <savedAt ms>, "d": <data>}`, where typed arrays inside `d` are `{"$b": <base64url bytes>, "$t"?: <kind>}` (see *Binary data*). With `meta` set, the sidecar `<key>:meta` holds `{"v", "t", "size", "label"?, "playMs"?, "thumbnail"?}`.

## Slots

A load/save menu needs several slots and their metadata without loading each one. `createSlotManager` numbers them `1..slots` (keys `thunderclap:<game>:slot<n>`) and writes a sidecar `<key>:meta` in the same flush as the data, so `list()` parses sidecars only.

```ts
import { createSlotManager } from '@thunderclap/engine/save';

const slots = createSlotManager<Progress>({
  game: 'my-game', version: 2, migrations, defaults, schema: Progress,
  slots: 3,                                              // default 3
  meta: (d) => ({ label: d.chapter, playMs: d.playMs, thumbnail: d.thumb }),
});
slots.list();            // SlotInfo[]: { slot, label, savedAt, version, playMs?, thumbnail?, size }
slots.mostRecent();      // the latest SlotInfo, or null ("Continue")
const save = slots.open(2);   // a SaveStore<Progress>; the same instance while it stays open
slots.copy(2, 3);        // data and sidecar
slots.rename(3, 'Hard run');
slots.remove(1);         // data, sidecar and backup; an open store resets to defaults
```

`label` defaults to `Slot <n>`; a `rename` sticks through later flushes unless `meta` returns its own `label`. `size` is the stored JSON's length in UTF-16 code units (what web storage quotas count). Slots saved before sidecars existed are listed from the data envelope's `v` and `t`. A failed sidecar write is not an error for the data. `SaveStoreOptions.meta` is what the manager passes to each store; a plain `createSaveStore` writes no sidecar unless you set it.

## Settings

Settings live apart from progress, in the `settings` slot, version 1 by default, written synchronously (`debounceMs` 0). `bind` wires a menu control: it sets the control from the store, writes the control on `input` and `change` (coerced to the key's current type: number, boolean (a checkbox uses `checked`) or string; a value the schema rejects snaps the control back), follows store changes made elsewhere, and returns an unbind function.

```ts
const settings = createSettingsStore<Settings>({ game: 'my-game', defaults, schema: Settings });
const unbind = settings.bind(document.querySelector('#volume')!, 'volume');
```

## Journal

`createJournal(store, { limit? })` keeps structural snapshots of `store.get()` (cloned the way `update` clones) and restores them through `store.set`, so every undo is validated and saved. `push(label?)` snapshots the current data: call it before a change (a checkpoint) or after one (a commit), both work; identical consecutive snapshots collapse (compared on their JSON text, cached per data reference). `undo()` restores the previous snapshot and keeps the current data as the redo step; `redo()` the reverse; both return false with nothing to do. `limit` (default 50) bounds the undo steps. `canUndo`, `canRedo`, `length`, `undoLabel`, `redoLabel`, `clear()`.

```ts
const journal = createJournal(save, { limit: 100 });
journal.push('move');
save.update((d) => applyMove(d, move));
undoButton.onclick = () => journal.undo();
```

## Binary data

Tilemaps and voxel chunks are typed arrays, not number arrays. `s.bytes({ maxLength? })` is a `Uint8Array`; `s.typed(kind, { maxLength? })` is one of `'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'f32' | 'f64'`. In the stored JSON and the export string they become `{ "$b": <base64url bytes> }` with `"$t": <kind>` for everything but `u8` (`saveReplacer`), and come back as typed arrays on load and import (`saveReviver`). Bytes are in platform order (little-endian everywhere WebGPU runs); `structuredClone` in `update` keeps them typed. A plain object of your own data with a key matching `/^\$+b$/` is stored with one more `$` (`$b` → `$$b`) and unescaped on load, so it never reads as a tag.

```ts
const Chunk = s.object({ tiles: s.bytes({ maxLength: 64 * 64 }), heights: s.typed('f32') });
```

Partitioned storage note: in some browsers, itch's iframe gets storage keyed to the itch.io top-level site, so it persists but is separate from a standalone visit. That's fine; nothing to do.

## API

- `createSaveStore(opts: SaveStoreOptions<T>) → SaveStore<T>`: `get, set, update, flush, reset, clear, exportString, importString, subscribe, dispose`, plus `key`, `persistent`, `status`, `savedAt`. `SaveStoreOptions` is `{ game, slot?, version, migrations?, defaults, schema, debounceMs?, host?, storage?, autoFlush?, now?, meta? }`; `meta: (data) => SlotMeta` (`{ label?, playMs?, thumbnail? }`) turns on the `<key>:meta` sidecar (`StoredMeta`: `SlotMeta` plus `v`, `t`, `size`).
- `createSlotManager(opts: SlotManagerOptions<T>) → SlotManager<T>`: `slots`, `list(): SlotInfo[]`, `open(slot): SaveStore<T>`, `copy(from, to): boolean`, `remove(slot)`, `rename(slot, label): boolean`, `mostRecent(): SlotInfo | null`. `SlotManagerOptions` is `{ game, version, migrations?, defaults, schema, slots?, host?, storage?, meta?, debounceMs?, autoFlush?, now? }`; `slotName(n)` is `slot<n>`.
- `createSettingsStore(opts: SettingsStoreOptions<T>) → SettingsStore<T>`: a `SaveStore<T>` plus `bind(input: BindTarget, key): () => void`. `SettingsStoreOptions` is `SaveStoreOptions` without `debounceMs` and `meta`, with `slot` (default `settings`) and `version` (default 1) optional. `BindTarget` is an `HTMLInputElement`, an `HTMLSelectElement` or any `{ value, checked?, type?, addEventListener?, removeEventListener? }`.
- `createJournal(store, opts?: JournalOptions) → Journal`: `push(label?)`, `undo(): boolean`, `redo(): boolean`, `canUndo`, `canRedo`, `length`, `undoLabel`, `redoLabel`, `clear()`. `JournalOptions` is `{ limit? }`.
- `SaveStatus` is `{ persistent, loadResult, error, dirty }`; `LoadResult` is `'fresh' | 'loaded' | 'migrated' | 'recovered'`; `ImportResult` is `{ ok: true, migrated } | { ok: false, error }`.
- `s`: schema builders `boolean, string({maxLength}), number({min,max,int}), literal(...), array, record, object(shape, {strict}), optional, nullable, union, unknown, bytes({maxLength}), typed(kind, {maxLength})`, each returning a `Schema<T>` (`validate(value, path?)` → `null` or a message, `is(value)`). `Infer<typeof schema>`.
- `runMigrations(data, from, to, migrations)`, `assertMigrationChain(version, migrations)`, `MigrationError`. `Migration` is `(data) => unknown`; `Migrations` maps a version `n` to the migration from v`n` to v`n+1`.
- `probeStorage(get)`, `MemoryStorage`, `isQuotaError`, `StorageLike` (the `localStorage` subset the store uses), `saveKey(game, slot)`, `listSlots(game, storage?)` (default storage: `defaultHost().storage.open()`).
- `encodeExport / decodeExport / fnv1a` (low level); `saveReplacer / saveReviver` (the `JSON.stringify` / `JSON.parse` hooks for typed arrays), `TypedKind`, `TypedArrayOf<K>`, `TYPED_CTORS` (kind → constructor), `typedKindOf(value)`.

## Storage
The store gets its storage from the host: `createSaveStore({ ..., host })`, default `defaultHost()` (`@thunderclap/engine/host`). On the web that is `localStorage`; an Electron host can supply a file-backed `StorageLike`. `storage:` overrides the host.

## Testing
Pass `storage: new MemoryStorage()` (or a throwing stub), `debounceMs: 0`, `autoFlush: false`, and a fixed `now`. See `save.test.ts`, `slots.test.ts`, `settings.test.ts`, `journal.test.ts` and `codec.test.ts`. The harness page `harness/save.html` (e2e/save.spec.ts) runs three slots, a bound volume slider, a 64×64 `Uint8Array` tilemap and undo/redo on every matrix row without WebGPU.
