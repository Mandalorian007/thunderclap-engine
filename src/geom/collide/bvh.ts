/**
 * The static collider: every source's triangles flattened into one world-space `Float32Array`
 * (nine floats per triangle) under a bounding-volume hierarchy, built once by median split along
 * the widest centroid axis. Each source owns a contiguous block of triangles and of nodes, so a
 * moving platform refits its own sub-tree and the small top-level tree over the sources, never
 * the rest. Queries (`queries.ts`) walk the flat node arrays with a shared stack; nothing here
 * allocates after the build.
 *
 * Node layout, index `i`: `nodeMin`/`nodeMax` at `3i`; `nodeLeaf[i]` 1 for a leaf; for a leaf
 * `nodeA[i]` is the first triangle and `nodeB[i]` the count, for an inner node they are the two
 * children. A removed or empty source keeps an empty root box (min +∞, max −∞) that no query
 * enters.
 */
import type { Geometry } from '../geometry';
import type { Heightfield } from '../heightfield';
import { type GridSource, gridTriangles } from './grid';

/** A 3×4 row-major matrix (`Transform.world`, 12 floats) or a 4×4 column-major one (16 floats). */
export type ColliderTransform = ArrayLike<number>;

/** A `Geometry` (any layout whose first three floats per vertex are the position), optionally placed. */
export interface GeometrySource {
  geometry: Geometry;
  transform?: ColliderTransform;
  /** Collision layer, a bit index 0..31 (`layerMask` tests `1 << layer`). Default 0. */
  layer?: number;
  /** Handed back on every hit of this source; not serialised. */
  userData?: unknown;
}

/** A heightfield, one quad (two triangles) per cell, in its own world placement. */
export interface HeightfieldSource {
  heightfield: Heightfield;
  layer?: number;
  userData?: unknown;
}

/** A 2D tile grid: each solid cell is a box in xz (see `grid.ts`). */
export interface TileGridSource {
  grid: GridSource;
  layer?: number;
  userData?: unknown;
}

export type ColliderSource = GeometrySource | HeightfieldSource | TileGridSource;

export interface StaticColliderOptions {
  /** Most triangles per BVH leaf. Default 4. */
  leafSize?: number;
}

/** The kinds a source can be, as stored (and serialised): geometry 0, heightfield 1, grid 2. */
export type SourceKind = 0 | 1 | 2;
export const SOURCE_GEOMETRY = 0;
export const SOURCE_HEIGHTFIELD = 1;
export const SOURCE_GRID = 2;

/** One source's record inside the collider. */
export interface SourceRecord {
  kind: SourceKind;
  /** First triangle and count in `tris`. */
  start: number;
  count: number;
  /** The source's root node, and its node block `[nodeStart, nodeEnd)`. */
  root: number;
  nodeStart: number;
  nodeEnd: number;
  layer: number;
  removed: boolean;
  /** Geometry sources keep their untransformed triangles (nine floats each) for `refit`. */
  local: Float32Array | null;
  userData: unknown;
}

export interface ColliderBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * A world of static triangles under a BVH. Build with `createStaticCollider`, query with
 * `raycast`, `overlap`, `sweep` and `slide`, ship with `exportCollider`.
 */
export class StaticCollider {
  /** World-space triangles, nine floats each, in BVH leaf order. */
  readonly tris: Float32Array;
  /** The source index of each triangle. */
  readonly triSource: Uint32Array;
  readonly nodeMin: Float32Array;
  readonly nodeMax: Float32Array;
  readonly nodeLeaf: Uint8Array;
  readonly nodeA: Int32Array;
  readonly nodeB: Int32Array;
  /** The root node index. */
  readonly root: number;
  /** Top-level nodes over the sources occupy `[0, topCount)` (0 when there is one source). */
  readonly topCount: number;
  readonly sources: SourceRecord[];
  readonly leafSize: number;
  /** The union of every live source, kept current by `refit` and `remove`. */
  readonly bounds: ColliderBounds = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };

  constructor(parts: {
    tris: Float32Array;
    triSource: Uint32Array;
    nodeMin: Float32Array;
    nodeMax: Float32Array;
    nodeLeaf: Uint8Array;
    nodeA: Int32Array;
    nodeB: Int32Array;
    root: number;
    topCount: number;
    sources: SourceRecord[];
    leafSize: number;
  }) {
    this.tris = parts.tris;
    this.triSource = parts.triSource;
    this.nodeMin = parts.nodeMin;
    this.nodeMax = parts.nodeMax;
    this.nodeLeaf = parts.nodeLeaf;
    this.nodeA = parts.nodeA;
    this.nodeB = parts.nodeB;
    this.root = parts.root;
    this.topCount = parts.topCount;
    this.sources = parts.sources;
    this.leafSize = parts.leafSize;
    this.updateBounds();
  }

  /** Triangles in the live (not removed) sources. */
  get triangleCount(): number {
    let n = 0;
    for (const s of this.sources) if (!s.removed) n += s.count;
    return n;
  }

  /** Number of sources, removed ones included (indices stay stable). */
  get sourceCount(): number {
    return this.sources.length;
  }

  /** The `userData` of a source (-1 or out of range gives `undefined`). */
  userData(source: number): unknown {
    return this.sources[source]?.userData;
  }

  /**
   * Moves a geometry source to `transform` (a 3×4 `Transform.world` or a 4×4 column-major
   * matrix): rewrites its world triangles from the local copy, refits its leaves and inner nodes
   * bottom-up, then the top-level nodes. Nothing is rebuilt; a tree whose leaves have drifted far
   * apart only gets looser. Throws for a heightfield or grid source.
   */
  refit(sourceIndex: number, transform: ColliderTransform): void {
    const s = this.sources[sourceIndex];
    if (!s) throw new Error(`collide: no source ${sourceIndex}`);
    if (!s.local)
      throw new Error(
        `collide: source ${sourceIndex} is not a geometry; only geometry sources refit`,
      );
    if (s.removed) return;
    const local = s.local;
    const tris = this.tris;
    const base = s.start * 9;
    for (let i = 0; i < local.length; i += 3) {
      applyTransform(transform, local[i]!, local[i + 1]!, local[i + 2]!, tris, base + i);
    }
    this.refitBlock(s.nodeStart, s.nodeEnd);
    this.refitTop();
  }

  /** Drops a source from every query (its root box becomes empty). Indices do not shift. */
  remove(sourceIndex: number): void {
    const s = this.sources[sourceIndex];
    if (!s) throw new Error(`collide: no source ${sourceIndex}`);
    if (s.removed) return;
    s.removed = true;
    setEmpty(this.nodeMin, this.nodeMax, s.root);
    this.refitTop();
  }

  /** Recomputes the nodes of one block from its leaves up (children always follow parents). */
  private refitBlock(start: number, end: number): void {
    const { nodeMin, nodeMax, nodeLeaf, nodeA, nodeB, tris } = this;
    for (let n = end - 1; n >= start; n--) {
      if (nodeLeaf[n]) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        const t0 = nodeA[n]! * 9;
        const t1 = t0 + nodeB[n]! * 9;
        for (let i = t0; i < t1; i += 3) {
          const x = tris[i]!;
          const y = tris[i + 1]!;
          const z = tris[i + 2]!;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        nodeMin[n * 3] = minX;
        nodeMin[n * 3 + 1] = minY;
        nodeMin[n * 3 + 2] = minZ;
        nodeMax[n * 3] = maxX;
        nodeMax[n * 3 + 1] = maxY;
        nodeMax[n * 3 + 2] = maxZ;
      } else {
        unionChildren(nodeMin, nodeMax, n, nodeA[n]!, nodeB[n]!);
      }
    }
  }

  private refitTop(): void {
    const { nodeMin, nodeMax, nodeA, nodeB } = this;
    for (let n = this.topCount - 1; n >= 0; n--) {
      unionChildren(nodeMin, nodeMax, n, nodeA[n]!, nodeB[n]!);
    }
    this.updateBounds();
  }

  private updateBounds(): void {
    const r = this.root * 3;
    const b = this.bounds;
    b.min[0] = this.nodeMin[r]!;
    b.min[1] = this.nodeMin[r + 1]!;
    b.min[2] = this.nodeMin[r + 2]!;
    b.max[0] = this.nodeMax[r]!;
    b.max[1] = this.nodeMax[r + 1]!;
    b.max[2] = this.nodeMax[r + 2]!;
  }
}

function setEmpty(nodeMin: Float32Array, nodeMax: Float32Array, n: number): void {
  nodeMin[n * 3] = nodeMin[n * 3 + 1] = nodeMin[n * 3 + 2] = Number.POSITIVE_INFINITY;
  nodeMax[n * 3] = nodeMax[n * 3 + 1] = nodeMax[n * 3 + 2] = Number.NEGATIVE_INFINITY;
}

function unionChildren(
  nodeMin: Float32Array,
  nodeMax: Float32Array,
  n: number,
  a: number,
  b: number,
): void {
  for (let k = 0; k < 3; k++) {
    nodeMin[n * 3 + k] = Math.min(nodeMin[a * 3 + k]!, nodeMin[b * 3 + k]!);
    nodeMax[n * 3 + k] = Math.max(nodeMax[a * 3 + k]!, nodeMax[b * 3 + k]!);
  }
}

/**
 * Writes `m × (x, y, z, 1)` into `out` at `o`. `m` is a 3×4 row-major matrix (12 floats, as
 * `Transform.world`) or a 4×4 column-major one (16 floats, as `Camera.view`). Anything else throws.
 */
export function applyTransform(
  m: ColliderTransform,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  o: number,
): void {
  if (m.length === 12) {
    out[o] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
    out[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!;
    out[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!;
  } else if (m.length === 16) {
    out[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    out[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    out[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  } else {
    throw new Error(
      `collide: a transform has 12 (3×4 row-major) or 16 (4×4) floats, got ${m.length}`,
    );
  }
}

// ------------------------------------------------------------------ building

/** The nine floats per triangle of a geometry, in its own space. */
function geometryTriangles(g: Geometry): Float32Array {
  const floats = g.layout.floats;
  const idx = g.indices;
  const out = new Float32Array(idx.length * 3);
  const v = g.vertices;
  for (let i = 0; i < idx.length; i++) {
    const o = idx[i]! * floats;
    out[i * 3] = v[o]!;
    out[i * 3 + 1] = v[o + 1]!;
    out[i * 3 + 2] = v[o + 2]!;
  }
  return out;
}

/** Two triangles per cell, counter-clockwise seen from +y, the same surface `heightAt` samples. */
function heightfieldTriangles(hf: Heightfield): Float32Array {
  const { width, depth, heights, scale, origin } = hf;
  const cells = (width - 1) * (depth - 1);
  const out = new Float32Array(cells * 18);
  let o = 0;
  const at = (x: number, z: number, k: number) => {
    out[o + k] = origin[0] + x * scale[0];
    out[o + k + 1] = origin[1] + heights[z * width + x]! * scale[1];
    out[o + k + 2] = origin[2] + z * scale[2];
  };
  for (let z = 0; z < depth - 1; z++) {
    for (let x = 0; x < width - 1; x++) {
      // (x, z) (x, z+1) (x+1, z+1) and (x, z) (x+1, z+1) (x+1, z): CCW from above (+y).
      at(x, z, 0);
      at(x, z + 1, 3);
      at(x + 1, z + 1, 6);
      o += 9;
      at(x, z, 0);
      at(x + 1, z + 1, 3);
      at(x + 1, z, 6);
      o += 9;
    }
  }
  return out;
}

interface BuiltTree {
  min: number[];
  max: number[];
  leaf: number[];
  a: number[];
  b: number[];
}

/**
 * Builds a subtree over triangles `order[lo..hi)` of `tris` into `tree`, node indices offset by
 * `nodeBase` (the index the first node of this block gets). Returns the root's index.
 */
function buildSubtree(
  tris: Float32Array,
  order: Uint32Array,
  centroids: Float32Array,
  lo: number,
  hi: number,
  leafSize: number,
  tree: BuiltTree,
  nodeBase: number,
): number {
  const index = nodeBase + tree.leaf.length;
  // Bounds of the range and of its centroids.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let cMinX = Number.POSITIVE_INFINITY;
  let cMinY = Number.POSITIVE_INFINITY;
  let cMinZ = Number.POSITIVE_INFINITY;
  let cMaxX = Number.NEGATIVE_INFINITY;
  let cMaxY = Number.NEGATIVE_INFINITY;
  let cMaxZ = Number.NEGATIVE_INFINITY;
  for (let i = lo; i < hi; i++) {
    const t = order[i]!;
    for (let k = 0; k < 9; k += 3) {
      const x = tris[t * 9 + k]!;
      const y = tris[t * 9 + k + 1]!;
      const z = tris[t * 9 + k + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const cx = centroids[t * 3]!;
    const cy = centroids[t * 3 + 1]!;
    const cz = centroids[t * 3 + 2]!;
    if (cx < cMinX) cMinX = cx;
    if (cx > cMaxX) cMaxX = cx;
    if (cy < cMinY) cMinY = cy;
    if (cy > cMaxY) cMaxY = cy;
    if (cz < cMinZ) cMinZ = cz;
    if (cz > cMaxZ) cMaxZ = cz;
  }
  tree.min.push(minX, minY, minZ);
  tree.max.push(maxX, maxY, maxZ);
  const count = hi - lo;
  const ex = cMaxX - cMinX;
  const ey = cMaxY - cMinY;
  const ez = cMaxZ - cMinZ;
  const widest = Math.max(ex, ey, ez);
  if (count <= leafSize || count < 2 || !(widest > 0)) {
    tree.leaf.push(1);
    tree.a.push(lo);
    tree.b.push(count);
    return index;
  }
  const axis = widest === ex ? 0 : widest === ey ? 1 : 2;
  order.subarray(lo, hi).sort((p, q) => centroids[p * 3 + axis]! - centroids[q * 3 + axis]!);
  const mid = (lo + hi) >> 1;
  tree.leaf.push(0);
  tree.a.push(0);
  tree.b.push(0);
  const slot = index - nodeBase;
  tree.a[slot] = buildSubtree(tris, order, centroids, lo, mid, leafSize, tree, nodeBase);
  tree.b[slot] = buildSubtree(tris, order, centroids, mid, hi, leafSize, tree, nodeBase);
  return index;
}

interface SourceBuild {
  kind: SourceKind;
  world: Float32Array;
  local: Float32Array | null;
  layer: number;
  userData: unknown;
}

function prepareSource(src: ColliderSource): SourceBuild {
  const layer = src.layer ?? 0;
  if (!(layer >= 0 && layer < 32 && Number.isInteger(layer))) {
    throw new Error(`collide: layer must be an integer 0..31, got ${layer}`);
  }
  if ('geometry' in src) {
    const local = geometryTriangles(src.geometry);
    let world = local;
    if (src.transform) {
      world = new Float32Array(local.length);
      for (let i = 0; i < local.length; i += 3) {
        applyTransform(src.transform, local[i]!, local[i + 1]!, local[i + 2]!, world, i);
      }
    } else {
      world = new Float32Array(local);
    }
    return { kind: SOURCE_GEOMETRY, world, local, layer, userData: src.userData };
  }
  if ('heightfield' in src) {
    return {
      kind: SOURCE_HEIGHTFIELD,
      world: heightfieldTriangles(src.heightfield),
      local: null,
      layer,
      userData: src.userData,
    };
  }
  if ('grid' in src) {
    return {
      kind: SOURCE_GRID,
      world: gridTriangles(src.grid),
      local: null,
      layer,
      userData: src.userData,
    };
  }
  throw new Error('collide: a source is { geometry }, { heightfield } or { grid }');
}

/**
 * Builds a `StaticCollider` over `sources`. Every source becomes a block of triangles (world
 * space) and a BVH sub-tree (median split on the widest centroid axis, leaves of at most
 * `leafSize` triangles, default 4); a top-level tree over the sources' roots joins them.
 * Build-time allocation only; queries then allocate nothing.
 */
export function createStaticCollider(
  sources: ColliderSource[],
  opts: StaticColliderOptions = {},
): StaticCollider {
  const leafSize = Math.max(1, Math.floor(opts.leafSize ?? 4));
  if (sources.length === 0) throw new Error('collide: at least one source is needed');
  const builds = sources.map(prepareSource);
  let total = 0;
  for (const b of builds) total += b.world.length / 9;

  const tris = new Float32Array(total * 9);
  const triSource = new Uint32Array(total);
  const records: SourceRecord[] = [];
  const trees: BuiltTree[] = [];
  const roots: number[] = [];

  // Top-level nodes come first: with S sources a binary tree over them has S - 1 inner nodes.
  const topCount = builds.length > 1 ? builds.length - 1 : 0;
  let nodeCursor = topCount;
  let triCursor = 0;
  for (let si = 0; si < builds.length; si++) {
    const b = builds[si]!;
    const n = b.world.length / 9;
    const order = new Uint32Array(n);
    const centroids = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) {
      order[t] = t;
      const o = t * 9;
      centroids[t * 3] = (b.world[o]! + b.world[o + 3]! + b.world[o + 6]!) / 3;
      centroids[t * 3 + 1] = (b.world[o + 1]! + b.world[o + 4]! + b.world[o + 7]!) / 3;
      centroids[t * 3 + 2] = (b.world[o + 2]! + b.world[o + 5]! + b.world[o + 8]!) / 3;
    }
    const tree: BuiltTree = { min: [], max: [], leaf: [], a: [], b: [] };
    let root: number;
    if (n === 0) {
      root = nodeCursor;
      tree.min.push(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      tree.max.push(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
      tree.leaf.push(1);
      tree.a.push(0);
      tree.b.push(0);
    } else {
      root = buildSubtree(b.world, order, centroids, 0, n, leafSize, tree, nodeCursor);
    }
    // Leaf triangle ranges are in `order` positions; place the triangles in that order.
    for (let k = 0; k < tree.leaf.length; k++) {
      if (tree.leaf[k]) tree.a[k] = tree.a[k]! + triCursor;
    }
    const local = b.local ? new Float32Array(n * 9) : null;
    for (let p = 0; p < n; p++) {
      const t = order[p]!;
      tris.set(b.world.subarray(t * 9, t * 9 + 9), (triCursor + p) * 9);
      if (local && b.local) local.set(b.local.subarray(t * 9, t * 9 + 9), p * 9);
      triSource[triCursor + p] = si;
    }
    records.push({
      kind: b.kind,
      start: triCursor,
      count: n,
      root,
      nodeStart: nodeCursor,
      nodeEnd: nodeCursor + tree.leaf.length,
      layer: b.layer,
      removed: false,
      local,
      userData: b.userData,
    });
    trees.push(tree);
    roots.push(root);
    nodeCursor += tree.leaf.length;
    triCursor += n;
  }

  const nodeCount = nodeCursor;
  const nodeMin = new Float32Array(nodeCount * 3);
  const nodeMax = new Float32Array(nodeCount * 3);
  const nodeLeaf = new Uint8Array(nodeCount);
  const nodeA = new Int32Array(nodeCount);
  const nodeB = new Int32Array(nodeCount);
  for (let si = 0; si < trees.length; si++) {
    const tree = trees[si]!;
    const base = records[si]!.nodeStart;
    for (let k = 0; k < tree.leaf.length; k++) {
      nodeMin.set(tree.min.slice(k * 3, k * 3 + 3), (base + k) * 3);
      nodeMax.set(tree.max.slice(k * 3, k * 3 + 3), (base + k) * 3);
      nodeLeaf[base + k] = tree.leaf[k]!;
      nodeA[base + k] = tree.a[k]!;
      nodeB[base + k] = tree.b[k]!;
    }
  }

  // The top-level tree: median split over the source roots by their box centres.
  let root: number;
  if (topCount === 0) {
    root = roots[0]!;
  } else {
    let next = 0;
    const centre = (n: number, axis: number) =>
      (nodeMin[n * 3 + axis]! + nodeMax[n * 3 + axis]!) / 2;
    const buildTop = (items: number[]): number => {
      if (items.length === 1) return items[0]!;
      const index = next++;
      let axis = 0;
      let widest = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < 3; k++) {
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (const n of items) {
          const c = centre(n, k);
          if (Number.isFinite(c)) {
            lo = Math.min(lo, c);
            hi = Math.max(hi, c);
          }
        }
        if (hi - lo > widest) {
          widest = hi - lo;
          axis = k;
        }
      }
      const sorted = items.slice().sort((p, q) => centre(p, axis) - centre(q, axis));
      const mid = sorted.length >> 1;
      nodeLeaf[index] = 0;
      nodeA[index] = buildTop(sorted.slice(0, mid));
      nodeB[index] = buildTop(sorted.slice(mid));
      unionChildren(nodeMin, nodeMax, index, nodeA[index]!, nodeB[index]!);
      return index;
    };
    root = buildTop(roots);
  }

  return new StaticCollider({
    tris,
    triSource,
    nodeMin,
    nodeMax,
    nodeLeaf,
    nodeA,
    nodeB,
    root,
    topCount,
    sources: records,
    leafSize,
  });
}
