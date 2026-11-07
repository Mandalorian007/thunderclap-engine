/**
 * `NavMesh`: convex walkable polygons with shared edges, baked from triangle soup by
 * `bakeNavMesh`. Queries (nearest polygon, random point, raycast, height) allocate nothing after
 * construction and write into an `out`. Polygons are wound counter-clockwise seen from above
 * (`area2 > 0`), so for edge `e` the right portal vertex is `v[e]` and the left is `v[e + 1]`.
 */
import { type AreaStamp, markArea } from './areas';
import { resolveNavBakeOptions } from './bake-options';
import { buildContours } from './contour';
import type { OffMeshLink } from './links';
import { buildPolyMesh } from './polymesh';
import { buildRegions } from './regions';
import {
  buildCompactHeightfield,
  computeBounds,
  createHeightfield,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  type NavBakeOptions,
  type NavBakeSource,
  rasterizeSources,
} from './voxelize';

export interface NavPoint3 {
  x: number;
  y: number;
  z: number;
}

export interface NavBounds {
  min: NavPoint3;
  max: NavPoint3;
}

/** Twice the signed XZ area of `a, b, c`; positive is counter-clockwise seen from above. */
export function area2(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): number {
  return (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
}

const GRID_MAX_DIM = 256;

export class NavMesh {
  /** World `x, y, z` per vertex. */
  readonly verts: Float32Array;
  readonly vertCount: number;
  /** `maxVertsPerPoly` vertex indices per polygon, -1 padded. */
  readonly polys: Int32Array;
  /** Per polygon edge `e` (from vertex `e` to `e + 1`): the polygon across it, or -1. */
  readonly adjacency: Int32Array;
  readonly polyCount: number;
  readonly maxVertsPerPoly: number;
  readonly bounds: NavBounds;
  /** The bake's cell size and height, kept for serialisation and for defaults in queries. */
  readonly cellSize: number;
  readonly cellHeight: number;
  /** The area byte per polygon (0 default; `markArea` stamps, 255 is reserved for obstacles). */
  readonly area: Uint8Array;
  /** Bumps whenever the mesh changes (links added or removed, areas stamped, obstacles applied). */
  version = 0;
  /** The polygons the last `polysInBox` found (its return value says how many). */
  readonly polysFound: Int32Array;
  private readonly foundStamp: Uint32Array;
  private findStamp = 0;

  /** Off-mesh links by index (holes stay `null` after removal); edit with `addOffMeshLink`. */
  readonly links: (OffMeshLink | null)[] = [];
  /** CSR of link ends per polygon: `linkItems[linkStart[p] .. linkStart[p + 1])` are `link * 2 + end`. */
  linkStart: Int32Array;
  linkItems: Int32Array;
  nextLinkId = 1;

  /** Vertices per polygon (3..`maxVertsPerPoly`). */
  private readonly nverts: Uint8Array;
  /** Per polygon XZ AABB, `minX, minZ, maxX, maxZ`. */
  private readonly polyBox: Float32Array;
  /** Cumulative polygon areas for `findRandomPoint`. */
  private readonly cumArea: Float64Array;
  private readonly gridW: number;
  private readonly gridH: number;
  private readonly gridCell: number;
  private readonly gridStart: Int32Array;
  private readonly gridItems: Int32Array;
  private readonly triArea: Float64Array;

  constructor(
    verts: Float32Array,
    vertCount: number,
    polys: Int32Array,
    polyCount: number,
    maxVertsPerPoly: number,
    cellSize: number,
    cellHeight: number,
    adjacency?: Int32Array,
    area?: Uint8Array,
  ) {
    this.verts = verts;
    this.vertCount = vertCount;
    this.polys = polys;
    this.polyCount = polyCount;
    this.maxVertsPerPoly = maxVertsPerPoly;
    this.cellSize = cellSize;
    this.cellHeight = cellHeight;
    const nvp = maxVertsPerPoly;
    this.nverts = new Uint8Array(Math.max(1, polyCount));
    for (let p = 0; p < polyCount; p++) {
      let n = 0;
      while (n < nvp && polys[p * nvp + n] !== -1) n++;
      this.nverts[p] = n;
    }
    this.normaliseWinding();
    this.adjacency = adjacency ?? buildAdjacency(polys, polyCount, nvp, this.nverts, vertCount);
    this.triArea = new Float64Array(Math.max(1, nvp));
    this.area = area ?? new Uint8Array(Math.max(1, polyCount));
    this.polysFound = new Int32Array(Math.max(1, polyCount));
    this.foundStamp = new Uint32Array(Math.max(1, polyCount));

    const min = {
      x: Number.POSITIVE_INFINITY,
      y: Number.POSITIVE_INFINITY,
      z: Number.POSITIVE_INFINITY,
    };
    const max = {
      x: Number.NEGATIVE_INFINITY,
      y: Number.NEGATIVE_INFINITY,
      z: Number.NEGATIVE_INFINITY,
    };
    for (let i = 0; i < vertCount; i++) {
      const x = verts[i * 3]!;
      const y = verts[i * 3 + 1]!;
      const z = verts[i * 3 + 2]!;
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
    }
    if (vertCount === 0) {
      min.x = min.y = min.z = 0;
      max.x = max.y = max.z = 0;
    }
    this.bounds = { min, max };

    this.polyBox = new Float32Array(Math.max(1, polyCount) * 4);
    this.cumArea = new Float64Array(Math.max(1, polyCount));
    let acc = 0;
    for (let p = 0; p < polyCount; p++) {
      let bx0 = Number.POSITIVE_INFINITY;
      let bz0 = Number.POSITIVE_INFINITY;
      let bx1 = Number.NEGATIVE_INFINITY;
      let bz1 = Number.NEGATIVE_INFINITY;
      const n = this.nverts[p]!;
      for (let k = 0; k < n; k++) {
        const v = polys[p * nvp + k]!;
        const x = verts[v * 3]!;
        const z = verts[v * 3 + 2]!;
        if (x < bx0) bx0 = x;
        if (z < bz0) bz0 = z;
        if (x > bx1) bx1 = x;
        if (z > bz1) bz1 = z;
      }
      this.polyBox[p * 4] = bx0;
      this.polyBox[p * 4 + 1] = bz0;
      this.polyBox[p * 4 + 2] = bx1;
      this.polyBox[p * 4 + 3] = bz1;
      acc += this.polyArea(p);
      this.cumArea[p] = acc;
    }

    // Uniform grid over the XZ bounds, about one polygon per cell.
    const dim = Math.min(GRID_MAX_DIM, Math.max(1, Math.ceil(Math.sqrt(polyCount))));
    const ex = Math.max(max.x - min.x, 1e-6);
    const ez = Math.max(max.z - min.z, 1e-6);
    this.gridCell = Math.max(ex, ez) / dim;
    this.gridW = Math.max(1, Math.ceil(ex / this.gridCell));
    this.gridH = Math.max(1, Math.ceil(ez / this.gridCell));
    const cells = this.gridW * this.gridH;
    this.gridStart = new Int32Array(cells + 1);
    for (let p = 0; p < polyCount; p++) {
      const x0 = this.gx(this.polyBox[p * 4]!);
      const z0 = this.gz(this.polyBox[p * 4 + 1]!);
      const x1 = this.gx(this.polyBox[p * 4 + 2]!);
      const z1 = this.gz(this.polyBox[p * 4 + 3]!);
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) this.gridStart[x + z * this.gridW + 1]!++;
    }
    for (let c = 0; c < cells; c++) this.gridStart[c + 1]! += this.gridStart[c]!;
    this.gridItems = new Int32Array(Math.max(1, this.gridStart[cells]!));
    const fill = new Int32Array(cells);
    for (let p = 0; p < polyCount; p++) {
      const x0 = this.gx(this.polyBox[p * 4]!);
      const z0 = this.gz(this.polyBox[p * 4 + 1]!);
      const x1 = this.gx(this.polyBox[p * 4 + 2]!);
      const z1 = this.gz(this.polyBox[p * 4 + 3]!);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const c = x + z * this.gridW;
          this.gridItems[this.gridStart[c]! + fill[c]!++] = p;
        }
      }
    }
    this.linkStart = new Int32Array(polyCount + 1);
    this.linkItems = new Int32Array(0);
  }

  private gx(x: number): number {
    const i = Math.floor((x - this.bounds.min.x) / this.gridCell);
    return i < 0 ? 0 : i >= this.gridW ? this.gridW - 1 : i;
  }
  private gz(z: number): number {
    const i = Math.floor((z - this.bounds.min.z) / this.gridCell);
    return i < 0 ? 0 : i >= this.gridH ? this.gridH - 1 : i;
  }

  /**
   * Collects every polygon whose XZ bounding box overlaps the box into `polysFound` (each
   * once) and returns how many. Allocation-free; the next call overwrites the list.
   */
  polysInBox(minX: number, minZ: number, maxX: number, maxZ: number): number {
    if (this.polyCount === 0) return 0;
    this.findStamp = (this.findStamp + 1) >>> 0;
    if (this.findStamp === 0) {
      this.foundStamp.fill(0);
      this.findStamp = 1;
    }
    const stamp = this.findStamp;
    const cx0 = this.gx(minX);
    const cz0 = this.gz(minZ);
    const cx1 = this.gx(maxX);
    const cz1 = this.gz(maxZ);
    let count = 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cx + cz * this.gridW;
        const end = this.gridStart[c + 1]!;
        for (let i = this.gridStart[c]!; i < end; i++) {
          const p = this.gridItems[i]!;
          if (this.foundStamp[p] === stamp) continue;
          this.foundStamp[p] = stamp;
          const bx0 = this.polyBox[p * 4]!;
          const bz0 = this.polyBox[p * 4 + 1]!;
          const bx1 = this.polyBox[p * 4 + 2]!;
          const bz1 = this.polyBox[p * 4 + 3]!;
          if (bx0 > maxX || bx1 < minX || bz0 > maxZ || bz1 < minZ) continue;
          this.polysFound[count++] = p;
        }
      }
    }
    return count;
  }

  /** Reverses any clockwise polygon so every polygon is counter-clockwise seen from above. */
  private normaliseWinding(): void {
    const nvp = this.maxVertsPerPoly;
    for (let p = 0; p < this.polyCount; p++) {
      const n = this.nverts[p]!;
      let a = 0;
      const v0 = this.polys[p * nvp]!;
      for (let k = 1; k + 1 < n; k++) {
        const v1 = this.polys[p * nvp + k]!;
        const v2 = this.polys[p * nvp + k + 1]!;
        a += area2(
          this.verts[v0 * 3]!,
          this.verts[v0 * 3 + 2]!,
          this.verts[v1 * 3]!,
          this.verts[v1 * 3 + 2]!,
          this.verts[v2 * 3]!,
          this.verts[v2 * 3 + 2]!,
        );
      }
      if (a < 0) {
        for (let i = 0, j = n - 1; i < j; i++, j--) {
          const t = this.polys[p * nvp + i]!;
          this.polys[p * nvp + i] = this.polys[p * nvp + j]!;
          this.polys[p * nvp + j] = t;
        }
      }
    }
  }

  /** Vertices in polygon `p`. */
  polyVertexCount(p: number): number {
    return this.nverts[p]!;
  }

  /** World position of vertex `k` of polygon `p`, into `out`. */
  polyVertex(p: number, k: number, out: NavPoint3): NavPoint3 {
    const v = this.polys[p * this.maxVertsPerPoly + k]! * 3;
    out.x = this.verts[v]!;
    out.y = this.verts[v + 1]!;
    out.z = this.verts[v + 2]!;
    return out;
  }

  /** The polygon's vertex centroid, into `out`. */
  polyCenter(p: number, out: NavPoint3): NavPoint3 {
    const n = this.nverts[p]!;
    const nvp = this.maxVertsPerPoly;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < n; k++) {
      const v = this.polys[p * nvp + k]! * 3;
      x += this.verts[v]!;
      y += this.verts[v + 1]!;
      z += this.verts[v + 2]!;
    }
    out.x = x / n;
    out.y = y / n;
    out.z = z / n;
    return out;
  }

  /** The polygon's XZ area. */
  polyArea(p: number): number {
    const n = this.nverts[p]!;
    const nvp = this.maxVertsPerPoly;
    const v0 = this.polys[p * nvp]! * 3;
    let a = 0;
    for (let k = 1; k + 1 < n; k++) {
      const v1 = this.polys[p * nvp + k]! * 3;
      const v2 = this.polys[p * nvp + k + 1]! * 3;
      a += area2(
        this.verts[v0]!,
        this.verts[v0 + 2]!,
        this.verts[v1]!,
        this.verts[v1 + 2]!,
        this.verts[v2]!,
        this.verts[v2 + 2]!,
      );
    }
    return a * 0.5;
  }

  /** Whether `(x, z)` projects inside polygon `p` (edges included). */
  containsXZ(p: number, x: number, z: number): boolean {
    const n = this.nverts[p]!;
    const nvp = this.maxVertsPerPoly;
    for (let k = 0; k < n; k++) {
      const a = this.polys[p * nvp + k]! * 3;
      const b = this.polys[p * nvp + (k + 1 === n ? 0 : k + 1)]! * 3;
      if (
        area2(this.verts[a]!, this.verts[a + 2]!, this.verts[b]!, this.verts[b + 2]!, x, z) < -1e-6
      ) {
        return false;
      }
    }
    return true;
  }

  /** The surface height of polygon `p` at `(x, z)`, by its triangle fan (extrapolated outside). */
  polyHeight(p: number, x: number, z: number): number {
    const n = this.nverts[p]!;
    const nvp = this.maxVertsPerPoly;
    const v0 = this.polys[p * nvp]! * 3;
    const ax = this.verts[v0]!;
    const ay = this.verts[v0 + 1]!;
    const az = this.verts[v0 + 2]!;
    let best = ay;
    const bestInside = false;
    let bestOut = Number.POSITIVE_INFINITY;
    for (let k = 1; k + 1 < n; k++) {
      const v1 = this.polys[p * nvp + k]! * 3;
      const v2 = this.polys[p * nvp + k + 1]! * 3;
      const bx = this.verts[v1]!;
      const by = this.verts[v1 + 1]!;
      const bz = this.verts[v1 + 2]!;
      const cx = this.verts[v2]!;
      const cy = this.verts[v2 + 1]!;
      const cz = this.verts[v2 + 2]!;
      const d = area2(ax, az, bx, bz, cx, cz);
      if (Math.abs(d) < 1e-12) continue;
      const u = area2(x, z, bx, bz, cx, cz) / d;
      const v = area2(ax, az, x, z, cx, cz) / d;
      const w = 1 - u - v;
      const h = u * ay + v * by + w * cy;
      const outside = Math.max(0, -u, -v, -w);
      if (outside === 0) return h;
      if (!bestInside && outside < bestOut) {
        bestOut = outside;
        best = h;
      }
    }
    return best;
  }

  /**
   * The polygon under or nearest to `(x, y, z)` within `radius`, or -1; the nearest point on it is
   * written to `out` (left untouched when none).
   */
  findNearestPoly(
    x: number,
    y: number,
    z: number,
    out: NavPoint3,
    radius = Number.POSITIVE_INFINITY,
  ): number {
    let best = -1;
    let bestD = radius * radius;
    const whole = !Number.isFinite(radius);
    const cx0 = whole ? 0 : this.gx(x - radius);
    const cz0 = whole ? 0 : this.gz(z - radius);
    const cx1 = whole ? this.gridW - 1 : this.gx(x + radius);
    const cz1 = whole ? this.gridH - 1 : this.gz(z + radius);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cx + cz * this.gridW;
        const end = this.gridStart[c + 1]!;
        for (let i = this.gridStart[c]!; i < end; i++) {
          const p = this.gridItems[i]!;
          // Skip a polygon seen through an earlier cell: it is nearest only once anyway.
          if (!whole) {
            const bx0 = this.polyBox[p * 4]!;
            const bz0 = this.polyBox[p * 4 + 1]!;
            const bx1 = this.polyBox[p * 4 + 2]!;
            const bz1 = this.polyBox[p * 4 + 3]!;
            if (bx0 > x + radius || bx1 < x - radius || bz0 > z + radius || bz1 < z - radius)
              continue;
          }
          const d = this.closestPointOnPoly(p, x, y, z, scratch);
          if (d < bestD) {
            bestD = d;
            best = p;
            out.x = scratch.x;
            out.y = scratch.y;
            out.z = scratch.z;
          }
        }
      }
    }
    return best;
  }

  /** The point of polygon `p` nearest `(x, y, z)` into `out`; returns the squared distance. */
  closestPointOnPoly(p: number, x: number, y: number, z: number, out: NavPoint3): number {
    if (this.containsXZ(p, x, z)) {
      out.x = x;
      out.z = z;
      out.y = this.polyHeight(p, x, z);
      const dy = out.y - y;
      return dy * dy;
    }
    const n = this.nverts[p]!;
    const nvp = this.maxVertsPerPoly;
    let bestD = Number.POSITIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      const a = this.polys[p * nvp + k]! * 3;
      const b = this.polys[p * nvp + (k + 1 === n ? 0 : k + 1)]! * 3;
      const ax = this.verts[a]!;
      const ay = this.verts[a + 1]!;
      const az = this.verts[a + 2]!;
      const ex = this.verts[b]! - ax;
      const ey = this.verts[b + 1]! - ay;
      const ez = this.verts[b + 2]! - az;
      const len = ex * ex + ez * ez;
      let t = len > 0 ? ((x - ax) * ex + (z - az) * ez) / len : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + ex * t;
      const py = ay + ey * t;
      const pz = az + ez * t;
      const dx = px - x;
      const dy = py - y;
      const dz = pz - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        out.x = px;
        out.y = py;
        out.z = pz;
      }
    }
    return bestD;
  }

  /** The polygon whose XZ footprint holds `(x, z)`, nearest in height to `y`; -1 when none. */
  findPolyAt(x: number, y: number, z: number): number {
    const c = this.gx(x) + this.gz(z) * this.gridW;
    const end = this.gridStart[c + 1]!;
    let best = -1;
    let bestDy = Number.POSITIVE_INFINITY;
    for (let i = this.gridStart[c]!; i < end; i++) {
      const p = this.gridItems[i]!;
      if (!this.containsXZ(p, x, z)) continue;
      const dy = Math.abs(this.polyHeight(p, x, z) - y);
      if (dy < bestDy) {
        bestDy = dy;
        best = p;
      }
    }
    return best;
  }

  /** The surface height at `(x, z)`: of `poly` when given, else of the polygon under it; NaN off the mesh. */
  height(x: number, z: number, poly = -1): number {
    const p = poly >= 0 ? poly : this.findPolyAt(x, 0, z);
    if (p < 0) return Number.NaN;
    return this.polyHeight(p, x, z);
  }

  /** A uniformly random point on the mesh into `out`; returns its polygon (-1 on an empty mesh). */
  findRandomPoint(out: NavPoint3, rng: () => number = Math.random): number {
    if (this.polyCount === 0) return -1;
    const total = this.cumArea[this.polyCount - 1]!;
    const target = rng() * total;
    let lo = 0;
    let hi = this.polyCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumArea[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    const p = lo;
    const n = this.nverts[p]!;
    const nvp = this.maxVertsPerPoly;
    const v0 = this.polys[p * nvp]! * 3;
    let acc = 0;
    for (let k = 1; k + 1 < n; k++) {
      const v1 = this.polys[p * nvp + k]! * 3;
      const v2 = this.polys[p * nvp + k + 1]! * 3;
      acc += Math.abs(
        area2(
          this.verts[v0]!,
          this.verts[v0 + 2]!,
          this.verts[v1]!,
          this.verts[v1 + 2]!,
          this.verts[v2]!,
          this.verts[v2 + 2]!,
        ),
      );
      this.triArea[k] = acc;
    }
    const pick = rng() * acc;
    let k = 1;
    while (k + 2 < n && this.triArea[k]! < pick) k++;
    const v1 = this.polys[p * nvp + k]! * 3;
    const v2 = this.polys[p * nvp + k + 1]! * 3;
    let s = rng();
    let t = rng();
    if (s + t > 1) {
      s = 1 - s;
      t = 1 - t;
    }
    const u = 1 - s - t;
    out.x = u * this.verts[v0]! + s * this.verts[v1]! + t * this.verts[v2]!;
    out.y = u * this.verts[v0 + 1]! + s * this.verts[v1 + 1]! + t * this.verts[v2 + 1]!;
    out.z = u * this.verts[v0 + 2]! + s * this.verts[v1 + 2]! + t * this.verts[v2 + 2]!;
    return p;
  }

  /**
   * Walks the segment `from → to` across polygon edges. Returns `true` when a boundary edge
   * stops it, with the hit point in `out`; otherwise `false` with `to` in `out`. A start off the
   * mesh hits at once. `startPoly` skips the lookup of the polygon under `from`.
   */
  raycast(from: NavPoint3, to: NavPoint3, out: NavPoint3, startPoly = -1): boolean {
    let p = startPoly >= 0 ? startPoly : this.findPolyAt(from.x, from.y, from.z);
    if (p < 0) {
      out.x = from.x;
      out.y = from.y;
      out.z = from.z;
      return true;
    }
    const nvp = this.maxVertsPerPoly;
    for (let guard = 0; guard <= this.polyCount; guard++) {
      // The segment leaves `p` through the edge whose exit parameter is smallest.
      const n = this.nverts[p]!;
      let tmax = Number.POSITIVE_INFINITY;
      let exit = -1;
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      for (let k = 0; k < n; k++) {
        const a = this.polys[p * nvp + k]! * 3;
        const b = this.polys[p * nvp + (k + 1 === n ? 0 : k + 1)]! * 3;
        const ax = this.verts[a]!;
        const az = this.verts[a + 2]!;
        const ex = this.verts[b]! - ax;
        const ez = this.verts[b + 2]! - az;
        // area2(a, b, from + d t) = dist + t * denom; the ray exits across this edge when that
        // falls to zero, which needs denom < 0 (dist is >= 0 inside a CCW polygon).
        const denom = ex * dz - ez * dx;
        if (denom >= -1e-12) continue;
        const dist = area2(ax, az, this.verts[b]!, this.verts[b + 2]!, from.x, from.z);
        const t = dist / -denom;
        if (t < tmax) {
          tmax = t;
          exit = k;
        }
      }
      if (exit === -1 || tmax >= 1) {
        out.x = to.x;
        out.y = to.y;
        out.z = to.z;
        return false;
      }
      const t = Math.max(0, tmax);
      const next = this.adjacency[p * nvp + exit]!;
      if (next < 0) {
        out.x = from.x + dx * t;
        out.z = from.z + dz * t;
        out.y = this.polyHeight(p, out.x, out.z);
        return true;
      }
      p = next;
    }
    out.x = to.x;
    out.y = to.y;
    out.z = to.z;
    return false;
  }
}

const scratch: NavPoint3 = { x: 0, y: 0, z: 0 };

/** Pairs polygons across shared edges (both directions) into a fresh adjacency array. */
export function buildAdjacency(
  polys: Int32Array,
  polyCount: number,
  nvp: number,
  nverts: Uint8Array,
  vertCount: number,
): Int32Array {
  const adjacency = new Int32Array(Math.max(1, polyCount) * nvp).fill(-1);
  const edgeOf = new Map<number, number>();
  for (let p = 0; p < polyCount; p++) {
    const n = nverts[p]!;
    for (let e = 0; e < n; e++) {
      const v0 = polys[p * nvp + e]!;
      const v1 = polys[p * nvp + (e + 1 === n ? 0 : e + 1)]!;
      const key = v0 < v1 ? v0 * vertCount + v1 : v1 * vertCount + v0;
      const other = edgeOf.get(key);
      if (other === undefined) {
        edgeOf.set(key, p * nvp + e);
      } else {
        const op = Math.floor(other / nvp);
        if (op !== p) {
          adjacency[p * nvp + e] = op;
          adjacency[other] = p;
        }
      }
    }
  }
  return adjacency;
}

export interface NavBakeAreaOptions {
  /** Area stamps applied to the baked polygons (`markArea` for each, in order). Optional. */
  areas?: AreaStamp[];
}

/**
 * Bakes a navmesh from triangle soup: voxelise, filter by height, climb and slope, erode by the
 * agent radius, partition into regions, trace and simplify contours, triangulate and merge into
 * convex polygons, then stamp `opts.areas` (if any). Bake-time only; allocates freely. Options
 * left out take the `resolveNavBakeOptions` defaults; a bad one throws a `NavBakeError`. An input
 * with no triangles gives an empty mesh; one whose triangles yield no polygon gives an empty mesh
 * and one `console.warn`.
 */
export function bakeNavMesh(
  input: NavBakeSource | NavBakeSource[],
  options: NavBakeOptions & NavBakeAreaOptions,
): NavMesh {
  const opts = resolveNavBakeOptions(options);
  const sources = Array.isArray(input) ? input : [input];
  const cs = opts.cellSize;
  const ch = opts.cellHeight;
  const nvp = opts.maxVertsPerPoly;
  const bmin: [number, number, number] = [0, 0, 0];
  const bmax: [number, number, number] = [0, 0, 0];
  if (!computeBounds(sources, bmin, bmax)) {
    return new NavMesh(new Float32Array(0), 0, new Int32Array(0), 0, nvp, cs, ch);
  }
  const walkableHeight = Math.ceil(opts.agentHeight / ch);
  const walkableClimb = Math.floor(opts.agentMaxClimb / ch);
  const walkableRadius = Math.ceil(opts.agentRadius / cs);
  // Pad by the radius so erosion sees the true edge of the world, not the heightfield's.
  const pad = (walkableRadius + 1) * cs;
  bmin[0] -= pad;
  bmin[2] -= pad;
  bmax[0] += pad;
  bmax[2] += pad;
  bmin[1] -= ch;
  bmax[1] += ch;
  const width = Math.ceil((bmax[0] - bmin[0]) / cs);
  const height = Math.ceil((bmax[2] - bmin[2]) / cs);
  const hf = createHeightfield(width, height, bmin, bmax, cs, ch);
  rasterizeSources(hf, sources, opts.agentMaxSlope, walkableClimb);
  filterLowHangingWalkableObstacles(hf, walkableClimb);
  filterLedgeSpans(hf, walkableHeight, walkableClimb);
  filterWalkableLowHeightSpans(hf, walkableHeight);
  const chf = buildCompactHeightfield(hf, walkableHeight, walkableClimb);
  erodeWalkableArea(chf, walkableRadius);
  // Recast's convention: the region thresholds are areas in cells.
  buildRegions(chf, opts.minRegionArea, opts.mergeRegionArea);
  const maxError = opts.maxSimplification / cs;
  const maxEdgeLen = Math.floor(opts.maxEdgeLength / cs);
  const contours = buildContours(chf, maxError, maxEdgeLen);
  const pm = buildPolyMesh(contours, nvp);

  const verts = new Float32Array(Math.max(1, pm.vertCount) * 3);
  for (let i = 0; i < pm.vertCount; i++) {
    verts[i * 3] = bmin[0] + pm.verts[i * 3]! * cs;
    verts[i * 3 + 1] = bmin[1] + pm.verts[i * 3 + 1]! * ch;
    verts[i * 3 + 2] = bmin[2] + pm.verts[i * 3 + 2]! * cs;
  }
  const polys = pm.polys.slice(0, Math.max(1, pm.polyCount) * nvp);
  const mesh = new NavMesh(verts, pm.vertCount, polys, pm.polyCount, nvp, cs, ch);
  if (pm.polyCount === 0) {
    console.warn(
      `[nav] bakeNavMesh: 0 polygons from ${countTriangles(sources)} triangles (cellSize ${cs}, cellHeight ${ch}, agentHeight ${opts.agentHeight}, agentRadius ${opts.agentRadius}, agentMaxClimb ${opts.agentMaxClimb}, agentMaxSlope ${opts.agentMaxSlope}); nothing is walkable`,
    );
  }
  if (options.areas) {
    for (const stamp of options.areas) markArea(mesh, stamp.shape, stamp.area);
    mesh.version = 0;
  }
  return mesh;
}

function countTriangles(sources: readonly NavBakeSource[]): number {
  let n = 0;
  for (const s of sources) n += Math.floor(s.indices.length / 3);
  return n;
}
