import { describe, expect, it } from 'vitest';
import { type Ray, rayTriangle } from '../../input/rays';
import { createHeightfield } from '../heightfield';
import { box, plane } from '../primitives';
import { stairs } from '../shapes';
import { createStaticCollider, type StaticCollider } from './bvh';
import { colliderWireframe, colliderWireframeLength } from './debug';
import { gridTriangles } from './grid';
import {
  createHit,
  createSweepHit,
  overlap,
  overlap2,
  raycast,
  raycast2,
  sweep,
  sweep2,
} from './queries';
import { exportCollider, importCollider } from './serialize';
import {
  type Aabb,
  type Capsule,
  type Contact,
  capsuleTriangle,
  closestPointTriangle,
  createContact,
  type Sphere,
  shapeTriangle,
  sphereTriangle,
} from './shapes';
import { createSlideResult, slide, slide2 } from './slide';

/** 3×4 row-major translation (the `Transform.world` layout). */
function translate(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
}

/** Rotation about y by `deg`, then translation: the 4×4 column-major layout. */
function rotateYTranslate(deg: number, x: number, y: number, z: number): Float32Array {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1]);
}

/** Deterministic pseudo-random numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Floor at y = 0 (20×20), stairs climbing +z from (0, 0, 2), a bumpy heightfield patch at x ≈ -6. */
function world(): StaticCollider {
  const hf = createHeightfield(5, 5, { scale: [0.5, 1, 0.5], origin: [-7, 0, -1] });
  for (let i = 0; i < hf.heights.length; i++) hf.heights[i] = 0.1 + 0.3 * Math.sin(i * 1.7);
  return createStaticCollider([
    { geometry: box({ size: [20, 1, 20] }), transform: translate(0, -0.5, 0), userData: 'floor' },
    {
      geometry: stairs({ steps: 5, rise: 0.2, run: 0.3, width: 2 }),
      transform: translate(0, 0.5, 2.75),
      layer: 1,
      userData: 'stairs',
    },
    { heightfield: hf, layer: 2, userData: 'hills' },
  ]);
}

/** Brute-force nearest ray hit over every live triangle. */
function bruteRay(c: StaticCollider, o: number[], d: number[], maxDist: number): number {
  const len = Math.hypot(d[0]!, d[1]!, d[2]!);
  const ray: Ray = {
    origin: [o[0]!, o[1]!, o[2]!],
    dir: [d[0]! / len, d[1]! / len, d[2]! / len],
  };
  let best = maxDist;
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  const cc: [number, number, number] = [0, 0, 0];
  for (const s of c.sources) {
    if (s.removed) continue;
    for (let t = s.start; t < s.start + s.count; t++) {
      const k = t * 9;
      for (let i = 0; i < 3; i++) {
        a[i] = c.tris[k + i]!;
        b[i] = c.tris[k + 3 + i]!;
        cc[i] = c.tris[k + 6 + i]!;
      }
      const d2 = rayTriangle(ray, a, b, cc, false, null);
      if (d2 >= 0 && d2 < best) best = d2;
    }
  }
  return best;
}

function bruteOverlap(c: StaticCollider, s: Sphere): Set<number> {
  const found = new Set<number>();
  const contact = createContact();
  for (const src of c.sources) {
    if (src.removed) continue;
    for (let t = src.start; t < src.start + src.count; t++) {
      const k = t * 9;
      const tr = Array.from(c.tris.subarray(k, k + 9)) as number[];
      if (
        shapeTriangle(
          s,
          tr[0]!,
          tr[1]!,
          tr[2]!,
          tr[3]!,
          tr[4]!,
          tr[5]!,
          tr[6]!,
          tr[7]!,
          tr[8]!,
          contact,
        )
      )
        found.add(t);
    }
  }
  return found;
}

describe('collide shapes', () => {
  it('closestPointTriangle hits the face, edges and corners', () => {
    const out = new Float64Array(3);
    closestPointTriangle(0.2, 5, 0.2, 0, 0, 0, 1, 0, 0, 0, 0, 1, out);
    expect(out[0]).toBeCloseTo(0.2, 12);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(0.2, 12);
    closestPointTriangle(-1, 0, -1, 0, 0, 0, 1, 0, 0, 0, 0, 1, out);
    expect(Array.from(out)).toEqual([0, 0, 0]);
    closestPointTriangle(2, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 1, out);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(0.5);
  });

  it('sphereTriangle reports depth and a normal into the sphere; touching is not a contact', () => {
    const c = createContact();
    expect(sphereTriangle({ x: 0.2, y: 0.3, z: 0.2, r: 0.5 }, 0, 0, 0, 1, 0, 0, 0, 0, 1, c)).toBe(
      true,
    );
    expect(c.depth).toBeCloseTo(0.2);
    expect(c.ny).toBeCloseTo(1);
    expect(sphereTriangle({ x: 0.2, y: 0.5, z: 0.2, r: 0.5 }, 0, 0, 0, 1, 0, 0, 0, 0, 1, c)).toBe(
      false,
    );
  });

  it('capsuleTriangle finds a floor under the bottom cap', () => {
    const c = createContact();
    const cap: Capsule = { x: 0.2, y: 0.9, z: 0.2, halfHeight: 0.5, r: 0.5 };
    expect(capsuleTriangle(cap, 0, 0, 0, 1, 0, 0, 0, 0, 1, c)).toBe(true);
    expect(c.depth).toBeCloseTo(0.1);
    expect(c.ny).toBeCloseTo(1);
  });
});

describe('collide BVH queries', () => {
  it('raycast equals brute force on 200 random rays', () => {
    const c = world();
    const r = rng(7);
    const hit = createHit();
    for (let i = 0; i < 200; i++) {
      const o = [r() * 20 - 10, r() * 4 + 0.1, r() * 20 - 10];
      const d = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      const brute = bruteRay(c, o, d, 50);
      const ok = raycast(c, o, d, 50, hit);
      if (brute >= 50) expect(ok).toBe(false);
      else {
        expect(ok).toBe(true);
        expect(hit.t).toBeCloseTo(brute, 5);
      }
    }
  });

  it('raycast fills the hit point, normal, source and userData', () => {
    const c = world();
    const hit = createHit();
    expect(raycast(c, [3, 5, 3], [0, -1, 0], 100, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(5);
    expect(hit.y).toBeCloseTo(0);
    expect(hit.ny).toBeCloseTo(1);
    expect(hit.userData).toBe('floor');
    // Only layer 1 (stairs): the ray down at x=3 misses them.
    expect(raycast(c, [3, 5, 3], [0, -1, 0], 100, hit, 1 << 1)).toBe(false);
    expect(raycast(c, [0, 5, 3], [0, -1, 0], 100, hit, 1 << 1)).toBe(true);
    expect(hit.userData).toBe('stairs');
  });

  it('overlap equals brute force on 50 random spheres', () => {
    const c = world();
    const r = rng(11);
    const out: Contact[] = Array.from({ length: 256 }, createContact);
    for (let i = 0; i < 50; i++) {
      const s: Sphere = { x: r() * 16 - 8, y: r() * 2 - 0.5, z: r() * 16 - 8, r: 0.2 + r() };
      const n = overlap(c, s, out);
      const set = new Set<number>();
      for (let k = 0; k < n; k++) set.add(out[k]!.triangle);
      expect(set).toEqual(bruteOverlap(c, s));
    }
  });

  it('overlap respects maxContacts and layerMask', () => {
    const c = world();
    const out: Contact[] = Array.from({ length: 8 }, createContact);
    const s: Sphere = { x: 0, y: 0.1, z: 3, r: 1 };
    expect(overlap(c, s, out, 2)).toBe(2);
    const n = overlap(c, s, out, 8, 1 << 0);
    for (let k = 0; k < n; k++) expect(out[k]!.source).toBe(0);
  });

  it('capsule sweep onto the floor lands within 1e-4 of the analytic time', () => {
    const c = world();
    const cap: Capsule = { x: 4, y: 2, z: -4, halfHeight: 0.5, r: 0.3 };
    const hit = createSweepHit();
    // Bottom of the capsule at y = 1.2; moving down 3 → touches at t = 1.2 / 3.
    expect(sweep(c, cap, 0, -3, 0, hit)).toBe(true);
    expect(Math.abs(hit.t - 0.4)).toBeLessThan(1e-4);
    expect(hit.ny).toBeCloseTo(1);
    expect(hit.y).toBeCloseTo(0, 4);
    expect(hit.userData).toBe('floor');
    // Diagonal approach too.
    expect(sweep(c, cap, 1, -3, 1, hit)).toBe(true);
    expect(Math.abs(hit.t - 0.4)).toBeLessThan(1e-4);
  });

  it('sphere and box sweeps agree on a wall, and a free sweep misses', () => {
    const c = world();
    const hit = createSweepHit();
    // A wall whose front face is at z = 2.9.
    const c2 = createStaticCollider([
      { geometry: box({ size: [4, 2, 0.2] }), transform: translate(0, 1, 3) },
    ]);
    const s: Sphere = { x: 0, y: 0.5, z: 1, r: 0.25 };
    expect(sweep(c2, s, 0, 0, 2, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(0.825, 4);
    expect(hit.nz).toBeCloseTo(-1);
    const b: Aabb = { min: [-0.25, 0.25, 0.75], max: [0.25, 0.75, 1.25] };
    expect(sweep(c2, b, 0, 0, 2, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(0.825, 4);
    expect(hit.nz).toBeCloseTo(-1);
    expect(sweep(c, s, 0, 1, 0, hit)).toBe(false);
  });

  it('a sweep that starts overlapping reports t = 0 with the penetration', () => {
    const c = world();
    const hit = createSweepHit();
    expect(sweep(c, { x: 5, y: 0.1, z: 5, r: 0.5 }, 1, 0, 0, hit)).toBe(true);
    expect(hit.t).toBe(0);
    expect(hit.depth).toBeCloseTo(0.4);
    expect(hit.ny).toBeCloseTo(1);
  });

  it('refit moves a hit and remove drops a source', () => {
    const c = world();
    const hit = createHit();
    expect(raycast(c, [0, 5, 3], [0, -1, 0], 100, hit, 1 << 1)).toBe(true);
    const before = c.triangleCount;
    c.refit(1, translate(5, 0.5, 2.75));
    expect(raycast(c, [0, 5, 3], [0, -1, 0], 100, hit, 1 << 1)).toBe(false);
    expect(raycast(c, [5, 5, 3], [0, -1, 0], 100, hit, 1 << 1)).toBe(true);
    c.refit(1, rotateYTranslate(90, 0, 0.5, 0));
    expect(raycast(c, [0.5, 5, 0], [0, -1, 0], 100, hit, 1 << 1)).toBe(true);
    expect(c.triangleCount).toBe(before);
    c.remove(1);
    expect(raycast(c, [0.5, 5, 0], [0, -1, 0], 100, hit, 1 << 1)).toBe(false);
    expect(c.triangleCount).toBeLessThan(before);
    expect(() => c.refit(2, translate(0, 0, 0))).toThrow();
  });

  it('bounds cover the sources and shrink on remove', () => {
    const c = world();
    expect(c.bounds.min[0]).toBeCloseTo(-10);
    expect(c.bounds.max[1]).toBeCloseTo(1);
    c.remove(1);
    expect(c.bounds.max[1]).toBeLessThan(0.9);
  });

  it('leafSize 1 and 64 give the same answers', () => {
    const geo = plane({ size: 10, segments: [7, 7] });
    const a = createStaticCollider([{ geometry: geo }], { leafSize: 1 });
    const b = createStaticCollider([{ geometry: geo }], { leafSize: 64 });
    const ha = createHit();
    const hb = createHit();
    const r = rng(3);
    for (let i = 0; i < 50; i++) {
      const o = [r() * 10 - 5, 2, r() * 10 - 5];
      const d = [r() - 0.5, -1, r() - 0.5];
      expect(raycast(a, o, d, 20, ha)).toBe(raycast(b, o, d, 20, hb));
      expect(ha.t).toBeCloseTo(hb.t, 6);
    }
  });
});

describe('collide slide', () => {
  const cap: Capsule = { x: 0, y: 0.8, z: -4, halfHeight: 0.5, r: 0.3 };

  it('slides along a 45° wall keeping speed × cos', () => {
    // A wall rotated 45° about y, standing on the floor.
    const c = createStaticCollider([
      { geometry: box({ size: [40, 1, 40] }), transform: translate(0, -0.5, 0) },
      { geometry: box({ size: [10, 3, 0.2] }), transform: rotateYTranslate(45, 0, 1.5, 0) },
    ]);
    const out = createSlideResult();
    // Start left of the wall's plane and push +x into it.
    const start: Capsule = { ...cap, x: -1.5, z: 0.7 };
    slide(c, start, 1, 0, 0, {}, out);
    expect(out.hitWall).toBe(true);
    expect(out.grounded).toBe(true);
    // Free travel to the wall, then the rest along it at speed × cos 45°.
    const hit = createSweepHit();
    sweep(c, start, 1, 0, 0, hit);
    const free = hit.t;
    const slid = Math.hypot(out.x - (start.x + free), out.z - start.z);
    expect(slid).toBeCloseTo((1 - free) * Math.cos(Math.PI / 4), 1);
    // Along the wall means equal parts +x and -z (less the skin backed off along x).
    expect(out.x - (start.x + free)).toBeCloseTo(start.z - out.z, 1);
    // Sliding keeps the perpendicular distance to the wall: the slid component is parallel.
    expect(out.remaining[0]).toBeCloseTo(0, 4);
  });

  it('climbs every stair step and ends grounded', () => {
    const c = world();
    const out = createSlideResult();
    let s: Capsule = { ...cap, x: 0, z: 0.5 };
    let grounded = true;
    // 32 frames of 0.1 reach the top step (z 3.2..3.5) without walking off its far end.
    for (let i = 0; i < 32; i++) {
      slide(c, s, 0, -0.1, 0.1, { wasGrounded: grounded }, out);
      s = { ...s, x: out.x, y: out.y, z: out.z };
      grounded = out.grounded;
    }
    // Five steps of 0.2 = 1.0 above the floor; the capsule's centre rests r + halfHeight above.
    expect(s.z).toBeGreaterThan(3.2);
    expect(s.z).toBeLessThan(3.5);
    expect(s.y).toBeCloseTo(1.0 + 0.8, 1);
    expect(out.grounded).toBe(true);
  });

  it('treats a 60° slope as a wall with maxSlope 50 and a 30° slope as ground', () => {
    const steep = createStaticCollider([
      { geometry: box({ size: [40, 1, 40] }), transform: translate(0, -0.5, 0) },
      { geometry: box({ size: [6, 0.2, 6] }), transform: tiltX(-60, 0, 1.6, 3) },
    ]);
    const out = createSlideResult();
    slide(steep, { ...cap, z: 0 }, 0, -0.1, 3, {}, out);
    expect(out.hitWall).toBe(true);
    const gentle = createStaticCollider([
      { geometry: box({ size: [40, 1, 40] }), transform: translate(0, -0.5, 0) },
      { geometry: box({ size: [6, 0.2, 6] }), transform: tiltX(-30, 0, 1.3, 3) },
    ]);
    slide(gentle, { ...cap, z: 0 }, 0, -0.1, 3, { stepHeight: 0 }, out);
    expect(out.hitWall).toBe(false);
    expect(out.grounded).toBe(true);
    expect(out.groundNormal[1]).toBeCloseTo(Math.cos(Math.PI / 6), 3);
  });

  it('snaps down across a 0.15 drop and stays grounded', () => {
    const c = createStaticCollider([
      { geometry: box({ size: [40, 1, 40] }), transform: translate(0, -0.5, 0) },
      { geometry: box({ size: [4, 0.15, 4] }), transform: translate(0, 0.075, 0) },
    ]);
    const out = createSlideResult();
    // Standing on the ledge, step off +x.
    const s: Capsule = { ...cap, x: 1.9, y: 0.15 + 0.8, z: 0 };
    slide(c, s, 0.5, 0, 0, {}, out);
    expect(out.grounded).toBe(true);
    // Resting the default skin (0.005) above the floor.
    expect(out.y).toBeCloseTo(0.805, 4);
    // Without snap-down it is airborne.
    slide(c, s, 0.5, 0, 0, { snapDown: 0 }, out);
    expect(out.grounded).toBe(false);
    expect(out.y).toBeCloseTo(0.95, 6);
  });

  it('does not mutate the shape and allocates nothing after warm-up', () => {
    const c = world();
    const out = createSlideResult();
    const s: Capsule = { ...cap, z: 0.5 };
    const copy = { ...s };
    // Enough calls for the JIT to settle; the interpreter boxes every double.
    for (let i = 0; i < 20000; i++) slide(c, s, 0.01, -0.1, 0.01, {}, out);
    expect(s).toEqual(copy);
    const opts = {};
    const gc = (globalThis as { gc?: () => void }).gc;
    const heapDelta = () => {
      gc?.();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 1000; i++) slide(c, s, 0.01, -0.1, 0.01, opts, out);
      return process.memoryUsage().heapUsed - before;
    };
    // The first measurement after a gc carries one-off runtime allocations; take the second.
    heapDelta();
    // No per-call garbage: the heap moves by less than a few KB (noise), not 1000 × objects.
    expect(heapDelta()).toBeLessThan(64 * 1024);
  });
});

/** Rotation about x by `deg` then translation, 3×4 row-major. */
function tiltX(deg: number, x: number, y: number, z: number): Float32Array {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return new Float32Array([1, 0, 0, x, 0, c, -s, y, 0, s, c, z]);
}

describe('collide 2D grid', () => {
  // A corridor one tile wide along +z: solid columns at x = 0 and x = 2, open x = 1.
  const grid = {
    width: 3,
    height: 8,
    cellSize: 1,
    origin: [0, 0] as [number, number],
    solid: (x: number) => x !== 1,
  };

  it('culls shared faces', () => {
    const tris = gridTriangles(grid);
    // 16 solid cells: 2 faces (top/bottom) each + exposed sides.
    // Each column: inner face ×8, outer face ×8, ends 2 → 18 side faces; ×2 columns = 36; +32 top/bottom = 68 quads.
    expect(tris.length / 18).toBe(68);
  });

  it('circle slides through the corridor without snagging', () => {
    const c = createStaticCollider([{ grid }]);
    expect(c.bounds.max[1]).toBeCloseTo(1);
    const out = createSlideResult();
    let x = 1.5;
    let z = 0.5;
    // Push diagonally into the right wall while moving along the corridor.
    for (let i = 0; i < 40; i++) {
      slide2(c, { x, z, r: 0.3 }, 0.1, 0.15, {}, out);
      x = out.x;
      z = out.z;
    }
    expect(z).toBeGreaterThan(6);
    expect(x).toBeLessThan(1.7 + 1e-3);
    expect(x).toBeGreaterThan(1.68);
  });

  it('raycast2, overlap2 and sweep2 see the walls', () => {
    const c = createStaticCollider([{ grid }]);
    const hit = createHit();
    expect(raycast2(c, 1.5, 3, 1, 0, 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(0.5);
    expect(hit.nx).toBeCloseTo(-1);
    const contacts = [createContact(), createContact()];
    expect(overlap2(c, { x: 1.9, z: 3, r: 0.3 }, contacts)).toBeGreaterThan(0);
    expect(contacts[0]!.nx).toBeCloseTo(-1);
    expect(overlap2(c, { x: 1.5, z: 3, hw: 0.3, hh: 0.3 }, contacts)).toBe(0);
    const sh = createSweepHit();
    expect(sweep2(c, { x: 1.5, z: 3, r: 0.3 }, 1, 0, sh)).toBe(true);
    expect(sh.t).toBeCloseTo(0.2, 3);
    expect(sweep2(c, { x: 1.5, z: 3, hw: 0.3, hh: 0.3 }, 1, 0, sh)).toBe(true);
    expect(sh.t).toBeCloseTo(0.2, 3);
  });
});

describe('collide serialisation and debug', () => {
  it('export/import round-trips byte-equal and query-identical', () => {
    const c = world();
    c.refit(1, translate(1, 0.5, 2.75));
    const buf = exportCollider(c);
    const d = importCollider(buf, ['floor', 'stairs', 'hills']);
    expect(new Uint8Array(exportCollider(d))).toEqual(new Uint8Array(buf));
    expect(d.triangleCount).toBe(c.triangleCount);
    expect(d.bounds).toEqual(c.bounds);
    const r = rng(5);
    const h1 = createHit();
    const h2 = createHit();
    for (let i = 0; i < 100; i++) {
      const o = [r() * 20 - 10, r() * 4 + 0.1, r() * 20 - 10];
      const dir = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      expect(raycast(c, o, dir, 50, h1)).toBe(raycast(d, o, dir, 50, h2));
      expect(h1.t).toBe(h2.t);
      expect(h1.triangle).toBe(h2.triangle);
      expect(h1.userData).toBe(h2.userData);
    }
    // Refit still works on the imported copy (local triangles survived).
    d.refit(1, translate(5, 0.5, 2.75));
    expect(raycast(d, [5, 5, 3], [0, -1, 0], 100, h2, 1 << 1)).toBe(true);
    expect(() => importCollider(new ArrayBuffer(8))).toThrow();
  });

  it('wireframes have the expected lengths and lie inside the bounds', () => {
    const c = world();
    const tri = colliderWireframe(c);
    expect(tri.length).toBe(c.triangleCount * 18);
    expect(colliderWireframeLength(c)).toBe(tri.length);
    const leaves = colliderWireframe(c, undefined, 'leaves');
    expect(leaves.length % 72).toBe(0);
    expect(leaves.length).toBeGreaterThan(0);
    for (let i = 0; i < leaves.length; i += 3) {
      expect(leaves[i]).toBeGreaterThanOrEqual(c.bounds.min[0] - 1e-6);
      expect(leaves[i]).toBeLessThanOrEqual(c.bounds.max[0] + 1e-6);
    }
    const reused = colliderWireframe(c, tri);
    expect(reused).toBe(tri);
  });
});

describe('collide bench', () => {
  it('sweeps 10k capsules through 100k triangles (timing, not asserted)', () => {
    const hf = createHeightfield(225, 225, { scale: [0.2, 1, 0.2], origin: [-22.4, 0, -22.4] });
    for (let i = 0; i < hf.heights.length; i++) hf.heights[i] = Math.sin(i * 0.013) * 0.5;
    const t0 = performance.now();
    const c = createStaticCollider([{ heightfield: hf }]);
    const t1 = performance.now();
    expect(c.triangleCount).toBe(224 * 224 * 2);
    const r = rng(99);
    const hit = createSweepHit();
    const cap: Capsule = { x: 0, y: 2, z: 0, halfHeight: 0.5, r: 0.3 };
    let hits = 0;
    for (let i = 0; i < 10000; i++) {
      cap.x = r() * 40 - 20;
      cap.z = r() * 40 - 20;
      if (sweep(c, cap, r() - 0.5, -3, r() - 0.5, hit)) hits++;
    }
    const t2 = performance.now();
    console.log(
      `collide bench: build ${c.triangleCount} tris ${(t1 - t0).toFixed(1)} ms; 10k capsule sweeps ${(t2 - t1).toFixed(1)} ms (${hits} hits)`,
    );
    expect(hits).toBe(10000);
  });
});
