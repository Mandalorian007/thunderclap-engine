import { CORE_DRAWABLE_WGSL, CORE_VIEW_EXTRA_WGSL } from '../render/core/drawable';
import { WGSL_PBR } from '../render/pbr-wgsl';
import { WGSL_GLOBALS, WGSL_LIGHTS, WGSL_NOISE } from '../render/wgsl';
import { FX_DEPTH_WGSL } from './depth';
import {
  shadeWgsl,
  WATER_CORE_STRUCT_WGSL,
  WATER_FIELD_WGSL,
  WATER_PARAMS_WGSL,
} from './water-shade-wgsl';

export { WATER_CORE_FLOATS, WATER_MAX_WAVES, waterLookWgsl } from './water-shade-wgsl';

/**
 * The water shader: a plane in the engine's 3D vertex layout, no instance, group 1 = the
 * water's params block and its copy of the scene depth.
 *
 * Waves. Each layer is an analytic field with a closed-form gradient (`water_wave`):
 * `p = (x, z) * scale + dir * (t * speed)`, `a = p.x + 0.6 sin(1.3 p.y)`,
 * `b = 0.8 p.y + 0.5 sin(0.9 p.x)`, value `sin(a) cos(b)` in -1..1, and its derivatives by the
 * chain rule. The height is `level + displace * Σ amplitude_i * value_i` (the vertex shader
 * offsets y by it; `waterHeight` in `water.ts` is the same sum in TypeScript), and the normal
 * is `normalize(-slope.x, 1, -slope.z)` with `slope = Σ amplitude_i * scale_i * grad_i`, so
 * `amplitude` is the normal strength whether or not vertices move.
 *
 * Shading, all linear: the view ray's Schlick Fresnel (f0 0.02) times `fresnel` lerps the
 * refraction colour (`shallow` → `deep` by the linear depth below the surface over
 * `depth_fade`, from the depth copy) towards the reflection colour (a sky gradient between
 * `lights.fog.rgb`, or a pale haze without fog, at the horizon and a bluer zenith, darkened at
 * night like `Sky`); the sun adds a GGX lobe of `roughness` (`engine_d_ggx`,
 * `engine_v_smith_ggx`, `engine_f_schlick` from `WGSL_PBR`), which also goes to the emissive
 * target so bloom picks it up; foam (`foam.w` > 0) mixes `foam.rgb` in where the depth below the
 * surface is under `foam.w`, through a two-octave noise mask; the alpha ramps up from zero at
 * the shoreline over a quarter of `depth_fade` to `opacity`, then `engine_fog`.
 *
 * Depth copy. `misc.z` says whether `scene_depth` holds this frame's copy. Its texel is turned
 * into view-space z (`view_z_of`) and compared with the fragment's own: the difference is the
 * water depth along the ray. A texel within a sliver of the fragment's own depth is the water
 * surface itself (the copy was taken after a frame that drew this water into the same depth
 * buffer) and counts as no information: fully deep, no foam. Without a copy the surface is
 * deep everywhere, foam off.
 */
export const WATER_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
${WGSL_LIGHTS}
${WGSL_NOISE}
${WGSL_PBR}
${WATER_PARAMS_WGSL}@group(1) @binding(0) var<uniform> water: WaterParams;
@group(1) @binding(1) var scene_depth: texture_depth_2d;

struct VertexIn {
  @location(0) pos: vec3f,
  @location(10) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
};

struct WaterOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) view_z: f32,
};

struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

${WATER_FIELD_WGSL}@vertex fn vs(v: VertexIn) -> WaterOut {
  let t = water.misc.x;
  let f = water_field(v.pos.xz, t);
  let world = vec3f(v.pos.x, water.misc.w + water.surface.w + water.surface.z * f.x, v.pos.z);
  var o: WaterOut;
  o.clip = camera.view_proj * vec4f(world, 1.0);
  o.world = world;
  o.view_z = (camera.view * vec4f(world, 1.0)).z;
  return o;
}

// View-space z of a depth-buffer value under camera.proj (any perspective or ortho matrix).
fn view_z_of(d: f32) -> f32 {
  let p = camera.proj;
  let den = d * p[2][3] - p[2][2];
  return (p[3][2] - d * p[3][3]) / select(den, 1e-6, abs(den) < 1e-6);
}

@fragment fn fs(in: WaterOut) -> FragOut {
  let t = water.misc.x;
  let f = water_field(in.world.xz, t);
  let n = normalize(vec3f(-f.y, 1.0, -f.z));
  let v = normalize(camera.camera_pos.xyz - in.world);
  let n_dot_v = max(dot(n, v), 1e-4);
  let depth_fade = max(water.deep.w, 1e-3);

  // Water depth along the view ray, from the depth copy.
  var diff = depth_fade;
  var has_depth = false;
  if (water.misc.z > 0.5) {
    let dims = vec2i(textureDimensions(scene_depth));
    let px = clamp(vec2i(in.clip.xy), vec2i(0), dims - 1);
    let scene_z = view_z_of(textureLoad(scene_depth, px, 0));
    let own = abs(scene_z - in.view_z) < 0.002 * abs(in.view_z) + 1e-3;
    if (!own) {
      diff = max(in.view_z - scene_z, 0.0);
      has_depth = true;
    }
  }
  let deep_t = saturate(diff / depth_fade);
  let refraction = mix(water.shallow.rgb, water.deep.rgb, deep_t);

  // Reflection: the sky gradient the reflected ray would see.
  let r = reflect(-v, n);
  let has_fog = lights.fog.w > 0.0;
  let horizon = select(vec3f(0.62, 0.72, 0.9), lights.fog.rgb, has_fog);
  let zenith = horizon * vec3f(0.35, 0.55, 1.0);
  let to_sun = -lights.sun_dir;
  let has_sun = dot(lights.sun_color, vec3f(1.0)) > 0.0;
  let day = select(1.0, smoothstep(-0.12, 0.08, to_sun.y), has_sun);
  let sky = mix(horizon, zenith, pow(saturate(r.y), 0.6)) * mix(0.06, 1.0, day);

  let fresnel = water.surface.x * engine_f_schlick(vec3f(0.02), n_dot_v).x;
  var col = mix(refraction, sky, saturate(fresnel));

  // Sun highlight.
  var spec = vec3f(0.0);
  let n_dot_l = dot(n, to_sun);
  if (has_sun && n_dot_l > 0.0) {
    let rough = max(water.surface.y, ENGINE_MIN_ROUGHNESS);
    let a2 = rough * rough * rough * rough;
    let h = normalize(to_sun + v);
    let d = engine_d_ggx(saturate(dot(n, h)), a2);
    let vis = engine_v_smith_ggx(n_dot_v, n_dot_l, a2);
    let f_s = engine_f_schlick(vec3f(0.02), saturate(dot(v, h)));
    spec = lights.sun_color * (d * vis * ENGINE_PI * n_dot_l) * f_s;
  }
  col += spec;

  // Alpha: transparent at the shoreline, opacity further out.
  var alpha = water.shallow.w * smoothstep(0.0, 0.25 * depth_fade, diff);

  // Foam against geometry.
  var foam = 0.0;
  if (has_depth && water.foam.w > 0.0) {
    let edge = saturate(1.0 - diff / water.foam.w);
    let mask = 0.65 * engine_noise(in.world.xz * 5.0 + vec2f(t * 0.4, -t * 0.3))
      + 0.35 * engine_noise(in.world.xz * 13.0 - vec2f(t * 0.9, t * 0.5));
    foam = edge * smoothstep(0.42, 0.72, mask + 0.4 * edge);
    col = mix(col, water.foam.rgb, foam);
    alpha = max(alpha, foam * water.shallow.w);
  }

  col = engine_fog(col, in.world);
  var o: FragOut;
  o.color = vec4f(col * alpha, alpha);
  o.emissive = vec4f(spec * alpha, alpha);
  return o;
}
`;

/** Copies a depth texture into the water's own depth32float copy (one fullscreen triangle). */
export const WATER_DEPTH_COPY_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_depth_2d;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @builtin(frag_depth) f32 {
  return textureLoad(src, vec2i(pos.xy), 0);
}
`;

/**
 * Water on the render core (B5): the same wave field and params block, drawn from `CoreView`
 * (group 0) for each view, with the core's depth (binding 2) and, when the target is copied, its
 * colour (binding 3) as inputs.
 *
 * The water depth along the ray comes from the core's depth: the scene point under the pixel,
 * unprojected by the eye's inverse view-projection (`CoreViewExtra`), against the fragment's
 * own distance. Refraction (`opts.x` > 0) samples the scene colour behind the surface at a
 * pixel nudged by the wave normal (unless the nudged texel is in front of the water) and tints
 * it towards `deep` with depth; without it the tint is `shallow` → `deep` as on a `Renderer`.
 * Reflection marches the reflected ray `opts.y` steps over `opts.z` units in the eye's own
 * screen, and takes the scene colour where it passes behind the depth (a screen-space
 * reflection), else the sky gradient (`sky`). A 1×1 colour or depth input means none. The
 * pixel's viewport (each eye's half of a stereo target) comes from screen derivatives, so a
 * march never reads the other eye.
 */
export const WATER_CORE_WGSL = /* @__PURE__ */ waterCoreWgsl();

/**
 * `WATER_CORE_WGSL` with a game's own `water_shade` (`WaterOptions.shade`, B24) in place of the
 * engine's (which stays as `water_shade_engine`); none gives `WATER_CORE_WGSL` byte for byte.
 */
export function waterCoreWgsl(shade?: string): string {
  return /* wgsl */ `
${CORE_DRAWABLE_WGSL}
${CORE_VIEW_EXTRA_WGSL}
${FX_DEPTH_WGSL}
${WATER_PARAMS_WGSL}
${WATER_CORE_STRUCT_WGSL}@group(1) @binding(0) var<uniform> water: WaterParams;
@group(1) @binding(1) var<uniform> wc: WaterCore;
@group(1) @binding(2) var scene_depth: texture_depth_2d;
@group(1) @binding(3) var scene_color: texture_2d<f32>;
@group(1) @binding(4) var<storage, read> extras: array<CoreViewExtra>;

struct VertexIn {
  @location(0) pos: vec3f,
  @location(10) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
};

struct WaterOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) ndc: vec4f,
};

struct WaterFrag {
  @location(0) color: vec4f,
  @location(2) rough_metal: vec4f,
  @location(3) velocity: vec4f,
};

${WGSL_NOISE}
${WATER_FIELD_WGSL}
${shadeWgsl(shade)}
@vertex fn vs(v: VertexIn) -> WaterOut {
  let t = water.misc.x;
  let f = water_field(v.pos.xz, t);
  let world = vec3f(v.pos.x, water.misc.w + water.surface.w + water.surface.z * f.x, v.pos.z);
  var o: WaterOut;
  let rel = world - view.origin.xyz;
  o.clip = view.viewProj * vec4f(rel, 1.0);
  o.ndc = o.clip;
  o.world = world;
  return o;
}

@fragment fn fs(in: WaterOut) -> WaterFrag {
  let s = water_shade(in.clip.xy, in.ndc.xy / in.ndc.w, in.world, vec3f(0.0, 1.0, 0.0));
  var o: WaterFrag;
  o.color = s.color;
  o.rough_metal = s.rough_metal;
  o.velocity = s.velocity;
  return o;
}
`;
}
