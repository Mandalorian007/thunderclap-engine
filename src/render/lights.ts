/**
 * The lighting block: what every material can read at `@group(0) @binding(2)` as
 * `EngineLights`, beside the globals and the camera. The engine supplies the uniforms; the
 * style (Lambert, toon, rim, nothing at all) is the game's WGSL. A game fills `frame.lights`
 * each frame; the renderer uploads it with the camera block of every view.
 *
 * The default block is unlit: ambient 1, no sun, no point or spot lights, no shadow, no fog. A material
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

/**
 * Float offset of `spot_count` (u32) inside the block; `sun_layers` (u32, the sun's layer mask)
 * is the next float, then two pad words.
 */
export const LAYERS_OFFSET_FLOATS = FOG_OFFSET_FLOATS + 8;

/** Float offset of `point_layers` (`array<vec4u, 4>`: one u32 mask per point light slot). */
export const POINT_LAYERS_OFFSET_FLOATS = LAYERS_OFFSET_FLOATS + 4;

/** Spot lights the block carries; `Lights.spots` beyond this many are ignored. */
export const MAX_SPOT_LIGHTS = 8;

/**
 * Floats per spot light: position xyz, radius, direction xyz, cos(outerAngle), colour rgb,
 * cos(innerAngle), layers (u32), three pad words (64 bytes).
 */
export const SPOT_LIGHT_FLOATS = 16;

/** Float offset of `spots[0]` inside the block. */
export const SPOT_LIGHTS_OFFSET_FLOATS = POINT_LAYERS_OFFSET_FLOATS + MAX_POINT_LIGHTS;

/** Floats in the WGSL `EngineLights` block (1264 bytes). */
export const LIGHTS_BLOCK_FLOATS = SPOT_LIGHTS_OFFSET_FLOATS + MAX_SPOT_LIGHTS * SPOT_LIGHT_FLOATS;

/** The layer mask a light has when `layers` is unset: every layer. */
export const ALL_LIGHT_LAYERS = 0xffffffff;

/**
 * Instance flag bits (`VertexIn.misc.y`, `VSOut.flags`): bit 0 is "does not receive shadow";
 * bits 1..23 carry the instance's low `INSTANCE_LAYER_BITS` layer bits, so a fragment shader
 * can mask lights against them (`engine_instance_layers(in.flags)` in WGSL). The float that
 * carries the flags holds 24 integer bits exactly, so layers above bit 22 are invisible to lights
 * (they still cull against the camera).
 */
export const INSTANCE_LAYER_SHIFT = 1;
export const INSTANCE_LAYER_BITS = 23;
const INSTANCE_LAYER_MASK = (1 << INSTANCE_LAYER_BITS) - 1;

/** The instance flags float for `receiveShadow` and a layer mask (see `INSTANCE_LAYER_SHIFT`). */
export function packInstanceFlags(receiveShadow: boolean, layers: number): number {
  return (receiveShadow ? 0 : 1) | ((layers & INSTANCE_LAYER_MASK) << INSTANCE_LAYER_SHIFT);
}

/**
 * The cone factor of a spot light, 0..1, mirrored by `engine_spot_cone` in WGSL: 1 inside
 * `innerAngle` of the axis, 0 outside `outerAngle`, a smooth Hermite step between. All three
 * arguments are cosines (`cosTheta` = dot of the light's direction with the direction to the
 * fragment); with `cosInner <= cosOuter` the edge is hard.
 */
export function spotCone(cosTheta: number, cosOuter: number, cosInner: number): number {
  const t = Math.min(1, Math.max(0, (cosTheta - cosOuter) / Math.max(cosInner - cosOuter, 1e-4)));
  return t * t * (3 - 2 * t);
}

/**
 * The sun's shadow map: an orthographic box centred on the rendering camera's position, looking
 * along `sun.direction`, `extent` world units of half-width, spanning `near`..`far` along the light
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

/**
 * A directional light: `dir` is the direction the light travels (sun → scene), any length.
 * `Lights.sun` is a `SunLight`, which spells it `direction` like `SpotLight`.
 */
export interface DirectionalLight {
  dir: ArrayLike<number>;
  /** Linear RGB, HDR allowed. All zero is "no sun". */
  color: ArrayLike<number>;
  /** The sun's shadow map, or null/undefined for none (the default). */
  shadow?: SunShadow | null;
  /** Layer mask (u32): the light reaches instances whose `layers` share a bit. Default all. */
  layers?: number;
}

/**
 * `Lights.sun`: a `DirectionalLight` whose direction is spelled `direction`, like
 * `SpotLight.direction` (ws/api-render).
 */
export interface SunLight extends Omit<DirectionalLight, 'dir'> {
  /** The direction the light travels (sun → scene), any length. */
  direction: ArrayLike<number>;
}

/** A point light: world position, linear RGB colour and the radius where it falls to zero. */
export interface PointLight {
  position: ArrayLike<number>;
  color: ArrayLike<number>;
  radius: number;
  /** Layer mask (u32): the light reaches instances whose `layers` share a bit. Default all. */
  layers?: number;
}

/**
 * A spot light: a point light with a cone. `direction` is the way the light travels (any
 * length); the cone is full inside `innerAngle` radians of it and gone outside `outerAngle`,
 * with a smooth step between (`spotCone`). `radius` is the distance falloff, as for points.
 */
export interface SpotLight {
  position: ArrayLike<number>;
  direction: ArrayLike<number>;
  color: ArrayLike<number>;
  radius: number;
  innerAngle: number;
  outerAngle: number;
  /** Layer mask (u32): the light reaches instances whose `layers` share a bit. Default all. */
  layers?: number;
}

/**
 * Distance fog, applied by `engine_fog(color, world_pos)` from the distance between the fragment
 * and the camera. `density` 0 (the default) is no fog. With `far > near` the fog is linear:
 * nothing until `near`, fully `density` (clamped to 1) of `color` at `far`. With `far <= near`
 * it is exponential past `near`: `1 - exp(-density × distance)`.
 *
 * `Lights.fog` is the only depth fog. Post's `mist` (`MistSettings`, formerly `fog`) is a
 * screen-space haze composited on top of the finished scene; the two stack, neither replaces
 * the other.
 */
export interface DistanceFog {
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
  /**
   * The one directional light. Default: travelling straight down with no colour, so it
   * contributes nothing; no shadow.
   */
  readonly sun: SunLight = createSun();
  /** Point lights, in order; the first `MAX_POINT_LIGHTS` reach the shader. */
  readonly points: PointLight[] = [];
  /** Spot lights, in order; the first `MAX_SPOT_LIGHTS` reach the shader. */
  readonly spots: SpotLight[] = [];
  /** Distance fog. Default density 0: `engine_fog` is the identity. */
  readonly fog: DistanceFog = { color: new Float32Array([0, 0, 0]), density: 0, near: 0, far: 0 };

  /** Back to the unlit default: ambient 1, no sun or shadow, `points` and `spots` emptied, no fog. */
  reset(): this {
    this.ambient.fill(1);
    const s = this.sun;
    set3(s.direction, 0, -1, 0);
    set3(s.color, 0, 0, 0);
    s.shadow = null;
    s.layers = undefined;
    this.points.length = 0;
    this.spots.length = 0;
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
   * `fog` (rgb, density) and `fog_range` (near, far), then `spot_count` and `sun_layers` (u32),
   * `point_layers` (one u32 per point slot) and `MAX_SPOT_LIGHTS` × (`position`, `radius`,
   * normalised `direction`, cos `outerAngle`, `color`, cos `innerAngle`, `layers`, pad). Unset
   * masks are `ALL_LIGHT_LAYERS`. Unused slots are zeroed. No allocation.
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
    const d = this.sun.direction;
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
    const ns = Math.min(this.spots.length, MAX_SPOT_LIGHTS);
    const lo = o + LAYERS_OFFSET_FLOATS;
    u32[lo] = ns;
    u32[lo + 1] = (this.sun.layers ?? ALL_LIGHT_LAYERS) >>> 0;
    u32[lo + 2] = 0;
    u32[lo + 3] = 0;
    const pl = o + POINT_LAYERS_OFFSET_FLOATS;
    for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
      u32[pl + i] = i < n ? (this.points[i]!.layers ?? ALL_LIGHT_LAYERS) >>> 0 : 0;
    }
    let sp2 = o + SPOT_LIGHTS_OFFSET_FLOATS;
    for (let i = 0; i < ns; i++, sp2 += SPOT_LIGHT_FLOATS) {
      const l = this.spots[i]!;
      const pos = l.position;
      const dir = l.direction;
      const col = l.color;
      out[sp2] = pos[0] ?? 0;
      out[sp2 + 1] = pos[1] ?? 0;
      out[sp2 + 2] = pos[2] ?? 0;
      out[sp2 + 3] = l.radius;
      const ddx = dir[0] ?? 0;
      const ddy = dir[1] ?? 0;
      const ddz = dir[2] ?? 0;
      const dl = Math.hypot(ddx, ddy, ddz);
      const dk = dl > 0 ? 1 / dl : 0;
      out[sp2 + 4] = ddx * dk;
      out[sp2 + 5] = ddy * dk;
      out[sp2 + 6] = ddz * dk;
      out[sp2 + 7] = Math.cos(l.outerAngle);
      out[sp2 + 8] = col[0] ?? 0;
      out[sp2 + 9] = col[1] ?? 0;
      out[sp2 + 10] = col[2] ?? 0;
      out[sp2 + 11] = Math.cos(l.innerAngle);
      u32[sp2 + 12] = (l.layers ?? ALL_LIGHT_LAYERS) >>> 0;
      out[sp2 + 13] = 0;
      out[sp2 + 14] = 0;
      out[sp2 + 15] = 0;
    }
    out.fill(0, sp2, o + LIGHTS_BLOCK_FLOATS);
  }
}

/** The default sun: travelling straight down, no colour, no shadow. */
function createSun(): SunLight {
  return {
    direction: new Float32Array([0, -1, 0]),
    color: new Float32Array([0, 0, 0]),
    shadow: null,
    layers: undefined,
  };
}

function set3(v: ArrayLike<number>, x: number, y: number, z: number): void {
  const w = v as unknown as number[];
  w[0] = x;
  w[1] = y;
  w[2] = z;
}
