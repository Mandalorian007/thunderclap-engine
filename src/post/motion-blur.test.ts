/** Motion blur (ws/post-3): the velocity of a pixel under a pure camera yaw. */
import { describe, expect, it } from 'vitest';
import { mat4 } from '../core/math';
import { motionVelocity } from './motion-blur';
import { taaReprojection } from './taa';

describe('motion velocity', () => {
  const proj = mat4.perspective(mat4.create(), 1, 16 / 9, 0.1, 100);
  const viewProj = (yaw: number) => {
    const view = mat4.lookAt(
      mat4.create(),
      [0, 0, 0],
      [Math.sin(yaw), 0, -Math.cos(yaw)],
      [0, 1, 0],
    );
    return mat4.multiply(mat4.create(), proj, view);
  };
  const vel = new Float32Array(2);

  it('is zero when the camera is still', () => {
    const vp = viewProj(0);
    const m = taaReprojection(mat4.create(), vp, mat4.invert(mat4.create(), vp)!);
    motionVelocity(vel, m, 0.3, 0.7, 0.5);
    expect(vel[0]).toBeCloseTo(0, 5);
    expect(vel[1]).toBeCloseTo(0, 5);
  });

  it('a yaw to the right moves the centre pixel left: velocity points right, no vertical part', () => {
    const prev = viewProj(0);
    const cur = viewProj(0.05);
    const m = taaReprojection(mat4.create(), prev, mat4.invert(mat4.create(), cur)!);
    // The centre pixel at mid depth: it was to the right of centre last frame.
    motionVelocity(vel, m, 0.5, 0.5, 0.9);
    expect(vel[0]).toBeGreaterThan(0.01);
    expect(Math.abs(vel[1]!)).toBeLessThan(1e-4);
    // The opposite yaw mirrors it.
    const m2 = taaReprojection(mat4.create(), prev, mat4.invert(mat4.create(), viewProj(-0.05))!);
    const left = new Float32Array(2);
    motionVelocity(left, m2, 0.5, 0.5, 0.9);
    expect(left[0]).toBeCloseTo(-vel[0]!, 5);
  });

  it('a point behind the previous camera has no velocity', () => {
    const m = mat4.create();
    m[15] = -1; // w = -1 for every point
    motionVelocity(vel, m, 0.5, 0.5, 0.5);
    expect(Array.from(vel)).toEqual([0, 0]);
  });
});
