import { describe, expect, it } from 'vitest';
import { Predictor } from './predict';

// A 1D walker: input is a move; the server may clamp to a wall the client doesn't know about.
interface S {
  x: number;
}
const step = (s: S, dx: number): S => ({ x: s.x + dx });
const equal = (a: S, b: S) => a.x === b.x;
const distance = (a: S, b: S) => Math.abs(a.x - b.x);

function make() {
  const t = { ms: 0 };
  const p = new Predictor<S, number>({
    step,
    equal,
    distance,
    start: { seq: 0, state: { x: 0 } },
    now: () => t.ms,
  });
  return { t, p };
}

describe('Predictor', () => {
  it('moves at once and, when the server agrees, corrects nothing', () => {
    const { t, p } = make();
    expect(p.apply(1)).toBe(1);
    expect(p.apply(1)).toBe(2);
    expect(p.state.x).toBe(2);
    expect(p.pending).toBe(2);
    t.ms = 80;
    expect(p.acknowledge(1, { x: 1 })).toBeNull();
    expect(p.acknowledge(2, { x: 2 })).toBeNull();
    expect(p.pending).toBe(0);
    expect(p.correctionCount).toBe(0);
    expect(p.roundTrips).toEqual([80, 80]);
  });

  it("snaps to the server's state and replays what is in flight when it disagrees", () => {
    const { t, p } = make();
    p.apply(1);
    p.apply(1);
    p.apply(1);
    t.ms = 100;
    // A wall at 0.5: the server's state after input 1 is 0.5.
    const c = p.acknowledge(1, { x: 0.5 });
    expect(c).toEqual({ seq: 1, distance: 0.5, at: 100 });
    expect(p.state.x).toBe(2.5);
    expect(p.previous.x).toBe(2.5);
    expect(p.pending).toBe(2);
    // The replayed predictions are what the later acknowledgements are checked against.
    expect(p.acknowledge(2, { x: 1.5 })).toBeNull();
    expect(p.correctionsWithin(1000)).toBe(1);
  });

  it('counts a lost input as a correction, and a server move as a reset', () => {
    const { p } = make();
    p.apply(1);
    p.apply(1);
    // Input 1 never arrived: the server's state after 2 is only one move on.
    expect(p.acknowledge(2, { x: 1 })?.seq).toBe(2);
    expect(p.correctionCount).toBe(1);
    p.expectReset();
    p.apply(1);
    expect(p.acknowledge(3, { x: 50 })).toBeNull();
    expect(p.resets).toBe(1);
    expect(p.state.x).toBe(50);
    // An acknowledgement for an input never predicted (after connecting) is a reset too.
    expect(p.acknowledge(9, { x: 7 })).toBeNull();
    expect(p.resets).toBe(2);
    expect(p.seq).toBe(9);
  });

  it('follows while another connection drives, and blends over a step', () => {
    const { t, p } = make();
    p.apply(1);
    p.follow(4, { x: 3 });
    expect(p.pending).toBe(0);
    expect(p.previous.x).toBe(1);
    expect(p.state.x).toBe(3);
    expect(p.seq).toBe(4);
    expect(p.alpha(t.ms)).toBe(0);
    expect(p.alpha(t.ms + 25)).toBe(0.5);
    expect(p.alpha(t.ms + 500)).toBe(1);
    p.apply(1);
    p.clear();
    expect(p.pending).toBe(0);
  });
});
