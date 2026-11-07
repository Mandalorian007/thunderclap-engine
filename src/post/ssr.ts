/**
 * Screen-space reflections (ws/post-3): a half-res `DepthPass` that marches a view-space ray
 * from each pixel's position along the reflection of the eye direction about the normal
 * (derived from the depth as the AO pass does), `P.ssr.y` steps of `maxDistance / maxSteps`,
 * and takes the scene colour where the ray drops behind the depth buffer by less than
 * `P.ssr.z` (thickness). The term is faded toward the screen edges over `P.ssr2.z` uv, by the
 * march distance, and by the roughness term, and written as premultiplied colour with the
 * fade in alpha; the composite adds it to the scene before bloom.
 *
 * A ray point projects through the projection's x/y scale (`P.ao2.zw`), divided by the depth
 * under a perspective camera and not under an orthographic one (`P.quality.z`, ws/post-4),
 * where the eye ray is the view axis too.
 *
 * Per surface (ws/post-4): with the rough-metal target bound (`P.ssr2.w`, `@binding(5)`) the
 * pixel's roughness fades the term (`ssrRoughnessFade` against `roughnessCutoff`) and its
 * metalness weights it (`ssrSurfaceWeight`: Schlick Fresnel from F0 0.04 for a dielectric,
 * 1 for a metal). Without it every surface is a mirror at full weight, as in ws/post-3.
 */
import { WGSL_DEPTH_VIEW } from './ao';
import { WGSL_POST_UNIFORMS } from './settings';

/** Length of one march step (view units): the longest ray split into the step budget. */
export function ssrStep(maxDistance: number, maxSteps: number): number {
  return Math.max(1e-3, maxDistance) / Math.max(1, Math.round(maxSteps));
}

/**
 * Fade of a hit at `(u, v)` toward the screen border: 1 inside, falling to 0 at the edge over
 * `fadeEdges` uv on each side (0 = a hard cut). Same shape as the shader's `edge_fade`.
 */
export function ssrEdgeFade(u: number, v: number, fadeEdges: number): number {
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const w = Math.max(fadeEdges, 1e-6);
  const dist = Math.min(u, 1 - u, v, 1 - v);
  const x = Math.min(1, Math.max(0, dist / w));
  return x * x * (3 - 2 * x);
}

/** Reflection fade for a surface roughness under `cutoff`: 1 when mirror-smooth, 0 at the cutoff. */
export function ssrRoughnessFade(roughness: number, cutoff: number): number {
  const c = Math.max(cutoff, 1e-4);
  const x = Math.min(1, Math.max(0, roughness / c));
  return 1 - x * x;
}

/**
 * The weight of a reflection off a surface of `metalness` seen at `cosView` (the cosine
 * between the normal and the direction to the eye): Schlick's Fresnel with F0 0.04 for a
 * dielectric, mixed toward 1 for a metal. The shader's `surface_weight` does the same.
 */
export function ssrSurfaceWeight(metalness: number, cosView: number): number {
  const m = Math.min(1, Math.max(0, metalness));
  const c = Math.min(1, Math.max(0, cosView));
  const f = 0.04 + 0.96 * (1 - c) ** 5;
  return m + (1 - m) * f;
}

export const SSR_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var colorTex: texture_2d<f32>;
@group(0) @binding(5) var roughMetalTex: texture_2d<f32>;
${WGSL_DEPTH_VIEW}

fn surface_weight(metal: f32, cosView: f32) -> f32 {
  let f = 0.04 + 0.96 * pow(1.0 - clamp(cosView, 0.0, 1.0), 5.0);
  return mix(f, 1.0, clamp(metal, 0.0, 1.0));
}

fn fetch(uv: vec2f, dim: vec2f) -> vec4f {
  let tuv = texel_uv(uv, dim);
  let d = textureSampleLevel(depthTex, nearest, tuv, 0u);
  return vec4f(view_pos(tuv, d), d);
}

fn edge_fade(uv: vec2f) -> f32 {
  let w = max(P.ssr2.z, 1e-6);
  let dist = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return smoothstep(0.0, 1.0, clamp(dist / w, 0.0, 1.0));
}

fn project(p: vec3f) -> vec2f {
  let z = select(max(-p.z, 1e-4), 1.0, P.quality.z > 0.5);
  let ndc = vec2f(P.ao2.z * p.x, P.ao2.w * p.y) / z;
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(depthTex));
  let c = fetch(in.uv, dim);
  if (c.w >= 1.0) {
    return vec4f(0.0);
  }
  let uv = texel_uv(in.uv, dim);
  // Per-surface roughness and metalness when the target is bound; a mirror at full weight else.
  var roughMetal = vec2f(0.0, 1.0);
  if (P.ssr2.w > 0.5) {
    roughMetal = textureSampleLevel(roughMetalTex, nearest, uv, 0.0).rg;
  }
  let rough = clamp(roughMetal.x / max(P.ssr2.x, 1e-4), 0.0, 1.0);
  let roughFade = 1.0 - rough * rough;
  if (roughFade <= 0.0) {
    return vec4f(0.0);
  }
  let p = c.xyz;
  let t = 1.0 / dim;
  let pl = fetch(uv - vec2f(t.x, 0.0), dim).xyz;
  let pr = fetch(uv + vec2f(t.x, 0.0), dim).xyz;
  let pu = fetch(uv - vec2f(0.0, t.y), dim).xyz;
  let pd = fetch(uv + vec2f(0.0, t.y), dim).xyz;
  let dx = select(p - pl, pr - p, length(pr - p) < length(p - pl));
  let dy = select(p - pu, pd - p, length(pd - p) < length(p - pu));
  var n = normalize(cross(dx, dy));
  // The eye ray: toward the point under a perspective camera, the view axis under an ortho one.
  let v = select(normalize(p), vec3f(0.0, 0.0, -1.0), P.quality.z > 0.5);
  if (dot(n, -v) < 0.0) {
    n = -n;
  }
  var weight = 1.0;
  if (P.ssr2.w > 0.5) {
    weight = surface_weight(roughMetal.y, dot(n, -v));
  }
  let r = reflect(v, n);
  let steps = i32(P.ssr.y);
  let stepLen = P.ssr.w / f32(steps);
  var hitUv = vec2f(-1.0);
  var hitFade = 0.0;
  for (var i = 1; i <= steps; i++) {
    let q = p + r * (stepLen * f32(i));
    if (q.z > -1e-3) {
      break;
    }
    let suv = project(q);
    if (any(suv < vec2f(0.0)) || any(suv > vec2f(1.0))) {
      break;
    }
    let sd = textureSampleLevel(depthTex, nearest, suv, 0u);
    if (sd >= 1.0) {
      continue;
    }
    let sz = view_pos(suv, sd).z;
    // The ray point is behind the surface (further from the eye) by less than the thickness.
    let behind = sz - q.z;
    if (behind > 0.0 && behind < P.ssr.z) {
      hitUv = suv;
      hitFade = 1.0 - f32(i) / f32(steps);
      break;
    }
  }
  if (hitFade <= 0.0) {
    return vec4f(0.0);
  }
  let fade = hitFade * edge_fade(hitUv) * roughFade * weight;
  let col = textureSampleLevel(colorTex, linSamp, hitUv, 0.0).rgb;
  return vec4f(col * fade * P.ssr2.y, fade);
}
`;
