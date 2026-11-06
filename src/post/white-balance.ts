/**
 * White balance (ws/post-3): the 3×3 linear-sRGB matrix that tints an image toward the colour
 * of a black body at a temperature, shifted green–magenta by a tint.
 *
 * Method: the target white's CIE 1931 chromaticity comes from the Kim et al. (2002) cubic
 * approximation of the Planckian locus (valid 1667..25000 K); `tint` moves its `y` by 0.05 per
 * unit (negative `y` shift = magenta). The matrix is the Bradford chromatic adaptation
 * transform (Lam 1985, as used by ICC) from the 6500 K white to that target, wrapped in the
 * sRGB (D65) ↔ XYZ matrices. At 6500 K / tint 0 source and target coincide and the matrix is
 * the identity, so the default setting leaves every pixel as it was.
 */

/** Bradford cone response matrix (row-major 3×3) and its inverse. */
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV = [
  0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428,
  0.9684867,
];
/** Linear sRGB → XYZ (D65) and back, row-major. */
const XYZ_FROM_SRGB = [
  0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041,
];
const SRGB_FROM_XYZ = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259,
  1.0572252,
];

const scratchA = new Float64Array(9);
const scratchB = new Float64Array(9);
const srcLms = new Float64Array(3);
const dstLms = new Float64Array(3);
const srcWhite = new Float64Array(3);
const dstWhite = new Float64Array(3);

/**
 * CIE 1931 `xy` of a black body at `kelvin` (clamped to 1667..25000), written to `out[0..1]`
 * (Kim et al. 2002).
 */
export function planckianXy(out: { [i: number]: number }, kelvin: number): void {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (t <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  out[0] = x;
  out[1] = y;
}

function xyToXyz(out: Float64Array, x: number, y: number): void {
  const yy = Math.max(y, 1e-4);
  out[0] = x / yy;
  out[1] = 1;
  out[2] = (1 - x - yy) / yy;
}

function mul3(out: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out;
}

function apply3(out: Float64Array, m: ArrayLike<number>, v: ArrayLike<number>): void {
  out[0] = m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!;
  out[1] = m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!;
  out[2] = m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!;
}

/**
 * Write the 3×3 row-major linear-sRGB white-balance matrix for `kelvin` and `tint` into `out`
 * (9 numbers): `rgb' = M × rgb`. 6500 / 0 gives the identity. No allocation.
 */
export function whiteBalanceMatrix(
  out: { [i: number]: number },
  kelvin: number,
  tint: number,
): typeof out {
  planckianXy(srcWhite, 6500);
  xyToXyz(srcWhite, srcWhite[0]!, srcWhite[1]!);
  planckianXy(dstWhite, kelvin);
  xyToXyz(dstWhite, dstWhite[0]!, dstWhite[1]! - 0.05 * Math.min(1, Math.max(-1, tint)));
  apply3(srcLms, BRADFORD, srcWhite);
  apply3(dstLms, BRADFORD, dstWhite);
  // A = Bradford⁻¹ × diag(dst / src) × Bradford.
  for (let r = 0; r < 3; r++) {
    const k = dstLms[r]! / srcLms[r]!;
    scratchA[r * 3] = BRADFORD[r * 3]! * k;
    scratchA[r * 3 + 1] = BRADFORD[r * 3 + 1]! * k;
    scratchA[r * 3 + 2] = BRADFORD[r * 3 + 2]! * k;
  }
  mul3(scratchB, BRADFORD_INV, scratchA); // A in XYZ
  mul3(scratchA, scratchB, XYZ_FROM_SRGB); // A × XYZ_from_sRGB
  mul3(scratchB, SRGB_FROM_XYZ, scratchA); // sRGB_from_XYZ × ...
  for (let i = 0; i < 9; i++) out[i] = scratchB[i]!;
  return out;
}
