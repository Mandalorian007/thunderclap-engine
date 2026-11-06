/**
 * Quaternion helpers on flat arrays: every function reads and writes `(x, y, z, w)` at an
 * offset into a `Float32Array` (or any `ArrayLike`), so poses and keyframe buffers are handled in
 * place and nothing allocates. No dependency on `render/`.
 *
 * Conventions match `render/transform.ts`: unit quaternions `(x, y, z, w)`, right-handed, and
 * `quatMultiply(out, a, b)` is "apply `b`, then `a`" (the same order as matrix products).
 */

/** Write the identity rotation at `out[o..o+4)`. */
export function quatIdentity(out: Float32Array, o = 0): void {
  out[o] = 0;
  out[o + 1] = 0;
  out[o + 2] = 0;
  out[o + 3] = 1;
}

/** Normalise the quaternion at `q[o..o+4)` in place. A zero quaternion becomes the identity. */
export function quatNormalize(q: Float32Array, o = 0): void {
  const x = q[o]!;
  const y = q[o + 1]!;
  const z = q[o + 2]!;
  const w = q[o + 3]!;
  const len = Math.hypot(x, y, z, w);
  if (len === 0) {
    quatIdentity(q, o);
    return;
  }
  const inv = 1 / len;
  q[o] = x * inv;
  q[o + 1] = y * inv;
  q[o + 2] = z * inv;
  q[o + 3] = w * inv;
}

/** Dot product of the quaternions at `a[ao..]` and `b[bo..]`. */
export function quatDot(
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
): number {
  return (
    a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]!
  );
}

/**
 * `out = a · b`: the rotation that applies `b` first, then `a`. `out` may alias either input.
 */
export function quatMultiply(
  out: Float32Array,
  oo: number,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
): void {
  const ax = a[ao]!;
  const ay = a[ao + 1]!;
  const az = a[ao + 2]!;
  const aw = a[ao + 3]!;
  const bx = b[bo]!;
  const by = b[bo + 1]!;
  const bz = b[bo + 2]!;
  const bw = b[bo + 3]!;
  out[oo] = aw * bx + ax * bw + ay * bz - az * by;
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * Normalised linear interpolation from `a` to `b` by `t` along the shorter arc. Cheaper than
 * `quatSlerp`, not constant speed; fine for blending nearby poses. `out` may alias an input.
 */
export function quatNlerp(
  out: Float32Array,
  oo: number,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  t: number,
): void {
  const sign = quatDot(a, ao, b, bo) < 0 ? -1 : 1;
  const s = 1 - t;
  const u = t * sign;
  out[oo] = s * a[ao]! + u * b[bo]!;
  out[oo + 1] = s * a[ao + 1]! + u * b[bo + 1]!;
  out[oo + 2] = s * a[ao + 2]! + u * b[bo + 2]!;
  out[oo + 3] = s * a[ao + 3]! + u * b[bo + 3]!;
  quatNormalize(out, oo);
}

/**
 * Spherical linear interpolation from `a` to `b` by `t` along the shorter arc (glTF `LINEAR`
 * rotation semantics). Falls back to a normalised lerp when the inputs are nearly parallel.
 * `out` may alias an input.
 */
export function quatSlerp(
  out: Float32Array,
  oo: number,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  t: number,
): void {
  let cos = quatDot(a, ao, b, bo);
  let sign = 1;
  if (cos < 0) {
    cos = -cos;
    sign = -1;
  }
  if (cos > 0.9995) {
    quatNlerp(out, oo, a, ao, b, bo, t);
    return;
  }
  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const s = Math.sin((1 - t) * theta) / sinTheta;
  const u = (Math.sin(t * theta) / sinTheta) * sign;
  out[oo] = s * a[ao]! + u * b[bo]!;
  out[oo + 1] = s * a[ao + 1]! + u * b[bo + 1]!;
  out[oo + 2] = s * a[ao + 2]! + u * b[bo + 2]!;
  out[oo + 3] = s * a[ao + 3]! + u * b[bo + 3]!;
}

/** Rotation about an axis (need not be unit length) by `radians`, written at `out[o..o+4)`. */
export function quatFromAxisAngle(
  out: Float32Array,
  o: number,
  ax: number,
  ay: number,
  az: number,
  radians: number,
): void {
  const len = Math.hypot(ax, ay, az) || 1;
  const s = Math.sin(radians / 2) / len;
  out[o] = ax * s;
  out[o + 1] = ay * s;
  out[o + 2] = az * s;
  out[o + 3] = Math.cos(radians / 2);
}

/**
 * Rotation from Euler angles in radians: about X, then Y, then Z in the parent frame
 * (`q = qz · qy · qx`). Written at `out[o..o+4)`.
 */
export function quatFromEuler(out: Float32Array, o: number, x: number, y: number, z: number): void {
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);
  out[o] = sx * cy * cz - cx * sy * sz;
  out[o + 1] = cx * sy * cz + sx * cy * sz;
  out[o + 2] = cx * cy * sz - sx * sy * cz;
  out[o + 3] = cx * cy * cz + sx * sy * sz;
}

/**
 * The rotation of a 3×3 matrix (or the 3×3 part of a 3×4 affine, with `stride` 4) read
 * row-major at `m[mo..]` (rows `r0 r1 r2`, `stride` floats apart; default 3 for a packed
 * mat3), written as a unit quaternion at `out[o..o+4)`. Shepperd's method: the largest
 * diagonal term picks the stable branch. A scaled matrix is normalised first (uniform scale
 * drops out; non-uniform scale gives the nearest rotation only approximately). Allocation-free.
 */
export function quatFromMat3(
  m: ArrayLike<number>,
  out: Float32Array,
  o = 0,
  mo = 0,
  stride = 3,
): void {
  // Normalise each row so a scaled matrix yields a unit quaternion.
  let m00 = m[mo]!;
  let m01 = m[mo + 1]!;
  let m02 = m[mo + 2]!;
  let m10 = m[mo + stride]!;
  let m11 = m[mo + stride + 1]!;
  let m12 = m[mo + stride + 2]!;
  let m20 = m[mo + 2 * stride]!;
  let m21 = m[mo + 2 * stride + 1]!;
  let m22 = m[mo + 2 * stride + 2]!;
  // Columns are the rotated basis vectors; their lengths are the scale.
  const sx = Math.hypot(m00, m10, m20) || 1;
  const sy = Math.hypot(m01, m11, m21) || 1;
  const sz = Math.hypot(m02, m12, m22) || 1;
  m00 /= sx;
  m10 /= sx;
  m20 /= sx;
  m01 /= sy;
  m11 /= sy;
  m21 /= sy;
  m02 /= sz;
  m12 /= sz;
  m22 /= sz;
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = w;
  quatNormalize(out, o);
}
