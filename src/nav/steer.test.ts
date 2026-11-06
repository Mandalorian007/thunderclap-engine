import { describe, expect, it } from 'vitest';
import type { NavPoint } from './grid';
import { arrive, avoidDisc, separate, steer } from './steer';

const v: NavPoint = { x: 0, z: 0 };

describe('steer', () => {
  it('exposes the three helpers', () => {
    expect(steer.separate).toBe(separate);
    expect(steer.arrive).toBe(arrive);
    expect(steer.avoidDisc).toBe(avoidDisc);
  });
});

describe('separate', () => {
  it('pushes away from near neighbours, weighted by closeness', () => {
    separate({ x: 0, z: 0 }, [{ x: 1, z: 0 }], 2, v);
    expect(v.x).toBeCloseTo(-0.5, 6);
    expect(v.z).toBeCloseTo(0, 6);
    separate({ x: 0, z: 0 }, [{ x: 0, z: 0.5 }], 2, v);
    expect(v.z).toBeCloseTo(-0.75, 6);
    // Two opposite neighbours cancel; one at the edge or beyond adds nothing.
    separate(
      { x: 0, z: 0 },
      [
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 0, z: 2 },
        { x: 5, z: 5 },
      ],
      2,
      v,
    );
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(0, 6);
  });

  it('is zero with no neighbours and skips one on the same spot', () => {
    expect(separate({ x: 3, z: 3 }, [], 2, v)).toEqual({ x: 0, z: 0 });
    expect(separate({ x: 3, z: 3 }, [{ x: 3, z: 3 }], 2, v)).toEqual({ x: 0, z: 0 });
  });
});

describe('arrive', () => {
  it('runs at full speed outside the slow radius and eases in', () => {
    arrive({ x: 0, z: 0 }, { x: 10, z: 0 }, 4, 5, v);
    expect(v).toEqual({ x: 4, z: 0 });
    arrive({ x: 0, z: 0 }, { x: 0, z: 2.5 }, 4, 5, v);
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(2, 6);
    arrive({ x: 0, z: 0 }, { x: 3, z: 4 }, 10, 0, v);
    expect(v.x).toBeCloseTo(6, 6);
    expect(v.z).toBeCloseTo(8, 6);
  });

  it('is zero at the target', () => {
    expect(arrive({ x: 1, z: 1 }, { x: 1, z: 1 }, 4, 5, v)).toEqual({ x: 0, z: 0 });
  });
});

describe('avoidDisc', () => {
  it('leaves a clear course, a disc behind and a stopped agent alone', () => {
    expect(avoidDisc({ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 5, z: 3, radius: 1 }, v)).toEqual({
      x: 2,
      z: 0,
    });
    expect(avoidDisc({ x: 0, z: 0 }, { x: 2, z: 0 }, { x: -3, z: 0, radius: 1 }, v)).toEqual({
      x: 2,
      z: 0,
    });
    expect(avoidDisc({ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 10, z: 0, radius: 1 }, v)).toEqual({
      x: 2,
      z: 0,
    });
    expect(avoidDisc({ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0, radius: 1 }, v)).toEqual({
      x: 0,
      z: 0,
    });
  });

  it('pushes sideways away from a disc on the course, more the deeper it cuts', () => {
    // Centre a little to +z of the course: push towards -z.
    avoidDisc({ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 1, z: 0.5, radius: 1 }, v);
    expect(v.x).toBeCloseTo(2, 6);
    expect(v.z).toBeCloseTo(-1, 6);
    // Centre to -z: push towards +z, and a graze pushes less.
    avoidDisc({ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 1, z: -0.9, radius: 1 }, v);
    expect(v.z).toBeCloseTo(0.2, 6);
    // Dead ahead: full-speed push, to one side, deterministic.
    avoidDisc({ x: 0, z: 0 }, { x: 0, z: 3 }, { x: 0, z: 2, radius: 1 }, v);
    expect(Math.abs(v.x)).toBeCloseTo(3, 6);
    expect(v.z).toBeCloseTo(3, 6);
    // `out` may alias `velocity`.
    const vel: NavPoint = { x: 2, z: 0 };
    avoidDisc({ x: 0, z: 0 }, vel, { x: 1, z: 0.5, radius: 1 }, vel);
    expect(vel.z).toBeCloseTo(-1, 6);
  });
});
