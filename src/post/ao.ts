/**
 * Screen-space ambient occlusion (ws/post-depth): a half-res pass over the scene depth, then a
 * 4×4 depth-aware blur. The composite multiplies the result into the scene colour before bloom.
 *
 * Positions come back from depth through `P.invProj`; normals from the smaller of the two depth
 * differences on each axis (so creases keep their edge). 12 (`PostQuality.aoSamples`) spiral
 * samples per pixel, rotated per pixel by interleaved-gradient noise, weighted by the cosine
 * to the normal and a smooth falloff inside `ao.radius`.
 */
import { WGSL_POST_UNIFORMS } from './settings';

/** Shared by both AO passes and DoF: depth → view-space position. */
export const WGSL_DEPTH_VIEW = /* wgsl */ `
fn view_pos(uv: vec2f, depth: f32) -> vec3f {
  let ndc = vec3f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth);
  let p = P.invProj * vec4f(ndc, 1.0);
  return p.xyz / p.w;
}
fn linear_depth(uv: vec2f, depth: f32) -> f32 {
  return -view_pos(uv, depth).z;
}
/** The centre of the depth texel under \`uv\`: positions must be rebuilt where the depth was read. */
fn texel_uv(uv: vec2f, dim: vec2f) -> vec2f {
  return (floor(clamp(uv, vec2f(0.0), vec2f(0.9999)) * dim) + 0.5) / dim;
}
`;

export const AO_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
${WGSL_DEPTH_VIEW}

/** Depth at the texel under \`uv\` and the view position of that texel's centre (w = depth). */
fn fetch(uv: vec2f, dim: vec2f) -> vec4f {
  let tuv = texel_uv(uv, dim);
  let d = textureSampleLevel(depthTex, nearest, tuv, 0u);
  return vec4f(view_pos(tuv, d), d);
}

/** Interleaved-gradient noise (Jimenez 2014), 0..1 per output pixel. */
fn ign(px: vec2f) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(depthTex));
  let c = fetch(in.uv, dim);
  if (c.w >= 1.0) {
    return vec4f(1.0);
  }
  let p = c.xyz;
  let uv = texel_uv(in.uv, dim);
  // Normal from the closer neighbour on each axis (one depth texel).
  let t = 1.0 / dim;
  let pl = fetch(uv - vec2f(t.x, 0.0), dim).xyz;
  let pr = fetch(uv + vec2f(t.x, 0.0), dim).xyz;
  let pu = fetch(uv - vec2f(0.0, t.y), dim).xyz;
  let pd = fetch(uv + vec2f(0.0, t.y), dim).xyz;
  var dx = pr - p;
  if (abs(pl.z - p.z) < abs(pr.z - p.z)) { dx = p - pl; }
  var dy = pu - p;
  if (abs(pd.z - p.z) < abs(pu.z - p.z)) { dy = p - pd; }
  let n = normalize(cross(dx, dy));

  let radius = P.ao.y;
  let z = -p.z;
  // World radius projected to uv: proj scale / depth, halved for the -1..1 → 0..1 range.
  let ruv = vec2f(P.ao2.z, P.ao2.w) * radius / max(z, 1e-3) * 0.5;
  let count = i32(P.ao2.y);
  let rot = ign(in.pos.xy) * 6.2831853;
  var occ = 0.0;
  for (var i = 0; i < count; i++) {
    let a = (f32(i) + 0.5) / f32(count);
    let ang = rot + a * 6.2831853 * 3.0;
    let suv = uv + vec2f(cos(ang), sin(ang)) * ruv * sqrt(a);
    let s = fetch(suv, dim);
    if (s.w >= 1.0) { continue; }
    let sp = s.xyz;
    let v = sp - p;
    let vv = dot(v, v);
    let vn = dot(v, n) - P.ao.w;
    let falloff = max(0.0, 1.0 - vv / (radius * radius));
    occ += max(0.0, vn * inverseSqrt(vv + 1e-4)) * falloff;
  }
  occ = occ / f32(count) * 2.0 * P.ao.z;
  let ao = pow(clamp(1.0 - occ, 0.0, 1.0), P.ao2.x);
  return vec4f(ao, ao, ao, 1.0);
}
`;

/** 4×4 depth-aware blur of the AO term (half res in, half res out). */
export const AO_BLUR_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var aoTex: texture_2d<f32>;
${WGSL_DEPTH_VIEW}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(depthTex));
  let uv = in.uv;
  let t = 1.0 / vec2f(textureDimensions(aoTex));
  let dc = textureSampleLevel(depthTex, nearest, uv, 0u);
  if (dc >= 1.0) {
    return vec4f(1.0);
  }
  let zc = linear_depth(texel_uv(uv, dim), dc);
  var sum = 0.0;
  var wsum = 0.0;
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      let o = vec2f(f32(x) - 1.5, f32(y) - 1.5) * t;
      let suv = uv + o;
      let zs = linear_depth(texel_uv(suv, dim), textureSampleLevel(depthTex, nearest, suv, 0u));
      let w = 1.0 / (1.0 + 16.0 * abs(zs - zc) / max(zc, 1e-3));
      sum += textureSampleLevel(aoTex, nearest, suv, 0.0).r * w;
      wsum += w;
    }
  }
  let ao = sum / max(wsum, 1e-4);
  return vec4f(ao, ao, ao, 1.0);
}
`;
