import { describe, expect, it } from 'vitest';
import { createPool } from './pool';

interface Spark {
  id: number;
  life: number;
}

function sparks(opts: { initial?: number; max?: number } = {}) {
  let made = 0;
  const resets: number[] = [];
  const pool = createPool<Spark>({
    create: () => ({ id: made++, life: 0 }),
    reset: (s) => {
      resets.push(s.id);
      s.life = 0;
    },
    ...opts,
  });
  return { pool, resets, made: () => made };
}

describe('createPool', () => {
  it('creates up front and reuses the most recently released item first', () => {
    const { pool, resets, made } = sparks({ initial: 2 });
    expect(pool.size).toBe(2);
    expect(pool.live).toBe(0);
    const a = pool.acquire()!;
    const b = pool.acquire()!;
    const c = pool.acquire()!;
    expect(made()).toBe(3);
    a.life = 1;
    expect(pool.release(a)).toBe(true);
    expect(pool.release(c)).toBe(true);
    expect(resets).toEqual([a.id, c.id]);
    expect(a.life).toBe(0);
    expect(pool.acquire()).toBe(c);
    expect(pool.acquire()).toBe(a);
    expect(pool.acquire()).not.toBe(b);
    expect(made()).toBe(4);
    expect(pool.release(b)).toBe(true);
    expect(pool.release(b)).toBe(false);
    expect(pool.release({ id: 99, life: 0 })).toBe(false);
  });

  it('returns undefined past max', () => {
    const { pool } = sparks({ max: 3, initial: 10 });
    expect(pool.size).toBe(3);
    const got = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(got.every(Boolean)).toBe(true);
    expect(pool.acquire()).toBeUndefined();
    expect(pool.live).toBe(3);
    pool.release(got[1]!);
    expect(pool.acquire()).toBe(got[1]);
    expect(pool.size).toBe(3);
  });

  it('forEach sees only live items and tolerates releasing the current one', () => {
    const { pool } = sparks();
    const items = Array.from({ length: 6 }, () => pool.acquire()!);
    pool.release(items[1]!);
    pool.release(items[4]!);
    const seen: number[] = [];
    pool.forEach((s) => {
      seen.push(s.id);
    });
    expect(seen.sort()).toEqual([0, 2, 3, 5]);
    // Release the odd-numbered life values while iterating.
    for (const s of items) s.life = s.id;
    pool.forEach((s) => {
      if (s.life % 2 === 1) pool.release(s);
    });
    const left: number[] = [];
    pool.forEach((s) => {
      left.push(s.id);
    });
    expect(left.sort()).toEqual([0, 2]);
    expect(pool.live).toBe(2);
  });

  it('drain releases every live item', () => {
    const { pool, resets } = sparks();
    pool.acquire();
    pool.acquire();
    pool.drain();
    expect(pool.live).toBe(0);
    expect(pool.size).toBe(2);
    expect(resets.length).toBe(2);
    let visited = 0;
    pool.forEach(() => {
      visited++;
    });
    expect(visited).toBe(0);
  });
});
