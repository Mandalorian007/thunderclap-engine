import { CORE_DRAWABLE_WGSL, CORE_VIEW_EXTRA_WGSL } from '../render/core/drawable';
import { FX_DEPTH_WGSL } from './depth';

/**
 * ws/core-decals (B6): the decal shaders on the render core. Same instance layout and params
 * block as the `Renderer` path (`decals-wgsl.ts`, `DECAL_INSTANCE_FLOATS`), but the view comes
 * from the core's `CoreView` at group 0 (one bundle serves every eye of a cull group), the
 * inverse view-projection from `CoreViewExtras` by `view.index`, positions are relative to
 * `view.origin`, and the fragment writes one colour target.
 */
const DECAL_CORE_COMMON = /* wgsl */ `
${CORE_DRAWABLE_WGSL}
${CORE_VIEW_EXTRA_WGSL}
${FX_DEPTH_WGSL}
struct DecalParams {
  inv_view_proj: mat4x4f, // unused on the core (the view's extras carry it)
  // normal_bias, fade_edge, offset, multiply (1 = multiply blend)
  shape: vec4f,
  // fade at age 0, fade at age 1, pad, pad
  fade: vec4f,
};
@group(1) @binding(0) var<uniform> decal: DecalParams;
@group(1) @binding(1) var decal_sampler: sampler;
@group(1) @binding(2) var decal_tex: texture_2d<f32>;
@group(1) @binding(3) var scene_depth: texture_depth_2d;
@group(1) @binding(4) var<storage, read> extras: array<CoreViewExtra>;

struct DecalVertex {
  @location(0) position: vec3f,
  @location(3) m0: vec4f,
  @location(4) m1: vec4f,
  @location(5) m2: vec4f,
  @location(6) uv_rect: vec4f,
  @location(7) color: vec4f,
  @location(8) life: vec4f,
};

struct DecalFrame {
  origin: vec3f,
  ax: vec3f,
  ay: vec3f,
  az: vec3f,
  normal: vec3f,
};

fn decal_frame(m0: vec4f, m1: vec4f, m2: vec4f) -> DecalFrame {
  var f: DecalFrame;
  let s0 = 1.0 / max(dot(m0.xyz, m0.xyz), 1e-12);
  let s1 = 1.0 / max(dot(m1.xyz, m1.xyz), 1e-12);
  let s2 = 1.0 / max(dot(m2.xyz, m2.xyz), 1e-12);
  f.ax = m0.xyz * s0;
  f.ay = m1.xyz * s1;
  f.az = m2.xyz * s2;
  f.origin = -(f.ax * m0.w + f.ay * m1.w + f.az * m2.w);
  f.normal = normalize(m2.xyz);
  return f;
}

fn decal_out(c: vec4f, alpha: f32) -> vec4f {
  if (decal.shape.w > 0.5) {
    return vec4f(mix(vec3f(1.0), c.rgb, alpha), 1.0);
  }
  return vec4f(c.rgb, alpha);
}

fn decal_age_fade(life: vec4f) -> f32 {
  return mix(decal.fade.x, decal.fade.y, clamp(life.x, 0.0, 1.0));
}
`;

/**
 * Depth-projected box decal on the core: the unit box drawn back faces only (so a camera inside
 * it still covers the screen), the world point under each pixel unprojected from the core's
 * depth with this view's inverse view-projection, mapped into the box, rejected outside it, and
 * faded by the box's z edge, the surface's facing and the age.
 */
export const DECAL_CORE_BOX_WGSL = /* wgsl */ `${DECAL_CORE_COMMON}
struct BoxOut {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec4f,
  @location(1) @interpolate(flat) m0: vec4f,
  @location(2) @interpolate(flat) m1: vec4f,
  @location(3) @interpolate(flat) m2: vec4f,
  @location(4) @interpolate(flat) uv_rect: vec4f,
  @location(5) @interpolate(flat) color: vec4f,
  @location(6) @interpolate(flat) life: vec4f,
  @location(7) @interpolate(flat) normal: vec3f,
};

@vertex fn vs(v: DecalVertex) -> BoxOut {
  let f = decal_frame(v.m0, v.m1, v.m2);
  let world = f.origin + f.ax * v.position.x + f.ay * v.position.y + f.az * v.position.z;
  var o: BoxOut;
  o.clip = view.viewProj * vec4f(world - view.origin.xyz, 1.0);
  o.ndc = o.clip;
  o.m0 = v.m0;
  o.m1 = v.m1;
  o.m2 = v.m2;
  o.uv_rect = v.uv_rect;
  o.color = v.color;
  o.life = v.life;
  o.normal = f.normal;
  return o;
}

@fragment fn fs(in: BoxOut) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(scene_depth));
  let px = clamp(vec2i(in.clip.xy), vec2i(0), dims - vec2i(1));
  let d = textureLoad(scene_depth, px, 0);
  if (fx_depth_is_far(d)) { discard; }
  // The fragment's own NDC: this eye's viewport, whichever half of the target it covers.
  let ndc = in.ndc.xy / in.ndc.w;
  let h = extras[view.index].invViewProj * vec4f(ndc, d, 1.0);
  let rel = h.xyz / h.w;
  let w4 = vec4f(rel + view.origin.xyz, 1.0);
  let local = vec3f(dot(in.m0, w4), dot(in.m1, w4), dot(in.m2, w4));
  if (any(abs(local) > vec3f(0.5))) { discard; }
  // Surface normal from the reconstructed position, turned towards the eye.
  let n0 = normalize(cross(dpdx(rel), dpdy(rel)));
  let n = select(-n0, n0, dot(n0, view.position.xyz - rel) >= 0.0);
  if (dot(n, in.normal) < decal.shape.x) { discard; }
  let uv = in.uv_rect.xy + vec2f(local.x + 0.5, 0.5 - local.y) * in.uv_rect.zw;
  let c = textureSample(decal_tex, decal_sampler, uv) * in.color;
  let edge = smoothstep(0.0, max(decal.shape.y, 1e-4), (0.5 - abs(local.z)) * 2.0);
  return decal_out(c, c.a * edge * decal_age_fade(in.life));
}
`;

/**
 * Surface quad decal on the core: the unit quad in the decal's frame, lifted along its normal by
 * `decal.shape.z`, depth tested against the core's depth (no depth read).
 */
export const DECAL_CORE_QUAD_WGSL = /* wgsl */ `${DECAL_CORE_COMMON}
struct QuadOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
  @location(2) @interpolate(flat) life: vec4f,
};

@vertex fn vs(v: DecalVertex) -> QuadOut {
  let f = decal_frame(v.m0, v.m1, v.m2);
  let world = f.origin + f.ax * v.position.x + f.ay * v.position.y + f.normal * decal.shape.z;
  var o: QuadOut;
  o.clip = view.viewProj * vec4f(world - view.origin.xyz, 1.0);
  o.uv = v.uv_rect.xy + vec2f(v.position.x + 0.5, 0.5 - v.position.y) * v.uv_rect.zw;
  o.color = v.color;
  o.life = v.life;
  return o;
}

@fragment fn fs(in: QuadOut) -> @location(0) vec4f {
  let c = textureSample(decal_tex, decal_sampler, in.uv) * in.color;
  return decal_out(c, c.a * decal_age_fade(in.life));
}
`;
