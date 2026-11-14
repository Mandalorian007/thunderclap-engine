/**
 * Which faces of a section its open cells connect (Checchi 2014, "advanced cave culling"):
 * 15 bits, one per pair of the six faces (−x, +x, −y, +y, −z, +z; the opposite of face f is
 * f ^ 1), set when a flood of the section's open cells reaches both faces of the pair. A
 * renderer's visibility search walks from the camera's section only through faces a section
 * connects. Open is every cell that is not an opaque cube.
 */

/** Every pair connected (a section of open cells only, or one not known yet). */
export const ALL_FACE_PAIRS = 0x7fff;

const PAIR_BASE = [0, 5, 9, 12, 14];

/** The bit of the pair of faces `a` and `b` (a ≠ b, 0..5) among the 15. */
export function facePairBit(a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return 1 << (PAIR_BASE[lo] + (hi - lo - 1));
}

const PAIRS_OF = new Uint16Array(64);
for (let m = 0; m < 64; m++) {
  let bits = 0;
  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) if (m & (1 << a) && m & (1 << b)) bits |= facePairBit(a, b);
  }
  PAIRS_OF[m] = bits;
}

/** A section's connectivity as the mesher reports it. */
export interface SectionConnectivity {
  /** The face pairs its open cells connect (`facePairBit`). */
  bits: number;
  /** Its open cells, 0..size³. */
  open: number;
  /** Some cell is open and none of them has sky or block light. */
  dark: boolean;
}

/**
 * Floods a section's open cells, reusing its buffers (one per thread). Its inputs are the
 * mesher's padded volumes (side `size + 2`): 1 for an opaque cube, sky light, and block light
 * (null when none is near).
 */
export class ConnectivityFlood implements SectionConnectivity {
  bits = 0;
  open = 0;
  dark = false;
  private readonly size: number;
  private readonly faceOf: Uint8Array;
  private readonly border: Uint8Array;
  private readonly seen: Uint8Array;
  private readonly stack: Int32Array;

  constructor(size: number) {
    this.size = size;
    const P = size + 2;
    const n = P * P * P;
    this.faceOf = new Uint8Array(n);
    this.border = new Uint8Array(n);
    this.seen = new Uint8Array(n);
    this.stack = new Int32Array(size * size * size);
    for (let py = 0; py < P; py++) {
      for (let pz = 0; pz < P; pz++) {
        for (let px = 0; px < P; px++) {
          const i = px + pz * P + py * P * P;
          if (px === 0 || py === 0 || pz === 0 || px === P - 1 || py === P - 1 || pz === P - 1) {
            this.border[i] = 1;
            continue;
          }
          this.faceOf[i] =
            (px === 1 ? 1 : 0) |
            (px === size ? 2 : 0) |
            (py === 1 ? 4 : 0) |
            (py === size ? 8 : 0) |
            (pz === 1 ? 16 : 0) |
            (pz === size ? 32 : 0);
        }
      }
    }
  }

  compute(opaque: Uint8Array, light: Uint8Array, block: Uint8Array | null = null): this {
    const S = this.size;
    const P = S + 2;
    const PA = P * P;
    let open = 0;
    let lit = 0;
    for (let py = 1; py <= S; py++) {
      for (let pz = 1; pz <= S; pz++) {
        let i = 1 + pz * P + py * PA;
        for (let px = 0; px < S; px++, i++) {
          if (opaque[i]) continue;
          open++;
          if (light[i] || (block !== null && block[i])) lit++;
        }
      }
    }
    this.open = open;
    this.dark = open > 0 && lit === 0;
    if (open === 0 || open === S * S * S) {
      this.bits = open === 0 ? 0 : ALL_FACE_PAIRS;
      return this;
    }
    const seen = this.seen;
    const stack = this.stack;
    const faceOf = this.faceOf;
    seen.set(this.border);
    let bits = 0;
    const steps = [-1, 1, -P, P, -PA, PA];
    outer: for (let py = 1; py <= S; py++) {
      for (let pz = 1; pz <= S; pz++) {
        let start = 1 + pz * P + py * PA;
        for (let px = 0; px < S; px++, start++) {
          if (seen[start] || opaque[start]) continue;
          let faces = 0;
          let top = 0;
          seen[start] = 1;
          stack[top++] = start;
          while (top > 0) {
            const i = stack[--top];
            faces |= faceOf[i];
            for (let n = 0; n < 6; n++) {
              const j = i + steps[n];
              if (!seen[j] && !opaque[j]) {
                seen[j] = 1;
                stack[top++] = j;
              }
            }
          }
          bits |= PAIRS_OF[faces];
          if (bits === ALL_FACE_PAIRS) break outer;
        }
      }
    }
    this.bits = bits;
    return this;
  }
}

/** The connectivity of a section that is one cell everywhere, open or opaque. */
export function uniformConnectivity(open: boolean, size = 16): SectionConnectivity {
  return open
    ? { bits: ALL_FACE_PAIRS, open: size ** 3, dark: false }
    : { bits: 0, open: 0, dark: false };
}
