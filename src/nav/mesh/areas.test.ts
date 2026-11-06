import { describe, expect, it } from 'vitest';
import { createAreaCosts, createAreaMask, markArea, OBSTACLE_AREA } from './areas';
import { createNavPath3, findMeshPath, pathDistance3 } from './mesh-path';
import { bakeNavMesh, type NavBakeAreaOptions, type NavMesh } from './navmesh';
import { exportNavMesh, importNavMesh } from './serialize';
import type { NavBakeOptions } from './voxelize';

/** Appends an axis-aligned box (12 triangles) centred at `cx, cy, cz`. */
function box(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  pos: number[],
  idx: number[],
): void {
  const b = pos.length / 3;
  const c = [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1];
  for (let i = 0; i < 8; i++)
    pos.push(
      cx + c[i * 3]! * sx * 0.5,
      cy + c[i * 3 + 1]! * sy * 0.5,
      cz + c[i * 3 + 2]! * sz * 0.5,
    );
  const f = [
    4, 7, 6, 4, 6, 5, 0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7,
    4, 3, 4, 0,
  ];
  for (const i of f) idx.push(b + i);
}

const OPTS: NavBakeOptions = {
  cellSize: 0.3,
  cellHeight: 0.2,
  agentHeight: 2,
  agentRadius: 0.5,
  agentMaxClimb: 0.4,
  agentMaxSlope: 45,
};

/** A `size` × `size` floor (top at y = 0) with the given pillars (`x, z, w, d` each), 3 high. */
function floor(size: number, pillars: number[][] = [], extra: NavBakeAreaOptions = {}): NavMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  box(0, -0.5, 0, size, 1, size, pos, idx);
  for (const [x, z, w, d] of pillars) box(x!, 1.5, z!, w!, 3, d!, pos, idx);
  return bakeNavMesh({ positions: pos, indices: idx }, { ...OPTS, ...extra });
}

describe('area types (ws/nav-4)', () => {
  it('marks polygons by box and convex polygon, 255 untouchable, and bumps the version', () => {
    // Two pillars leave a gap polygon around the origin and lanes beside them.
    const mesh = floor(20, [
      [-4, 0, 2, 2],
      [4, 0, 2, 2],
    ]);
    expect(mesh.area.length).toBe(mesh.polyCount);
    expect(mesh.area.every((a) => a === 0)).toBe(true);
    const gap = mesh.findPolyAt(0, 0, 0);
    expect(gap).toBeGreaterThanOrEqual(0);
    const v = mesh.version;
    const n = markArea(mesh, { minX: -3, minZ: -3, maxX: 3, maxZ: 3 }, 3);
    expect(n).toBe(1);
    expect(mesh.version).toBe(v + 1);
    expect(mesh.area[gap]).toBe(3);
    // Marking again with the same value changes nothing.
    expect(markArea(mesh, { minX: -3, minZ: -3, maxX: 3, maxZ: 3 }, 3)).toBe(1);
    expect(mesh.version).toBe(v + 1);
    // A triangle (clockwise) holding the same centre; a height band that misses the floor.
    expect(markArea(mesh, { points: [-3, -3, 3, -3, 0, 3] }, 7)).toBe(1);
    expect(mesh.area[gap]).toBe(7);
    expect(markArea(mesh, { minX: -10, minZ: -10, maxX: 10, maxZ: 10, minY: 5 }, 9)).toBe(0);
    // Everything: an obstacle polygon is left alone; 255 itself is clamped to 254.
    mesh.area[gap] = OBSTACLE_AREA;
    const all = markArea(mesh, { minX: -10, minZ: -10, maxX: 10, maxZ: 10 }, 255);
    expect(all).toBe(mesh.polyCount - 1);
    expect(mesh.area[gap]).toBe(OBSTACLE_AREA);
    expect(mesh.area[mesh.findPolyAt(0, 0, -6)]).toBe(254);
  });

  it('prices a mud polygon by its multiplier: the detour wins once the mud costs more', () => {
    // The gap between the pillars (≈ 4 long) is mud; the lanes outside them are ≈ 4 longer.
    const mesh = floor(
      20,
      [
        [-4, 0, 2, 2],
        [4, 0, 2, 2],
      ],
      {
        areas: [{ shape: { minX: -3, minZ: -3, maxX: 3, maxZ: 3 }, area: 1 }],
      },
    );
    expect(mesh.version).toBe(0);
    const gap = mesh.findPolyAt(0, 0, 0);
    expect(mesh.area[gap]).toBe(1);
    const from = { x: 0, y: 0, z: -8 };
    const to = { x: 0, y: 0, z: 8 };
    const plain = createNavPath3();
    expect(findMeshPath(mesh, from, to, plain)).toBe(true);
    expect(pathDistance3(plain)).toBeCloseTo(16, 1);
    expect(plain.polys.subarray(0, plain.polyCount)).toContain(gap);
    const costs = createAreaCosts();
    const path = createNavPath3();
    // Mud at 1.5×: 16 + 0.5 × 4 = 18 beats the ≈ 19.8 detour.
    costs[1] = 1.5;
    expect(findMeshPath(mesh, from, to, path, { areaCost: costs })).toBe(true);
    expect(path.polys.subarray(0, path.polyCount)).toContain(gap);
    expect(pathDistance3(path)).toBeCloseTo(16, 1);
    // Mud at 3×: 16 + 2 × 4 = 24 loses to the detour.
    costs[1] = 3;
    expect(findMeshPath(mesh, from, to, path, { areaCost: costs })).toBe(true);
    expect(path.polys.subarray(0, path.polyCount)).not.toContain(gap);
    expect(pathDistance3(path)).toBeGreaterThan(19);
    expect(pathDistance3(path)).toBeLessThan(21);
  });

  it('an excluded area routes around; an excluded goal or no way through fails at once', () => {
    const mesh = floor(
      20,
      [
        [-4, 0, 2, 2],
        [4, 0, 2, 2],
      ],
      {
        areas: [{ shape: { minX: -3, minZ: -3, maxX: 3, maxZ: 3 }, area: 2 }],
      },
    );
    const gap = mesh.findPolyAt(0, 0, 0);
    const from = { x: 0, y: 0, z: -8 };
    const to = { x: 0, y: 0, z: 8 };
    const path = createNavPath3();
    const costs = createAreaCosts();
    costs[2] = Infinity;
    expect(findMeshPath(mesh, from, to, path, { areaCost: costs })).toBe(true);
    expect(path.polys.subarray(0, path.polyCount)).not.toContain(gap);
    const mask = createAreaMask();
    mask[2] = 0;
    expect(findMeshPath(mesh, from, to, path, { areaMask: mask })).toBe(true);
    expect(path.polys.subarray(0, path.polyCount)).not.toContain(gap);
    // A goal inside an excluded area fails at once.
    expect(findMeshPath(mesh, from, { x: 0, y: 0, z: 0 }, path, { areaMask: mask })).toBe(false);
    expect(path.length).toBe(0);
    expect(path.polyCount).toBe(0);
    // A band across the whole floor leaves no way through.
    const banded = floor(20, [], {
      areas: [{ shape: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 }, area: 2 }],
    });
    expect(findMeshPath(banded, from, to, path)).toBe(true);
    expect(findMeshPath(banded, from, to, path, { areaMask: mask })).toBe(false);
  });

  it('round-trips areas through the serialiser; format-1 bytes load with area 0', () => {
    const mesh = floor(
      20,
      [
        [-4, 0, 2, 2],
        [4, 0, 2, 2],
      ],
      {
        areas: [{ shape: { minX: -3, minZ: -3, maxX: 3, maxZ: 3 }, area: 5 }],
      },
    );
    const bytes = new Uint8Array(exportNavMesh(mesh));
    const back = importNavMesh(bytes);
    expect(back.polyCount).toBe(mesh.polyCount);
    expect(Array.from(back.area)).toEqual(Array.from(mesh.area));
    expect(Array.from(back.area)).toContain(5);
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(2);
    // Rewrite the header as format 1 and drop the area bytes: everything loads as area 0.
    const areaBytes = (mesh.polyCount + 3) & ~3;
    const nvp = mesh.maxVertsPerPoly;
    const polyEnd = 15 * 4 + mesh.vertCount * 12 + mesh.polyCount * nvp * 4 * 2;
    const old = new Uint8Array(bytes.length - areaBytes);
    old.set(bytes.subarray(0, polyEnd));
    old.set(bytes.subarray(polyEnd + areaBytes), polyEnd);
    new DataView(old.buffer).setUint32(4, 1, true);
    const legacy = importNavMesh(old);
    expect(legacy.polyCount).toBe(mesh.polyCount);
    expect(legacy.area.every((a) => a === 0)).toBe(true);
  });
});
