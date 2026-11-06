import { describe, expect, it } from 'vitest';
import { Follow, type FollowCamera, type FollowOptions } from './follow';
import type { Look } from './look';
import type { Vec3 } from './rays';

/** A camera that records the last `lookAt`. */
function fakeCamera() {
  const eye: Vec3 = [0, 0, 0];
  const at: Vec3 = [0, 0, 0];
  let calls = 0;
  const camera: FollowCamera = {
    lookAt(e, t) {
      eye[0] = e[0]!;
      eye[1] = e[1]!;
      eye[2] = e[2]!;
      at[0] = t[0]!;
      at[1] = t[1]!;
      at[2] = t[2]!;
      calls++;
      return camera as never;
    },
  };
  return {
    camera,
    eye,
    at,
    get calls() {
      return calls;
    },
  };
}

/** A `Look` stand-in: only `look` is read. */
function fakeLook(): Look {
  return { look: { dx: 0, dy: 0 } } as unknown as Look;
}

function setup(opts: FollowOptions = {}) {
  const cam = fakeCamera();
  const follow = new Follow(cam.camera, opts);
  const target = { position: [0, 0, 0] as Vec3, yaw: 0 };
  follow.target = target;
  const look = fakeLook();
  follow.setLook(look);
  return { cam, follow, target, look };
}

describe('Follow: third person', () => {
  it('places the eye `distance` behind the pivot along the view and looks at the pivot', () => {
    const { cam, follow } = setup({ distance: 4, eyeHeight: 1.5, pitch: 0, smoothing: 0 });
    follow.update(1 / 60);
    // Yaw 0 looks down -z: the camera sits at +z, behind.
    expect(follow.position).toEqual([0, 1.5, 4]);
    expect(cam.eye).toEqual([0, 1.5, 4]);
    expect(cam.at).toEqual([0, 1.5, 0]);
    expect(follow.currentDistance).toBe(4);
    expect(cam.calls).toBe(1);
  });

  it('a negative pitch raises the camera above the pivot', () => {
    const { follow } = setup({ distance: 4, pitch: -0.5, smoothing: 0 });
    follow.update(1 / 60);
    expect(follow.position[1]).toBeGreaterThan(follow.pivot[1]);
    expect(follow.position[2]).toBeCloseTo(4 * Math.cos(0.5));
  });

  it('reads the look deltas as yaw and pitch; yaw turns the orbit', () => {
    const { follow, look } = setup({ distance: 2, pitch: 0, smoothing: 0 });
    look.look.dx = Math.PI / 2;
    follow.update(1 / 60);
    expect(follow.yaw).toBeCloseTo(Math.PI / 2);
    // Looking towards +x puts the camera at -x.
    expect(follow.position[0]).toBeCloseTo(-2);
    expect(follow.position[2]).toBeCloseTo(0);
    look.look.dx = 0;
    look.look.dy = 0.3;
    follow.update(1 / 60);
    expect(follow.pitch).toBeCloseTo(0.3);
  });

  it('clamps the pitch to pitchMin..pitchMax', () => {
    const { follow, look } = setup({ pitchMin: -0.5, pitchMax: 0.4, pitch: 0 });
    look.look.dy = 3;
    follow.update(1 / 60);
    expect(follow.pitch).toBe(0.4);
    look.look.dy = -3;
    follow.update(1 / 60);
    expect(follow.pitch).toBe(-0.5);
  });

  it('the shoulder offset shifts the pivot along the camera right and up', () => {
    const { follow } = setup({ distance: 3, pitch: 0, shoulder: [0.5, 0.25], smoothing: 0 });
    follow.update(1 / 60);
    expect(follow.pivot[0]).toBeCloseTo(0.5);
    expect(follow.pivot[1]).toBeCloseTo(1.6 + 0.25);
    expect(follow.position[0]).toBeCloseTo(0.5);
  });

  it('smoothing converges on a moved target without overshooting', () => {
    const { follow, target } = setup({ distance: 2, pitch: 0, smoothing: 0.1 });
    follow.update(1 / 60);
    expect(follow.pivot[0]).toBe(0);
    target.position[0] = 10;
    follow.update(1 / 60);
    const first = follow.pivot[0];
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(10);
    let last = first;
    for (let i = 0; i < 120; i++) {
      follow.update(1 / 60);
      expect(follow.pivot[0]).toBeGreaterThanOrEqual(last);
      expect(follow.pivot[0]).toBeLessThanOrEqual(10);
      last = follow.pivot[0];
    }
    expect(last).toBeCloseTo(10, 3);
    // `snap` forgets the lag.
    target.position[0] = -5;
    follow.snap();
    follow.update(1 / 60);
    expect(follow.pivot[0]).toBe(-5);
  });

  it('an obstacle shortens the distance to the hit minus the margin; it snaps in and eases out', () => {
    let wall: number | null = 1.5; // a plane at z = wall, between pivot (z 0) and the camera (z 4)
    const seen: { from: Vec3; to: Vec3 }[] = [];
    const { follow } = setup({
      distance: 4,
      pitch: 0,
      margin: 0.2,
      smoothing: 0.1,
      obstacle(from, to, out) {
        seen.push({ from: [...from] as Vec3, to: [...to] as Vec3 });
        if (wall === null) return false;
        out[0] = from[0];
        out[1] = from[1];
        out[2] = wall;
        return true;
      },
    });
    follow.update(1 / 60);
    expect(seen[0]?.from).toEqual([0, 1.6, 0]);
    expect(seen[0]?.to).toEqual([0, 1.6, 4]);
    expect(follow.currentDistance).toBeCloseTo(1.3);
    expect(follow.position[2]).toBeCloseTo(1.3);
    expect(follow.distance).toBe(4);
    wall = null;
    follow.update(1 / 60);
    expect(follow.currentDistance).toBeGreaterThan(1.3);
    expect(follow.currentDistance).toBeLessThan(4);
    for (let i = 0; i < 200; i++) follow.update(1 / 60);
    expect(follow.currentDistance).toBeCloseTo(4, 3);
  });

  it('an obstacle at the pivot leaves the camera on the pivot looking forward', () => {
    const { cam, follow } = setup({
      distance: 4,
      pitch: 0,
      smoothing: 0,
      obstacle(from, _to, out) {
        out[0] = from[0];
        out[1] = from[1];
        out[2] = from[2];
        return true;
      },
    });
    follow.update(1 / 60);
    expect(follow.currentDistance).toBe(0);
    expect(cam.eye).toEqual([0, 1.6, 0]);
    expect(cam.at[2]).toBeCloseTo(-1);
  });

  it('zoom steps the distance within min..max', () => {
    const { follow } = setup({ distance: 4, minDistance: 2, maxDistance: 5, zoomStep: 1 });
    follow.zoom(1);
    expect(follow.distance).toBe(5);
    follow.zoom(1);
    expect(follow.distance).toBe(5);
    follow.zoom(-10);
    expect(follow.distance).toBe(2);
  });

  it('realign eases the yaw back to target.yaw only while the look is still', () => {
    const { follow, target, look } = setup({ realign: 0.1, pitch: 0 });
    target.yaw = 1;
    look.look.dx = 0.01;
    follow.update(1 / 60);
    expect(follow.yaw).toBeCloseTo(0.01);
    look.look.dx = 0;
    for (let i = 0; i < 120; i++) follow.update(1 / 60);
    expect(follow.yaw).toBeCloseTo(1, 3);
  });
});

describe('Follow: first person', () => {
  it('puts the eye at target + eyeHeight looking along yaw/pitch, with no lag', () => {
    const { cam, follow, target, look } = setup({ eyeHeight: 1.7, pitch: 0, mode: 'first' });
    target.position[0] = 3;
    target.position[2] = -2;
    look.look.dx = Math.PI / 2;
    follow.update(1 / 60);
    expect(follow.position).toEqual([3, 1.7, -2]);
    expect(cam.eye).toEqual([3, 1.7, -2]);
    expect(cam.at[0]).toBeCloseTo(4);
    expect(cam.at[1]).toBeCloseTo(1.7);
    expect(cam.at[2]).toBeCloseTo(-2);
    expect(follow.currentDistance).toBe(0);
  });

  it('toggles with one assignment and back, keeping yaw and pitch', () => {
    const { follow, look } = setup({ distance: 3, pitch: 0, smoothing: 0 });
    look.look.dx = 0.5;
    follow.update(1 / 60);
    look.look.dx = 0;
    follow.mode = 'first';
    follow.update(1 / 60);
    expect(follow.yaw).toBeCloseTo(0.5);
    expect(follow.position[1]).toBeCloseTo(1.6);
    expect(follow.position[2]).toBeCloseTo(0);
    follow.mode = 'third';
    follow.update(1 / 60);
    expect(follow.currentDistance).toBe(3);
    expect(Math.hypot(follow.position[0], follow.position[2])).toBeCloseTo(3);
  });

  it('ignores the shoulder and obstacle in first person', () => {
    let asked = 0;
    const { follow } = setup({
      mode: 'first',
      shoulder: [1, 1],
      obstacle() {
        asked++;
        return true;
      },
    });
    follow.update(1 / 60);
    expect(asked).toBe(0);
    expect(follow.position).toEqual([0, 1.6, 0]);
  });
});
