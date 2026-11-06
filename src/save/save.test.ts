import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeExport, encodeExport } from './codec';
import { assertMigrationChain, MigrationError, runMigrations } from './migrate';
import { type Infer, s } from './schema';
import { MemoryStorage, probeStorage, type StorageLike } from './storage';
import { createSaveStore, listSlots, saveKey } from './store';

const Data = s.object({
  name: s.string(),
  score: s.number({ int: true, min: 0 }),
  flags: s.array(s.string()),
  note: s.optional(s.string()),
});
type Data = Infer<typeof Data>;
const defaults = (): Data => ({ name: 'new', score: 0, flags: [] });

function opts(
  storage: StorageLike | null,
  extra: Partial<Parameters<typeof createSaveStore<Data>>[0]> = {},
) {
  return {
    game: 'test-game',
    version: 1,
    defaults,
    schema: Data,
    storage,
    autoFlush: false,
    debounceMs: 0,
    now: () => 1000,
    ...extra,
  };
}

/** Storage whose every call throws, like a sandboxed iframe. */
class ThrowingStorage implements StorageLike {
  length = 0;
  key(): string | null {
    throw new DOMException('denied', 'SecurityError');
  }
  getItem(): string | null {
    throw new DOMException('denied', 'SecurityError');
  }
  setItem(): void {
    throw new DOMException('denied', 'SecurityError');
  }
  removeItem(): void {
    throw new DOMException('denied', 'SecurityError');
  }
}

/** Reads fine, writes throw quota errors. */
class FullStorage extends MemoryStorage {
  full = true;
  override setItem(k: string, v: string): void {
    if (this.full) throw new DOMException('full', 'QuotaExceededError');
    super.setItem(k, v);
  }
}

describe('schema', () => {
  it('accepts valid data and names the failing path', () => {
    expect(Data.validate({ name: 'a', score: 1, flags: ['x'] })).toBeNull();
    expect(Data.validate({ name: 'a', score: 1.5, flags: [] })).toBe('$.score: expected integer');
    expect(Data.validate({ name: 'a', score: 1, flags: [2] })).toMatch(/\$\.flags\[0\]/);
    expect(Data.validate({ score: 1, flags: [] })).toBe('$.name: missing');
    expect(Data.validate(null)).toMatch(/expected object/);
    expect(Data.is({ name: 'a', score: 0, flags: [], note: 'n' })).toBe(true);
    expect(Data.is({ name: 'a', score: 0, flags: [], note: 5 })).toBe(false);
  });

  it('supports literal, union, record, nullable, strict', () => {
    const S = s.object(
      {
        mode: s.literal('a', 'b'),
        v: s.union(s.number(), s.nullable(s.string())),
        m: s.record(s.boolean()),
      },
      { strict: true },
    );
    expect(S.validate({ mode: 'a', v: null, m: { x: true } })).toBeNull();
    expect(S.validate({ mode: 'c', v: 1, m: {} })).toMatch(/expected one of/);
    expect(S.validate({ mode: 'a', v: 1, m: { x: 1 } })).toMatch(/\$\.m\.x/);
    expect(S.validate({ mode: 'a', v: 1, m: {}, extra: 1 })).toMatch(/unexpected key/);
    expect(s.number({ max: 1 }).validate(Number.NaN)).toMatch(/finite/);
  });
});

describe('migrations', () => {
  const migrations = {
    1: (d: { n: number }) => ({ count: d.n }),
    2: (d: { count: number }) => ({ ...d, tags: [] }),
  };

  it('runs the chain in order', () => {
    expect(runMigrations({ n: 3 }, 1, 3, migrations)).toEqual({ count: 3, tags: [] });
    expect(runMigrations({ count: 3 }, 2, 3, migrations)).toEqual({ count: 3, tags: [] });
    expect(runMigrations({ x: 1 }, 3, 3, migrations)).toEqual({ x: 1 });
  });

  it('rejects gaps, future versions and throwing steps', () => {
    expect(() => runMigrations({}, 1, 3, { 1: (d) => d })).toThrow(MigrationError);
    expect(() => runMigrations({}, 4, 3, migrations)).toThrow(/newer than this build/);
    expect(() => runMigrations({}, 0, 3, migrations)).toThrow(/invalid save version/);
    expect(() =>
      runMigrations({}, 1, 2, {
        1: () => {
          throw new Error('boom');
        },
      }),
    ).toThrow(/v1 → v2 failed: boom/);
    expect(() => assertMigrationChain(3, { 1: (d) => d })).toThrow(/gap: v2/);
  });
});

describe('codec', () => {
  it('round-trips unicode and detects damage', () => {
    const env = { v: 2, t: 5, d: { name: 'Ünïcødé ⚡', n: [1, 2] } };
    const text = encodeExport('g', env);
    expect(text.startsWith('TC1.g.')).toBe(true);
    expect(decodeExport('g', text)).toEqual({ ok: true, envelope: env });
    expect(decodeExport('other', text).ok).toBe(false);
    expect(decodeExport('g', text.slice(0, -3)).ok).toBe(false);
    expect(decodeExport('g', 'hello').ok).toBe(false);
  });
});

describe('storage probe', () => {
  it('returns null when access or writes throw', () => {
    expect(probeStorage(() => new ThrowingStorage())).toBeNull();
    expect(
      probeStorage(() => {
        throw new DOMException('denied', 'SecurityError');
      }),
    ).toBeNull();
    expect(probeStorage(() => undefined)).toBeNull();
    const mem = new MemoryStorage();
    expect(probeStorage(() => mem)).toBe(mem);
    expect(mem.length).toBe(0);
  });
});

describe('save store', () => {
  let mem: MemoryStorage;
  beforeEach(() => {
    mem = new MemoryStorage();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('namespaces keys and validates names', () => {
    expect(saveKey('g', 'main')).toBe('thunderclap:g:main');
    expect(() => saveKey('bad:id', 'main')).toThrow();
    expect(() => saveKey('g', '')).toThrow();
  });

  it('starts fresh, writes an envelope, reloads', () => {
    const a = createSaveStore(opts(mem));
    expect(a.status.loadResult).toBe('fresh');
    expect(a.persistent).toBe(true);
    a.update((d) => {
      d.score = 7;
    });
    expect(JSON.parse(mem.getItem('thunderclap:test-game:main')!)).toEqual({
      v: 1,
      t: 1000,
      d: { name: 'new', score: 7, flags: [] },
    });
    const b = createSaveStore(opts(mem));
    expect(b.status.loadResult).toBe('loaded');
    expect(b.get().score).toBe(7);
    expect(b.savedAt).toBe(1000);
  });

  it('update works on a clone and rejects invalid data', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const st = createSaveStore(opts(mem));
    const before = st.get();
    expect(st.update((d) => ({ ...d, score: -1 }))).toBe(false);
    expect(st.get()).toBe(before);
    expect(st.status.error).toMatch(/score/);
    expect(st.update((d) => void d.flags.push('x'))).toBe(true);
    expect(before.flags).toEqual([]);
    expect(st.get().flags).toEqual(['x']);
  });

  it('debounces writes and flushes on demand', () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(mem, 'setItem');
    const st = createSaveStore(opts(mem, { debounceMs: 100 }));
    st.set({ ...defaults(), score: 1 });
    st.set({ ...defaults(), score: 2 });
    st.set({ ...defaults(), score: 3 });
    expect(setItem).not.toHaveBeenCalled();
    expect(st.status.dirty).toBe(true);
    vi.advanceTimersByTime(100);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(st.status.dirty).toBe(false);
    st.set({ ...defaults(), score: 4 });
    st.flush();
    expect(setItem).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mem.getItem(st.key)!).d.score).toBe(4);
  });

  it('migrates old saves and backs up the original', () => {
    mem.setItem('thunderclap:test-game:main', JSON.stringify({ v: 1, t: 1, d: { title: 'old' } }));
    const st = createSaveStore(
      opts(mem, {
        version: 2,
        migrations: { 1: (d: { title: string }) => ({ name: d.title, score: 0, flags: [] }) },
      }),
    );
    expect(st.status.loadResult).toBe('migrated');
    expect(st.get().name).toBe('old');
    expect(mem.getItem('thunderclap:test-game:main:backup')).toContain('"title":"old"');
    expect(st.status.dirty).toBe(true);
    st.flush();
    expect(JSON.parse(mem.getItem(st.key)!).v).toBe(2);
  });

  it('recovers from corrupt, invalid and future saves with a backup', () => {
    // The five shapes the game's robustness e2e used to boot through (now one there, D-041).
    for (const raw of [
      '{not json',
      JSON.stringify({ v: 1, t: 1, d: { name: 5 } }),
      JSON.stringify({ hello: 1 }),
      JSON.stringify({ v: 9, t: 1, d: defaults() }),
      '',
    ]) {
      mem.clear();
      mem.setItem('thunderclap:test-game:main', raw);
      const st = createSaveStore(opts(mem));
      expect(st.status.loadResult).toBe('recovered');
      expect(st.status.error).toBeTruthy();
      expect(st.get()).toEqual(defaults());
      expect(mem.getItem('thunderclap:test-game:main:backup')).toBe(raw);
    }
  });

  it('falls back to memory when storage is unavailable', () => {
    const st = createSaveStore(opts(null));
    expect(st.persistent).toBe(false);
    expect(st.status.error).toMatch(/memory/);
    st.update((d) => {
      d.score = 3;
    });
    expect(st.get().score).toBe(3);
    expect(st.flush()).toBe(false);
  });

  it('survives storage that throws on every call', () => {
    const st = createSaveStore(opts(new ThrowingStorage()));
    expect(st.status.loadResult).toBe('fresh');
    expect(st.persistent).toBe(false);
    expect(st.set({ ...defaults(), score: 1 })).toBe(true);
    expect(st.get().score).toBe(1);
    expect(() => st.clear()).not.toThrow();
    expect(listSlots('test-game', new ThrowingStorage())).toEqual([]);
  });

  it('reports quota errors, keeps data in memory, recovers when space frees up', () => {
    const full = new FullStorage();
    const seen: boolean[] = [];
    const st = createSaveStore(opts(full));
    st.subscribe((x) => seen.push(x.persistent));
    st.set({ ...defaults(), score: 9 });
    expect(st.persistent).toBe(false);
    expect(st.status.error).toMatch(/full/);
    expect(st.get().score).toBe(9);
    full.full = false;
    st.set({ ...defaults(), score: 10 });
    expect(st.persistent).toBe(true);
    expect(st.status.error).toBeNull();
    expect(seen).toEqual([false, true]);
  });

  it('exports and imports, including across versions', () => {
    const v1 = createSaveStore(opts(mem));
    v1.update((d) => {
      d.name = 'Ada';
    });
    const text = v1.exportString();

    const other = new MemoryStorage();
    const v2 = createSaveStore(
      opts(other, {
        version: 2,
        migrations: { 1: (d: Data) => ({ ...d, flags: [...d.flags, 'migrated'] }) },
      }),
    );
    expect(v2.importString(text)).toEqual({ ok: true, migrated: true });
    expect(v2.get()).toEqual({ name: 'Ada', score: 0, flags: ['migrated'] });
    expect(JSON.parse(other.getItem(v2.key)!).v).toBe(2);

    expect(v2.importString('garbage').ok).toBe(false);
    const bad = encodeExport('test-game', { v: 2, t: 0, d: { name: 1 } });
    const res = v2.importString(bad);
    expect(res.ok).toBe(false);
    expect(v2.get().name).toBe('Ada');
  });

  it('reset, clear and listSlots', () => {
    const a = createSaveStore(opts(mem, { slot: 'a' }));
    const b = createSaveStore(opts(mem, { slot: 'b' }));
    a.set({ ...defaults(), score: 1 });
    b.set({ ...defaults(), score: 2 });
    mem.setItem('thunderclap:test-game:b:backup', 'x');
    mem.setItem('thunderclap:other:main', 'x');
    expect(listSlots('test-game', mem)).toEqual(['a', 'b']);
    a.reset();
    expect(JSON.parse(mem.getItem(a.key)!).d.score).toBe(0);
    b.clear();
    expect(mem.getItem(b.key)).toBeNull();
    expect(mem.getItem(`${b.key}:backup`)).toBeNull();
    expect(listSlots('test-game', mem)).toEqual(['a']);
  });

  it('accepts a plain type-guard function as schema', () => {
    const st = createSaveStore({
      game: 'g',
      version: 1,
      defaults: () => 0,
      schema: (v: unknown): v is number => typeof v === 'number',
      storage: mem,
      autoFlush: false,
      debounceMs: 0,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(st.set(5)).toBe(true);
    expect(st.set('x' as unknown as number)).toBe(false);
  });
});

describe('meta sidecar', () => {
  it('is written in the same flush when `meta` is set, and removed by clear', () => {
    const mem = new MemoryStorage();
    const st = createSaveStore<Data>(
      opts(mem, { meta: (d) => ({ label: d.name, playMs: d.score }) }),
    );
    expect(mem.getItem(`${st.key}:meta`)).toBeNull();
    st.update((d) => {
      d.name = 'Ada';
      d.score = 3;
    });
    expect(JSON.parse(mem.getItem(`${st.key}:meta`)!)).toEqual({
      v: 1,
      t: 1000,
      size: mem.getItem(st.key)!.length,
      label: 'Ada',
      playMs: 3,
    });
    expect(listSlots('test-game', mem)).toEqual(['main']);
    st.clear();
    expect(mem.getItem(`${st.key}:meta`)).toBeNull();
    // Without `meta`, no sidecar.
    const plain = createSaveStore<Data>(opts(mem));
    plain.update((d) => {
      d.score = 1;
    });
    expect(mem.getItem(`${plain.key}:meta`)).toBeNull();
  });

  it('a failed meta write is not an error for the data', () => {
    class MetaFails extends MemoryStorage {
      override setItem(k: string, v: string): void {
        if (k.endsWith(':meta')) throw new DOMException('full', 'QuotaExceededError');
        super.setItem(k, v);
      }
    }
    const mem = new MetaFails();
    const st = createSaveStore<Data>(opts(mem, { meta: () => ({ label: 'x' }) }));
    expect(
      st.update((d) => {
        d.score = 2;
      }),
    ).toBe(true);
    expect(st.persistent).toBe(true);
    expect(st.status.error).toBeNull();
    expect(JSON.parse(mem.getItem(st.key)!).d.score).toBe(2);
    expect(mem.getItem(`${st.key}:meta`)).toBeNull();
  });
});
