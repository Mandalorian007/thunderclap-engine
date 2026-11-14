import { describe, expect, it } from 'vitest';
import { Optimistic } from './optimistic';

function store() {
  const cells = new Map<string, number>([
    ['a', 1],
    ['b', 2],
  ]);
  return {
    cells,
    read: (k: string) => cells.get(k),
    write: (k: string, v: number) => cells.set(k, v),
  };
}

describe('Optimistic', () => {
  it('shows an edit at once and keeps it when taken', () => {
    const s = store();
    const o = new Optimistic(s);
    const settle = o.edit('a', 5);
    expect(s.cells.get('a')).toBe(5);
    expect(o.has('a')).toBe(true);
    expect(settle(true)).toBe(false);
    expect(s.cells.get('a')).toBe(5);
    expect(o.size).toBe(0);
  });

  it("rolls a refused edit back to the server's value, under stacked edits", () => {
    const s = store();
    const o = new Optimistic(s);
    const first = o.edit('a', 5);
    const second = o.edit('a', 6);
    expect(o.confirmed('a')).toBe(1);
    // Another player set it meanwhile: the server's value is now 3.
    o.confirm('a', 3);
    s.cells.set('a', 3);
    s.cells.set('a', 6);
    expect(second(false)).toBe(true);
    expect(s.cells.get('a')).toBe(3);
    expect(first(true)).toBe(false);
    expect(first(false)).toBe(false);
    expect(o.rollbacks).toBe(1);
    expect(o.size).toBe(0);
  });

  it('runs a command around an edit, and predicts nothing where nothing is', async () => {
    const s = store();
    const o = new Optimistic(s);
    expect(await o.run('b', 9, () => Promise.reject(new Error('no')))).toBe(false);
    expect(s.cells.get('b')).toBe(2);
    expect(await o.run('b', 9, () => Promise.resolve())).toBe(true);
    expect(s.cells.get('b')).toBe(9);
    expect(o.edit('zz', 1)(false)).toBe(false);
    expect(s.cells.has('zz')).toBe(false);
    o.edit('a', 4);
    o.clear();
    expect(o.size).toBe(0);
  });
});
