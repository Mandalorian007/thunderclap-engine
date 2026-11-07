import { describe, expect, it, vi } from 'vitest';
import { addOffMeshLink, getOffMeshLink, removeOffMeshLink } from './links';
import { createNavPath3, findMeshPath, followPath3, pathDistance3 } from './mesh-path';
import { bakeNavMesh, type NavMesh, type NavPoint3 } from './navmesh';
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
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const corners = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, -1, 1],
    [-1, -1, 1],
    [-1, 1, -1],
    [1, 1, -1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  for (const [x, y, z] of corners) pos.push(cx + x! * hx, cy + y! * hy, cz + z! * hz);
  const faces = [
    [4, 7, 6],
    [4, 6, 5],
    [0, 1, 2],
    [0, 2, 3],
    [0, 4, 5],
    [0, 5, 1],
    [1, 5, 6],
    [1, 6, 2],
    [2, 6, 7],
    [2, 7, 3],
    [3, 7, 4],
    [3, 4, 0],
  ];
  for (const t of faces) idx.push(b + t[0]!, b + t[1]!, b + t[2]!);
}

const OPTS = {
  cellSize: 0.3,
  cellHeight: 0.2,
  agentHeight: 2,
  agentRadius: 0.5,
  agentMaxClimb: 0.4,
  agentMaxSlope: 45,
} satisfies NavBakeOptions;

/** A 20 × 20 floor (top at y = 0) with a 2 × 2 pillar at the origin. */
function floorWithPillar(opts: Partial<NavBakeOptions> = {}): NavMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  box(0, -0.5, 0, 20, 1, 20, pos, idx);
  box(0, 1.5, 0, 2, 3, 2, pos, idx);
  return bakeNavMesh({ positions: pos, indices: idx }, { ...OPTS, ...opts });
}

function totalArea(mesh: NavMesh): number {
  let a = 0;
  for (let p = 0; p < mesh.polyCount; p++) a += mesh.polyArea(p);
  return a;
}

const pt = (): NavPoint3 => ({ x: 0, y: 0, z: 0 });

describe('bakeNavMesh', () => {
  it('leaves a hole where the wall stands', () => {
    const mesh = floorWithPillar();
    expect(mesh.polyCount).toBeGreaterThan(0);
    const out = pt();
    // The pillar is ±1 and the agent radius 0.5: nothing walkable within 1.2 of its centre.
    expect(mesh.findNearestPoly(0, 0, 0, out, 1.2)).toBe(-1);
    expect(Number.isNaN(mesh.height(0, 0))).toBe(true);
    // Open floor is found, and the surface sits within one cell height of y = 0.
    expect(mesh.findNearestPoly(5, 0, 5, out, 1)).toBeGreaterThanOrEqual(0);
    expect(Math.abs(out.y)).toBeLessThanOrEqual(OPTS.cellHeight + 1e-6);
    expect(Math.abs(mesh.height(5, 5))).toBeLessThanOrEqual(OPTS.cellHeight + 1e-6);
    // Every polygon is wound the same way and no edge is shared more than once.
    for (let p = 0; p < mesh.polyCount; p++) expect(mesh.polyArea(p)).toBeGreaterThan(0);
    for (let p = 0; p < mesh.polyCount; p++) {
      const n = mesh.polyVertexCount(p);
      for (let e = 0; e < n; e++) {
        const q = mesh.adjacency[p * mesh.maxVertsPerPoly + e]!;
        if (q < 0) continue;
        let back = false;
        for (let k = 0; k < mesh.polyVertexCount(q); k++) {
          if (mesh.adjacency[q * mesh.maxVertsPerPoly + k] === p) back = true;
        }
        expect(back).toBe(true);
      }
    }
  });

  it('rejects slopes steeper than agentMaxSlope', () => {
    // A 4 × 4 quad rising 30°.
    const rise = 4 * Math.tan(Math.PI / 6);
    const pos = [0, 0, 0, 4, rise, 0, 4, rise, 4, 0, 0, 4];
    const idx = [0, 2, 1, 0, 3, 2];
    const slopeOpts = { ...OPTS, agentRadius: 0.2 };
    const gentle = bakeNavMesh(
      { positions: pos, indices: idx },
      { ...slopeOpts, agentMaxSlope: 45 },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const steep = bakeNavMesh(
      { positions: pos, indices: idx },
      { ...slopeOpts, agentMaxSlope: 20 },
    );
    // Triangles in, no polygon out: one warning (ws/nav-6).
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(gentle.polyCount).toBeGreaterThan(0);
    expect(steep.polyCount).toBe(0);
    expect(gentle.height(2, 2)).toBeGreaterThan(rise / 2 - OPTS.cellHeight * 2);
  });

  it('erodes by the agent radius', () => {
    const thin = floorWithPillar({ agentRadius: 0.3 });
    const wide = floorWithPillar({ agentRadius: 1 });
    expect(totalArea(wide)).toBeLessThan(totalArea(thin));
    expect(totalArea(thin)).toBeLessThan(400);
    expect(totalArea(thin)).toBeGreaterThan(300);
  });

  it('reads any vertex stride', () => {
    const pos: number[] = [];
    const idx: number[] = [];
    box(0, -0.5, 0, 10, 1, 10, pos, idx);
    const strided = new Float32Array((pos.length / 3) * 12);
    for (let v = 0; v < pos.length / 3; v++) {
      strided[v * 12] = pos[v * 3]!;
      strided[v * 12 + 1] = pos[v * 3 + 1]!;
      strided[v * 12 + 2] = pos[v * 3 + 2]!;
    }
    const a = bakeNavMesh({ positions: pos, indices: idx }, OPTS);
    const b = bakeNavMesh({ positions: strided, indices: idx, stride: 12 }, OPTS);
    expect(b.polyCount).toBe(a.polyCount);
    expect(totalArea(b)).toBeCloseTo(totalArea(a));
  });

  it('gives an empty mesh for no input', () => {
    const mesh = bakeNavMesh({ positions: [], indices: [] }, OPTS);
    expect(mesh.polyCount).toBe(0);
    const out = pt();
    expect(mesh.findNearestPoly(0, 0, 0, out)).toBe(-1);
    expect(mesh.findRandomPoint(out)).toBe(-1);
    const path = createNavPath3();
    expect(findMeshPath(mesh, pt(), pt(), path)).toBe(false);
  });
});

describe('NavMesh queries', () => {
  it('raycast stops at the wall and passes open floor', () => {
    const mesh = floorWithPillar();
    const out = pt();
    expect(mesh.raycast({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, out)).toBe(true);
    expect(out.x).toBeGreaterThan(-2);
    expect(out.x).toBeLessThan(-1);
    expect(Math.abs(out.z)).toBeLessThan(1e-3);
    expect(mesh.raycast({ x: -5, y: 0, z: 5 }, { x: 5, y: 0, z: 5 }, out)).toBe(false);
    expect(out.x).toBe(5);
    expect(out.z).toBe(5);
    // Off the mesh at the start: blocked at once.
    expect(mesh.raycast({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, out)).toBe(true);
    expect(out.x).toBe(0);
  });

  it('findRandomPoint lands on the mesh', () => {
    const mesh = floorWithPillar();
    const out = pt();
    let seed = 7;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    for (let i = 0; i < 200; i++) {
      const p = mesh.findRandomPoint(out, rng);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(mesh.containsXZ(p, out.x, out.z)).toBe(true);
      expect(Math.max(Math.abs(out.x), Math.abs(out.z))).toBeGreaterThan(1.2);
    }
  });
});

describe('findMeshPath', () => {
  it('routes around the pillar, start and goal snapped onto the mesh', () => {
    const mesh = floorWithPillar();
    const path = createNavPath3();
    expect(findMeshPath(mesh, { x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, path)).toBe(true);
    expect(path.length).toBeGreaterThanOrEqual(3);
    expect(path.points[0]).toBeCloseTo(-6);
    expect(path.points[(path.length - 1) * 3]).toBeCloseTo(6);
    expect(path.version).toBe(mesh.version);
    expect(path.linkCount).toBe(0);
    // Every waypoint is on the mesh (the corners are polygon vertices).
    const out = pt();
    for (let i = 0; i < path.length; i++) {
      const p = mesh.findNearestPoly(
        path.points[i * 3]!,
        path.points[i * 3 + 1]!,
        path.points[i * 3 + 2]!,
        out,
        0.05,
      );
      expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  it('pulls the string shorter than the portal midpoints', () => {
    const mesh = floorWithPillar();
    const pulled = createNavPath3();
    const mid = createNavPath3();
    const from = { x: -8, y: 0, z: -3 };
    const to = { x: 8, y: 0, z: 3 };
    expect(findMeshPath(mesh, from, to, pulled)).toBe(true);
    expect(findMeshPath(mesh, from, to, mid, { stringPull: false })).toBe(true);
    expect(pathDistance3(pulled)).toBeLessThan(pathDistance3(mid));
    // And no longer than 10% over the straight line bent around one corner.
    expect(pathDistance3(pulled)).toBeLessThan(Math.hypot(16, 6) * 1.1);
  });

  it('fails cleanly for a goal off the mesh or a snap radius too small', () => {
    const mesh = floorWithPillar();
    const path = createNavPath3();
    expect(
      findMeshPath(mesh, { x: -6, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, path, { snapRadius: 0.5 }),
    ).toBe(false);
    expect(path.length).toBe(0);
    expect(findMeshPath(mesh, { x: -6, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, path)).toBe(true);
    expect(
      findMeshPath(mesh, { x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, path, { maxExpand: 1 }),
    ).toBe(false);
  });

  it('allocates nothing after the first query', () => {
    const mesh = floorWithPillar();
    const path = createNavPath3(8);
    findMeshPath(mesh, { x: -8, y: 0, z: -8 }, { x: 8, y: 0, z: 8 }, path);
    const points = path.points;
    for (let i = 0; i < 20; i++) {
      findMeshPath(mesh, { x: -8 + i * 0.1, y: 0, z: -8 }, { x: 8, y: 0, z: 8 - i * 0.1 }, path);
    }
    expect(path.points).toBe(points);
  });

  it('followPath3 walks the waypoints', () => {
    const mesh = floorWithPillar();
    const path = createNavPath3();
    findMeshPath(mesh, { x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, path);
    const pos = { x: -6, y: 0, z: 0 };
    const vel = pt();
    let steps = 0;
    while (followPath3(path, pos, 4, 0.1, vel) === 'moving' && steps < 2000) {
      pos.x += vel.x / 60;
      pos.y += vel.y / 60;
      pos.z += vel.z / 60;
      steps++;
    }
    expect(steps).toBeLessThan(2000);
    expect(Math.hypot(pos.x - 6, pos.z)).toBeLessThan(0.2);
  });
});

describe('off-mesh links', () => {
  it('are taken when cheaper and skipped when not', () => {
    const mesh = floorWithPillar();
    const path = createNavPath3();
    const from = { x: -6, y: 0, z: 0 };
    const to = { x: 6, y: 0, z: 0 };
    findMeshPath(mesh, from, to, path);
    const walked = pathDistance3(path);
    const v0 = mesh.version;
    const id = addOffMeshLink(mesh, {
      from: { x: -5, y: 0, z: 0 },
      to: { x: 5, y: 0, z: 0 },
      radius: 0.5,
      cost: 1,
      userData: 'jump',
    });
    expect(mesh.version).toBeGreaterThan(v0);
    expect(getOffMeshLink(mesh, id)?.userData).toBe('jump');
    expect(findMeshPath(mesh, from, to, path)).toBe(true);
    expect(path.linkCount).toBe(1);
    expect(path.links[0]).toEqual({ index: 1, id });
    expect(path.points[3]).toBeCloseTo(-5);
    expect(path.points[6]).toBeCloseTo(5);
    expect(pathDistance3(path)).toBeLessThan(walked);
    // One way only: the reverse route walks.
    expect(findMeshPath(mesh, to, from, path)).toBe(true);
    expect(path.linkCount).toBe(0);
    // Too expensive: walked around instead.
    expect(removeOffMeshLink(mesh, id)).toBe(true);
    expect(removeOffMeshLink(mesh, id)).toBe(false);
    addOffMeshLink(mesh, {
      from: { x: -5, y: 0, z: 0 },
      to: { x: 5, y: 0, z: 0 },
      radius: 0.5,
      cost: 100,
    });
    findMeshPath(mesh, from, to, path);
    expect(path.linkCount).toBe(0);
    expect(pathDistance3(path)).toBeCloseTo(walked);
  });

  it('bidirectional links work both ways', () => {
    const mesh = floorWithPillar();
    addOffMeshLink(mesh, {
      from: { x: -5, y: 0, z: 0 },
      to: { x: 5, y: 0, z: 0 },
      radius: 0.5,
      bidirectional: true,
      cost: 1,
    });
    const path = createNavPath3();
    expect(findMeshPath(mesh, { x: 6, y: 0, z: 0 }, { x: -6, y: 0, z: 0 }, path)).toBe(true);
    expect(path.linkCount).toBe(1);
    expect(path.points[3]).toBeCloseTo(5);
    expect(path.points[6]).toBeCloseTo(-5);
  });
});

describe('serialisation', () => {
  it('round-trips byte for byte, links included', () => {
    const mesh = floorWithPillar();
    addOffMeshLink(mesh, {
      from: { x: -5, y: 0, z: 0 },
      to: { x: 5, y: 0, z: 0 },
      radius: 0.5,
      bidirectional: true,
      cost: 1,
    });
    addOffMeshLink(mesh, { from: { x: -5, y: 0, z: 5 }, to: { x: 5, y: 0, z: 5 }, radius: 0.5 });
    const bytes = exportNavMesh(mesh);
    const again = importNavMesh(bytes);
    expect(again.polyCount).toBe(mesh.polyCount);
    expect(again.vertCount).toBe(mesh.vertCount);
    expect(again.links.length).toBe(2);
    expect(again.links[1]?.cost).toBeUndefined();
    expect(new Uint8Array(exportNavMesh(again))).toEqual(new Uint8Array(bytes));
    const a = createNavPath3();
    const b = createNavPath3();
    findMeshPath(mesh, { x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, a);
    findMeshPath(again, { x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, b);
    expect(b.length).toBe(a.length);
    expect(b.linkCount).toBe(1);
    expect(importNavMesh(new Uint8Array(bytes))).toBeDefined();
    expect(() => importNavMesh(new ArrayBuffer(8))).toThrow();
  });
});

describe('bake time', () => {
  it('bakes 64 × 64 m at cellSize 0.3 under 500 ms (best of three)', () => {
    const pos: number[] = [];
    const idx: number[] = [];
    box(0, -0.5, 0, 64, 1, 64, pos, idx);
    for (let i = 0; i < 16; i++) {
      box(-24 + (i % 4) * 16, 1.5, -24 + Math.floor(i / 4) * 16, 2, 3, 2, pos, idx);
    }
    let best = Number.POSITIVE_INFINITY;
    let polys = 0;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      const mesh = bakeNavMesh({ positions: pos, indices: idx }, OPTS);
      best = Math.min(best, performance.now() - t0);
      polys = mesh.polyCount;
    }
    console.log(`bakeNavMesh 64x64 m @ 0.3: best ${best.toFixed(1)} ms, ${polys} polys`);
    expect(polys).toBeGreaterThan(0);
    expect(best).toBeLessThan(500);
  });
});
