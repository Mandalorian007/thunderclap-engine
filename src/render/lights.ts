/**
 * The lighting block: what every material can read at `@group(0) @binding(2)` as
 * `EngineLights`, beside the globals and the camera. The engine supplies the uniforms; the
 * style (Lambert, toon, rim, nothing at all) is the game's WGSL. A game fills `frame.lights`
 * each frame; the renderer uploads it with the camera block of every view.
 *
 * The default block is unlit: ambient 1, no sun, no point lights, no shadow, no fog. A material
 * that multiplies by `engine_lambert(n, p)` therefore draws its albedo unchanged until the game
 * lights the scene, `engine_shadow` returns 1 and `engine_fog` returns its input, and materials
 * that never read the block are untouched.
 */

/** Point lights the block carries; `Lights.points` beyond this many are ignored. */
export const MAX_POINT_LIGHTS = 16;

/** Floats per point light in the block: position xyz, radius, colour rgb, pad (32 bytes). */
export const POINT_LIGHT_FLOATS = 8;

/** Float offset of `points[0]` inside the block (ambient, count, sun_dir, sun_color first). */
export const POINT_LIGHTS_OFFSET_FLOATS = 12;

/** Float offset of `sun_view_proj` (mat4x4f, world → sun clip) inside the block. */
export const SUN_VIEW_PROJ_OFFSET_FLOATS =
  POINT_LIGHTS_OFFSET_FLOATS + MAX_POINT_LIGHTS * POINT_LIGHT_FLOATS;

/** Float offset of `shadow_params` (bias, texel size, enabled, pad) inside the block. */
export const SHADOW_PARAMS_OFFSET_FLOATS = SUN_VIEW_PROJ_OFFSET_FLOATS + 16;

/** Float offset of `fog` (rgb, density) inside the block; `fog_range` (near, far) follows it. */
export const FOG_OFFSET_FLOATS = SHADOW_PARAMS_OFFSET_FLOATS + 4;

/** Floats in the WGSL `EngineLights` block (672 bytes). */
export const LIGHTS_BLOCK_FLOATS = FOG_OFFSET_FLOATS + 8;

/**
 * The sun's shadow map: an orthographic box centred on the rendering camera's position, looking
 * along `sun.dir`, `extent` world units of half-width, spanning `near`..`far` along the light
 * (measured from the camera position; defaults `-extent`..`extent`). `size` is the map's side
 * in texels (default 2048); `bias` is subtracted from the receiver's depth before the compare
 * (default `DEFAULT_SHADOW_BIAS`). Set `sun.shadow` to one of these and the renderer encodes a
 * shadow pass per view; leave it null and nothing changes.
 */
export interface SunShadow {
  size?: 1024 | 2048 | 4096;
  extent: number;
  near?: number;
  far?: number;
  bias?: number;
}

/** Depth bias of `SunShadow` when none is given (in 0..1 shadow-depth units). */
export const DEFAULT_SHADOW_BIAS = 0.0015;

/** A directional light: `dir` is the direction the light travels (sun → scene), any length. */
export interface DirectionalLight {
  dir: ArrayLike<number>;
  /** Linear RGB, HDR allowed. All zero is "no sun". */
  color: ArrayLike<number>;
  /** The sun's shadow map, or null/undefined for none (the default). */
  shadow?: SunShadow | null;
}

/** A point light: world position, linear RGB colour and the radius where it falls to zero. */
export interface PointLight {
  position: ArrayLike<number>;
  color: ArrayLike<number>;
  radius: number;
}

/**
 * Distance fog, applied by `engine_fog(color, world_pos)` from the distance between the fragment
 * and the camera. `density` 0 (the default) is no fog. With `far > near` the fog is linear:
 * nothing until `near`, fully `density` (clamped to 1) of `color` at `far`. With `far <= near`
 * it is exponential past `near`: `1 - exp(-density × distance)`.
 */
export interface Fog {
  /** Linear RGB the scene fades to. */
  color: ArrayLike<number>;
  density: number;
  near: number;
  far: number;
}

/**
 * What the renderer passes to `Lights.writeBlock` when a shadow pass rendered this view: the
 * sun's world → clip matrix (column-major, 16 floats), the depth bias and one texel in map uv.
 */
export interface ShadowUniforms {
  viewProj: ArrayLike<number>;
  bias: number;
  texelSize: number;
}

/**
 * The lights of one frame. Mutate the fields (or push into `points`) and keep the object; the
 * renderer calls `writeBlock` into its own uniform staging each view, so nothing allocates.
 */
export class Lights {
  /** Linear RGB added to everything the game's lighting touches. Default white (unlit). */
  readonly ambient = new Float32Array([1, 1, 1]);
  /** The one directional light. Default: no colour, so it contributes nothing; no shadow. */
  readonly sun: DirectionalLight = {
    dir: new Float32Array([0, -1, 0]),
    color: new Float32Array([0, 0, 0]),
    shadow: null,
  };
  /** Point lights, in order; the first `MAX_POINT_LIGHTS` reach the shader. */
  readonly points: PointLight[] = [];
  /** Distance fog. Default density 0: `engine_fog` is the identity. */
  readonly fog: Fog = { color: new Float32Array([0, 0, 0]), density: 0, near: 0, far: 0 };

  /** Back to the unlit default: ambient 1, no sun or shadow, `points` emptied, no fog. */
  reset(): this {
    this.ambient.fill(1);
    const s = this.sun;
    set3(s.dir, 0, -1, 0);
    set3(s.color, 0, 0, 0);
    s.shadow = null;
    this.points.length = 0;
    const f = this.fog;
    set3(f.color, 0, 0, 0);
    f.density = 0;
    f.near = 0;
    f.far = 0;
    return this;
  }

  /**
   * Write the `EngineLights` block into `out` at float offset `o` (`LIGHTS_BLOCK_FLOATS` floats):
   * `ambient` (0–2), `point_count` as u32 (3, through `u32`, a `Uint32Array` over the same
   * buffer as `out`, like `Camera.writeBlock`), normalised `sun_dir` (4–6), `sun_color` (8–10),
   * `MAX_POINT_LIGHTS` × (`position`, `radius`, `color`, pad), then `sun_view_proj`,
   * `shadow_params` (bias, texel size, enabled) from `shadow` (zeros and enabled 0 when null),
   * `fog` (rgb, density) and `fog_range` (near, far). Unused slots are zeroed. No allocation.
   */
  writeBlock(
    out: Float32Array,
    u32: Uint32Array,
    o = 0,
    shadow: ShadowUniforms | null = null,
  ): void {
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
    const sv = o + SUN_VIEW_PROJ_OFFSET_FLOATS;
    const sp = o + SHADOW_PARAMS_OFFSET_FLOATS;
    if (shadow) {
      out.fill(0, p, sv);
      const m = shadow.viewProj;
      for (let i = 0; i < 16; i++) out[sv + i] = m[i] ?? 0;
      out[sp] = shadow.bias;
      out[sp + 1] = shadow.texelSize;
      out[sp + 2] = 1;
      out[sp + 3] = 0;
    } else {
      out.fill(0, p, sp + 4);
    }
    const f = this.fog;
    const fc = f.color;
    const fo = o + FOG_OFFSET_FLOATS;
    out[fo] = fc[0] ?? 0;
    out[fo + 1] = fc[1] ?? 0;
    out[fo + 2] = fc[2] ?? 0;
    out[fo + 3] = f.density;
    out[fo + 4] = f.near;
    out[fo + 5] = f.far;
    out[fo + 6] = 0;
    out[fo + 7] = 0;
  }
}

function set3(v: ArrayLike<number>, x: number, y: number, z: number): void {
  const w = v as unknown as number[];
  w[0] = x;
  w[1] = y;
  w[2] = z;
}
