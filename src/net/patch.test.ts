import { describe, expect, it } from 'vitest';
import { applyPatch, diffValues, PatchError } from './patch';
import { defineTypes, typeRef } from './schema';

const schema = defineTypes({
  roots: ['Board'],
  types: {
    Board: {
      struct: {
        title: 'String',
        scores: { map: ['String', 'i32'] },
        state: 'State',
        long: { vec: 'u32' },
        best: { option: 'Pair' },
      },
    },
    Pair: { struct: { a: 'u32', b: 'u32' } },
    State: { enum: { Idle: null, Playing: { round: 'u32', name: 'String' }, Over: ['u32'] } },
  },
});
const ty = typeRef('Board');

const SCORES = new Map<string, number>(Array.from({ length: 12 }, (_, i) => [`player ${i}`, i]));

function board(over: Partial<Record<string, unknown>> = {}) {
  return {
    title: 'a long enough title to make a Set costly',
    scores: SCORES,
    state: { type: 'Playing', round: 1, name: 'first round of many' },
    long: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    best: { a: 1, b: 2 },
    ...over,
  };
}

function roundTrip(a: unknown, b: unknown) {
  const ea = schema.encode('Board', a);
  const eb = schema.encode('Board', b);
  const ops = diffValues(schema.types, ty, ea, eb);
  expect(applyPatch(schema.types, ty, ea, ops)).toEqual(eb);
  return ops;
}

describe('patches', () => {
  it('is empty for equal values', () => {
    expect(roundTrip(board(), board())).toEqual([]);
  });

  it('puts and removes map entries instead of resending the map', () => {
    const ops = roundTrip(
      board(),
      board({
        scores: new Map([...[...SCORES].filter(([k]) => k !== 'player 3'), ['newcomer', 5]]),
      }),
    );
    expect(ops.map((o) => o.type).sort()).toEqual(['MapPut', 'MapRemove']);
  });

  it('reaches into a variant for one field', () => {
    const ops = roundTrip(
      board(),
      board({ state: { type: 'Playing', round: 2, name: 'first round of many' } }),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.path.map((s) => s.type)).toEqual(['Field', 'Variant']);
    roundTrip(board(), board({ best: { a: 1, b: 9 } }));
  });

  it('falls back to a Set where that is smaller, or the shape changed', () => {
    const ops = roundTrip(board(), board({ state: { type: 'Over', value: 3 } }));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe('Set');
    roundTrip(board(), board({ best: null }));
    roundTrip(board({ best: null }), board());
    roundTrip(board(), board({ long: [1] }));
    roundTrip(board(), board({ title: 'b' }));
  });

  it("refuses a patch that doesn't fit", () => {
    const ea = schema.encode('Board', board());
    expect(() =>
      applyPatch(schema.types, ty, ea, [
        { type: 'Set', path: [{ type: 'Field', index: 9 }], value: new Uint8Array() },
      ]),
    ).toThrow(PatchError);
    expect(() =>
      applyPatch(schema.types, ty, ea, [
        {
          type: 'MapRemove',
          path: [{ type: 'Field', index: 1 }],
          key: schema.encode('String', 'nobody'),
        },
      ]),
    ).toThrow(PatchError);
  });
});
