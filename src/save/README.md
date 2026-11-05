# engine/save

Versioned save slots in the host's storage (`host.storage`; `localStorage` on the web). Survives the itch.io iframe: storage that is missing, blocked, partitioned, full, or throws on every call. No dependencies.

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

Stored format: `{"v": <version>, "t": <savedAt ms>, "d": <data>}`.

Partitioned storage note: in some browsers, itch's iframe gets storage keyed to the itch.io top-level site, so it persists but is separate from a standalone visit. That's fine; nothing to do.

## API

- `createSaveStore(opts: SaveStoreOptions<T>) → SaveStore<T>`: `get, set, update, flush, reset, clear, exportString, importString, subscribe, dispose`, plus `key`, `persistent`, `status`, `savedAt`. `SaveStoreOptions` is `{ game, slot?, version, migrations?, defaults, schema, debounceMs?, host?, storage?, autoFlush?, now? }`.
- `SaveStatus` is `{ persistent, loadResult, error, dirty }`; `LoadResult` is `'fresh' | 'loaded' | 'migrated' | 'recovered'`; `ImportResult` is `{ ok: true, migrated } | { ok: false, error }`.
- `s`: schema builders `boolean, string({maxLength}), number({min,max,int}), literal(...), array, record, object(shape, {strict}), optional, nullable, union, unknown`, each returning a `Schema<T>` (`validate(value, path?)` → `null` or a message, `is(value)`). `Infer<typeof schema>`.
- `runMigrations(data, from, to, migrations)`, `assertMigrationChain(version, migrations)`, `MigrationError`. `Migration` is `(data) => unknown`; `Migrations` maps a version `n` to the migration from v`n` to v`n+1`.
- `probeStorage(get)`, `MemoryStorage`, `isQuotaError`, `StorageLike` (the `localStorage` subset the store uses), `saveKey(game, slot)`, `listSlots(game, storage?)` (default storage: `defaultHost().storage.open()`).
- `encodeExport / decodeExport / fnv1a` (low level).

## Storage
The store gets its storage from the host: `createSaveStore({ ..., host })`, default `defaultHost()` (`@thunderclap/engine/host`). On the web that is `localStorage`; an Electron host can supply a file-backed `StorageLike`. `storage:` overrides the host.

## Testing
Pass `storage: new MemoryStorage()` (or a throwing stub), `debounceMs: 0`, `autoFlush: false`, and a fixed `now`. See `save.test.ts`.
