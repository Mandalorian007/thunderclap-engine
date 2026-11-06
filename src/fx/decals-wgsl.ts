import { WGSL_GLOBALS } from '../render/wgsl';

/**
 * Shared by both decal shaders: the params block, the atlas, the depth copy and the instance
 * decode. An instance carries the world → local 3×4 matrix of its unit box (rows `m0..m2`,
 * each `xyz` a scaled axis and `w` the translation), its atlas rect (`u0, v0, du, dv`), its
 * colour and `life` (`x` = age / lifetime, 0 when the decal lives forever). `decal_frame`
 * inverts the rows back into the three world axes (scaled) and the origin, which the vertex
 * shader needs to place the box or quad.
 */
const DECAL_COMMON = /* wgsl */ `
struct DecalParams {
  inv_view_proj: mat4x4f,
  // normal_bias, fade_edge, offset, multiply (1 = multiply blend)
  shape: vec4f,
  // fade at age 0, fade at age 1, pad, pad
  fade: vec4f,
};
@group(1) @binding(0) var<uniform> decal: DecalParams;
@group(1) @binding(1) var decal_sampler: sampler;
@group(1) @binding(2) var decal_tex: texture_2d<f32>;
@group(1) @binding(3) var scene_depth: texture_depth_2d;

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

// The rows of the world → local matrix are axis_i / scale_i and -dot(axis_i, origin) / scale_i:
// local → world is origin + sum(axis_i * scale_i * local_i).
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

struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

fn decal_out(c: vec4f, alpha: f32) -> FragOut {
  var o: FragOut;
  if (decal.shape.w > 0.5) {
    o.color = vec4f(mix(vec3f(1.0), c.rgb, alpha), 1.0);
    o.emissive = vec4f(1.0);
  } else {
    o.color = vec4f(c.rgb, alpha);
    o.emissive = vec4f(0.0);
  }
  return o;
}

fn decal_age_fade(life: vec4f) -> f32 {
  return mix(decal.fade.x, decal.fade.y, clamp(life.x, 0.0, 1.0));
}
`;

/**
 * Depth-projected box decal. The vertex shader places the unit box; the fragment shader
 * reconstructs the world position under each pixel from the previous frame's depth copy
 * (`inv_view_proj × (ndc, depth)`), maps it into the box, rejects what falls outside, samples
 * the atlas by the local xy and fades by the local z edge, the surface's facing (its normal
 * from `dpdx`/`dpdy` of the reconstructed position against the box axis) and the age.
 */
export const WGSL_DECAL_BOX = /* wgsl */ `${WGSL_GLOBALS}${DECAL_COMMON}
struct BoxOut {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) m0: vec4f,
  @location(1) @interpolate(flat) m1: vec4f,
  @location(2) @interpolate(flat) m2: vec4f,
  @location(3) @interpolate(flat) uv_rect: vec4f,
  @location(4) @interpolate(flat) color: vec4f,
  @location(5) @interpolate(flat) life: vec4f,
  @location(6) @interpolate(flat) normal: vec3f,
};

@vertex fn vs(v: DecalVertex) -> BoxOut {
  let f = decal_frame(v.m0, v.m1, v.m2);
  let world = f.origin + f.ax * v.position.x + f.ay * v.position.y + f.az * v.position.z;
  var o: BoxOut;
  o.clip = camera.view_proj * vec4f(world, 1.0);
  o.m0 = v.m0;
  o.m1 = v.m1;
  o.m2 = v.m2;
  o.uv_rect = v.uv_rect;
  o.color = v.color;
  o.life = v.life;
  o.normal = f.normal;
  return o;
}

@fragment fn fs(in: BoxOut) -> FragOut {
  let dims = vec2i(textureDimensions(scene_depth));
  let px = clamp(vec2i(in.clip.xy), vec2i(0), dims - vec2i(1));
  let d = textureLoad(scene_depth, px, 0);
  if (d >= 1.0) { discard; }
  let vp = camera.viewport;
  let ndc = vec2f(
    (in.clip.x - vp.x) / vp.z * 2.0 - 1.0,
    1.0 - (in.clip.y - vp.y) / vp.w * 2.0);
  let wp = decal.inv_view_proj * vec4f(ndc, d, 1.0);
  let world = wp.xyz / wp.w;
  let w4 = vec4f(world, 1.0);
  let local = vec3f(dot(in.m0, w4), dot(in.m1, w4), dot(in.m2, w4));
  if (any(abs(local) > vec3f(0.5))) { discard; }
  // Surface normal from the reconstructed position, turned towards the camera.
  let n0 = normalize(cross(dpdx(world), dpdy(world)));
  let n = select(-n0, n0, dot(n0, camera.camera_pos.xyz - world) >= 0.0);
  if (dot(n, in.normal) < decal.shape.x) { discard; }
  let uv = in.uv_rect.xy + vec2f(local.x + 0.5, 0.5 - local.y) * in.uv_rect.zw;
  let c = textureSample(decal_tex, decal_sampler, uv) * in.color;
  let edge = smoothstep(0.0, max(decal.shape.y, 1e-4), (0.5 - abs(local.z)) * 2.0);
  return decal_out(c, c.a * edge * decal_age_fade(in.life));
}
`;

/**
 * Surface quad decal: the unit quad (local xy, z = 0) placed in the decal's frame and lifted
 * along its normal by `decal.shape.z`; the fragment is the atlas × colour × age fade.
 */
export const WGSL_DECAL_QUAD = /* wgsl */ `${WGSL_GLOBALS}${DECAL_COMMON}
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
  o.clip = camera.view_proj * vec4f(world, 1.0);
  o.uv = v.uv_rect.xy + vec2f(v.position.x + 0.5, 0.5 - v.position.y) * v.uv_rect.zw;
  o.color = v.color;
  o.life = v.life;
  return o;
}

@fragment fn fs(in: QuadOut) -> FragOut {
  let c = textureSample(decal_tex, decal_sampler, in.uv) * in.color;
  return decal_out(c, c.a * decal_age_fade(in.life));
}
`;

/** Copies the scene depth into the decals' own `depth32float` texture (fullscreen triangle). */
export const WGSL_DECAL_DEPTH_COPY = /* wgsl */ `
@group(0) @binding(0) var src: texture_depth_2d;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @builtin(frag_depth) f32 {
  return textureLoad(src, vec2i(pos.xy), 0);
}
`;
