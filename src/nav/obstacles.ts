/**
 * Dynamic obstacles: discs and yawed boxes dropped onto a `NavMesh` or a `NavGrid` at runtime.
 * `apply()` stamps only what moved since the last apply: on a mesh the polygons the footprint
 * touches take the reserved area 255 (nothing is split; the ones it left get their area back),
 * on a grid a cost layer the grid's `edgeCost` hook reads gets `Infinity` under the footprint.
 * Either way the target's `version` bumps, so paths, fields and corridors read as stale.
 * Everything is allocated at creation for `maxObstacles`; `apply` allocates nothing.
 */
import type { NavGrid } from './grid';
import { OBSTACLE_AREA } from './mesh/areas';
import { NavMesh } from './mesh/navmesh';

export interface ObstacleDisc {
  x: number;
  z: number;
  radius: number;
}

export interface ObstacleBox {
  x: number;
  z: number;
  /** Full extents along the box's local x and z. */
  w: number;
  d: number;
  /** Rotation about y, radians. */
  yaw: number;
}

export type ObstacleShape = ObstacleDisc | ObstacleBox;

/** One obstacle slot; `active` false for an empty one. Read-only: edit through the set. */
export interface Obstacle {
  active: boolean;
  id: number;
  kind: 'disc' | 'box';
  x: number;
  z: number;
  /** Disc radius, or for a box half its diagonal (the bounding disc). */
  radius: number;
  w: number;
  d: number;
  yaw: number;
}

export interface ObstacleSetOptions {
  maxObstacles: number;
  /**
   * Grid only: the per-cell cost layer to write (`grid.size` floats, `Infinity` under an
   * obstacle, 0 elsewhere), so a hook created before the set can read it. Default: a fresh one.
   */
  layer?: Float32Array;
}

export interface ObstacleSet {
  /** One slot per index up to `maxObstacles`; check `active`. Never changes identity. */
  readonly obstacles: readonly Obstacle[];
  /** Active obstacles. */
  readonly count: number;
  /** Bumps on every `apply` that changed a polygon or a cell. */
  readonly version: number;
  /**
   * Grid only: the cost layer per cell (`Infinity` under an obstacle, 0 elsewhere). Read it from
   * the grid's hook: `edgeCost: (from, to) => set.layer[to]`. Empty on a mesh.
   */
  readonly layer: Float32Array;
  /** Adds an obstacle and returns its id (never 0), or -1 when the set is full. Takes effect on `apply`. */
  add(shape: ObstacleShape): number;
  /** Moves an obstacle (and turns a box when `yaw` is given). Takes effect on `apply`. */
  move(id: number, x: number, z: number, yaw?: number): void;
  /** Removes an obstacle; false when there is none. Takes effect on `apply`. */
  remove(id: number): boolean;
  /** The slot of an obstacle, or undefined. */
  get(id: number): Obstacle | undefined;
  /**
   * Stamps every change since the last apply onto the target, touching only the polygons or
   * cells the old and new footprints cover, and bumps the target's version when anything
   * changed. Returns the number of polygons or cells whose state changed (0: nothing to do).
   */
  apply(): number;
}

interface Slot extends Obstacle {
  dirty: boolean;
  /** The footprint currently stamped on the target (valid when `applied`). */
  applied: boolean;
  ax: number;
  az: number;
  aradius: number;
  aw: number;
  ad: number;
  ayaw: number;
  akind: 'disc' | 'box';
}

/** Squared XZ distance from `(x, z)` to polygon `p` (0 inside). */
function polyDistance2(mesh: NavMesh, p: number, x: number, z: number): number {
  if (mesh.containsXZ(p, x, z)) return 0;
  const n = mesh.polyVertexCount(p);
  const nvp = mesh.maxVertsPerPoly;
  const verts = mesh.verts;
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < n; k++) {
    const a = mesh.polys[p * nvp + k]! * 3;
    const b = mesh.polys[p * nvp + (k + 1 === n ? 0 : k + 1)]! * 3;
    const ax = verts[a]!;
    const az = verts[a + 2]!;
    const ex = verts[b]! - ax;
    const ez = verts[b + 2]! - az;
    const len = ex * ex + ez * ez;
    let t = len > 0 ? ((x - ax) * ex + (z - az) * ez) / len : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const dx = ax + ex * t - x;
    const dz = az + ez * t - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return best;
}

/** Separating-axis test between polygon `p` and a yawed box (both convex, XZ). */
function polyOverlapsBox(
  mesh: NavMesh,
  p: number,
  bx: number,
  bz: number,
  hw: number,
  hd: number,
  yaw: number,
): boolean {
  const n = mesh.polyVertexCount(p);
  const nvp = mesh.maxVertsPerPoly;
  const verts = mesh.verts;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Box axes: u = (c, s), v = (-s, c); the box's projection on an axis (nx, nz) has half width
  // hw·|u·n| + hd·|v·n| around its centre.
  const axes = n + 2;
  for (let i = 0; i < axes; i++) {
    let nx: number;
    let nz: number;
    if (i === n) {
      nx = c;
      nz = s;
    } else if (i === n + 1) {
      nx = -s;
      nz = c;
    } else {
      const a = mesh.polys[p * nvp + i]! * 3;
      const b = mesh.polys[p * nvp + (i + 1 === n ? 0 : i + 1)]! * 3;
      nx = -(verts[b + 2]! - verts[a + 2]!);
      nz = verts[b]! - verts[a]!;
    }
    let pmin = Number.POSITIVE_INFINITY;
    let pmax = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      const v = mesh.polys[p * nvp + k]! * 3;
      const d = verts[v]! * nx + verts[v + 2]! * nz;
      if (d < pmin) pmin = d;
      if (d > pmax) pmax = d;
    }
    const bc = bx * nx + bz * nz;
    const br = hw * Math.abs(c * nx + s * nz) + hd * Math.abs(-s * nx + c * nz);
    if (bc + br < pmin || bc - br > pmax) return false;
  }
  return true;
}

/** Whether a yawed box holds `(x, z)` once inflated by `pad` on every side. */
function boxHolds(
  x: number,
  z: number,
  bx: number,
  bz: number,
  hw: number,
  hd: number,
  yaw: number,
  pad: number,
): boolean {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const dx = x - bx;
  const dz = z - bz;
  const lx = dx * c + dz * s;
  const lz = -dx * s + dz * c;
  return Math.abs(lx) <= hw + pad && Math.abs(lz) <= hd + pad;
}

/** A set of up to `maxObstacles` obstacles over a mesh or a grid. */
export function createObstacleSet(
  target: NavMesh | NavGrid,
  opts: ObstacleSetOptions,
): ObstacleSet {
  const max = Math.max(1, opts.maxObstacles);
  const mesh = target instanceof NavMesh ? target : null;
  const grid = mesh ? null : (target as NavGrid);
  const slots: Slot[] = [];
  for (let i = 0; i < max; i++) {
    slots.push({
      active: false,
      id: 0,
      kind: 'disc',
      x: 0,
      z: 0,
      radius: 0,
      w: 0,
      d: 0,
      yaw: 0,
      dirty: false,
      applied: false,
      ax: 0,
      az: 0,
      aradius: 0,
      aw: 0,
      ad: 0,
      ayaw: 0,
      akind: 'disc',
    });
  }
  const layer =
    grid && opts.layer && opts.layer.length >= grid.size
      ? opts.layer
      : new Float32Array(grid ? grid.size : 0);
  const cover = new Uint16Array(mesh ? Math.max(1, mesh.polyCount) : grid ? grid.size : 1);
  const saved = mesh ? new Uint8Array(Math.max(1, mesh.polyCount)) : null;
  let nextId = 1;
  let count = 0;
  let version = 0;

  const slotOf = (id: number): Slot | undefined => {
    if (id <= 0) return undefined;
    for (let i = 0; i < max; i++) {
      const s = slots[i]!;
      if (s.active && s.id === id) return s;
    }
    return undefined;
  };

  /** Adds or removes one footprint's coverage; returns the polygons or cells whose state flipped. */
  const stamp = (
    kind: 'disc' | 'box',
    x: number,
    z: number,
    radius: number,
    w: number,
    d: number,
    yaw: number,
    delta: 1 | -1,
  ): number => {
    let flipped = 0;
    const hw = w * 0.5;
    const hd = d * 0.5;
    if (mesh && saved) {
      const n = mesh.polysInBox(x - radius, z - radius, x + radius, z + radius);
      const found = mesh.polysFound;
      for (let i = 0; i < n; i++) {
        const p = found[i]!;
        const hit =
          kind === 'disc'
            ? polyDistance2(mesh, p, x, z) <= radius * radius
            : polyOverlapsBox(mesh, p, x, z, hw, hd, yaw);
        if (!hit) continue;
        const was = cover[p]!;
        const now = was + delta;
        cover[p] = now;
        if (was === 0 && now === 1) {
          saved[p] = mesh.area[p]!;
          mesh.area[p] = OBSTACLE_AREA;
          flipped++;
        } else if (was === 1 && now === 0) {
          mesh.area[p] = saved[p]!;
          flipped++;
        }
      }
    } else if (grid) {
      const cs = grid.cellSize;
      const pad = cs * 0.5;
      const reach = radius + pad;
      const x0 = Math.max(0, Math.floor((x - reach - grid.origin.x) / cs));
      const z0 = Math.max(0, Math.floor((z - reach - grid.origin.z) / cs));
      const x1 = Math.min(grid.width - 1, Math.floor((x + reach - grid.origin.x) / cs));
      const z1 = Math.min(grid.height - 1, Math.floor((z + reach - grid.origin.z) / cs));
      const r2 = reach * reach;
      for (let cy = z0; cy <= z1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const wx = grid.origin.x + (cx + 0.5) * cs;
          const wz = grid.origin.z + (cy + 0.5) * cs;
          let hit: boolean;
          if (kind === 'disc') {
            const dx = wx - x;
            const dz = wz - z;
            hit = dx * dx + dz * dz <= r2;
          } else {
            hit = boxHolds(wx, wz, x, z, hw, hd, yaw, pad);
          }
          if (!hit) continue;
          const i = cy * grid.width + cx;
          const was = cover[i]!;
          const now = was + delta;
          cover[i] = now;
          if (was === 0 && now === 1) {
            layer[i] = Infinity;
            flipped++;
          } else if (was === 1 && now === 0) {
            layer[i] = 0;
            flipped++;
          }
        }
      }
    }
    return flipped;
  };

  return {
    obstacles: slots,
    get count() {
      return count;
    },
    get version() {
      return version;
    },
    layer,
    add(shape) {
      for (let i = 0; i < max; i++) {
        const s = slots[i]!;
        if (s.active) continue;
        s.active = true;
        s.id = nextId++;
        s.x = shape.x;
        s.z = shape.z;
        if ('radius' in shape) {
          s.kind = 'disc';
          s.radius = Math.max(0, shape.radius);
          s.w = s.d = s.radius * 2;
          s.yaw = 0;
        } else {
          s.kind = 'box';
          s.w = Math.max(0, shape.w);
          s.d = Math.max(0, shape.d);
          s.yaw = shape.yaw;
          s.radius = Math.sqrt(s.w * s.w + s.d * s.d) * 0.5;
        }
        s.dirty = true;
        count++;
        return s.id;
      }
      return -1;
    },
    move(id, x, z, yaw) {
      const s = slotOf(id);
      if (!s) return;
      if (s.x === x && s.z === z && (yaw === undefined || yaw === s.yaw)) return;
      s.x = x;
      s.z = z;
      if (yaw !== undefined && s.kind === 'box') s.yaw = yaw;
      s.dirty = true;
    },
    remove(id) {
      const s = slotOf(id);
      if (!s) return false;
      s.active = false;
      s.dirty = true;
      count--;
      return true;
    },
    get: slotOf,
    apply() {
      let flipped = 0;
      for (let i = 0; i < max; i++) {
        const s = slots[i]!;
        if (!s.dirty) continue;
        s.dirty = false;
        if (s.applied) {
          flipped += stamp(s.akind, s.ax, s.az, s.aradius, s.aw, s.ad, s.ayaw, -1);
          s.applied = false;
        }
        if (s.active) {
          flipped += stamp(s.kind, s.x, s.z, s.radius, s.w, s.d, s.yaw, 1);
          s.applied = true;
          s.akind = s.kind;
          s.ax = s.x;
          s.az = s.z;
          s.aradius = s.radius;
          s.aw = s.w;
          s.ad = s.d;
          s.ayaw = s.yaw;
        }
      }
      if (flipped > 0) {
        version++;
        if (mesh) mesh.version++;
        else grid?.touch();
      }
      return flipped;
    },
  };
}
