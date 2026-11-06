import { describe, expect, it } from 'vitest';
import { createVoxelGrid, type VoxelGrid } from './grid';
import {
  countExposedFaces,
  createChunkMeshOut,
  meshChunk,
  VOXEL_AO_CURVE,
  VOXEL_FACE_NORMALS,
  VOXEL_VERTEX_FLOATS,
} from './mesher';

const F = VOXEL_VERTEX_FLOATS;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function vertex(out: ReturnType<typeof createChunkMeshOut>, i: number): number[] {
  return Array.from(out.vertices.subarray(i * F, i * F + F));
}

/** Sum of every quad's area in cells (each quad is a rectangle of w × h exposed faces). */
function quadArea(out: ReturnType<typeof createChunkMeshOut>): number {
  let area = 0;
  for (let q = 0; q < out.vertexCount / 4; q++) {
    const a = vertex(out, q * 4);
    const b = vertex(out, q * 4 + 1);
    const d = vertex(out, q * 4 + 3);
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    area += Math.hypot(cx, cy, cz);
  }
  return area;
}

function cross(a: number[], b: number[], c: number[]): number[] {
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  return [
    u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!,
    u[0]! * v[1]! - u[1]! * v[0]!,
  ];
}

/**
 * Every quad is planar on its normal's axis, both triangles face along the vertex normal
 * (counter-clockwise from outside) and neither is degenerate. The riser-triangle check.
 * Plain loops with one `expect` at the end: a dense chunk has thousands of triangles.
 */
function checkWinding(out: ReturnType<typeof createChunkMeshOut>): void {
  expect(out.indexCount).toBe((out.vertexCount / 4) * 6);
  const bad: string[] = [];
  for (let t = 0; t < out.indexCount / 3 && bad.length < 5; t++) {
    const i0 = out.indices[t * 3]!;
    const i1 = out.indices[t * 3 + 1]!;
    const i2 = out.indices[t * 3 + 2]!;
    const q = Math.floor(i0 / 4);
    if (Math.floor(i1 / 4) !== q || Math.floor(i2 / 4) !== q) {
      bad.push(`tri ${t} spans quads`);
      continue;
    }
    const a = vertex(out, i0);
    const b = vertex(out, i1);
    const c = vertex(out, i2);
    const n = [a[3]!, a[4]!, a[5]!];
    const axis = n.findIndex((v) => v !== 0);
    if (Math.abs(n[axis]!) !== 1) bad.push(`tri ${t} normal ${n}`);
    for (let k = 3; k < 6; k++) {
      if (b[k] !== a[k] || c[k] !== a[k]) bad.push(`tri ${t} mixed normals`);
    }
    if (b[axis] !== a[axis] || c[axis] !== a[axis]) bad.push(`tri ${t} not planar`);
    const tn = cross(a, b, c);
    const len = Math.hypot(tn[0]!, tn[1]!, tn[2]!);
    if (len < 0.5) bad.push(`tri ${t} degenerate`);
    const dot = (tn[0]! * n[0]! + tn[1]! * n[1]! + tn[2]! * n[2]!) / len;
    if (Math.abs(dot - 1) > 1e-6) bad.push(`tri ${t} winds against its normal (${dot})`);
  }
  expect(bad).toEqual([]);
}

function randomGrid(seed: number, size = 16, fill = 0.3): VoxelGrid {
  const r = rng(seed);
  const g = createVoxelGrid({ sizeX: size, sizeY: size, sizeZ: size, chunk: 16 });
  g.fill(() => (r() < fill ? 1 + Math.floor(r() * 3) : 0));
  return g;
}

describe('meshChunk', () => {
  it('one block gives 6 quads, 24 vertices, 36 indices, outward normals, layer in alpha', () => {
    const g = createVoxelGrid({ sizeX: 16, sizeY: 16, sizeZ: 16 });
    g.set(3, 4, 5, 2);
    const out = createChunkMeshOut();
    meshChunk(g, 0, 0, 0, { ao: false }, out);
    expect(out.vertexCount).toBe(24);
    expect(out.indexCount).toBe(36);
    checkWinding(out);
    const seen = new Set<string>();
    for (let v = 0; v < 24; v++) {
      const d = vertex(out, v);
      seen.add(`${d[3]},${d[4]},${d[5]}`);
      expect(d[6]).toBeGreaterThanOrEqual(0);
      expect(d[8]).toBe(1);
      expect(d[9]).toBe(1);
      expect(d[10]).toBe(1);
      expect(d[11]).toBe(1); // layer = block - 1
      for (let a = 0; a < 3; a++) {
        expect(d[a]).toBeGreaterThanOrEqual([3, 4, 5][a]!);
        expect(d[a]).toBeLessThanOrEqual([3, 4, 5][a]! + 1);
      }
    }
    expect(seen.size).toBe(6);
    for (const n of VOXEL_FACE_NORMALS) expect(seen.has(n.join(','))).toBe(true);
    expect(out.bounds.center).toEqual([3.5, 4.5, 5.5]);
    expect(out.bounds.radius).toBeCloseTo(Math.sqrt(0.75));
  });

  it('a full chunk is one quad per side of the box and uses layerOf per face', () => {
    const g = createVoxelGrid({ sizeX: 16, sizeY: 16, sizeZ: 16 });
    g.fill(() => 5);
    const out = createChunkMeshOut();
    const layerOf = (block: number, face: number) => block * 10 + face;
    meshChunk(g, 0, 0, 0, { ao: false, layerOf }, out);
    expect(out.vertexCount).toBe(24);
    checkWinding(out);
    const layers = new Set<number>();
    for (let v = 0; v < 24; v++) layers.add(vertex(out, v)[11]!);
    expect([...layers].sort()).toEqual([50, 51, 52, 53, 54, 55]);
    expect(out.bounds.center).toEqual([8, 8, 8]);
    // Merged quads span the whole face: uv runs 0..16.
    let maxUv = 0;
    for (let v = 0; v < 24; v++) maxUv = Math.max(maxUv, vertex(out, v)[6]!, vertex(out, v)[7]!);
    expect(maxUv).toBe(16);
  });

  it('outside hides the faces it covers; a solid floor below y 0 hides the underside', () => {
    const g = createVoxelGrid({ sizeX: 16, sizeY: 16, sizeZ: 16 });
    g.fill((_x, y) => (y < 2 ? 1 : 0));
    const out = createChunkMeshOut();
    meshChunk(g, 0, 0, 0, { ao: false }, out);
    expect(out.vertexCount / 4).toBe(6);
    meshChunk(g, 0, 0, 0, { ao: false, outside: (_x, y) => (y < 0 ? 1 : 0) }, out);
    expect(out.vertexCount / 4).toBe(5);
    meshChunk(g, 0, 0, 0, { ao: false, outside: 1 }, out);
    expect(out.vertexCount / 4).toBe(1);
    expect(countExposedFaces(g, 0, 0, 0, 1)).toBe(16 * 16);
  });

  it('quad areas sum to the brute-force exposed-face count on random grids, ao on and off', () => {
    const out = createChunkMeshOut(4);
    for (let seed = 1; seed <= 3; seed++) {
      const g = randomGrid(seed);
      const expected = countExposedFaces(g, 0, 0, 0);
      expect(expected).toBeGreaterThan(100);
      meshChunk(g, 0, 0, 0, { ao: true }, out);
      expect(quadArea(out)).toBe(expected);
      checkWinding(out);
      const withAo = out.vertexCount;
      meshChunk(g, 0, 0, 0, { ao: false }, out);
      expect(quadArea(out)).toBe(expected);
      checkWinding(out);
      expect(out.vertexCount).toBeLessThanOrEqual(withAo);
    }
    // The small buffers grew with slack and are reused.
    expect(out.vertices.length).toBeGreaterThan(4 * 4 * F);
  });

  it('chunks at a ragged grid edge and across chunk borders', () => {
    const r = rng(42);
    const g = createVoxelGrid({ sizeX: 20, sizeY: 9, sizeZ: 17, chunk: 8 });
    g.fill(() => (r() < 0.4 ? 1 : 0));
    const out = createChunkMeshOut();
    for (let c = 0; c < g.chunkCount; c++) {
      const cc = [0, 0, 0];
      g.chunkCoords(c, cc);
      meshChunk(g, cc[0]!, cc[1]!, cc[2]!, {}, out);
      expect(quadArea(out)).toBe(countExposedFaces(g, cc[0]!, cc[1]!, cc[2]!));
      checkWinding(out);
      for (let v = 0; v < out.vertexCount; v++) {
        const d = vertex(out, v);
        expect(d[0]).toBeGreaterThanOrEqual(0);
        expect(d[0]).toBeLessThanOrEqual(8);
        expect(d[1]).toBeLessThanOrEqual(8);
      }
    }
  });

  it('a one-block step bakes AO into the inside corner and flips the diagonal along it', () => {
    const g = createVoxelGrid({ sizeX: 16, sizeY: 16, sizeZ: 16 });
    g.fill((_x, y) => (y === 0 ? 1 : 0));
    g.set(5, 1, 5, 1);
    const out = createChunkMeshOut();
    meshChunk(g, 0, 0, 0, { ao: true }, out);
    checkWinding(out);
    expect(quadArea(out)).toBe(countExposedFaces(g, 0, 0, 0));
    // Top faces of the floor next to the step carry occlusion; far ones are fully lit.
    const tops: number[][] = [];
    for (let v = 0; v < out.vertexCount; v++) {
      const d = vertex(out, v);
      if (d[4] === 1 && d[1] === 1) tops.push(d);
    }
    const near = tops.filter((d) => Math.abs(d[0]! - 5.5) <= 0.5 && Math.abs(d[2]! - 5.5) <= 0.5);
    const far = tops.filter((d) => Math.abs(d[0]! - 5.5) > 2 || Math.abs(d[2]! - 5.5) > 2);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    for (const d of far) expect(d[8]).toBe(1);
    for (const d of near) {
      expect(d[8]).toBeLessThan(1);
      expect(VOXEL_AO_CURVE.some((a) => Math.abs(a - d[8]!) < 1e-6)).toBe(true);
    }
    // Every floor quad touching the step: the shared diagonal joins the darker pair of corners,
    // so the occlusion grades across both triangles instead of filling one and sparing the
    // other (the riser triangle).
    for (let q = 0; q < out.vertexCount / 4; q++) {
      const vs = [0, 1, 2, 3].map((i) => vertex(out, q * 4 + i));
      const ao = vs.map((d) => d[8]!);
      if (ao.every((a) => a === ao[0])) continue;
      const i0 = out.indices[q * 6]!;
      const tri1 = [out.indices[q * 6]!, out.indices[q * 6 + 1]!, out.indices[q * 6 + 2]!];
      const tri2 = [out.indices[q * 6 + 3]!, out.indices[q * 6 + 4]!, out.indices[q * 6 + 5]!];
      const shared = tri1.filter((i) => tri2.includes(i)).map((i) => i - q * 4);
      expect(shared).toHaveLength(2);
      const [s0, s1] = shared as [number, number];
      const other = [0, 1, 2, 3].filter((i) => i !== s0 && i !== s1) as [number, number];
      expect(ao[s0]! + ao[s1]!).toBeLessThanOrEqual(ao[other[0]]! + ao[other[1]]!);
      expect(Math.floor(i0 / 4)).toBe(q);
    }
  });

  it('is pure: the same grid meshes to the same bytes twice, and an empty chunk to nothing', () => {
    const g = randomGrid(7);
    const a = createChunkMeshOut();
    const b = createChunkMeshOut();
    meshChunk(g, 0, 0, 0, {}, a);
    meshChunk(g, 0, 0, 0, {}, b);
    expect(a.vertexCount).toBe(b.vertexCount);
    expect(Array.from(a.vertices.subarray(0, a.vertexCount * F))).toEqual(
      Array.from(b.vertices.subarray(0, b.vertexCount * F)),
    );
    expect(Array.from(a.indices.subarray(0, a.indexCount))).toEqual(
      Array.from(b.indices.subarray(0, b.indexCount)),
    );
    const empty = createVoxelGrid({ sizeX: 16, sizeY: 16, sizeZ: 16 });
    meshChunk(empty, 0, 0, 0, {}, a);
    expect(a.vertexCount).toBe(0);
    expect(a.indexCount).toBe(0);
    expect(a.bounds.radius).toBe(0);
  });
});
