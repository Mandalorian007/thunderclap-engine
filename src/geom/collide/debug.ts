/**
 * Wireframes of a collider for `createDebugDraw`: either every triangle's three edges or the
 * boxes of the BVH leaves (twelve edges each). Six floats per segment, `x0 y0 z0 x1 y1 z1`.
 */
import type { StaticCollider } from './bvh';

export type WireframeMode = 'triangles' | 'leaves';

/** The number of floats `colliderWireframe` writes for `c` in `mode`. */
export function colliderWireframeLength(
  c: StaticCollider,
  mode: WireframeMode = 'triangles',
): number {
  if (mode === 'leaves') {
    let leaves = 0;
    for (let n = 0; n < c.nodeLeaf.length; n++) {
      if (c.nodeLeaf[n] && c.nodeB[n]! > 0 && !c.sources[c.triSource[c.nodeA[n]!]!]!.removed)
        leaves++;
    }
    return leaves * 12 * 6;
  }
  return c.triangleCount * 3 * 6;
}

const BOX_EDGES = [
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0],
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

/**
 * Line segments for the collider's live triangles (`'triangles'`) or BVH leaf boxes
 * (`'leaves'`). Reuses `out` when it is long enough, else allocates; returns the array (which may
 * be longer than the written part: `colliderWireframeLength` gives the exact count).
 */
export function colliderWireframe(
  c: StaticCollider,
  out?: Float32Array,
  mode: WireframeMode = 'triangles',
): Float32Array {
  const need = colliderWireframeLength(c, mode);
  const buf = out && out.length >= need ? out : new Float32Array(need);
  let o = 0;
  if (mode === 'leaves') {
    for (let n = 0; n < c.nodeLeaf.length; n++) {
      if (!c.nodeLeaf[n] || c.nodeB[n]! <= 0) continue;
      if (c.sources[c.triSource[c.nodeA[n]!]!]!.removed) continue;
      const b = n * 3;
      for (const [i, j] of BOX_EDGES) {
        buf[o++] = i & 1 ? c.nodeMax[b]! : c.nodeMin[b]!;
        buf[o++] = i & 2 ? c.nodeMax[b + 1]! : c.nodeMin[b + 1]!;
        buf[o++] = i & 4 ? c.nodeMax[b + 2]! : c.nodeMin[b + 2]!;
        buf[o++] = j & 1 ? c.nodeMax[b]! : c.nodeMin[b]!;
        buf[o++] = j & 2 ? c.nodeMax[b + 1]! : c.nodeMin[b + 1]!;
        buf[o++] = j & 4 ? c.nodeMax[b + 2]! : c.nodeMin[b + 2]!;
      }
    }
    return buf;
  }
  const tris = c.tris;
  for (const s of c.sources) {
    if (s.removed) continue;
    const t0 = s.start * 9;
    const t1 = t0 + s.count * 9;
    for (let t = t0; t < t1; t += 9) {
      for (let e = 0; e < 3; e++) {
        const a = t + e * 3;
        const b = t + ((e + 1) % 3) * 3;
        buf[o++] = tris[a]!;
        buf[o++] = tris[a + 1]!;
        buf[o++] = tris[a + 2]!;
        buf[o++] = tris[b]!;
        buf[o++] = tris[b + 1]!;
        buf[o++] = tris[b + 2]!;
      }
    }
  }
  return buf;
}
