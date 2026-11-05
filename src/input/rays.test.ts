import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { type Aabb, aabbTester, createRay, planeTester, type Ray, rayAt, screenRay } from './rays';

function ray(o: [number, number, number], d: [number, number, number]): Ray {
  const r = createRay();
  const len = Math.hypot(...d);
  for (let i = 0; i < 3; i++) {
    r.origin[i] = o[i]!;
    r.dir[i] = d[i]! / len;
  }
  return r;
}

describe('screenRay', () => {
  it('ortho2d: the origin is the world point at z = 0 and the ray points +z', () => {
    const cam = Camera.ortho2d(800, 600);
    const r = createRay();
    expect(screenRay(cam, 100, 50, r)).toBe(true);
    expect(r.origin[0]).toBeCloseTo(100);
    expect(r.origin[1]).toBeCloseTo(50);
    expect(r.origin[2]).toBeCloseTo(0);
    expect(r.dir[0]).toBeCloseTo(0);
    expect(r.dir[1]).toBeCloseTo(0);
    expect(r.dir[2]).toBeCloseTo(1);
  });

  it('ortho2d follows pan and zoom', () => {
    const cam = Camera.ortho2d(800, 600);
    cam.zoom = 2;
    cam.x = 50;
    const r = createRay();
    screenRay(cam, 400, 300, r);
    // The view centre shows world (400 + 50, 300).
    expect(r.origin[0]).toBeCloseTo(450);
    expect(r.origin[1]).toBeCloseTo(300);
    screenRay(cam, 600, 300, r);
    expect(r.origin[0]).toBeCloseTo(550);
  });

  it('perspective: the centre ray goes from the eye down the view direction', () => {
    const cam = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
    cam.lookAt([0, 0, 10], [0, 0, 0]);
    const r = createRay();
    expect(screenRay(cam, 0.5, 0.5, r)).toBe(true);
    expect(r.origin[0]).toBeCloseTo(0);
    expect(r.origin[2]).toBeCloseTo(9.9, 3);
    expect(r.dir[2]).toBeCloseTo(-1);
    // Off centre: the ray leans to the right for a point right of centre.
    screenRay(cam, 0.75, 0.5, r);
    expect(r.dir[0]).toBeGreaterThan(0.1);
    expect(Math.hypot(...r.dir)).toBeCloseTo(1);
  });

  it('perspective with an infinite far plane still gives a ray', () => {
    const cam = Camera.perspective(Math.PI / 3, 1, 0.1, Infinity);
    const r = createRay();
    expect(screenRay(cam, 0.5, 0.5, r)).toBe(true);
    expect(r.dir[2]).toBeCloseTo(-1);
  });
});

describe('rayAt', () => {
  it('walks along the ray', () => {
    const out: [number, number, number] = [0, 0, 0];
    expect(rayAt(ray([1, 2, 3], [0, 0, 1]), 4, out)).toEqual([1, 2, 7]);
  });
});

describe('planeTester', () => {
  it('hits the plane where the ray crosses it, normal facing the ray', () => {
    const t = planeTester(0, 'ground');
    const h = t(ray([1, 2, 5], [0, 0, -1]));
    expect(h?.point).toEqual([1, 2, 0]);
    expect(h?.distance).toBeCloseTo(5);
    expect(h?.normal).toEqual([0, 0, 1]);
    expect(h?.target).toBe('ground');
  });

  it('through ortho2d it is the world point under the pointer at distance 0', () => {
    const cam = Camera.ortho2d(800, 600);
    const r = createRay();
    screenRay(cam, 123, 456, r);
    const h = planeTester()(r);
    expect(h?.point[0]).toBeCloseTo(123);
    expect(h?.point[1]).toBeCloseTo(456);
    expect(h?.distance).toBeCloseTo(0);
    expect(h?.target).toBeNull();
  });

  it('misses parallel rays and planes behind the origin', () => {
    const t = planeTester(0);
    expect(t(ray([0, 0, 1], [1, 0, 0]))).toBeNull();
    expect(t(ray([0, 0, 1], [0, 0, 1]))).toBeNull();
  });

  it('reuses one hit object', () => {
    const t = planeTester(2);
    const a = t(ray([0, 0, 0], [0, 0, 1]));
    const b = t(ray([1, 0, 0], [0, 0, 1]));
    expect(a).toBe(b);
    expect(b?.point).toEqual([1, 0, 2]);
  });
});

describe('aabbTester', () => {
  const boxes: Aabb<string>[] = [
    { min: [-1, -1, -1], max: [1, 1, 1], target: 'near' },
    { min: [-1, -1, -6], max: [1, 1, -4], target: 'far' },
    { min: [5, 5, -1], max: [6, 6, 1], target: 'aside' },
  ];
  const t = aabbTester(boxes);

  it('hits the nearest box with the entering face normal', () => {
    const h = t(ray([0, 0, 10], [0, 0, -1]));
    expect(h?.target).toBe('near');
    expect(h?.distance).toBeCloseTo(9);
    expect(h?.point).toEqual([0, 0, 1]);
    expect(h?.normal).toEqual([0, 0, 1]);
  });

  it('normals on other faces', () => {
    expect(t(ray([-10, 0, 0], [1, 0, 0]))?.normal).toEqual([-1, 0, 0]);
    expect(t(ray([0, 10, 0], [0, -1, 0]))?.normal).toEqual([0, 1, 0]);
    expect(t(ray([0, 0, -20], [0, 0, 1]))?.target).toBe('far');
    expect(t(ray([0, 0, -20], [0, 0, 1]))?.normal).toEqual([0, 0, -1]);
  });

  it('misses beside and behind', () => {
    expect(t(ray([3, 3, 10], [0, 0, -1]))).toBeNull();
    expect(t(ray([0, 0, 10], [0, 0, 1]))).toBeNull();
  });

  it('diagonal rays', () => {
    const h = t(ray([5.5, 5.5, 10], [0, 0, -1]));
    expect(h?.target).toBe('aside');
    const d = t(ray([-5, 0, 5], [1, 0, -1]));
    expect(d?.target).toBe('near');
    expect(d?.normal).not.toBeNull();
  });

  it('a ray starting inside hits at distance 0 with no normal', () => {
    const h = t(ray([0, 0, 0], [0, 0, -1]));
    expect(h?.target).toBe('near');
    expect(h?.distance).toBe(0);
    expect(h?.normal).toBeNull();
  });

  it('flat 2D quads at z = 0 are picked through ortho2d; ties go to the earlier box', () => {
    const quads: Aabb<number>[] = [
      { min: [0, 0, 0], max: [100, 100, 0], target: 1 },
      { min: [50, 50, 0], max: [150, 150, 0], target: 2 },
    ];
    const q = aabbTester(quads);
    const cam = Camera.ortho2d(800, 600);
    const r = createRay();
    screenRay(cam, 75, 75, r);
    expect(q(r)?.target).toBe(1);
    screenRay(cam, 125, 125, r);
    expect(q(r)?.target).toBe(2);
    screenRay(cam, 300, 300, r);
    expect(q(r)).toBeNull();
    // The array is live.
    quads.push({ min: [290, 290, 0], max: [310, 310, 0], target: 3 });
    expect(q(r)?.target).toBe(3);
  });

  it('through a perspective camera the box in front wins', () => {
    const cam = Camera.perspective(Math.PI / 3, 1, 0.1, 100);
    cam.lookAt([0, 0, 10], [0, 0, 0]);
    const r = createRay();
    screenRay(cam, 0.5, 0.5, r);
    expect(t(r)?.target).toBe('near');
  });
});
