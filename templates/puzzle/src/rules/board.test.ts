import { describe, expect, it } from 'vitest';
import { createBoard, isFaceUp, pairsLeft, phase, reveal, settle } from './board';
import { rng, shuffle } from './random';

/** Index of the other card with the same face as `index`. */
const partnerOf = (faces: readonly number[], index: number) =>
  faces.findIndex((f, i) => f === faces[index] && i !== index);

describe('random', () => {
  it('is deterministic per seed and in [0, 1)', () => {
    const a = rng(7);
    const b = rng(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(rng(7)()).not.toBe(rng(8)());
  });

  it('shuffle keeps every item once and does not touch the input', () => {
    const items = [1, 2, 3, 4, 5, 6];
    const out = shuffle(items, rng(1));
    expect(items).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.slice().sort()).toEqual(items);
  });
});

describe('createBoard', () => {
  it('deals every face exactly twice, face down, from a seed', () => {
    const b = createBoard(4, 4, 42);
    expect(b.faces).toHaveLength(16);
    for (let face = 0; face < 8; face++) {
      expect(b.faces.filter((f) => f === face)).toHaveLength(2);
    }
    expect(b.matched.every((m) => !m)).toBe(true);
    expect(b.up).toEqual([]);
    expect(b.moves).toBe(0);
    expect(phase(b)).toBe('first');
    expect(pairsLeft(b)).toBe(8);
    expect(createBoard(4, 4, 42).faces).toEqual(b.faces);
    expect(createBoard(4, 4, 43).faces).not.toEqual(b.faces);
  });

  it('refuses an odd number of cells', () => {
    expect(() => createBoard(3, 3, 1)).toThrow(/even/);
  });
});

describe('reveal', () => {
  const b0 = createBoard(4, 2, 3);

  it('turns one card, then a matching second card stays up as a pair', () => {
    const b1 = reveal(b0, 0);
    expect(phase(b1)).toBe('second');
    expect(isFaceUp(b1, 0)).toBe(true);
    expect(b1.moves).toBe(0);
    expect(b0.up).toEqual([]); // the input is untouched

    const b2 = reveal(b1, partnerOf(b1.faces, 0));
    expect(phase(b2)).toBe('first');
    expect(b2.matched[0]).toBe(true);
    expect(b2.up).toEqual([]);
    expect(b2.moves).toBe(1);
    expect(pairsLeft(b2)).toBe(3);
  });

  it('leaves a mismatch on the table until it settles', () => {
    const other = b0.faces.findIndex((f) => f !== b0.faces[0]);
    const b2 = reveal(reveal(b0, 0), other);
    expect(phase(b2)).toBe('mismatch');
    expect(b2.up).toEqual([0, other]);
    expect(b2.moves).toBe(1);

    const b3 = settle(b2);
    expect(phase(b3)).toBe('first');
    expect(b3.up).toEqual([]);
    expect(b3.matched.every((m) => !m)).toBe(true);
    expect(settle(b3)).toBe(b3); // nothing to settle: same object
  });

  it('settles a mismatch itself when the player keeps going', () => {
    const other = b0.faces.findIndex((f) => f !== b0.faces[0]);
    const b2 = reveal(reveal(b0, 0), other);
    const third = b0.faces.findIndex((_, i) => i !== 0 && i !== other);
    const b3 = reveal(b2, third);
    expect(b3.up).toEqual([third]);
    expect(phase(b3)).toBe('second');
  });

  it('ignores a card that is already up, a matched card and an index off the board', () => {
    const b1 = reveal(b0, 0);
    expect(reveal(b1, 0)).toBe(b1);
    expect(reveal(b1, -1)).toBe(b1);
    expect(reveal(b1, 99)).toBe(b1);
    const b2 = reveal(b1, partnerOf(b1.faces, 0));
    expect(reveal(b2, 0)).toBe(b2);
  });

  it('wins when every pair is matched and then ignores reveals', () => {
    let b = b0;
    for (let i = 0; i < b.faces.length; i++) {
      if (b.matched[i]) continue;
      b = reveal(reveal(b, i), partnerOf(b.faces, i));
    }
    expect(phase(b)).toBe('won');
    expect(b.moves).toBe(4);
    expect(pairsLeft(b)).toBe(0);
    expect(reveal(b, 0)).toBe(b);
  });
});
