/**
 * Transforms: position, rotation and scale, with an optional parent, cached as a 3×4 world
 * matrix. The renderer copies that matrix straight into the instance buffer
 * (`frame.sprite(material, transform)` / `frame.mesh(mesh, material, transform)`).
 *
 * Conventions:
 * - The world matrix is **3×4, row-major**: 12 floats `[r0 | tx, r1 | ty, r2 | tz]`, so
 *   `world = (dot(row0, p), dot(row1, p), dot(row2, p))` with `p = (x, y, z, 1)`. The fourth
 *   row of an affine matrix is always `(0, 0, 0, 1)` and is not stored.
 * - The local matrix is `T · R · S` (scale, then rotate, then translate); a child's world
 *   matrix is `parent.world · local`.
 * - Rotation is a unit quaternion `(x, y, z, w)`. The 2D case is a rotation about +Z:
 *   `rotation = a` (radians) gives the same matrix as `DrawParams.rotation`, clockwise on
 *   screen when y points down. A pure Z rotation is built from `Math.cos/sin(a)` directly, so
 *   it matches the `DrawParams` path exactly.
 * - 2D: keep `z = 0`, rotate about Z only, and `scale.z = 1`.
 *
 * Setters mark the transform dirty; `world` recomputes lazily, at most once per change (or
 * per parent change). Nothing allocates after construction.
 */

/** Floats in a 3×4 world matrix. */
export const MATRIX3X4_FLOATS = 12;

/**
 * Write the 3×4 row-major matrix of a 2D draw (`DrawParams` x, y, w, h, rotation) at
 * `out[o..o+12)`. This is the instance matrix `frame.sprite(material, params)` builds: the
 * built-in quad spans -0.5..0.5, so `w, h` are its size. No allocation.
 */
export function writeMatrix2d(
  out: Float32Array,
  o: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
): void {
  const c = rotation === 0 ? 1 : Math.cos(rotation);
  const s = rotation === 0 ? 0 : Math.sin(rotation);
  out[o] = c * w;
  out[o + 1] = -s * h;
  out[o + 2] = 0;
  out[o + 3] = x;
  out[o + 4] = s * w;
  out[o + 5] = c * h;
  out[o + 6] = 0;
  out[o + 7] = y;
  out[o + 8] = 0;
  out[o + 9] = 0;
  out[o + 10] = 1;
  out[o + 11] = 0;
}

/**
 * `out = a · b` for 3×4 affine matrices (implicit last row `0 0 0 1`). `out` may alias
 * neither input. No allocation.
 */
export function multiplyMatrix3x4(
  out: Float32Array,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): void {
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4]!;
    const a1 = a[r * 4 + 1]!;
    const a2 = a[r * 4 + 2]!;
    const a3 = a[r * 4 + 3]!;
    out[r * 4] = a0 * b[0]! + a1 * b[4]! + a2 * b[8]!;
    out[r * 4 + 1] = a0 * b[1]! + a1 * b[5]! + a2 * b[9]!;
    out[r * 4 + 2] = a0 * b[2]! + a1 * b[6]! + a2 * b[10]!;
    out[r * 4 + 3] = a0 * b[3]! + a1 * b[7]! + a2 * b[11]! + a3;
  }
}

/** Read-only view of a vector a transform owns. */
export interface ReadonlyVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface ReadonlyQuat extends ReadonlyVec3 {
  readonly w: number;
}

export class Transform {
  private readonly _position = { x: 0, y: 0, z: 0 };
  private readonly _rotation = { x: 0, y: 0, z: 0, w: 1 };
  private readonly _scale = { x: 1, y: 1, z: 1 };
  /** Angle about Z when the rotation was set as one (exact cos/sin path), else NaN. */
  private angleZ = 0;
  private _parent: Transform | null = null;
  private readonly local = new Float32Array(MATRIX3X4_FLOATS);
  private readonly _world = new Float32Array(MATRIX3X4_FLOATS);
  private localDirty = true;
  private worldDirty = true;
  /** Bumps whenever `world` is recomputed; children compare it to their cached value. */
  private worldVersion = 0;
  private parentVersion = -1;
  /** Setter calls on this transform (ws/audio-4); `changed` adds the ancestors'. */
  private _changed = 0;

  constructor(opts?: {
    x?: number;
    y?: number;
    z?: number;
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
    scaleZ?: number;
    parent?: Transform | null;
  }) {
    if (opts) {
      this.setPosition(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
      if (opts.rotation) this.rotation = opts.rotation;
      this.setScale(opts.scaleX ?? 1, opts.scaleY ?? 1, opts.scaleZ ?? 1);
      if (opts.parent) this.parent = opts.parent;
    }
  }

  get position(): ReadonlyVec3 {
    return this._position;
  }
  /**
   * A monotonic counter bumped by every setter on this transform or an ancestor (ws/audio-4),
   * so a reader can skip `world` when nothing moved (`Voice.follow` does). It does not say
   * whether `world` is stale; the dirty flags still do that.
   */
  get changed(): number {
    return this._changed + (this._parent ? this._parent.changed : 0);
  }
  get quaternion(): ReadonlyQuat {
    return this._rotation;
  }
  get scale(): ReadonlyVec3 {
    return this._scale;
  }

  setPosition(x: number, y: number, z = 0): this {
    const p = this._position;
    p.x = x;
    p.y = y;
    p.z = z;
    this._changed++;
    this.localDirty = true;
    return this;
  }

  /**
   * Set the local scale. One argument scales all three axes (`setScale(2)` is `2, 2, 2`, so a
   * 3D node keeps its shape; a flat 2D quad has no depth, so it draws the same). Two arguments
   * are the 2D form: `z` stays 1. Three set each axis.
   */
  setScale(s: number): this;
  setScale(x: number, y: number, z?: number): this;
  setScale(x: number, y?: number, z?: number): this {
    const s = this._scale;
    s.x = x;
    s.y = y ?? x;
    s.z = z ?? (y === undefined ? x : 1);
    this._changed++;
    this.localDirty = true;
    return this;
  }

  /**
   * The 2D rotation: radians about +Z (clockwise on screen with y down, like
   * `DrawParams.rotation`). Reading it after `setQuaternion` returns the quaternion's angle
   * about Z, which is only meaningful for a pure Z rotation.
   */
  get rotation(): number {
    if (!Number.isNaN(this.angleZ)) return this.angleZ;
    const q = this._rotation;
    return 2 * Math.atan2(q.z, q.w);
  }
  set rotation(radians: number) {
    this.angleZ = radians;
    const q = this._rotation;
    q.x = 0;
    q.y = 0;
    q.z = Math.sin(radians / 2);
    q.w = Math.cos(radians / 2);
    this._changed++;
    this.localDirty = true;
  }

  /** Set a 3D rotation as a quaternion (normalised here). */
  setQuaternion(x: number, y: number, z: number, w: number): this {
    const len = Math.hypot(x, y, z, w) || 1;
    const q = this._rotation;
    q.x = x / len;
    q.y = y / len;
    q.z = z / len;
    q.w = w / len;
    this.angleZ = Number.NaN;
    this._changed++;
    this.localDirty = true;
    return this;
  }

  /** Rotation from an axis (need not be unit length) and an angle in radians. */
  setAxisAngle(ax: number, ay: number, az: number, radians: number): this {
    const len = Math.hypot(ax, ay, az) || 1;
    const s = Math.sin(radians / 2) / len;
    return this.setQuaternion(ax * s, ay * s, az * s, Math.cos(radians / 2));
  }

  /**
   * Set the local matrix from a 3×4 row-major matrix at `m[o..o+12)` (an animation socket, a
   * node world matrix). The 12 floats are copied as they are, so `world` is exact; `position`,
   * `quaternion` and `scale` are decomposed from it (translation column, column lengths, the
   * rotation of the normalised columns; a mirrored matrix carries the sign on `scale.z`), so a
   * later setter rebuilds the nearest `T · R · S`. No allocation.
   */
  setMatrix(m: ArrayLike<number>, o = 0): this {
    const l = this.local;
    for (let i = 0; i < MATRIX3X4_FLOATS; i++) l[i] = m[o + i]!;
    const p = this._position;
    p.x = l[3]!;
    p.y = l[7]!;
    p.z = l[11]!;
    const s = this._scale;
    let sx = Math.hypot(l[0]!, l[4]!, l[8]!);
    let sy = Math.hypot(l[1]!, l[5]!, l[9]!);
    let sz = Math.hypot(l[2]!, l[6]!, l[10]!);
    const det =
      l[0]! * (l[5]! * l[10]! - l[6]! * l[9]!) -
      l[1]! * (l[4]! * l[10]! - l[6]! * l[8]!) +
      l[2]! * (l[4]! * l[9]! - l[5]! * l[8]!);
    if (det < 0) sz = -sz;
    s.x = sx;
    s.y = sy;
    s.z = sz;
    sx = sx || 1;
    sy = sy || 1;
    sz = sz || 1;
    // Rotation matrix columns (unit), row-major: r[row][col].
    const r00 = l[0]! / sx;
    const r01 = l[1]! / sy;
    const r02 = l[2]! / sz;
    const r10 = l[4]! / sx;
    const r11 = l[5]! / sy;
    const r12 = l[6]! / sz;
    const r20 = l[8]! / sx;
    const r21 = l[9]! / sy;
    const r22 = l[10]! / sz;
    const q = this._rotation;
    const trace = r00 + r11 + r22;
    if (trace > 0) {
      const w = Math.sqrt(trace + 1) * 0.5;
      const k = 0.25 / w;
      q.x = (r21 - r12) * k;
      q.y = (r02 - r20) * k;
      q.z = (r10 - r01) * k;
      q.w = w;
    } else if (r00 > r11 && r00 > r22) {
      const x = Math.sqrt(1 + r00 - r11 - r22) * 0.5;
      const k = 0.25 / x;
      q.x = x;
      q.y = (r01 + r10) * k;
      q.z = (r02 + r20) * k;
      q.w = (r21 - r12) * k;
    } else if (r11 > r22) {
      const y = Math.sqrt(1 + r11 - r00 - r22) * 0.5;
      const k = 0.25 / y;
      q.x = (r01 + r10) * k;
      q.y = y;
      q.z = (r12 + r21) * k;
      q.w = (r02 - r20) * k;
    } else {
      const z = Math.sqrt(1 + r22 - r00 - r11) * 0.5;
      const k = 0.25 / z;
      q.x = (r02 + r20) * k;
      q.y = (r12 + r21) * k;
      q.z = z;
      q.w = (r10 - r01) * k;
    }
    this.angleZ = Number.NaN;
    this._changed++;
    this.localDirty = false;
    this.worldDirty = true;
    return this;
  }

  get parent(): Transform | null {
    return this._parent;
  }
  set parent(p: Transform | null) {
    for (let q = p; q; q = q._parent) {
      if (q === this) throw new Error('Transform: parent cycle');
    }
    this._parent = p;
    this.parentVersion = -1;
    this._changed++;
    this.worldDirty = true;
  }

  /** Local matrix (3×4 row-major), recomputed if a setter ran since the last read. */
  get localMatrix(): Float32Array {
    if (this.localDirty) this.updateLocal();
    return this.local;
  }

  /**
   * World matrix (3×4 row-major): the parent's world times the local matrix. Cached; it
   * recomputes only after a setter on this transform or a change anywhere up the chain.
   */
  get world(): Float32Array {
    const p = this._parent;
    if (p) {
      const pw = p.world;
      if (this.localDirty || this.worldDirty || p.worldVersion !== this.parentVersion) {
        multiplyMatrix3x4(this._world, pw, this.localMatrix);
        this.parentVersion = p.worldVersion;
        this.worldDirty = false;
        this.worldVersion++;
      }
    } else if (this.localDirty || this.worldDirty) {
      this._world.set(this.localMatrix);
      this.worldDirty = false;
      this.worldVersion++;
    }
    return this._world;
  }

  private updateLocal(): void {
    const m = this.local;
    const s = this._scale;
    const p = this._position;
    if (!Number.isNaN(this.angleZ)) {
      writeMatrix2d(m, 0, p.x, p.y, s.x, s.y, this.angleZ);
      m[10] = s.z;
      m[11] = p.z;
    } else {
      const { x, y, z, w } = this._rotation;
      const xx = x * x;
      const yy = y * y;
      const zz = z * z;
      const xy = x * y;
      const xz = x * z;
      const yz = y * z;
      const wx = w * x;
      const wy = w * y;
      const wz = w * z;
      m[0] = (1 - 2 * (yy + zz)) * s.x;
      m[1] = 2 * (xy - wz) * s.y;
      m[2] = 2 * (xz + wy) * s.z;
      m[3] = p.x;
      m[4] = 2 * (xy + wz) * s.x;
      m[5] = (1 - 2 * (xx + zz)) * s.y;
      m[6] = 2 * (yz - wx) * s.z;
      m[7] = p.y;
      m[8] = 2 * (xz - wy) * s.x;
      m[9] = 2 * (yz + wx) * s.y;
      m[10] = (1 - 2 * (xx + yy)) * s.z;
      m[11] = p.z;
    }
    this.localDirty = false;
    this.worldDirty = true;
  }
}
