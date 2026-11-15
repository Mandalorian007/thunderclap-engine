// Decoded values' shapes and the schema's field lists: what keeps a game's numbers unboxed.
//
// V8 shares a hidden class between objects built the same way with the same property names, and
// a field's representation (unboxed double, or any value) is the class's. An object literal of
// field names (`{ x: 'i32' }`) puts strings in the class a game's `{ x: 0.5 }` then gets, so the
// game's doubles go boxed and every write allocates. Field lists (`[['x', 'i32']]`) build no such
// object, and decoded values get a class of their own per type.
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { defineSchema } from './envelope';
import { defineTypes, type QueryApi, queryApis, type TypesDesc } from './schema';
import { DecodeError, Reader } from './wire';

v8.setFlagsFromString('--expose-gc');
v8.setFlagsFromString('--allow-natives-syntax');
const gc = runInNewContext('gc') as () => void;
const sameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)') as (
  a: object,
  b: object,
) => boolean;
const fast = new Function('a', 'return %HasFastProperties(a)') as (a: object) => boolean;
/** Optimizes `f` for `p` now (the interpreter boxes every fraction; a measurement wants the JIT's code). */
const optimize = new Function(
  'f',
  'p',
  '%PrepareFunctionForOptimization(f); f(p, 10); f(p, 10); %OptimizeFunctionOnNextCall(f); f(p, 10);',
) as <P>(f: (p: P, n: number) => void, p: P) => void;

function young(): number {
  for (const s of v8.getHeapSpaceStatistics())
    if (s.space_name === 'new_space') return s.space_used_size;
  return 0;
}
/** Young-generation bytes `run` allocates, retried until no collection ran during it. */
function allocated(run: () => void): number {
  for (let attempt = 0; attempt < 8; attempt++) {
    gc();
    const prof = new v8.GCProfiler();
    prof.start();
    const a = young();
    run();
    const after = young();
    if (prof.stop().statistics.length === 0) return after - a;
  }
  throw new Error('a collection ran during every attempt');
}

/**
 * An object of `entries` with no prototype: a class of its own, so this file's string-valued
 * objects named like `Pt`'s fields don't box the game object the tests watch.
 */
function bare(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const o: Record<string, unknown> = Object.create(null);
  for (const [k, v] of entries) o[k] = v;
  return o;
}

interface Pt {
  shx: number;
  shy: number;
}
/** Writes fractions into `p` `n` times: no allocation while its fields are unboxed doubles. */
function writes(p: Pt, n: number): void {
  for (let i = 0; i < n; i++) {
    p.shx = i + 0.5;
    p.shy = i * 0.25;
  }
}
const N = 20_000;
// A boxed double costs 12 or 16 bytes, so N writes of two fields would be ~500 kB.
const NONE = 16 * 1024;

const pts: TypesDesc = {
  roots: ['Msg', 'Named'],
  types: {
    Pt: {
      struct: [
        ['shx', 'i32'],
        ['shy', 'i32'],
      ],
    },
    Named: {
      struct: [
        ['shx', 'String'],
        ['shy', 'String'],
      ],
    },
    Msg: {
      enum: {
        At: [
          ['pt', 'Pt'],
          ['label', 'String'],
        ],
        One: [['shx', 'u32']],
        Raw: ['u32'],
        Off: null,
      },
    },
  },
};

describe('field lists', () => {
  it('build the same schema as objects: one text, one hash, one wire', () => {
    const asObjects = defineTypes({
      roots: ['Msg', 'Named'],
      types: {
        Pt: {
          struct: bare([
            ['shx', 'i32'],
            ['shy', 'i32'],
          ]) as Record<string, 'i32'>,
        },
        Named: {
          struct: bare([
            ['shx', 'String'],
            ['shy', 'String'],
          ]) as Record<string, 'String'>,
        },
        Msg: {
          enum: {
            At: bare([
              ['pt', 'Pt'],
              ['label', 'String'],
            ]) as Record<string, string>,
            One: bare([['shx', 'u32']]) as Record<string, 'u32'>,
            Raw: ['u32'],
            Off: null,
          },
        },
      },
    });
    const s = defineTypes(pts);
    expect(s.text).toBe(asObjects.text);
    expect(s.hash).toBe(asObjects.hash);
    const msgs = [
      { type: 'At', pt: { shx: -3, shy: 7 }, label: 'a' },
      { type: 'One', shx: 9 },
      { type: 'Raw', value: 4 },
      { type: 'Off' },
    ];
    for (const m of msgs) {
      const bytes = s.encode('Msg', m);
      expect(bytes).toEqual(asObjects.encode('Msg', m));
      expect(s.decode('Msg', bytes)).toStrictEqual(m);
    }
  });

  it('take query arguments and an empty struct', () => {
    const s = defineTypes({
      roots: [],
      types: { Unit: { struct: [] } },
      queries: {
        near: {
          args: [
            ['x', 'i32'],
            ['max_dist', 'u32'],
          ],
          result: 'Unit',
        },
      },
    });
    expect(s.text).toContain('query near(x: i32, max_dist: u32) -> Unit');
    expect(s.text).toContain('struct Unit {  }');
    expect([...s.encodeArgs('near', { x: -1, maxDist: 2 })]).toEqual([1, 2]);
  });
});

describe('decode errors', () => {
  it('print a variant index past 2^53 exactly', () => {
    const s = defineTypes(pts);
    // u64::MAX as a varint: nine 0xff bytes, then 0x01.
    const bytes = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01);
    expect(() => s.decode('Msg', bytes)).toThrow(DecodeError);
    expect(() => s.decode('Msg', bytes)).toThrow(
      'at byte 0: unknown variant 18446744073709551615 for Msg',
    );
    expect(() => s.decode('Msg', Uint8Array.of(9))).toThrow('at byte 0: unknown variant 9 for Msg');
    // Integers past 2^53 too.
    expect(() => new Reader(bytes).u64()).toThrow('u64 value 18446744073709551615 exceeds');
  });
});

describe('decoded shapes', () => {
  it('share one class per type, and none with game objects or other types', () => {
    const s = defineTypes(pts);
    const a = s.decode<{ pt: Pt }>(
      'Msg',
      s.encode('Msg', { type: 'At', pt: { shx: 1, shy: 2 }, label: '' }),
    );
    const b = s.decode<{ pt: Pt }>(
      'Msg',
      s.encode('Msg', { type: 'At', pt: { shx: 3, shy: 4 }, label: 'b' }),
    );
    const named = s.decode<object>(
      'Named',
      s.encode(
        'Named',
        bare([
          ['shx', 'p'],
          ['shy', 'q'],
        ]),
      ),
    );
    const game = { shx: 0.5, shy: 0.5 };
    expect(sameMap(a.pt, b.pt)).toBe(true);
    expect(sameMap(a, b)).toBe(true);
    expect(sameMap(a.pt, named)).toBe(false);
    expect(sameMap(a.pt, game)).toBe(false);
    expect(Object.getPrototypeOf(a.pt)).toBe(Object.prototype);
    expect(Object.keys(a)).toEqual(['type', 'pt', 'label']);
  });

  it('keep a wide struct in fast mode', () => {
    const fields = Array.from({ length: 48 }, (_, i) => [`f${i}`, 'u32'] as const);
    const s = defineTypes({ roots: ['Wide'], types: { Wide: { struct: fields } } });
    const value = Object.fromEntries(fields.map(([f], i) => [f, i]));
    const one = s.decode<object>('Wide', s.encode('Wide', value));
    const two = s.decode<object>('Wide', s.encode('Wide', value));
    expect(fast(one)).toBe(true);
    expect(sameMap(one, two)).toBe(true);
  });
});

describe('steady state', () => {
  it("a game object named like a schema's fields keeps its doubles unboxed", () => {
    // The schema, the envelope's own types, and decoding: all before the game's object exists.
    const s = defineTypes(pts);
    defineSchema({ types: pts.types, roots: ['Msg', 'Named'] });
    for (let i = 0; i < 100; i++)
      s.decode(
        'Named',
        s.encode(
          'Named',
          bare([
            ['shx', 'a'],
            ['shy', 'b'],
          ]),
        ),
      );
    const p: Pt = { shx: 0.5, shy: 0.5 };
    optimize(writes, p);
    expect(allocated(() => writes(p, N))).toBeLessThan(NONE);
  });

  it('a decoded value takes fractions without allocating', () => {
    const s = defineTypes(pts);
    const p = s.decode<Pt>('Pt', s.encode('Pt', { shx: 1, shy: 2 }));
    optimize(writes, p);
    expect(allocated(() => writes(p, N))).toBeLessThan(NONE);
  });

  it('reading decoded numbers in a hot loop allocates nothing once warm', () => {
    // Small integers are Smis, read straight; a u32 past 2^30 makes its field an unboxed double,
    // read into arithmetic or a Float64Array without a box. (Passing such a double to a call the
    // JIT doesn't inline, or storing it in an array of any value, boxes it: see the README.)
    const s = defineTypes({
      roots: ['Pt', 'Big'],
      types: {
        Pt: pts.types.Pt!,
        Big: {
          struct: [
            ['bga', 'u32'],
            ['bgb', 'u32'],
          ],
        },
      },
    });
    const small = [
      s.decode<Pt>('Pt', s.encode('Pt', { shx: 1, shy: -2 })),
      s.decode<Pt>('Pt', s.encode('Pt', { shx: 300, shy: 4 })),
    ];
    interface Big {
      bga: number;
      bgb: number;
    }
    const big = [
      s.decode<Big>('Big', s.encode('Big', { bga: 3_000_000_000, bgb: 5 })),
      s.decode<Big>('Big', s.encode('Big', { bga: 7, bgb: 4_000_000_000 })),
    ];
    const out = new Float64Array(3);
    const readSmall = (ps: readonly Pt[], n: number): void => {
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const p = ps[i & 1]!;
        acc += p.shx * 0.5 + p.shy;
        out[0] = p.shx;
      }
      out[2] = acc;
    };
    const readBig = (ps: readonly Big[], n: number): void => {
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const p = ps[i & 1]!;
        acc += p.bga * 0.5 + p.bgb;
        out[1] = p.bga;
      }
      out[2] = acc;
    };
    optimize(readSmall, small);
    optimize(readBig, big);
    expect(allocated(() => readSmall(small, N))).toBeLessThan(NONE);
    expect(allocated(() => readBig(big, N))).toBeLessThan(NONE);
  });

  it('(control) an object literal of the same names would box them', () => {
    // What a schema written as objects does to the game: the hazard the lists avoid.
    const desc = { ctx: 'i32', cty: 'i32' };
    defineTypes({ roots: ['C'], types: { C: { struct: desc } } });
    const p = { ctx: 0.5, cty: 0.5 };
    const run = (_: unknown, n: number) => {
      for (let i = 0; i < n; i++) {
        p.ctx = i + 0.5;
        p.cty = i * 0.25;
      }
    };
    optimize(run, p);
    expect(allocated(() => run(p, N))).toBeGreaterThan(NONE);
  });
});

describe('queryApis', () => {
  it("gives a query's codecs over the schema, built on first use", () => {
    let built = 0;
    let s: ReturnType<typeof defineTypes> | null = null;
    const schema = () => {
      if (s === null) {
        built++;
        s = defineTypes({
          roots: [],
          types: { Pt: pts.types.Pt! },
          queries: { pt_at: { args: [['id', 'u32']], result: 'Pt' } },
        });
      }
      return s;
    };
    const api = queryApis<{ ptAt: QueryApi<{ id: number }, Pt> }>(schema, {
      ptAt: ['pt_at', true],
    });
    expect(built).toBe(0);
    expect(api.ptAt.name).toBe('pt_at');
    expect(api.ptAt.player).toBe(true);
    expect(built).toBe(0);
    expect(api.ptAt.result).toStrictEqual({ named: 'Pt' });
    expect([...api.ptAt.encodeArgs({ id: 7 })]).toEqual([7]);
    const bytes = api.ptAt.encodeResult({ shx: -1, shy: 2 });
    expect(api.ptAt.decodeResult(bytes)).toStrictEqual({ shx: -1, shy: 2 });
    expect(built).toBe(1);
    expect(
      () => queryApis<{ x: QueryApi<unknown, unknown> }>(schema, { x: ['nope', false] }).x.result,
    ).toThrow('the schema has no query nope');
  });
});
