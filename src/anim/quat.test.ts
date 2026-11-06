import { describe, expect, it } from 'vitest';
import {
  quatDot,
  quatFromAxisAngle,
  quatFromEuler,
  quatFromMat3,
  quatIdentity,
  quatMultiply,
  quatNlerp,
  quatNormalize,
  quatSlerp,
} from './quat';

const q = (x: number, y: number, z: number, w: number) => new Float32Array([x, y, z, w]);
const axisAngle = (ax: number, ay: number, az: number, a: number) => {
  const out = new Float32Array(4);
  quatFromAxisAngle(out, 0, ax, ay, az, a);
  return out;
};
/** Rotate a vector by a quaternion (reference implementation for the tests). */
function rotate(qa: ArrayLike<number>, v: number[]): number[] {
  const [x, y, z, w] = [qa[0]!, qa[1]!, qa[2]!, qa[3]!];
  const [vx, vy, vz] = v as [number, number, number];
  // t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}
const close = (a: ArrayLike<number>, b: number[], eps = 1e-5) => {
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i]!, Math.round(-Math.log10(eps)));
};

describe('quat basics', () => {
  it('identity and normalise', () => {
    const a = new Float32Array(8);
    quatIdentity(a, 4);
    expect([...a]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    const b = q(0, 0, 3, 4);
    quatNormalize(b);
    close(b, [0, 0, 0.6, 0.8]);
    const zero = q(0, 0, 0, 0);
    quatNormalize(zero);
    expect([...zero]).toEqual([0, 0, 0, 1]);
  });

  it('multiply composes rotations in matrix order (b first, then a)', () => {
    const rx = axisAngle(1, 0, 0, Math.PI / 2);
    const rz = axisAngle(0, 0, 1, Math.PI / 2);
    const out = new Float32Array(4);
    quatMultiply(out, 0, rz, 0, rx, 0);
    // (0,1,0) → rx → (0,0,1) → rz → (0,0,1)
    close(rotate(out, [0, 1, 0]), [0, 0, 1]);
    // (0,0,1) → rx → (0,-1,0) → rz → (1,0,0)
    close(rotate(out, [0, 0, 1]), [1, 0, 0]);
    expect(quatDot(out, 0, out, 0)).toBeCloseTo(1, 5);
  });

  it('multiply tolerates aliasing', () => {
    const a = axisAngle(0, 1, 0, 0.7);
    const b = axisAngle(1, 0, 0, 0.3);
    const ref = new Float32Array(4);
    quatMultiply(ref, 0, a, 0, b, 0);
    quatMultiply(a, 0, a, 0, b, 0);
    close(a, [...ref]);
  });

  it('fromEuler applies X, then Y, then Z', () => {
    const out = new Float32Array(4);
    quatFromEuler(out, 0, 0.4, -1.1, 2.0);
    const rx = axisAngle(1, 0, 0, 0.4);
    const ry = axisAngle(0, 1, 0, -1.1);
    const rz = axisAngle(0, 0, 1, 2.0);
    const t = new Float32Array(4);
    quatMultiply(t, 0, ry, 0, rx, 0);
    quatMultiply(t, 0, rz, 0, t, 0);
    close(out, [...t]);
  });
});

describe('slerp', () => {
  it('hits the endpoints and the midpoint of a 90° rotation', () => {
    const a = axisAngle(0, 0, 1, 0);
    const b = axisAngle(0, 0, 1, Math.PI / 2);
    const out = new Float32Array(4);
    quatSlerp(out, 0, a, 0, b, 0, 0);
    close(out, [...a]);
    quatSlerp(out, 0, a, 0, b, 0, 1);
    close(out, [...b]);
    quatSlerp(out, 0, a, 0, b, 0, 0.5);
    close(out, [...axisAngle(0, 0, 1, Math.PI / 4)]);
  });

  it('is constant speed: equal steps rotate by equal angles', () => {
    const a = axisAngle(0, 1, 0, 0);
    const b = axisAngle(0, 1, 0, 2.4);
    const out = new Float32Array(4);
    for (let i = 0; i <= 10; i++) {
      quatSlerp(out, 0, a, 0, b, 0, i / 10);
      const angle = 2 * Math.atan2(out[1]!, out[3]!);
      expect(angle).toBeCloseTo(0.24 * i, 5);
      expect(quatDot(out, 0, out, 0)).toBeCloseTo(1, 5);
    }
  });

  it('takes the shorter arc when the inputs have opposite sign', () => {
    const a = axisAngle(1, 0, 0, 0.2);
    const b = axisAngle(1, 0, 0, 0.6);
    const negB = q(-b[0]!, -b[1]!, -b[2]!, -b[3]!);
    const out = new Float32Array(4);
    quatSlerp(out, 0, a, 0, negB, 0, 0.5);
    const mid = axisAngle(1, 0, 0, 0.4);
    expect(Math.abs(quatDot(out, 0, mid, 0))).toBeCloseTo(1, 5);
  });

  it('nearly parallel inputs fall back to a normalised lerp without NaN', () => {
    const a = axisAngle(0, 0, 1, 0.1);
    const b = axisAngle(0, 0, 1, 0.1 + 1e-4);
    const out = new Float32Array(4);
    quatSlerp(out, 0, a, 0, b, 0, 0.5);
    expect(Number.isNaN(out[0])).toBe(false);
    expect(quatDot(out, 0, out, 0)).toBeCloseTo(1, 5);
    expect(2 * Math.atan2(out[2]!, out[3]!)).toBeCloseTo(0.1 + 0.5e-4, 6);
  });

  it('nlerp is unit length and agrees with slerp at the endpoints and midpoint of a symmetric arc', () => {
    const a = axisAngle(0, 0, 1, -0.5);
    const b = axisAngle(0, 0, 1, 0.5);
    const n = new Float32Array(4);
    const s = new Float32Array(4);
    for (const t of [0, 0.5, 1]) {
      quatNlerp(n, 0, a, 0, b, 0, t);
      quatSlerp(s, 0, a, 0, b, 0, t);
      close(n, [...s]);
      expect(quatDot(n, 0, n, 0)).toBeCloseTo(1, 5);
    }
  });

  it('writes at an offset and may alias its first input', () => {
    const buf = new Float32Array(12);
    const a = axisAngle(1, 0, 0, 0);
    const b = axisAngle(1, 0, 0, 1);
    buf.set(a, 4);
    quatSlerp(buf, 4, buf, 4, b, 0, 0.5);
    close(buf.subarray(4, 8), [...axisAngle(1, 0, 0, 0.5)]);
    expect([...buf.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });
});

describe('quatFromMat3 (ws/ergo-3d)', () => {
  /** Row-major 3×3 of a unit quaternion (the convention of `writeNodeMatrix`). */
  const mat3 = (q: Float32Array, scale = 1): Float32Array => {
    const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    // biome-ignore format: matrix rows
    return new Float32Array([
      (1 - 2 * (yy + zz)) * scale, 2 * (xy - wz) * scale, 2 * (xz + wy) * scale,
      2 * (xy + wz) * scale, (1 - 2 * (xx + zz)) * scale, 2 * (yz - wx) * scale,
      2 * (xz - wy) * scale, 2 * (yz + wx) * scale, (1 - 2 * (xx + yy)) * scale,
    ]);
  };
  const same = (a: Float32Array, b: Float32Array) => {
    // q and -q are one rotation.
    const sign = quatDot(a, 0, b, 0) < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(sign * b[i]!, 5);
  };

  it('inverts the quaternion-to-matrix map on every Shepperd branch', () => {
    const cases = [
      q(0, 0, 0, 1),
      axisAngle(0, 1, 0, Math.PI / 2),
      axisAngle(1, 0, 0, Math.PI * 0.9), // m00 largest
      axisAngle(0, 1, 0, Math.PI * 0.95), // m11 largest
      axisAngle(0, 0, 1, Math.PI * 0.99), // m22 largest
      axisAngle(1, 1, 1, 2.1),
    ];
    for (const src of cases) {
      const out = new Float32Array(4);
      quatFromMat3(mat3(src), out);
      same(out, src);
      expect(Math.hypot(out[0]!, out[1]!, out[2]!, out[3]!)).toBeCloseTo(1, 6);
    }
  });

  it('drops a uniform scale, writes at an offset and reads a 3×4 affine with stride 4', () => {
    const src = axisAngle(0.3, 1, -0.2, 1.2);
    const out = new Float32Array(8);
    quatFromMat3(mat3(src, 2.5), out, 4);
    same(out.subarray(4), src);
    const m = mat3(src);
    // biome-ignore format: 3×4 rows with a translation column
    const affine = new Float32Array([
      m[0]!, m[1]!, m[2]!, 7,
      m[3]!, m[4]!, m[5]!, 8,
      m[6]!, m[7]!, m[8]!, 9,
    ]);
    const o2 = new Float32Array(4);
    quatFromMat3(affine, o2, 0, 0, 4);
    same(o2, src);
  });
});
