import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { createFollow2D } from './camera-2d';

const W = 1920;
const H = 1080;

function setup(opts: Parameters<typeof createFollow2D>[1] = {}) {
  const camera = Camera.ortho2d(W, H);
  const follow = createFollow2D(camera, opts);
  return { camera, follow };
}

describe('createFollow2D', () => {
  it('snaps to the target on the first update and writes camera.x / camera.y only', () => {
    const { camera, follow } = setup({ deadZone: { w: 200, h: 100 }, smoothing: 1 });
    camera.zoom = 1;
    follow.update(1 / 60, 1000, 700, 50, 0);
    expect([follow.x, follow.y]).toEqual([1000, 700]);
    expect([camera.x, camera.y]).toEqual([1000 - W / 2, 700 - H / 2]);
    expect(camera.zoom).toBe(1);
    expect(camera.rotation).toBe(0);
  });

  it('inside the dead zone nothing moves; leaving it moves the anchor exactly to the edge', () => {
    const { camera, follow } = setup({ deadZone: { w: 200, h: 100 } });
    follow.teleport(500, 500);
    const cx = camera.x;
    const cy = camera.y;
    follow.update(1 / 60, 590, 540);
    follow.update(1 / 60, 420, 460);
    expect([follow.x, follow.y]).toEqual([500, 500]);
    expect([camera.x, camera.y]).toEqual([cx, cy]);
    // 130 px right of the anchor: 30 px past the half-width of 100.
    follow.update(1 / 60, 630, 500);
    expect([follow.anchorX, follow.x]).toEqual([530, 530]);
    expect(camera.x).toBe(530 - W / 2);
    follow.update(1 / 60, 630, 400);
    expect([follow.anchorY, follow.y]).toEqual([450, 450]);
  });

  it('without a dead zone the view tracks the target', () => {
    const { follow } = setup();
    follow.update(0.1, 10, 20);
    follow.update(0.1, 11, 25);
    expect([follow.x, follow.y]).toEqual([11, 25]);
  });

  it('look-ahead eases toward the velocity sign, deterministic in dt', () => {
    const { follow } = setup({ lookAhead: { x: 100, y: 0 }, lookAheadSmoothing: 0.5 });
    follow.teleport(0, 0);
    follow.update(0.5, 0, 0, 3, 0);
    const k = 1 - Math.exp(-1);
    expect(follow.lookX).toBeCloseTo(100 * k, 10);
    expect(follow.x).toBeCloseTo(100 * k, 10);
    follow.update(0.5, 0, 0, 3, 0);
    expect(follow.lookX).toBeCloseTo(100 * (1 - Math.exp(-2)), 10);
    // Reverse: eases back toward -100; stop: toward 0.
    follow.update(0.5, 0, 0, -3, 0);
    expect(follow.lookX).toBeLessThan(100 * (1 - Math.exp(-2)));
    for (let i = 0; i < 60; i++) follow.update(0.5, 0, 0, -3, 0);
    expect(follow.lookX).toBeCloseTo(-100, 6);
    for (let i = 0; i < 60; i++) follow.update(0.5, 0, 0, 0, 0);
    expect(follow.lookX).toBeCloseTo(0, 6);
    // Instant look-ahead.
    const { follow: f2 } = setup({ lookAhead: { x: 40, y: 30 }, lookAheadSmoothing: 0 });
    f2.teleport(0, 0);
    f2.update(1 / 60, 0, 0, 1, -1);
    expect([f2.lookX, f2.lookY, f2.x, f2.y]).toEqual([40, -30, 40, -30]);
  });

  it('smoothing eases the view toward anchor + look-ahead', () => {
    const { follow } = setup({ smoothing: 1 });
    follow.teleport(0, 0);
    follow.update(1, 100, 0);
    expect(follow.anchorX).toBe(100);
    expect(follow.x).toBeCloseTo(100 * (1 - Math.exp(-1)), 10);
    // Two half steps land where one whole step does not (exponential, not linear), but both
    // are a function of dt alone.
    const { follow: a } = setup({ smoothing: 1 });
    const { follow: b } = setup({ smoothing: 1 });
    a.teleport(0, 0);
    b.teleport(0, 0);
    a.update(1, 100, 0);
    b.update(0.5, 100, 0);
    b.update(0.5, 100, 0);
    expect(b.x).toBeCloseTo(a.x, 10);
  });

  it('clamps the view rect to the bounds at a corner, after the look-ahead', () => {
    const { camera, follow } = setup({
      lookAhead: { x: 300, y: 300 },
      lookAheadSmoothing: 0,
      bounds: { minX: 0, minY: 0, maxX: 4000, maxY: 3000 },
    });
    follow.teleport(-500, -500);
    expect([follow.x, follow.y]).toEqual([W / 2, H / 2]);
    expect([camera.x, camera.y]).toEqual([0, 0]);
    follow.update(1 / 60, 3900, 2900, 1, 1);
    expect([follow.lookX, follow.lookY]).toEqual([300, 300]);
    expect([follow.x, follow.y]).toEqual([4000 - W / 2, 3000 - H / 2]);
    expect([camera.x, camera.y]).toEqual([4000 - W, 3000 - H]);
    // Zoomed in, the view is smaller and the centre may come closer to the edge.
    camera.zoom = 2;
    follow.update(1 / 60, 3900, 2900, 1, 1);
    expect([follow.x, follow.y]).toEqual([4000 - W / 4, 3000 - H / 4]);
    // Bounds narrower than the view: centred.
    follow.bounds = { minX: 100, minY: 100, maxX: 500, maxY: 300 };
    camera.zoom = 1;
    follow.update(1 / 60, 0, 0);
    expect([follow.x, follow.y]).toEqual([300, 200]);
  });

  it('teleport has no easing and drops the look-ahead', () => {
    const { camera, follow } = setup({
      smoothing: 2,
      lookAhead: { x: 100, y: 0 },
      lookAheadSmoothing: 0,
    });
    follow.update(1 / 60, 0, 0, 1, 0);
    follow.update(1 / 60, 0, 0, 1, 0);
    expect(follow.lookX).toBe(100);
    follow.teleport(2000, 1500);
    expect([follow.x, follow.y, follow.lookX, follow.anchorX]).toEqual([2000, 1500, 0, 2000]);
    expect([camera.x, camera.y]).toEqual([2000 - W / 2, 1500 - H / 2]);
  });

  it('snapOnStart false starts from the camera position and eases in', () => {
    const camera = Camera.ortho2d(W, H);
    camera.x = 100;
    camera.y = 50;
    const follow = createFollow2D(camera, { snapOnStart: false, smoothing: 1 });
    expect([follow.x, follow.y]).toEqual([100 + W / 2, 50 + H / 2]);
    follow.update(1, 100 + W / 2 + 100, 50 + H / 2);
    expect(follow.x).toBeCloseTo(100 + W / 2 + 100 * (1 - Math.exp(-1)), 10);
  });
});
