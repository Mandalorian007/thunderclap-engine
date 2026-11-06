import { describe, expect, it } from 'vitest';
import { decodeExport, encodeExport, saveReplacer, saveReviver, typedKindOf } from './codec';
import { type Infer, s } from './schema';
import { MemoryStorage } from './storage';
import { createSaveStore } from './store';

const roundTrip = (v: unknown) => JSON.parse(JSON.stringify(v, saveReplacer), saveReviver);

describe('typed-array codec', () => {
  it('tags Uint8Array as { $b } and the others with $t', () => {
    const json = JSON.stringify({ a: new Uint8Array([0, 1, 2, 255]) }, saveReplacer);
    expect(json).toBe('{"a":{"$b":"AAEC_w"}}');
    const f = JSON.stringify(new Float32Array([1.5]), saveReplacer);
    expect(JSON.parse(f)).toEqual({ $b: expect.any(String), $t: 'f32' });
    expect(typedKindOf(new Int16Array(1))).toBe('i16');
    expect(typedKindOf(new DataView(new ArrayBuffer(2)))).toBeNull();
    expect(typedKindOf([1])).toBeNull();
  });

  it('round-trips every kind, a subarray view and large arrays', () => {
    const big = new Uint8Array(70_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const data = {
      u8: new Uint8Array([1, 2, 3]),
      u16: new Uint16Array([1, 65535]),
      u32: new Uint32Array([7, 0xffffffff]),
      i8: new Int8Array([-1, 127]),
      i16: new Int16Array([-32768, 2]),
      i32: new Int32Array([-5, 2 ** 31 - 1]),
      f32: new Float32Array([0.5, -2.25]),
      f64: new Float64Array([Math.PI, -0]),
      view: new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4),
      big,
      empty: new Uint8Array(0),
      nested: [{ t: new Uint16Array([3]) }],
    };
    const back = roundTrip(data);
    expect(back.u8).toBeInstanceOf(Uint8Array);
    expect([...back.u8]).toEqual([1, 2, 3]);
    expect(back.u16).toBeInstanceOf(Uint16Array);
    expect([...back.u16]).toEqual([1, 65535]);
    expect([...back.u32]).toEqual([7, 0xffffffff]);
    expect([...back.i8]).toEqual([-1, 127]);
    expect([...back.i16]).toEqual([-32768, 2]);
    expect([...back.i32]).toEqual([-5, 2 ** 31 - 1]);
    expect(back.f32).toBeInstanceOf(Float32Array);
    expect([...back.f32]).toEqual([0.5, -2.25]);
    expect(back.f64[0]).toBe(Math.PI);
    expect([...back.view]).toEqual([8, 7, 6]);
    expect(back.big).toEqual(big);
    expect(back.empty.length).toBe(0);
    expect(back.nested[0].t).toBeInstanceOf(Uint16Array);
  });

  it('escapes a player object with a $b key and leaves damaged tags alone', () => {
    const data = { $b: 'mine', $$b: 'also', x: { $b: 1 } };
    const json = JSON.stringify(data, saveReplacer);
    expect(JSON.parse(json)).toEqual({ $$b: 'mine', $$$b: 'also', x: { $$b: 1 } });
    expect(roundTrip(data)).toEqual(data);
    // A `$b` object with extra keys or a wrong `$t` is not a tag.
    expect(roundTrip({ $b: 'AAEC', extra: 1 })).toEqual({ $b: 'AAEC', extra: 1 });
    expect(JSON.parse('{"$b":"AAEC","$t":"nope"}', saveReviver)).toEqual({
      $b: 'AAEC',
      $t: 'nope',
    });
    // Odd byte count for a u16: left as the object.
    expect(JSON.parse('{"$b":"AAEC","$t":"u16"}', saveReviver)).toEqual({
      $b: 'AAEC',
      $t: 'u16',
    });
  });

  it('goes through the export string', () => {
    const env = { v: 1, t: 2, d: { tiles: new Uint8Array([4, 5, 6]), f: new Float32Array([1]) } };
    const text = encodeExport('g', env);
    expect(text.startsWith('TC1.g.')).toBe(true);
    const res = decodeExport('g', text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = res.envelope.d as typeof env.d;
    expect(d.tiles).toBeInstanceOf(Uint8Array);
    expect([...d.tiles]).toEqual([4, 5, 6]);
    expect([...d.f]).toEqual([1]);
  });
});

describe('typed arrays through the store', () => {
  const Data = s.object({
    tiles: s.bytes({ maxLength: 16 }),
    heights: s.typed('f32'),
    ids: s.optional(s.typed('u16', { maxLength: 2 })),
  });
  type Data = Infer<typeof Data>;
  const defaults = (): Data => ({ tiles: new Uint8Array(4), heights: new Float32Array(2) });
  const opts = (storage: MemoryStorage) => ({
    game: 'g',
    version: 1,
    defaults,
    schema: Data,
    storage,
    autoFlush: false,
    debounceMs: 0,
    now: () => 7,
  });

  it('stores base64url, loads typed arrays back and validates them', () => {
    const mem = new MemoryStorage();
    const a = createSaveStore<Data>(opts(mem));
    expect(
      a.update((d) => {
        d.tiles[1] = 200;
        d.heights[0] = 1.5;
        d.ids = new Uint16Array([1, 2]);
      }),
    ).toBe(true);
    const raw = mem.getItem(a.key)!;
    expect(raw).not.toContain('[0,200');
    expect(JSON.parse(raw).d.tiles).toEqual({ $b: 'AMgAAA' });
    expect(JSON.parse(raw).d.heights.$t).toBe('f32');

    const b = createSaveStore<Data>(opts(mem));
    expect(b.status.loadResult).toBe('loaded');
    expect(b.get().tiles).toBeInstanceOf(Uint8Array);
    expect(b.get().tiles[1]).toBe(200);
    expect(b.get().heights[0]).toBe(1.5);
    expect([...b.get().ids!]).toEqual([1, 2]);

    expect(b.set({ ...b.get(), tiles: new Uint8Array(17) })).toBe(false);
    expect(b.status.error).toMatch(/bytes longer than 16/);
    expect(b.set({ ...b.get(), ids: new Uint16Array(3) })).toBe(false);
    expect(b.set({ ...b.get(), heights: [1] as unknown as Float32Array })).toBe(false);
    expect(b.status.error).toMatch(/expected Float32Array, got array/);
    expect(Data.validate({ tiles: new Uint16Array(1), heights: new Float32Array() })).toMatch(
      /expected Uint8Array, got Uint16Array/,
    );
  });

  it('exports and imports typed arrays', () => {
    const a = createSaveStore<Data>(opts(new MemoryStorage()));
    a.update((d) => {
      d.tiles.set([1, 2, 3, 4]);
    });
    const b = createSaveStore<Data>(opts(new MemoryStorage()));
    expect(b.importString(a.exportString())).toEqual({ ok: true, migrated: false });
    expect([...b.get().tiles]).toEqual([1, 2, 3, 4]);
    expect(b.get().heights).toBeInstanceOf(Float32Array);
  });
});
