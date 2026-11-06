import {
  INSTANCE_PARAM_FLOATS,
  type InstanceBatch,
  type InstanceParams,
  writeInstanceParams,
} from './frame';
import { INSTANCE_FLOATS, INSTANCE_STRIDE, type Material } from './material';
import type { Mesh, MeshBounds } from './mesh';
import { MATRIX3X4_FLOATS, Transform } from './transform';

const NO_PARAMS: InstanceParams = Object.freeze({});

/**
 * A retained list of up to `capacity` instances of one mesh and material, drawn with
 * `frame.list(list)`; made by `renderer.createInstanceList`. Instances are set and removed by
 * index (`set`, `remove`: swap-remove) and live in the list's own GPU vertex buffer, in the
 * engine instance format: a frame uploads only the index range touched since the last one, so
 * an unchanged list costs nothing on the CPU and no `writeBuffer`. `matrices` (12 floats per
 * instance, 3×4 row-major) and `params` (`INSTANCE_PARAM_FLOATS` each) are the CPU copies; code
 * that writes them directly calls `touch(i)` so the range uploads.
 *
 * The list is culled as one unit by `bounds`, a world-space sphere: computed from the mesh's
 * bounds through every instance (the centre of their box, the radius to the farthest one plus
 * its scaled mesh radius) whenever instances changed, or fixed by `setBounds`. A mesh without
 * bounds (`radius` Infinity) gives a list that is never culled.
 */
export class InstanceList implements InstanceBatch {
  readonly matrices: Float32Array;
  readonly params: Float32Array;
  /** Layer mask of the whole list (`camera.layers`); default 1. */
  layerBits = 1;
  /** Sort key (`InstanceParams.order`); default 0. */
  order = 0;
  /** Draw into the sun's shadow map; default: the mesh is not 2D. */
  castShadow?: boolean;
  /** The GPU vertex buffer the instances live in (`capacity` × `INSTANCE_STRIDE` bytes). */
  readonly buffer: GPUBuffer;
  private _count = 0;
  private _bounds: MeshBounds | null = null;
  private fixedBounds = false;
  private boundsDirty = false;
  /** Instance range `[dirtyLo, dirtyHi)` to upload; empty when `dirtyLo >= dirtyHi`. */
  private dirtyLo = 0;
  private dirtyHi = 0;
  /** Interleaved staging for the upload, in the instance format. */
  private readonly data: Float32Array;
  private readonly center: [number, number, number] = [0, 0, 0];

  constructor(
    device: GPUDevice,
    readonly mesh: Mesh,
    readonly material: Material,
    readonly capacity: number,
  ) {
    if (!(capacity >= 1)) throw new Error(`InstanceList: capacity ${capacity}`);
    this.matrices = new Float32Array(capacity * MATRIX3X4_FLOATS);
    this.params = new Float32Array(capacity * INSTANCE_PARAM_FLOATS);
    this.data = new Float32Array(capacity * INSTANCE_FLOATS);
    this.buffer = device.createBuffer({
      label: 'instance-list',
      size: capacity * INSTANCE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /** Live instances (the first `count` slots). */
  get count(): number {
    return this._count;
  }

  /**
   * The world sphere the list is culled by: `setBounds`'s, or the one computed from the
   * instances (refreshed by the next `frame.list` after a change, or by `flush`); null for a
   * mesh without bounds.
   */
  get bounds(): MeshBounds | null {
    if (this.boundsDirty) this.computeBounds();
    return this._bounds;
  }

  /** True when the next `frame.list` has something to upload. */
  get dirty(): boolean {
    return this.dirtyLo < this.dirtyHi;
  }

  /**
   * Place instance `i` (0..count; `count` appends) by a `Transform` or a 3×4 row-major matrix
   * (12 floats, read from `offset`), with `params` (`InstanceParams`; omitted: the defaults).
   * `size` is the transform's scale.xy, or the matrix's x and y column lengths.
   */
  set(
    i: number,
    m: Transform | ArrayLike<number>,
    params: InstanceParams = NO_PARAMS,
    offset = 0,
  ): this {
    if (i < 0 || i > this._count) throw new Error(`InstanceList.set: index ${i} of ${this._count}`);
    if (i === this.capacity) throw new Error(`InstanceList.set: full (capacity ${this.capacity})`);
    if (i === this._count) this._count++;
    const mats = this.matrices;
    const o = i * MATRIX3X4_FLOATS;
    let sx: number;
    let sy: number;
    if (m instanceof Transform) {
      mats.set(m.world, o);
      sx = m.scale.x;
      sy = m.scale.y;
    } else {
      for (let k = 0; k < MATRIX3X4_FLOATS; k++) mats[o + k] = m[offset + k]!;
      sx = Math.hypot(mats[o]!, mats[o + 4]!, mats[o + 8]!);
      sy = Math.hypot(mats[o + 1]!, mats[o + 5]!, mats[o + 9]!);
    }
    writeInstanceParams(this.params, i * INSTANCE_PARAM_FLOATS, params, sx, sy);
    this.touch(i);
    return this;
  }

  /**
   * Remove instance `i`: the last instance moves into its slot (swap-remove). Returns the index
   * that moved (the old last), or -1 when `i` was the last. Callers keeping indices update
   * the moved one.
   */
  remove(i: number): number {
    if (i < 0 || i >= this._count)
      throw new Error(`InstanceList.remove: index ${i} of ${this._count}`);
    const last = --this._count;
    this.boundsDirty = !this.fixedBounds;
    if (i === last) return -1;
    const mats = this.matrices;
    const prm = this.params;
    mats.copyWithin(i * MATRIX3X4_FLOATS, last * MATRIX3X4_FLOATS, (last + 1) * MATRIX3X4_FLOATS);
    prm.copyWithin(
      i * INSTANCE_PARAM_FLOATS,
      last * INSTANCE_PARAM_FLOATS,
      (last + 1) * INSTANCE_PARAM_FLOATS,
    );
    this.touch(i);
    return last;
  }

  /** Drop every instance (nothing to upload: the next `set`s mark their own range). */
  clear(): void {
    this._count = 0;
    this.dirtyLo = this.dirtyHi = 0;
    this.boundsDirty = !this.fixedBounds;
  }

  /** Mark instance `i` changed (after writing `matrices` / `params` directly). */
  touch(i: number): void {
    if (this.dirtyLo >= this.dirtyHi) {
      this.dirtyLo = i;
      this.dirtyHi = i + 1;
    } else {
      if (i < this.dirtyLo) this.dirtyLo = i;
      if (i + 1 > this.dirtyHi) this.dirtyHi = i + 1;
    }
    this.boundsDirty = !this.fixedBounds;
  }

  /**
   * Fix the cull sphere (world space, copied), or pass null to go back to the automatic one.
   */
  setBounds(bounds: MeshBounds | null): this {
    if (bounds) {
      this.fixedBounds = true;
      this.boundsDirty = false;
      const c = this.center;
      c[0] = bounds.center[0];
      c[1] = bounds.center[1];
      c[2] = bounds.center[2];
      this._bounds = { center: c, radius: bounds.radius };
    } else {
      this.fixedBounds = false;
      this.boundsDirty = true;
    }
    return this;
  }

  /**
   * Upload the changed range to `buffer` (one `writeBuffer`, or none when nothing changed) and
   * refresh the automatic bounds. The renderer calls it from `frame.list`; no allocation.
   */
  flush(queue: GPUQueue): void {
    if (this.boundsDirty) this.computeBounds();
    const lo = this.dirtyLo;
    const hi = Math.min(this.dirtyHi, this._count);
    this.dirtyLo = this.dirtyHi = 0;
    if (lo >= hi) return;
    const d = this.data;
    const mats = this.matrices;
    const prm = this.params;
    for (let i = lo; i < hi; i++) {
      const to = i * INSTANCE_FLOATS;
      const mo = i * MATRIX3X4_FLOATS;
      for (let k = 0; k < MATRIX3X4_FLOATS; k++) d[to + k] = mats[mo + k]!;
      const po = i * INSTANCE_PARAM_FLOATS;
      for (let k = 0; k < INSTANCE_PARAM_FLOATS; k++) d[to + MATRIX3X4_FLOATS + k] = prm[po + k]!;
    }
    queue.writeBuffer(
      this.buffer,
      lo * INSTANCE_STRIDE,
      d.buffer,
      lo * INSTANCE_STRIDE,
      (hi - lo) * INSTANCE_STRIDE,
    );
  }

  destroy(): void {
    this.buffer.destroy();
    this._count = 0;
  }

  /** The automatic sphere: `mesh.bounds` through every live instance. */
  private computeBounds(): void {
    this.boundsDirty = false;
    const mb = this.mesh.bounds;
    const n = this._count;
    if (mb.radius === Number.POSITIVE_INFINITY || n === 0) {
      this._bounds = null;
      return;
    }
    const m = this.matrices;
    const cx = mb.center[0];
    const cy = mb.center[1];
    const cz = mb.center[2];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const o = i * MATRIX3X4_FLOATS;
      const x = m[o]! * cx + m[o + 1]! * cy + m[o + 2]! * cz + m[o + 3]!;
      const y = m[o + 4]! * cx + m[o + 5]! * cy + m[o + 6]! * cz + m[o + 7]!;
      const z = m[o + 8]! * cx + m[o + 9]! * cy + m[o + 10]! * cz + m[o + 11]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const c = this.center;
    c[0] = (minX + maxX) / 2;
    c[1] = (minY + maxY) / 2;
    c[2] = (minZ + maxZ) / 2;
    let r2 = 0;
    for (let i = 0; i < n; i++) {
      const o = i * MATRIX3X4_FLOATS;
      const x = m[o]! * cx + m[o + 1]! * cy + m[o + 2]! * cz + m[o + 3]! - c[0];
      const y = m[o + 4]! * cx + m[o + 5]! * cy + m[o + 6]! * cz + m[o + 7]! - c[1];
      const z = m[o + 8]! * cx + m[o + 9]! * cy + m[o + 10]! * cz + m[o + 11]! - c[2];
      const s0 = m[o]! * m[o]! + m[o + 4]! * m[o + 4]! + m[o + 8]! * m[o + 8]!;
      const s1 = m[o + 1]! * m[o + 1]! + m[o + 5]! * m[o + 5]! + m[o + 9]! * m[o + 9]!;
      const s2 = m[o + 2]! * m[o + 2]! + m[o + 6]! * m[o + 6]! + m[o + 10]! * m[o + 10]!;
      const d = Math.sqrt(x * x + y * y + z * z) + mb.radius * Math.sqrt(Math.max(s0, s1, s2));
      if (d > r2) r2 = d;
    }
    const b = this._bounds;
    if (b && b.center === c) b.radius = r2;
    else this._bounds = { center: c, radius: r2 };
  }
}
