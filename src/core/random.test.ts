import { describe, expect, it } from 'vitest';
import { createRandom, seedKey } from './random';

function draws(seed: number | string, n: number): number[] {
  const r = createRandom(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.next());
  return out;
}

/** The harness checksum (harness/core2.ts): FNV-1a over the u32s of the first 100 draws. */
function checksum(seed: string): number {
  const r = createRandom(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < 100; i++) h = Math.imul(h ^ Math.floor(r.next() * 4294967296), 0x01000193);
  return h >>> 0;
}

describe('createRandom', () => {
  it('replays byte-identical sequences for a seed', () => {
    const a = new Float64Array(draws(42, 1000));
    const b = new Float64Array(draws(42, 1000));
    expect(new Uint8Array(a.buffer)).toEqual(new Uint8Array(b.buffer));
    expect(draws('seed', 50)).toEqual(draws('seed', 50));
    expect(draws(42, 10)).not.toEqual(draws(43, 10));
    expect(draws('a', 10)).not.toEqual(draws('b', 10));
  });

  it('pins the generator and the seed hash', () => {
    // FNV-1a 32 reference values.
    expect(seedKey('')).toBe(0x811c9dc5);
    expect(seedKey('a')).toBe(0xe40c292c);
    expect(seedKey('foobar')).toBe(0xbf9cf968);
    expect(seedKey(7)).toBe(7);
    expect(seedKey(-1)).toBe(0xffffffff);
    // xoshiro128** reference outputs from the state [1, 2, 3, 4].
    const x = createRandom(0);
    x.state = new Uint32Array([1, 2, 3, 4]);
    const u32 = () => x.next() * 4294967296;
    expect([u32(), u32(), u32(), u32()]).toEqual([11520, 0, 5927040, 70819200]);
    // A golden for the harness page: e2e/core2.spec.ts asserts the same number.
    expect(checksum('core2')).toBe(CORE2_CHECKSUM);
  });

  it('keeps next() in [0, 1) and int() inclusive', () => {
    const r = createRandom(1);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const k = r.int(1, 6);
      expect(Number.isInteger(k)).toBe(true);
      seen.add(k);
      const f = r.float(-2, 3);
      expect(f).toBeGreaterThanOrEqual(-2);
      expect(f).toBeLessThan(3);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.int(5, 5)).toBe(5);
  });

  it('fork is independent of calls on the parent', () => {
    const p1 = createRandom('world');
    const a = p1.fork('a');
    const p2 = createRandom('world');
    for (let i = 0; i < 37; i++) p2.next();
    const b = p2.fork('a');
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 20; i++) {
      xs.push(a.next());
      ys.push(b.next());
      p2.next();
    }
    expect(xs).toEqual(ys);
    // Distinct names and the parent itself give distinct streams.
    const c = createRandom('world').fork('b');
    expect(c.next()).not.toBe(createRandom('world').fork('a').next());
    expect(createRandom('world').fork('a').next()).not.toBe(createRandom('world').next());
    // Forks of forks are stable too.
    expect(createRandom(3).fork('x').fork('y').next()).toBe(
      createRandom(3).fork('x').fork('y').next(),
    );
  });

  it('shuffle is unbiased over 10k runs within 2% on 4 elements', () => {
    const r = createRandom('shuffle');
    const counts = new Map<string, number>();
    const runs = 10_000;
    const arr = [0, 1, 2, 3];
    for (let i = 0; i < runs; i++) {
      arr[0] = 0;
      arr[1] = 1;
      arr[2] = 2;
      arr[3] = 3;
      r.shuffle(arr);
      const k = arr.join('');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(24);
    for (const n of counts.values()) expect(Math.abs(n / runs - 1 / 24)).toBeLessThan(0.02);
    // Per position, each value lands a quarter of the time.
    const pos = new Uint32Array(16);
    for (let i = 0; i < runs; i++) {
      const a = r.shuffle([0, 1, 2, 3]);
      for (let j = 0; j < 4; j++) pos[j * 4 + a[j]!]!++;
    }
    for (const n of pos) expect(Math.abs(n / runs - 0.25)).toBeLessThan(0.02);
  });

  it('state round-trips', () => {
    const r = createRandom('save');
    for (let i = 0; i < 10; i++) r.next();
    const saved = r.state;
    expect(saved).toBeInstanceOf(Uint32Array);
    expect(saved.length).toBe(4);
    const ahead = [r.next(), r.int(0, 100), r.gaussian()];
    const q = createRandom('other');
    q.state = saved;
    expect([q.next(), q.int(0, 100), q.gaussian()]).toEqual(ahead);
    // The getter copies: mutating it does not move the stream.
    saved[0] = 0;
    r.state = q.state;
    expect(r.next()).toBe(q.next());
    expect(() => {
      r.state = new Uint32Array(4);
    }).toThrow(RangeError);
  });

  it('pick, weighted, bool, gaussian and unit vectors', () => {
    const r = createRandom(9);
    expect(() => r.pick([])).toThrow(RangeError);
    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) expect(items).toContain(r.pick(items));
    expect(r.weighted([0, 0])).toBe(-1);
    const hits = [0, 0, 0];
    for (let i = 0; i < 6000; i++) hits[r.weighted([1, 0, 3])]!++;
    expect(hits[1]).toBe(0);
    expect(hits[2]! / hits[0]!).toBeGreaterThan(2.6);
    expect(hits[2]! / hits[0]!).toBeLessThan(3.4);
    let t = 0;
    for (let i = 0; i < 4000; i++) if (r.bool(0.25)) t++;
    expect(t / 4000).toBeGreaterThan(0.22);
    expect(t / 4000).toBeLessThan(0.28);
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < 20000; i++) {
      const g = r.gaussian(10, 2);
      sum += g;
      sq += g * g;
    }
    const mean = sum / 20000;
    expect(mean).toBeCloseTo(10, 1);
    expect(Math.sqrt(sq / 20000 - mean * mean)).toBeCloseTo(2, 1);
    const v2 = new Float32Array(2);
    const v3 = [0, 0, 0];
    for (let i = 0; i < 100; i++) {
      r.unitVec2(v2);
      expect(Math.hypot(v2[0]!, v2[1]!)).toBeCloseTo(1, 5);
      r.unitVec3(v3);
      expect(Math.hypot(v3[0]!, v3[1]!, v3[2]!)).toBeCloseTo(1, 9);
    }
  });
});

const CORE2_CHECKSUM = 156046407;
