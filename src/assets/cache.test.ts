import { describe, expect, it } from 'vitest';
import type { AssetReader } from './bundle';
import { createAssetCache } from './cache';

/** A `read` over an in-memory table that counts calls per uri. */
function memoryReader(files: Record<string, number>): {
  read: AssetReader;
  calls: Map<string, number>;
} {
  const calls = new Map<string, number>();
  const read: AssetReader = async (uri) => {
    calls.set(uri, (calls.get(uri) ?? 0) + 1);
    const n = files[uri];
    if (n === undefined) throw new Error(`no file ${uri}`);
    return new ArrayBuffer(n);
  };
  return { read, calls };
}

const bytesOf = (b: ArrayBuffer) => b.byteLength;

describe('createAssetCache', () => {
  it('two concurrent acquires call load once and share the value', async () => {
    const { read, calls } = memoryReader({ a: 10 });
    const cache = createAssetCache<ArrayBuffer>({ budgetBytes: 100 });
    const load = () => read('a') as Promise<ArrayBuffer>;
    const [x, y] = await Promise.all([
      cache.acquire('a', load, bytesOf),
      cache.acquire('a', load, bytesOf),
    ]);
    expect(x).toBe(y);
    expect(calls.get('a')).toBe(1);
    expect(cache.refs('a')).toBe(2);
    expect(cache.stats()).toEqual({ bytes: 10, entries: 1, hits: 1, misses: 1, evictions: 0 });
  });

  it('evicts unreferenced entries least recently used first, through onEvict', async () => {
    const { read } = memoryReader({ a: 40, b: 40, c: 40, d: 40 });
    const evicted: string[] = [];
    const cache = createAssetCache<ArrayBuffer>({
      budgetBytes: 100,
      onEvict: (key) => evicted.push(key),
    });
    const get = (k: string) => cache.acquire(k, () => read(k) as Promise<ArrayBuffer>, bytesOf);
    await get('a');
    await get('b');
    cache.release('a');
    cache.release('b');
    // Touch a again: b is now the least recently used.
    await get('a');
    cache.release('a');
    await get('c'); // 120 > 100: b goes (a is newer, c is held).
    expect(evicted).toEqual(['b']);
    cache.release('c');
    await get('d'); // 120 again: a is the oldest unreferenced.
    expect(evicted).toEqual(['b', 'a']);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.stats()).toMatchObject({ bytes: 80, entries: 2, evictions: 2 });
  });

  it('never evicts a held or pinned entry, even over budget', async () => {
    const { read } = memoryReader({ big: 80, pinned: 50, other: 10 });
    const cache = createAssetCache<ArrayBuffer>({ budgetBytes: 60 });
    const get = (k: string) => cache.acquire(k, () => read(k) as Promise<ArrayBuffer>, bytesOf);
    await get('pinned');
    cache.pin('pinned');
    cache.release('pinned');
    await get('big'); // held: 130 bytes, nothing evictable
    expect(cache.stats().bytes).toBe(130);
    expect(cache.stats().evictions).toBe(0);
    cache.release('big'); // big is unreferenced now: it goes, pinned stays
    expect(cache.has('big')).toBe(false);
    expect(cache.has('pinned')).toBe(true);
    await get('other');
    cache.release('other');
    expect(cache.has('pinned')).toBe(true);
    cache.unpin('pinned');
    expect(cache.has('pinned')).toBe(true); // 60 bytes: within budget
    expect(cache.stats()).toEqual({ bytes: 60, entries: 2, hits: 0, misses: 3, evictions: 1 });
  });

  it('dispose frees an unreferenced entry now and refuses a held one', async () => {
    const freed: string[] = [];
    const cache = createAssetCache<{ id: string }>({
      budgetBytes: 1000,
      onEvict: (_k, v) => freed.push(v.id),
    });
    await cache.acquire(
      'x',
      async () => ({ id: 'gpu-x' }),
      () => 5,
    );
    expect(() => cache.dispose('x')).toThrow(/reference/);
    cache.release('x');
    expect(cache.dispose('x')).toBe(true);
    expect(freed).toEqual(['gpu-x']);
    expect(cache.dispose('x')).toBe(false);
    expect(cache.stats()).toMatchObject({ bytes: 0, entries: 0, evictions: 0 });
  });

  it('a failed load leaves nothing behind and the next acquire retries', async () => {
    const { read, calls } = memoryReader({});
    const cache = createAssetCache<ArrayBuffer>({ budgetBytes: 10 });
    const load = () => read('gone') as Promise<ArrayBuffer>;
    await expect(cache.acquire('gone', load, bytesOf)).rejects.toThrow(/no file gone/);
    expect(cache.has('gone')).toBe(false);
    await expect(cache.acquire('gone', load, bytesOf)).rejects.toThrow();
    expect(calls.get('gone')).toBe(2);
    expect(() => cache.release('gone')).toThrow(/not in the cache/);
  });
});
