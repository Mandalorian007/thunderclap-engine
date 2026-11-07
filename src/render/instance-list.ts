import {
  INSTANCE_PARAM_FLOATS,
  type InstanceBatch,
  type InstanceParams,
  writeInstanceParams,
} from './frame';
import { isMeshLod, type MeshLod } from './lod';
import { INSTANCE_FLOATS, INSTANCE_STRIDE, type Material } from './material';
import type { Mesh, MeshBounds } from './mesh';
import { MATRIX3X4_FLOATS, Transform } from './transform';

const NO_PARAMS: InstanceParams = Object.freeze({});

/** `renderer.createInstanceList` options. */
export interface InstanceListOptions {
  /**
   * Keep each instance's previous-frame matrix in a second vertex buffer (`prevBuffer`), so a
   * material writing a velocity attachment (`SceneTargetDesc.aux.velocity`) sees the
   * instance's own motion rather than the camera's alone. A LOD list keeps the matrices but
   * no buffer: they travel with its per-frame copy. Default false.
   */
  velocity?: boolean;
}

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
  /**
   * With `velocity` (ws/render-4): the previous frame's matrices (12 floats per instance) and
   * the vertex buffer (48 bytes per instance, slot 2) a material writing a velocity attachment
   * reads them from; null otherwise. A slot `set` this frame keeps what it held before as
   * previous; one left alone settles to its current matrix at the next flush (no motion).
   * A LOD list (`lod`) keeps `prevMatrices` but has no `prevBuffer` and uploads none
   * (ws/render-8): the renderer copies its previous matrices into its shared lane.
   */
  readonly prevMatrices: Float32Array | null;
  readonly prevBuffer: GPUBuffer | null;
  /** Keeps a previous-matrix lane (`createInstanceList(..., { velocity: true })`). */
  readonly velocity: boolean;
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
  /** With velocity: the flush each slot was last captured in (0: never); `flushes` counts them. */
  private readonly stamp: Uint32Array;
  private flushes = 1;
  /** With velocity: the range dirty at the last flush, settled (prev := current) at the next. */
  private settleLo = 0;
  private settleHi = 0;
  /** Live instances at the last flush. */
  private lastCount = 0;
  /** Per-slot keys (`setKey`; NaN: none), made on the first `setKey`. */
  private keys: Float64Array | null = null;
  /**
   * Key → slot hash tables (open addressing, `tableMask + 1` entries): `tableSlots[t]` -1 is
   * empty. `cur` is the one the last flush filled; the other is refilled at the next.
   */
  private tableKeys: [Float64Array, Float64Array] | null = null;
  private tableSlots: [Int32Array, Int32Array] | null = null;
  private tableMask = 0;
  private cur = 0;
  /** With velocity and keys: each slot's matrix at the last flush. */
  private lastMatrices: Float32Array | null = null;
  private _previousIndex: Int32Array | null = null;

  /** The list's mesh: the one it was made with, or the first level of its `lod`. */
  readonly mesh: Mesh;
  /**
   * The LOD chain the list was made with (ws/render-6), else null. Each instance then picks a
   * level per view, and `frame.list` copies the instances into the frame's upload bucketed by
   * level rather than drawing from `buffer`; with `velocity` its `prevMatrices` travel with
   * the copy into the renderer's shared lane (ws/render-7), so it has no `prevBuffer`.
   */
  readonly lod: MeshLod | null;

  constructor(
    device: GPUDevice,
    mesh: Mesh | MeshLod,
    readonly material: Material,
    readonly capacity: number,
    opts: InstanceListOptions = {},
  ) {
    if (!(capacity >= 1)) throw new Error(`InstanceList: capacity ${capacity}`);
    if (isMeshLod(mesh)) {
      const first = mesh.meshes[0];
      if (!first) throw new Error('InstanceList: MeshLod has no meshes');
      this.lod = mesh;
      this.mesh = first;
    } else {
      this.lod = null;
      this.mesh = mesh;
    }
    this.matrices = new Float32Array(capacity * MATRIX3X4_FLOATS);
    this.params = new Float32Array(capacity * INSTANCE_PARAM_FLOATS);
    this.data = new Float32Array(capacity * INSTANCE_FLOATS);
    this.buffer = device.createBuffer({
      label: 'instance-list',
      size: capacity * INSTANCE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.velocity = opts.velocity === true;
    if (this.velocity) {
      this.prevMatrices = new Float32Array(capacity * MATRIX3X4_FLOATS);
      // A LOD list's previous matrices travel with its per-frame copy (ws/render-8): no buffer.
      this.prevBuffer = this.lod
        ? null
        : device.createBuffer({
            label: 'instance-list-prev',
            size: capacity * MATRIX3X4_FLOATS * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          });
      this.stamp = new Uint32Array(capacity);
    } else {
      this.prevMatrices = null;
      this.prevBuffer = null;
      this.stamp = new Uint32Array(0);
    }
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

  /**
   * True once any instance has a key (`setKey`, ws/render-7): the list then matches each
   * instance to last frame's by key (keyless slots by index) at every flush, for its LOD
   * level memory and its velocity history.
   */
  get keyed(): boolean {
    return this.keys !== null;
  }

  /**
   * Flushes so far (`flush`, once per `frame.list`). `previousIndex` maps the instances of
   * flush `flushCount` onto those of flush `flushCount - 1`.
   */
  get flushCount(): number {
    return this.flushes - 1;
  }

  /**
   * With keys (`keyed`), after each flush: per live instance, the index it held at the
   * previous flush (matched by key, a keyless slot by its own index), or -1 for an instance
   * that was not there (a new key, or an index past last flush's count). Null until keyed.
   */
  get previousIndex(): Int32Array | null {
    return this._previousIndex;
  }

  /**
   * Give instance `i` (0..count-1) a stable `key` (ws/render-7): a finite number, an entity
   * id, unique in the list (on duplicates the last slot wins). The instance's LOD level
   * memory and velocity history then follow the key, not the index, so removing or
   * reordering instances (`remove`'s swap, a `clear` and refill in another order) changes no
   * other instance's level and no other instance's motion. `null` clears it. The key stays
   * with the slot through `set` and moves with `remove`; a slot appended by `set` starts
   * without one. Chain it after `set`: `list.set(i, t).setKey(i, id)`.
   */
  setKey(i: number, key: number | null): this {
    if (i < 0 || i >= this._count)
      throw new Error(`InstanceList.setKey: index ${i} of ${this._count}`);
    if (key !== null && !Number.isFinite(key))
      throw new Error(`InstanceList.setKey: key ${key} is not a finite number`);
    if (key === null && !this.keys) return this;
    this.ensureKeys()[i] = key ?? Number.NaN;
    return this;
  }

  /** Instance `i`'s key (`setKey`), or null for none. */
  keyOf(i: number): number | null {
    const k = this.keys ? this.keys[i]! : Number.NaN;
    return i < this._count && !Number.isNaN(k) ? k : null;
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
    if (i === this._count) {
      this._count++;
      if (this.keys) this.keys[i] = Number.NaN;
    }
    const mats = this.matrices;
    const o = i * MATRIX3X4_FLOATS;
    if (this.velocity) this.capture(i, o);
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
    if (this.keys) this.keys[i] = this.keys[last]!;
    mats.copyWithin(i * MATRIX3X4_FLOATS, last * MATRIX3X4_FLOATS, (last + 1) * MATRIX3X4_FLOATS);
    if (this.velocity) {
      // The moved instance keeps its own history.
      this.prevMatrices!.copyWithin(
        i * MATRIX3X4_FLOATS,
        last * MATRIX3X4_FLOATS,
        (last + 1) * MATRIX3X4_FLOATS,
      );
      this.stamp[i] = this.stamp[last]!;
    }
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
    if (this.keys) this.matchKeys();
    if (this.velocity) this.flushPrevious(queue, lo, hi);
    this.lastCount = this._count;
    this.flushes++;
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
    this.prevBuffer?.destroy();
    this._count = 0;
  }

  /** With velocity: the first `set` of a slot in a frame keeps its current matrix as previous. */
  private capture(i: number, o: number): void {
    // A slot never flushed has no history: `flushPrevious` settles it from its first matrix.
    if (this.stamp[i] === this.flushes || this.stamp[i] === 0) return;
    this.stamp[i] = this.flushes;
    const prev = this.prevMatrices!;
    const cur = this.matrices;
    for (let k = 0; k < MATRIX3X4_FLOATS; k++) prev[o + k] = cur[o + k]!;
  }

  /**
   * Settle the slots dirty last flush but untouched this one (previous := current), give a
   * brand-new instance its current matrix as previous, and upload the previous lane over the
   * union of both ranges.
   */
  private flushPrevious(queue: GPUQueue, lo: number, hi: number): void {
    const prev = this.prevMatrices!;
    const cur = this.matrices;
    const sLo = this.settleLo;
    const sHi = Math.min(this.settleHi, this._count);
    const now = this.flushes;
    // Slots that died since the last flush lose their history: one appended there later is new.
    for (let i = this._count; i < this.lastCount; i++) this.stamp[i] = 0;
    for (let i = sLo; i < sHi; i++) {
      if (this.stamp[i] === now) continue;
      const o = i * MATRIX3X4_FLOATS;
      for (let k = 0; k < MATRIX3X4_FLOATS; k++) prev[o + k] = cur[o + k]!;
    }
    for (let i = lo; i < hi; i++) {
      // Never flushed (a new slot) or touched directly without `set`: no history → settle.
      const o = i * MATRIX3X4_FLOATS;
      if (this.stamp[i] !== now) {
        for (let k = 0; k < MATRIX3X4_FLOATS; k++) prev[o + k] = cur[o + k]!;
        this.stamp[i] = now;
      }
    }
    this.settleLo = lo;
    this.settleHi = hi;
    let uLo = sLo < sHi ? (lo < hi ? Math.min(lo, sLo) : sLo) : lo;
    let uHi = sLo < sHi ? (lo < hi ? Math.max(hi, sHi) : sHi) : hi;
    if (this.keys) {
      // Keyed slots take the matrix their key held at the last flush (none: no motion);
      // keyless ones keep the index history above. The whole live range uploads.
      const keys = this.keys;
      const pi = this._previousIndex!;
      const n = this._count;
      let last = this.lastMatrices;
      if (!last) last = this.lastMatrices = new Float32Array(this.capacity * MATRIX3X4_FLOATS);
      for (let i = 0; i < n; i++) {
        const k = keys[i]!;
        if (Number.isNaN(k)) continue;
        const j = pi[i]!;
        const o = i * MATRIX3X4_FLOATS;
        const src = j >= 0 ? last : cur;
        const so = j >= 0 ? j * MATRIX3X4_FLOATS : o;
        for (let f = 0; f < MATRIX3X4_FLOATS; f++) prev[o + f] = src[so + f]!;
        this.stamp[i] = now;
      }
      last.set(cur.subarray(0, n * MATRIX3X4_FLOATS));
      uLo = 0;
      uHi = n;
    }
    if (uLo >= uHi || !this.prevBuffer) return;
    const bytes = MATRIX3X4_FLOATS * 4;
    queue.writeBuffer(this.prevBuffer!, uLo * bytes, prev.buffer, uLo * bytes, (uHi - uLo) * bytes);
  }

  private ensureKeys(): Float64Array {
    let keys = this.keys;
    if (keys) return keys;
    keys = this.keys = new Float64Array(this.capacity).fill(Number.NaN);
    let size = 16;
    while (size < this.capacity * 2) size *= 2;
    this.tableMask = size - 1;
    this.tableKeys = [new Float64Array(size), new Float64Array(size)];
    this.tableSlots = [new Int32Array(size).fill(-1), new Int32Array(size).fill(-1)];
    this._previousIndex = new Int32Array(this.capacity);
    return keys;
  }

  /** Hash table start index of `k`. */
  private hashOf(k: number): number {
    const lo = k | 0;
    const hi = (k / 4294967296) | 0;
    let h = Math.imul(lo ^ Math.imul(hi, 0x85ebca6b), 0x9e3779b1);
    h ^= h >>> 15;
    return h & this.tableMask;
  }

  /**
   * Fill `previousIndex` from the table of the last flush (keyed slots by key, keyless by
   * index), then refill the other table with this flush's keys and make it current. No
   * allocation.
   */
  private matchKeys(): void {
    const keys = this.keys!;
    const pi = this._previousIndex!;
    const mask = this.tableMask;
    const lastK = this.tableKeys![this.cur]!;
    const lastS = this.tableSlots![this.cur]!;
    const n = this._count;
    const lastCount = this.lastCount;
    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      if (Number.isNaN(k)) {
        pi[i] = i < lastCount ? i : -1;
        continue;
      }
      let t = this.hashOf(k);
      let j = -1;
      for (;;) {
        const s = lastS[t]!;
        if (s < 0) break;
        if (lastK[t] === k) {
          j = s;
          break;
        }
        t = (t + 1) & mask;
      }
      pi[i] = j;
    }
    const next = 1 - this.cur;
    const nk = this.tableKeys![next]!;
    const ns = this.tableSlots![next]!;
    ns.fill(-1);
    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      if (Number.isNaN(k)) continue;
      let t = this.hashOf(k);
      for (;;) {
        const s = ns[t]!;
        if (s < 0 || nk[t] === k) break;
        t = (t + 1) & mask;
      }
      nk[t] = k;
      ns[t] = i;
    }
    this.cur = next;
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
