import { describe, expect, it } from 'vitest';
import { EntityEncoder, EntityStream, EntityStreamError, MAX_VIEW_FIELDS } from './entities';
import { defineTypes } from './schema';
import { Writer } from './wire';

const schema = defineTypes({
  roots: ['Ghost'],
  types: {
    Ghost: { struct: { x: 'i32', y: 'i32', name: 'String', hat: { option: 'u8' } } },
  },
});

type Ghost = { x: number; y: number; name: string; hat: number | null };

describe('entity stream', () => {
  it('sends things whole, then only the fields that changed, then their going', () => {
    const enc = new EntityEncoder<Ghost>(schema, 'Ghost');
    const dec = new EntityStream<Ghost>(schema, 'Ghost');
    const things = new Map<number, Ghost>([
      [1, { x: 0, y: 0, name: 'ann', hat: null }],
      [2, { x: 5, y: 5, name: 'bo', hat: 3 }],
    ]);
    const key = enc.frame(10, things)!;
    expect(key[0]).toBe(1);
    const c1 = dec.apply(key)!;
    expect(c1.key).toBe(true);
    expect(c1.changed).toEqual([1, 2]);
    expect(dec.get(2)).toEqual({ x: 5, y: 5, name: 'bo', hat: 3 });
    expect(enc.frame(11, things)).toBeNull();
    things.set(1, { x: 1, y: 0, name: 'ann', hat: null });
    things.delete(2);
    const delta = enc.frame(12, things)!;
    // flags, tick, count, [id 1, bits x, x=1 (zigzag 2)], [id 2, gone]
    expect([...delta]).toEqual([0, 12, 2, 1, 4, 2, 2, 1]);
    const c2 = dec.apply(delta)!;
    expect(c2.changed).toEqual([1]);
    expect(c2.gone).toEqual([2]);
    expect(dec.tick).toBe(12);
    expect([...dec.entities.keys()]).toEqual([1]);
    expect(dec.get(1)!.x).toBe(1);
  });

  it('refuses what does not fit, then waits for a key frame', () => {
    const enc = new EntityEncoder<Ghost>(schema, 'Ghost');
    const dec = new EntityStream<Ghost>(schema, 'Ghost');
    dec.apply(enc.frame(1, new Map([[1, { x: 0, y: 0, name: 'a', hat: null }]]))!);
    const bad = (bytes: number[]) =>
      expect(() => dec.apply(new Uint8Array(bytes))).toThrow(EntityStreamError);
    bad([0, 2, 1, 9, 4]); // changed but not held
    expect(dec.waiting).toBe(true);
    expect(dec.apply(new Uint8Array([0, 3, 0]))).toBeNull();
    enc.resync();
    const key = enc.frame(4, new Map([[2, { x: 1, y: 1, name: 'b', hat: 1 }]]))!;
    expect(dec.apply(key)!.gone).toEqual([1]);
    expect(dec.waiting).toBe(false);
    bad([4, 1, 0]); // unknown flag
    dec.apply(key);
    bad([0, 5, 1, 2, 1 << 6]); // unknown field bit
    dec.apply(key);
    bad([0, 5, 1, 2, 1 | 4]); // gone with fields
    dec.apply(key);
    bad([1, 5, 1, 2, 1]); // gone in a key frame
    dec.apply(key);
    bad([0, 5, 1, 2, 4, 2, 0]); // trailing bytes
  });

  it('limits views to 29 fields', () => {
    const fields: Record<string, 'u8'> = {};
    for (let i = 0; i <= MAX_VIEW_FIELDS; i++) fields[`f${i}`] = 'u8';
    const big = defineTypes({ roots: ['Big'], types: { Big: { struct: fields } } });
    expect(() => new EntityStream(big, 'Big')).toThrow(/at most 29/);
    const w = new Writer();
    w.u8(0);
    expect(w.finish().length).toBe(1);
  });
});
