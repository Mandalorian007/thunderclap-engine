import { WGSL_GLOBALS, WGSL_LIGHTS, WGSL_NOISE } from '../render/wgsl';
import { materialConstName } from './compile';
import type { MaterialCodeTable } from './spec';

/**
 * What a model's fragment shade function gets (`ModelSurface` in WGSL):
 *
 * - `world_pos`, `normal` (world, unit), `local_pos` (model space, after the part's motion);
 * - `base`: the resolved colour (material, own rgb or instance colour), times the baked `shade`;
 * - `emissive`: the material's emissive (default its colour) times the unit's glow;
 * - `glow`: the unit's glow (0 for a part without one);
 * - `material`: the material code (compare with the generated `MODEL_MAT_<NAME>` constants);
 * - `user`: the instance's free vec4.
 *
 * A shade function is `fn model_shade(s: ModelSurface) -> ModelShaded` returning the colour
 * and emissive written to the scene's two targets; it may call `engine_lambert`,
 * `engine_fog`, `engine_shadow` and `engine_fbm`.
 */
export const MODEL_SURFACE_WGSL = /* wgsl */ `
struct ModelSurface {
  world_pos: vec3f,
  normal: vec3f,
  local_pos: vec3f,
  base: vec3f,
  emissive: vec3f,
  glow: f32,
  material: u32,
  user: vec4f,
};
struct ModelShaded {
  color: vec3f,
  emissive: vec3f,
};
`;

/**
 * The default shade: the surface colour lit by the frame's lights (Lambert) and fogged; the
 * glow goes to the emissive target (the final image is colour + emissive + bloom).
 */
export const MODEL_DEFAULT_SHADE_WGSL = /* wgsl */ `
fn model_shade(s: ModelSurface) -> ModelShaded {
  let lit = s.base * engine_lambert(s.normal, s.world_pos);
  return ModelShaded(engine_fog(lit, s.world_pos), s.emissive);
}
`;

/** `const MODEL_MAT_<NAME>: u32 = <code>u;` for every material of `table`. */
export function materialConstantsWgsl(table: MaterialCodeTable): string {
  return Object.keys(table)
    .map((name, i) => `const ${materialConstName(name)}: u32 = ${i}u;`)
    .join('\n');
}

const BODY = /* wgsl */ `
struct ModelInst {
  m0: vec4f,
  m1: vec4f,
  m2: vec4f,
  values: vec4f,
  rates: vec4f,
  color: vec4f,
  color2: vec4f,
  user: vec4f,
  slot_info: vec4f,
};
struct ModelFrame {
  dt: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
// Per vertex, 3 vec4: position + material, normal + shade, rgb + colour mode.
@group(1) @binding(0) var<storage, read> model_verts: array<vec4f>;
@group(1) @binding(1) var<storage, read> model_insts: array<ModelInst>;
@group(1) @binding(2) var<storage, read> model_order: array<u32>;
// Per unit, 4 vec4: kind/axis/channel/glow channel, pivot/p0, p1/glow scale/min/max, wraps.
@group(1) @binding(3) var<storage, read> model_units: array<vec4f>;
// Per material, 2 vec4: colour, emissive (w 1 when declared).
@group(1) @binding(4) var<storage, read> model_mats: array<vec4f>;
@group(1) @binding(5) var<uniform> model_frame: ModelFrame;

struct ModelPose {
  angle: f32,
  offset: f32,
  glow: f32,
};

fn model_channel(inst: ModelInst, wraps: vec4f, c: u32) -> f32 {
  var v = inst.values[c] + inst.rates[c] * model_frame.dt;
  let w = wraps[c];
  if (w > 0.0) { v = v - floor(v / w) * w; }
  return v;
}

// The CPU twin is evaluateUnit (compile.ts): keep them in step.
fn model_unit_pose(inst: ModelInst, u: u32) -> ModelPose {
  let r0 = model_units[u * 4u];
  let r1 = model_units[u * 4u + 1u];
  let r2 = model_units[u * 4u + 2u];
  let wraps = model_units[u * 4u + 3u];
  var pose = ModelPose(0.0, 0.0, 0.0);
  let kind = u32(r0.x);
  if (kind != 0u) {
    let v = model_channel(inst, wraps, u32(r0.z));
    let p0 = r1.w;
    let p1 = r2.x;
    let t = clamp(v, 0.0, 1.0);
    switch (kind) {
      case 1u: { pose.angle = v * p0; }
      case 2u: { pose.angle = p0 * sin(v + p1); }
      case 3u: { pose.angle = p0 + (p1 - p0) * t; }
      case 4u: { pose.offset = p0 + (p1 - p0) * t; }
      default: { pose.offset = p0 * sin(v + p1); }
    }
  }
  if (r0.w < 0.0) {
    pose.glow = r2.z;
  } else {
    pose.glow = clamp(model_channel(inst, wraps, u32(r0.w)) * r2.y, r2.z, r2.w);
  }
  return pose;
}

fn model_rotate(p: vec3f, axis: u32, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  if (axis == 0u) { return vec3f(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
  if (axis == 1u) { return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
  return vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

fn model_axis(axis: u32) -> vec3f {
  return select(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), axis == 1u), vec3f(1.0, 0.0, 0.0), axis == 0u);
}

struct ModelVaryings {
  @builtin(position) clip: vec4f,
  @location(0) world_pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) local_pos: vec3f,
  @location(3) base: vec3f,
  @location(4) emissive: vec3f,
  @location(5) @interpolate(flat) material: u32,
  @location(6) @interpolate(flat) glow: f32,
  @location(7) @interpolate(flat) user: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ModelVaryings {
  let inst = model_insts[model_order[ii]];
  let u = u32(inst.slot_info.x);
  let a = model_verts[vi * 3u];
  let b = model_verts[vi * 3u + 1u];
  let c = model_verts[vi * 3u + 2u];
  let pose = model_unit_pose(inst, u);
  let r0 = model_units[u * 4u];
  let pivot = model_units[u * 4u + 1u].xyz;
  let axis = u32(r0.y);
  var p = model_rotate(a.xyz - pivot, axis, pose.angle) + pivot + model_axis(axis) * pose.offset;
  let n = model_rotate(b.xyz, axis, pose.angle);
  let wp = vec3f(dot(inst.m0, vec4f(p, 1.0)), dot(inst.m1, vec4f(p, 1.0)), dot(inst.m2, vec4f(p, 1.0)));
  let wn = vec3f(dot(inst.m0.xyz, n), dot(inst.m1.xyz, n), dot(inst.m2.xyz, n));
  let mat = u32(a.w);
  let mode = u32(c.w);
  var base = model_mats[mat * 2u].rgb;
  if (mode == 1u) { base = c.rgb; }
  if (mode == 2u) { base = inst.color.rgb; }
  if (mode == 3u) { base = inst.color2.rgb; }
  let em = model_mats[mat * 2u + 1u];
  let emissive = select(base, em.rgb, em.w > 0.0) * pose.glow;
  var out: ModelVaryings;
  out.clip = camera.view_proj * vec4f(wp, 1.0);
  out.world_pos = wp;
  out.normal = wn;
  out.local_pos = p;
  out.base = base * b.w;
  out.emissive = emissive;
  out.material = mat;
  out.glow = pose.glow;
  out.user = inst.user;
  return out;
}

struct ModelTargets {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

@fragment
fn fs(v: ModelVaryings) -> ModelTargets {
  let s = ModelSurface(v.world_pos, normalize(v.normal), v.local_pos, v.base, v.emissive, v.glow, v.material, v.user);
  let o = model_shade(s);
  return ModelTargets(vec4f(o.color, 1.0), vec4f(o.emissive, 1.0));
}
`;

/** The whole model shader for `table`, with `shade` (a `model_shade` function) or the default. */
export function modelShaderWgsl(table: MaterialCodeTable, shade?: string): string {
  return [
    WGSL_GLOBALS,
    WGSL_LIGHTS,
    WGSL_NOISE,
    MODEL_SURFACE_WGSL,
    materialConstantsWgsl(table),
    shade ?? MODEL_DEFAULT_SHADE_WGSL,
    BODY,
  ].join('\n');
}
