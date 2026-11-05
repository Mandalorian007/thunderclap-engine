/**
 * A small 4×4 matrix module. Matrices are column-major `Float32Array(16)` (the layout WGSL's
 * `mat4x4f` expects): element (row r, column c) is `m[c * 4 + r]`, and the translation sits in
 * `m[12..14]`.
 *
 * Every function writes into `out` and returns it, so a caller that keeps its matrices
 * allocates nothing per frame. `out` may alias an input.
 *
 * Conventions: right-handed view space looking down -z; clip depth is WebGPU's 0..1.
 */

export type Mat4 = Float32Array;

/** A new identity matrix (allocates; keep it). */
function create(): Mat4 {
  return identity(new Float32Array(16));
}

function identity(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

function copy(out: Mat4, a: ArrayLike<number>): Mat4 {
  for (let i = 0; i < 16; i++) out[i] = a[i]!;
  return out;
}

/** `out = a × b` (apply `b` first, then `a`). */
function multiply(out: Mat4, a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  const a00 = a[0]!,
    a01 = a[1]!,
    a02 = a[2]!,
    a03 = a[3]!;
  const a10 = a[4]!,
    a11 = a[5]!,
    a12 = a[6]!,
    a13 = a[7]!;
  const a20 = a[8]!,
    a21 = a[9]!,
    a22 = a[10]!,
    a23 = a[11]!;
  const a30 = a[12]!,
    a31 = a[13]!,
    a32 = a[14]!,
    a33 = a[15]!;
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!,
      b1 = b[c * 4 + 1]!,
      b2 = b[c * 4 + 2]!,
      b3 = b[c * 4 + 3]!;
    out[c * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[c * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[c * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[c * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}

/**
 * Orthographic projection: x in `left..right` and y in `bottom..top` map to clip -1..1; view
 * depth `-near..-far` maps to 0..1. Pass `bottom > top` for a y-down space.
 */
function ortho(
  out: Mat4,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  out.fill(0);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = -1 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -near / (far - near);
  out[15] = 1;
  return out;
}

/**
 * Perspective projection, vertical field of view `fovY` (radians). View depth `-near` maps to
 * 0 and `-far` to 1; `far = Infinity` gives an infinite far plane.
 */
function perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  if (Number.isFinite(far)) {
    out[10] = far / (near - far);
    out[14] = (near * far) / (near - far);
  } else {
    out[10] = -1;
    out[14] = -near;
  }
  return out;
}

/** View matrix for an eye at `eye` looking at `target`, with `up` roughly up. */
function lookAt(
  out: Mat4,
  eye: ArrayLike<number>,
  target: ArrayLike<number>,
  up: ArrayLike<number>,
): Mat4 {
  const ex = eye[0]!,
    ey = eye[1]!,
    ez = eye[2]!;
  // z axis: from target to eye.
  let zx = ex - target[0]!,
    zy = ey - target[1]!,
    zz = ez - target[2]!;
  let len = Math.hypot(zx, zy, zz);
  if (len === 0) return identity(out);
  zx /= len;
  zy /= len;
  zz /= len;
  // x axis: up × z.
  let xx = up[1]! * zz - up[2]! * zy,
    xy = up[2]! * zx - up[0]! * zz,
    xz = up[0]! * zy - up[1]! * zx;
  len = Math.hypot(xx, xy, xz);
  if (len === 0) {
    xx = 0;
    xy = 0;
    xz = 0;
  } else {
    xx /= len;
    xy /= len;
    xz /= len;
  }
  // y axis: z × x.
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}

/**
 * 2D view over a `width × height` space (y down): the world point `(width/2 + x, height/2 + y)`
 * lands on the space's centre, scaled by `zoom` about it. `rotation` (radians) turns the view
 * clockwise on screen, so the world appears to turn counter-clockwise. With `x = y = rotation = 0` and `zoom = 1` it is the identity.
 */
function view2d(
  out: Mat4,
  x: number,
  y: number,
  zoom: number,
  rotation: number,
  width: number,
  height: number,
): Mat4 {
  const c = Math.cos(-rotation) * zoom;
  const s = Math.sin(-rotation) * zoom;
  const cx = width / 2 + x;
  const cy = height / 2 + y;
  out.fill(0);
  out[0] = c;
  out[1] = s;
  out[4] = -s;
  out[5] = c;
  out[10] = 1;
  out[12] = width / 2 - c * cx + s * cy;
  out[13] = height / 2 - s * cx - c * cy;
  out[15] = 1;
  return out;
}

/** `out = a⁻¹`. Returns null (and leaves `out` untouched) when `a` is singular. */
function invert(out: Mat4, a: ArrayLike<number>): Mat4 | null {
  const a00 = a[0]!,
    a01 = a[1]!,
    a02 = a[2]!,
    a03 = a[3]!;
  const a10 = a[4]!,
    a11 = a[5]!,
    a12 = a[6]!,
    a13 = a[7]!;
  const a20 = a[8]!,
    a21 = a[9]!,
    a22 = a[10]!,
    a23 = a[11]!;
  const a30 = a[12]!,
    a31 = a[13]!,
    a32 = a[14]!,
    a33 = a[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

/**
 * Transform the point `(x, y, z, 1)` by `m` and divide by w: `out[0..2]` get the result.
 * Returns w (before the divide), which is ≤ 0 for a point behind a perspective camera.
 */
function transformPoint(
  out: { [i: number]: number },
  m: ArrayLike<number>,
  x: number,
  y: number,
  z = 0,
): number {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const k = w !== 0 ? 1 / w : 1;
  const ox = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * k;
  const oy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * k;
  const oz = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * k;
  out[0] = ox;
  out[1] = oy;
  out[2] = oz;
  return w;
}

/** Column-major 4×4 matrix helpers. See the module comment for conventions. */
export const mat4 = {
  create,
  identity,
  copy,
  multiply,
  ortho,
  perspective,
  lookAt,
  view2d,
  invert,
  transformPoint,
} as const;
