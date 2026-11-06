import { reportGpuError } from './diagnostics';
import { VERTEX_LAYOUT_2D, type VertexLayout } from './mesh';

/**
 * Create a shader module and surface compile errors with file/line context. Compilation is
 * async in the browser; errors are logged as soon as they are known.
 */
export function createShaderModule(
  device: GPUDevice,
  code: string,
  label: string,
): GPUShaderModule {
  const module = device.createShaderModule({ code, label });
  module.getCompilationInfo().then((info) => {
    if (!info.messages.length) return;
    const lines = code.split('\n');
    for (const m of info.messages) {
      const src = lines[m.lineNum - 1] ?? '';
      const caret = `${' '.repeat(Math.max(0, m.linePos - 1))}^`;
      const text = `[wgsl] ${label}:${m.lineNum}:${m.linePos} ${m.type}: ${m.message}\n    ${src}\n    ${caret}`;
      if (m.type === 'error') reportGpuError(text);
      else console.warn(text);
    }
  });
  return module;
}

/**
 * Per-frame engine bindings for every material and drawable, in `@group(0)`:
 *
 * - `@binding(0) globals`: `logicalSize`, `targetSize` (scene target px), `time`, `dt`.
 * - `@binding(1) camera` (the camera block): `view`, `proj`, `view_proj` (world → clip),
 *   `camera_pos` (world eye position, w = 1), `viewport` (target px: x, y, w, h) and
 *   `view_index` (0 today; 0/1 per eye later).
 */
export const WGSL_GLOBALS = /* wgsl */ `
struct EngineGlobals {
  logicalSize: vec2f,
  targetSize: vec2f,
  time: f32,
  dt: f32,
  _pad: vec2f,
};
@group(0) @binding(0) var<uniform> globals: EngineGlobals;
struct EngineCamera {
  view: mat4x4f,
  proj: mat4x4f,
  view_proj: mat4x4f,
  camera_pos: vec4f,
  viewport: vec4f,
  view_index: u32,
  _pad: vec3u,
};
@group(0) @binding(1) var<uniform> camera: EngineCamera;
`;

/**
 * The lighting block, `@group(0) @binding(2)` (see `Lights` / `lights.ts`), in every material
 * and drawable prelude: `lights.ambient`, `lights.point_count`, `lights.sun_dir` (the way
 * the light travels), `lights.sun_color`, `lights.points[i]` (`position`, `radius`, `color`),
 * `lights.sun_view_proj` (world → sun clip), `lights.shadow_params` (bias, map texel size,
 * enabled, pad), `lights.fog` (rgb, density) and `lights.fog_range` (near, far, pad, pad).
 * The sun's shadow map (`texture_depth_2d`) and its comparison sampler sit at `@binding(3)`
 * and `@binding(4)`; with no shadow pass a 1×1 depth texture is bound there.
 *
 * Helpers a game may call or ignore: `engine_point_lights(normal, world_pos)` sums the point
 * lights' diffuse (Lambert × a smooth falloff that reaches zero at `radius`);
 * `engine_shadow(world_pos)` is the sun's visibility, 0..1 (3×3 PCF over the shadow map; 1
 * outside the map or when there is no shadow pass); `engine_fog(color, world_pos)` blends
 * `color` toward the fog colour by the distance to the camera (linear over `fog_range` when
 * `far > near`, else exponential past `near`; identity when density is 0);
 * `engine_lambert(normal, world_pos)` is ambient + sun Lambert × `engine_shadow` + the point
 * lights, so with the default block it returns `vec3f(1.0)` and `albedo * engine_lambert(...)`
 * is unlit.
 */
export const WGSL_LIGHTS = /* wgsl */ `
struct EnginePointLight {
  position: vec3f,
  radius: f32,
  color: vec3f,
  _pad: f32,
};
struct EngineLights {
  ambient: vec3f,
  point_count: u32,
  sun_dir: vec3f,
  _pad0: f32,
  sun_color: vec3f,
  _pad1: f32,
  points: array<EnginePointLight, 16>,
  sun_view_proj: mat4x4f,
  shadow_params: vec4f,
  fog: vec4f,
  fog_range: vec4f,
};
@group(0) @binding(2) var<uniform> lights: EngineLights;
@group(0) @binding(3) var engine_shadow_map: texture_depth_2d;
@group(0) @binding(4) var engine_shadow_sampler: sampler_comparison;
fn engine_point_lights(normal: vec3f, world_pos: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0u; i < lights.point_count; i++) {
    let l = lights.points[i];
    let to = l.position - world_pos;
    let d = length(to);
    let falloff = saturate(1.0 - d / max(l.radius, 1e-4));
    let diffuse = max(dot(normal, to / max(d, 1e-4)), 0.0);
    sum += l.color * (falloff * falloff * diffuse);
  }
  return sum;
}
fn engine_shadow(world_pos: vec3f) -> f32 {
  if (lights.shadow_params.z == 0.0) { return 1.0; }
  let clip = lights.sun_view_proj * vec4f(world_pos, 1.0);
  let ndc = clip.xyz / clip.w;
  if (any(abs(ndc.xy) > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return 1.0; }
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let depth = ndc.z - lights.shadow_params.x;
  let texel = lights.shadow_params.y;
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y)) * texel;
      lit += textureSampleCompareLevel(engine_shadow_map, engine_shadow_sampler, uv + o, depth);
    }
  }
  return lit / 9.0;
}
fn engine_fog(color: vec3f, world_pos: vec3f) -> vec3f {
  let density = lights.fog.w;
  if (density == 0.0) { return color; }
  let d = distance(world_pos, camera.camera_pos.xyz);
  let near = lights.fog_range.x;
  let far = lights.fog_range.y;
  let linear = saturate((d - near) / max(far - near, 1e-4)) * saturate(density);
  let expo = 1.0 - exp(-density * max(d - near, 0.0));
  let f = select(expo, linear, far > near);
  return mix(color, lights.fog.rgb, f);
}
fn engine_lambert(normal: vec3f, world_pos: vec3f) -> vec3f {
  let sun = lights.sun_color * max(dot(normal, -lights.sun_dir), 0.0) * engine_shadow(world_pos);
  return lights.ambient + sun + engine_point_lights(normal, world_pos);
}
`;

/** Hash / value-noise / fbm helpers available to every material and fullscreen pass. */
export const WGSL_NOISE = /* wgsl */ `
fn engine_hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn engine_hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
fn engine_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = engine_hash21(i);
  let b = engine_hash21(i + vec2f(1.0, 0.0));
  let c = engine_hash21(i + vec2f(0.0, 1.0));
  let d = engine_hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn engine_fbm(p: vec2f, octaves: i32) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < octaves; i++) {
    v += amp * engine_noise(q);
    q = q * 2.03 + vec2f(17.1, 9.2);
    amp *= 0.5;
  }
  return v;
}
fn engine_luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}
`;

/**
 * Prelude prepended to every material, generated per vertex layout. Declares `VertexIn` (the
 * layout's vertex fields plus the 28-float instance: 3×4 world matrix rows `m0..m2`,
 * `uvRect`, `tint`, `params`, `misc` = emissive, flags, size.xy), the default vertex entry
 * `vs_main`, the `VSOut` varyings (`flags` is the instance's flag bits: bit 0 set means
 * `receiveShadow: false`) and the `FragOut` MRT struct.
 *
 * Helpers: `engine_local_position(v)` / `engine_local_normal(v)` (object space, `vec3f` for
 * every layout), `engine_world_position(v)` and `engine_vertex(v)`; the lighting block and
 * `engine_lambert` / `engine_point_lights` from `WGSL_LIGHTS`.
 */
export function materialPrelude(layout: VertexLayout): string {
  return /* wgsl */ `
${WGSL_GLOBALS}
${WGSL_LIGHTS}
${WGSL_NOISE}
struct VertexIn {
${layout.wgslFields}
  @location(3) m0: vec4f,
  @location(4) m1: vec4f,
  @location(5) m2: vec4f,
  @location(6) uvRect: vec4f,
  @location(7) tint: vec4f,
  @location(8) params: vec4f,
  @location(9) misc: vec4f,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) local: vec2f,
  @location(2) color: vec4f,
  @location(3) params: vec4f,
  @location(4) world: vec2f,
  @location(5) emissive: f32,
  @location(6) size: vec2f,
  @location(7) normal: vec3f,
  @location(8) worldPos: vec3f,
  @location(9) @interpolate(flat) flags: u32,
};

struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

fn engine_local_position(v: VertexIn) -> vec3f {
  return ${layout.wgslPosition};
}

fn engine_local_normal(v: VertexIn) -> vec3f {
  return ${layout.wgslNormal};
}

fn engine_world_position(v: VertexIn) -> vec3f {
  let p = vec4f(engine_local_position(v), 1.0);
  return vec3f(dot(v.m0, p), dot(v.m1, p), dot(v.m2, p));
}

fn engine_vertex(v: VertexIn) -> VSOut {
  let world3 = engine_world_position(v);
  let world = world3.xy;
  let n = engine_local_normal(v);
  var o: VSOut;
  o.clip = camera.view_proj * vec4f(world3, 1.0);
  o.uv = mix(v.uvRect.xy, v.uvRect.zw, v.uv);
  o.local = v.uv;
  o.color = v.color * v.tint;
  o.params = v.params;
  o.world = world;
  o.emissive = v.misc.x;
  o.size = v.misc.zw;
  o.normal = normalize(vec3f(dot(v.m0.xyz, n), dot(v.m1.xyz, n), dot(v.m2.xyz, n)));
  o.worldPos = world3;
  o.flags = u32(v.misc.y);
  return o;
}

@vertex fn vs_main(v: VertexIn) -> VSOut {
  return engine_vertex(v);
}
`;
}

/** The material prelude for the 2D vertex layout (what every 2D material compiles with). */
export const WGSL_MATERIAL_PRELUDE = materialPrelude(VERTEX_LAYOUT_2D);

/** Prelude for fullscreen passes: `vs_fullscreen` emits one triangle covering the target. */
export const WGSL_FULLSCREEN_PRELUDE = /* wgsl */ `
${WGSL_NOISE}
struct FullscreenIn {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vs_fullscreen(@builtin(vertex_index) i: u32) -> FullscreenIn {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FullscreenIn;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;
