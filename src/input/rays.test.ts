import { describe, expect, it } from 'vitest';
import { Camera, ORTHO2D_HALF_DEPTH } from '../render/camera';
import { Transform } from '../render/transform';
import {
  aabbTester,
  createRay,
  meshTester,
  obbTester,
  planeTester,
  type Ray,
  type RayBox,
  type RayPlane,
  rayAt,
  rayTriangle,
  screenRay,
  sphereTester,
  transformRayInto,
  type Vec3,
} from './rays';

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
  it('ortho2d: the origin is the world point on the near plane and the ray points +z', () => {
    const cam = Camera.ortho2d(800, 600);
    const r = createRay();
    expect(screenRay(cam, 100, 50, r)).toBe(true);
    expect(r.origin[0]).toBeCloseTo(100);
    expect(r.origin[1]).toBeCloseTo(50);
    expect(r.origin[2]).toBeCloseTo(-ORTHO2D_HALF_DEPTH, 3);
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

  it('through ortho2d it is the world point under the pointer, one near-plane depth away', () => {
    const cam = Camera.ortho2d(800, 600);
    const r = createRay();
    screenRay(cam, 123, 456, r);
    const h = planeTester()(r);
    expect(h?.point[0]).toBeCloseTo(123);
    expect(h?.point[1]).toBeCloseTo(456);
    expect(h?.distance).toBeCloseTo(ORTHO2D_HALF_DEPTH, 3);
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

  it('takes any plane (ws/api-core): a floor, a tilted wall, moved in place', () => {
    const floor: RayPlane = { normal: [0, 1, 0] };
    const t = planeTester(floor, 'floor');
    const h = t(ray([3, 4, -2], [0, -1, 0]));
    expect(h?.point[0]).toBeCloseTo(3);
    expect(h?.point[1]).toBeCloseTo(0);
    expect(h?.point[2]).toBeCloseTo(-2);
    expect(h?.distance).toBeCloseTo(4);
    expect(h?.normal).toEqual([0, 1, 0]);
    expect(h?.target).toBe('floor');
    // From below the normal turns to face the ray.
    expect(t(ray([0, -1, 0], [0, 1, 0]))?.normal).toEqual([-0, -1, -0]);
    expect(t(ray([0, 1, 0], [1, 0, 0]))).toBeNull();
    expect(t(ray([0, 1, 0], [0, 1, 0]))).toBeNull();
    floor.offset = 2;
    expect(t(ray([0, 5, 0], [0, -1, 0]))?.distance).toBeCloseTo(3);
    // Not unit length: x + y = 2 is the plane 2x + 2y = 4.
    const wall = planeTester({ normal: [2, 2, 0], offset: 4 });
    const w = wall(ray([0, 0, 0], [1, 0, 0]));
    expect(w?.distance).toBeCloseTo(2);
    expect(w?.normal?.[0]).toBeCloseTo(-Math.SQRT1_2);
    expect(planeTester({ normal: [0, 0, 1], offset: 2 })(ray([0, 0, 0], [0, 0, 1]))?.point).toEqual(
      [0, 0, 2],
    );
  });
});

describe('aabbTester', () => {
  const boxes: RayBox<string>[] = [
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
    const quads: RayBox<number>[] = [
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

// ---------------------------------------------------------------- transformed testers (ws/pick)

const S = Math.SQRT1_2;

function near(v: Vec3 | null, x: number, y: number, z: number, digits = 5): void {
  expect(v).not.toBeNull();
  expect(v![0]).toBeCloseTo(x, digits);
  expect(v![1]).toBeCloseTo(y, digits);
  expect(v![2]).toBeCloseTo(z, digits);
}

/** A unit quad in the plane z = `z`, facing +z (counter-clockwise from +z), 12 floats/vertex. */
function quad(z: number, out: number[], base: number, indices: number[]): void {
  for (const [x, y] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ]) {
    out.push(x!, y!, z, 0, 0, 1, 0, 0, 1, 1, 1, 1);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

describe('transformRayInto', () => {
  it('moves the ray into object space and returns world units per object unit', () => {
    const t = new Transform({ x: 5, y: 0, z: 0, scaleX: 2, scaleY: 2, scaleZ: 2 });
    const out = createRay();
    const k = transformRayInto(ray([5, 0, 10], [0, 0, -1]), t.world, out);
    expect(k).toBeCloseTo(2);
    near(out.origin, 0, 0, 5);
    near(out.dir, 0, 0, -1);
  });

  it('handles rotation and non-uniform scale', () => {
    const t = new Transform({ scaleX: 1, scaleY: 1, scaleZ: 4 });
    t.setAxisAngle(0, 1, 0, Math.PI / 2);
    const out = createRay();
    // World -z is object +x after a +90° turn about y; the object x axis is unscaled.
    const k = transformRayInto(ray([0, 0, 10], [0, 0, -1]), t.world, out);
    expect(k).toBeCloseTo(1);
    near(out.dir, 1, 0, 0);
    near(out.origin, -10, 0, 0);
  });

  it('returns 0 on a singular matrix', () => {
    const t = new Transform({ scaleX: 0, scaleY: 1, scaleZ: 1 });
    const out = createRay();
    expect(transformRayInto(ray([0, 0, 10], [0, 0, -1]), t.world, out)).toBe(0);
  });
});

describe('rayTriangle', () => {
  const a: Vec3 = [-1, -1, 0];
  const b: Vec3 = [1, -1, 0];
  const c: Vec3 = [0, 1, 0];

  it('returns the distance and the normal facing the ray', () => {
    const n: Vec3 = [0, 0, 0];
    expect(rayTriangle(ray([0, 0, 3], [0, 0, -1]), a, b, c, false, n)).toBeCloseTo(3);
    near(n, 0, 0, 1);
    expect(rayTriangle(ray([0, 0, -3], [0, 0, 1]), a, b, c, false, n)).toBeCloseTo(3);
    near(n, 0, 0, -1);
  });

  it('misses beside, behind and parallel', () => {
    expect(rayTriangle(ray([2, 2, 3], [0, 0, -1]), a, b, c, false, null)).toBe(-1);
    expect(rayTriangle(ray([0, 0, 3], [0, 0, 1]), a, b, c, false, null)).toBe(-1);
    expect(rayTriangle(ray([0, 0, 3], [1, 0, 0]), a, b, c, false, null)).toBe(-1);
  });

  it('culls back faces when asked', () => {
    // Front is +z (counter-clockwise seen from +z): a ray from -z sees the back.
    expect(rayTriangle(ray([0, 0, -3], [0, 0, 1]), a, b, c, true, null)).toBe(-1);
    expect(rayTriangle(ray([0, 0, 3], [0, 0, -1]), a, b, c, true, null)).toBeCloseTo(3);
  });
});

describe('sphereTester', () => {
  const bounds = { center: [0, 0, 0] as [number, number, number], radius: 1 };

  it('hits a translated sphere with point, normal and distance', () => {
    const t = new Transform({ x: 3, y: 0, z: 0 });
    const test = sphereTester(t, bounds, 'ball');
    const h = test(ray([3, 0, 10], [0, 0, -1]));
    expect(h?.target).toBe('ball');
    expect(h?.distance).toBeCloseTo(9);
    near(h!.point, 3, 0, 1);
    near(h!.normal, 0, 0, 1);
    expect(test(ray([3, 2, 10], [0, 0, -1]))).toBeNull();
  });

  it('scales: the distance is in world units and the normal follows the ellipsoid', () => {
    const t = new Transform({ scaleX: 1, scaleY: 1, scaleZ: 4 });
    const test = sphereTester(t, bounds);
    expect(test(ray([0, 0, 10], [0, 0, -1]))?.distance).toBeCloseTo(6);
    const side = test(ray([10, 0, 0], [-1, 0, 0]));
    expect(side?.distance).toBeCloseTo(9);
    near(side!.normal, 1, 0, 0);
    // Off axis on the ellipsoid the normal is not radial, but still unit and outward.
    const h = test(ray([0.5, 0, 10], [0, 0, -1]));
    expect(h).not.toBeNull();
    expect(Math.hypot(...h!.normal!)).toBeCloseTo(1);
    expect(h!.normal![0]).toBeGreaterThan(0);
    expect(h!.normal![2]).toBeGreaterThan(0);
  });

  it('a ray starting inside hits at 0 with no normal; the transform is read each call', () => {
    const t = new Transform({});
    const test = sphereTester(t, bounds, 1);
    const inside = test(ray([0, 0, 0], [0, 0, -1]));
    expect(inside?.distance).toBe(0);
    expect(inside?.normal).toBeNull();
    t.setPosition(0, 0, -5);
    expect(test(ray([0, 0, 0], [0, 0, -1]))?.distance).toBeCloseTo(4);
    bounds.radius = 2;
    expect(test(ray([0, 0, 0], [0, 0, -1]))?.distance).toBeCloseTo(3);
    bounds.radius = 1;
  });
});

describe('obbTester', () => {
  const half = [0.5, 0.5, 0.5] as const;

  it('hits an axis-aligned box like aabbTester, with the entering face normal', () => {
    const t = new Transform({ x: 0, y: 1, z: 0 });
    const test = obbTester(t, half, 'box');
    const h = test(ray([0, 1, 10], [0, 0, -1]));
    expect(h?.target).toBe('box');
    expect(h?.distance).toBeCloseTo(9.5);
    near(h!.point, 0, 1, 0.5);
    near(h!.normal, 0, 0, 1);
    expect(test(ray([2, 1, 10], [0, 0, -1]))).toBeNull();
  });

  it('a rotated box: the ray aimed at its turned face hits it square', () => {
    const t = new Transform({});
    t.setAxisAngle(0, 1, 0, Math.PI / 4);
    const test = obbTester(t, half);
    // The +z face centre turned about y by 45° is (S/2, 0, S/2); approach it along its normal.
    const h = test(ray([S / 2 + 10 * S, 0, S / 2 + 10 * S], [-S, 0, -S]));
    expect(h?.distance).toBeCloseTo(10);
    near(h!.point, S / 2, 0, S / 2);
    near(h!.normal, S, 0, S);
    // Straight down -z at x = 0.6 the box's corner (0.707) is still in the way; at x = 0.8 not.
    expect(test(ray([0.6, 0, 10], [0, 0, -1]))).not.toBeNull();
    expect(test(ray([0.8, 0, 10], [0, 0, -1]))).toBeNull();
  });

  it('non-uniform scale: world distance, normal of the scaled face; inside gives 0 and null', () => {
    const t = new Transform({ scaleX: 2, scaleY: 1, scaleZ: 4 });
    const test = obbTester(t, half);
    const h = test(ray([0.9, 0, 10], [0, 0, -1]));
    expect(h?.distance).toBeCloseTo(8);
    near(h!.normal, 0, 0, 1);
    const side = test(ray([10, 0, 1.5], [-1, 0, 0]));
    expect(side?.distance).toBeCloseTo(9);
    near(side!.normal, 1, 0, 0);
    const inside = test(ray([0, 0, 0], [1, 0, 0]));
    expect(inside?.distance).toBe(0);
    expect(inside?.normal).toBeNull();
    t.setPosition(0, 0, -5);
    expect(test(ray([0, 0, 10], [0, 0, -1]))?.distance).toBeCloseTo(13);
  });
});

describe('meshTester', () => {
  function twoQuads(): { positions: Float32Array; indices: Uint16Array } {
    const v: number[] = [];
    const i: number[] = [];
    quad(0, v, 0, i);
    quad(-1, v, 4, i);
    return { positions: new Float32Array(v), indices: new Uint16Array(i) };
  }

  it('hits the nearest triangle with point, normal and distance; misses beside', () => {
    const { positions, indices } = twoQuads();
    const t = new Transform({});
    const test = meshTester(t, positions, indices, 'm');
    const h = test(ray([0.2, 0.1, 5], [0, 0, -1]));
    expect(h?.target).toBe('m');
    expect(h?.distance).toBeCloseTo(5);
    near(h!.point, 0.2, 0.1, 0);
    near(h!.normal, 0, 0, 1);
    // From behind the nearer quad is the one at z = -1, seen from its back: normal faces the ray.
    const back = test(ray([0, 0, -5], [0, 0, 1]));
    expect(back?.distance).toBeCloseTo(4);
    near(back!.normal, 0, 0, -1);
    expect(test(ray([2, 2, 5], [0, 0, -1]))).toBeNull();
  });

  it('cullBack skips triangles seen from behind', () => {
    const { positions, indices } = twoQuads();
    const test = meshTester(new Transform({}), positions, indices, 'm', { cullBack: true });
    expect(test(ray([0, 0, 5], [0, 0, -1]))?.distance).toBeCloseTo(5);
    expect(test(ray([0, 0, -5], [0, 0, 1]))).toBeNull();
  });

  it('rejects on the bounds sphere before any triangle', () => {
    const { positions, indices } = twoQuads();
    const far = { center: [50, 50, 50] as [number, number, number], radius: 0.1 };
    const t = new Transform({});
    const test = meshTester(t, positions, indices, 'm', { bounds: far });
    expect(test(ray([0, 0, 5], [0, 0, -1]))).toBeNull();
    // The bounds are read each call.
    far.center[0] = far.center[1] = far.center[2] = 0;
    far.radius = 2;
    expect(test(ray([0, 0, 5], [0, 0, -1]))?.distance).toBeCloseTo(5);
    // The default bounds cover the mesh.
    expect(meshTester(t, positions, indices)(ray([0.49, 0.49, 5], [0, 0, -1]))).not.toBeNull();
  });

  it('distance in world units under scale, rotation read each call, Uint32 and no indices', () => {
    const v: number[] = [];
    const i: number[] = [];
    quad(1, v, 0, i);
    const positions = new Float32Array(v);
    const t = new Transform({ scaleX: 1, scaleY: 1, scaleZ: 3 });
    const test = meshTester(t, positions, new Uint32Array(i), 'q');
    // The quad at object z = 1 sits at world z = 3.
    const h = test(ray([0, 0, 10], [0, 0, -1]));
    expect(h?.distance).toBeCloseTo(7);
    near(h!.point, 0, 0, 3);
    near(h!.normal, 0, 0, 1);
    // Turned to face +x, it is no longer under the ray; a ray from +x finds it.
    t.setAxisAngle(0, 1, 0, Math.PI / 2);
    expect(test(ray([0, 0, 10], [0, 0, -1]))).toBeNull();
    const side = test(ray([10, 0, 0], [-1, 0, 0]));
    expect(side?.distance).toBeCloseTo(7);
    near(side!.normal, 1, 0, 0);
    // A plain triangle list (no indices): the same quad unrolled.
    const list = new Float32Array(i.flatMap((k) => v.slice(k * 12, k * 12 + 12)));
    const plain = meshTester(new Transform({}), list, null, 'p');
    expect(plain(ray([0.3, -0.3, 10], [0, 0, -1]))?.distance).toBeCloseTo(9);
  });

  it('stride and offset pick the positions out of another layout', () => {
    // 5 floats per vertex, positions at float 1: [pad, x, y, z, pad].
    const verts = [
      [-1, -1, 0],
      [1, -1, 0],
      [0, 1, 0],
    ];
    const positions = new Float32Array(verts.flatMap(([x, y, z]) => [9, x!, y!, z!, 9]));
    const test = meshTester(new Transform({}), positions, null, 't', { stride: 5, offset: 1 });
    const h = test(ray([0, 0, 2], [0, 0, -1]));
    expect(h?.distance).toBeCloseTo(2);
    near(h!.point, 0, 0, 0);
  });

  it('returns the same hit object on every call', () => {
    const { positions, indices } = twoQuads();
    const test = meshTester(new Transform({}), positions, indices);
    const a = test(ray([0, 0, 5], [0, 0, -1]));
    const b = test(ray([0.1, 0, 5], [0, 0, -1]));
    expect(a).toBe(b);
  });
});
