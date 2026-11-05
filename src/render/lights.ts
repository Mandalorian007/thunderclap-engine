/**
 * The lighting block: what every material can read at `@group(0) @binding(2)` as
 * `EngineLights`, beside the globals and the camera. The engine supplies the uniforms; the
 * style (Lambert, toon, rim, nothing at all) is the game's WGSL. A game fills `frame.lights`
 * each frame; the renderer uploads it with the camera block of every view.
 *
 * The default block is unlit: ambient 1, no sun, no point lights. A material that multiplies
 * by `engine_lambert(n, p)` therefore draws its albedo unchanged until the game lights the
 * scene, and materials that never read the block are untouched.
 */

/** Point lights the block carries; `Lights.points` beyond this many are ignored. */
export const MAX_POINT_LIGHTS = 16;

/** Floats per point light in the block: position xyz, radius, colour rgb, pad (32 bytes). */
export const POINT_LIGHT_FLOATS = 8;

/** Float offset of `points[0]` inside the block (ambient, count, sun_dir, sun_color first). */
export const POINT_LIGHTS_OFFSET_FLOATS = 12;

/** Floats in the WGSL `EngineLights` block (560 bytes). */
export const LIGHTS_BLOCK_FLOATS =
  POINT_LIGHTS_OFFSET_FLOATS + MAX_POINT_LIGHTS * POINT_LIGHT_FLOATS;

/** A directional light: `dir` is the direction the light travels (sun → scene), any length. */
export interface DirectionalLight {
  dir: ArrayLike<number>;
  /** Linear RGB, HDR allowed. All zero is "no sun". */
  color: ArrayLike<number>;
}

/** A point light: world position, linear RGB colour and the radius where it falls to zero. */
export interface PointLight {
  position: ArrayLike<number>;
  color: ArrayLike<number>;
  radius: number;
}

/**
 * The lights of one frame. Mutate the fields (or push into `points`) and keep the object; the
 * renderer calls `writeBlock` into its own uniform staging each view, so nothing allocates.
 */
export class Lights {
  /** Linear RGB added to everything the game's lighting touches. Default white (unlit). */
  readonly ambient = new Float32Array([1, 1, 1]);
  /** The one directional light. Default: no colour, so it contributes nothing. */
  readonly sun: DirectionalLight = {
    dir: new Float32Array([0, -1, 0]),
    color: new Float32Array([0, 0, 0]),
  };
  /** Point lights, in order; the first `MAX_POINT_LIGHTS` reach the shader. */
  readonly points: PointLight[] = [];

  /** Back to the unlit default: ambient 1, no sun, `points` emptied (`length = 0`). */
  reset(): this {
    this.ambient.fill(1);
    const s = this.sun;
    set3(s.dir, 0, -1, 0);
    set3(s.color, 0, 0, 0);
    this.points.length = 0;
    return this;
  }

  /**
   * Write the `EngineLights` block into `out` at float offset `o` (`LIGHTS_BLOCK_FLOATS` floats):
   * `ambient` (0–2), `point_count` as u32 (3, through `u32`, a `Uint32Array` over the same
   * buffer as `out`, like `Camera.writeBlock`), normalised `sun_dir` (4–6), `sun_color` (8–10),
   * then `MAX_POINT_LIGHTS` × (`position`, `radius`, `color`, pad). Unused slots are zeroed.
   * No allocation.
   */
  writeBlock(out: Float32Array, u32: Uint32Array, o = 0): void {
    const a = this.ambient;
    out[o] = a[0]!;
    out[o + 1] = a[1]!;
    out[o + 2] = a[2]!;
    const n = Math.min(this.points.length, MAX_POINT_LIGHTS);
    u32[o + 3] = n;
    const d = this.sun.dir;
    const dx = d[0] ?? 0;
    const dy = d[1] ?? 0;
    const dz = d[2] ?? 0;
    const len = Math.hypot(dx, dy, dz);
    const k = len > 0 ? 1 / len : 0;
    out[o + 4] = dx * k;
    out[o + 5] = dy * k;
    out[o + 6] = dz * k;
    out[o + 7] = 0;
    const c = this.sun.color;
    out[o + 8] = c[0] ?? 0;
    out[o + 9] = c[1] ?? 0;
    out[o + 10] = c[2] ?? 0;
    out[o + 11] = 0;
    let p = o + POINT_LIGHTS_OFFSET_FLOATS;
    for (let i = 0; i < n; i++, p += POINT_LIGHT_FLOATS) {
      const l = this.points[i]!;
      const pos = l.position;
      const col = l.color;
      out[p] = pos[0] ?? 0;
      out[p + 1] = pos[1] ?? 0;
      out[p + 2] = pos[2] ?? 0;
      out[p + 3] = l.radius;
      out[p + 4] = col[0] ?? 0;
      out[p + 5] = col[1] ?? 0;
      out[p + 6] = col[2] ?? 0;
      out[p + 7] = 0;
    }
    out.fill(0, p, o + LIGHTS_BLOCK_FLOATS);
  }
}

function set3(v: ArrayLike<number>, x: number, y: number, z: number): void {
  const w = v as unknown as number[];
  w[0] = x;
  w[1] = y;
  w[2] = z;
}
