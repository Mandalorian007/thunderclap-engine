import { WGSL_DEPTH_VIEW } from './ao';
import { WGSL_POST_UNIFORMS } from './settings';

/** Bright-pass + 2× downsample into bloom mip 0. Karis-weighted to tame fireflies. */
export const PREFILTER_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var colorTex: texture_2d<f32>;
@group(0) @binding(3) var emissiveTex: texture_2d<f32>;

fn soft_threshold(c: vec3f) -> vec3f {
  let br = max(c.r, max(c.g, c.b));
  let knee = max(P.bloom.z, 1e-4);
  var rq = clamp(br - P.bloom.y + knee, 0.0, 2.0 * knee);
  rq = rq * rq / (4.0 * knee);
  let w = max(rq, br - P.bloom.y) / max(br, 1e-4);
  return c * w;
}

fn tap(uv: vec2f) -> vec3f {
  let c = textureSampleLevel(colorTex, samp, uv, 0.0).rgb;
  let e = textureSampleLevel(emissiveTex, samp, uv, 0.0).rgb;
  return min(e * P.bloom.w + soft_threshold(c), vec3f(64.0));
}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(colorTex));
  let a = tap(in.uv + t * vec2f(-1.0, -1.0));
  let b = tap(in.uv + t * vec2f(1.0, -1.0));
  let c = tap(in.uv + t * vec2f(-1.0, 1.0));
  let d = tap(in.uv + t * vec2f(1.0, 1.0));
  let wa = 1.0 / (1.0 + engine_luma(a));
  let wb = 1.0 / (1.0 + engine_luma(b));
  let wc = 1.0 / (1.0 + engine_luma(c));
  let wd = 1.0 / (1.0 + engine_luma(d));
  let sum = (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-4);
  return vec4f(sum, 1.0);
}
`;

/** 13-tap downsample (Jimenez 2014). */
export const DOWN_WGSL = /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

fn s(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = in.uv;
  let a = s(uv + t * vec2f(-2.0, -2.0));
  let b = s(uv + t * vec2f(0.0, -2.0));
  let c = s(uv + t * vec2f(2.0, -2.0));
  let d = s(uv + t * vec2f(-1.0, -1.0));
  let e = s(uv + t * vec2f(1.0, -1.0));
  let f = s(uv + t * vec2f(-2.0, 0.0));
  let g = s(uv);
  let h = s(uv + t * vec2f(2.0, 0.0));
  let i = s(uv + t * vec2f(-1.0, 1.0));
  let j = s(uv + t * vec2f(1.0, 1.0));
  let k = s(uv + t * vec2f(-2.0, 2.0));
  let l = s(uv + t * vec2f(0.0, 2.0));
  let m = s(uv + t * vec2f(2.0, 2.0));
  var o = (d + e + i + j) * 0.125;
  o += (a + b + g + f) * 0.03125;
  o += (b + c + h + g) * 0.03125;
  o += (f + g + l + k) * 0.03125;
  o += (g + h + m + l) * 0.03125;
  return vec4f(o, 1.0);
}
`;

/** 9-tap tent upsample; additively blended (× blend constant) onto the finer level. */
export const UP_WGSL = /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

fn s(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = in.uv;
  var o = s(uv) * 4.0;
  o += (s(uv + vec2f(-t.x, 0.0)) + s(uv + vec2f(t.x, 0.0)) + s(uv + vec2f(0.0, -t.y)) + s(uv + vec2f(0.0, t.y))) * 2.0;
  o += s(uv + vec2f(-t.x, -t.y)) + s(uv + vec2f(t.x, -t.y)) + s(uv + vec2f(-t.x, t.y)) + s(uv + vec2f(t.x, t.y));
  return vec4f(o / 16.0, 1.0);
}
`;

/** Screen-space god rays: radial march towards the light over bloom + a light disc. */
export const RAYS_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;

// Reference sample count: decay and weight are tuned per step at 64 samples. With fewer
// samples (P.quality.x) each step covers more distance, so decay and weight are rescaled.
const REF_SAMPLES: f32 = 64.0;

fn source(uv: vec2f) -> vec3f {
  let aspect = P.frame.y;
  var s = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb * P.raysColor.w;
  let d = length((uv - P.rays.xy) * vec2f(aspect, 1.0));
  let r = max(P.rays2.z, 1e-4);
  let disc = 1.0 - smoothstep(0.0, r, d);
  s += vec3f(disc * disc * P.rays2.w);
  // Outside the screen there is no bloom; keep the disc (light can sit off-screen).
  return s * P.raysColor.rgb;
}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  var coord = in.uv;
  // Small per-pixel jitter hides the step pattern.
  let jitter = engine_hash21(in.pos.xy + fract(P.frame.x) * 61.0);
  let n = i32(clamp(P.quality.x, 8.0, 64.0));
  let k = REF_SAMPLES / f32(n);
  let delta = (coord - P.rays.xy) * (P.rays2.x / f32(n));
  coord -= delta * jitter;
  let decay = pow(P.rays.w, k);
  let weight = P.rays2.y * k;
  var illum = 1.0;
  var acc = vec3f(0.0);
  for (var i = 0; i < n; i++) {
    coord -= delta;
    acc += source(coord) * illum * weight;
    illum *= decay;
  }
  return vec4f(acc * P.rays.z, 1.0);
}
`;

/** Final pass: combine, SSR, mist, bloom (× dirt), rays, white balance, exposure, tonemap, grade, vignette, dither, sRGB. */
export const COMPOSITE_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var colorTex: texture_2d<f32>;
@group(0) @binding(3) var emissiveTex: texture_2d<f32>;
@group(0) @binding(4) var bloomTex: texture_2d<f32>;
@group(0) @binding(5) var raysTex: texture_2d<f32>;
// Depth passes (ws/post-depth); bound to a placeholder and ignored while P.ao.x / P.dof.x are 0.
@group(0) @binding(6) var aoTex: texture_2d<f32>;
@group(0) @binding(7) var dofTex: texture_2d<f32>;
// Finishing (ws/post-2): the outline mask (placeholder while P.outline.x is 0) and the 3D LUT
// (a 1×1×1 placeholder while P.lut.x is 0).
@group(0) @binding(8) var outlineTex: texture_2d<f32>;
@group(0) @binding(9) var lutTex: texture_3d<f32>;
// Post 3 (ws/post-3): the half-res SSR term (placeholder while P.ssr.x is 0) and the lens-dirt
// map (placeholder while P.dirt.x is 0). TAA and motion blur replace colorTex with their result.
@group(0) @binding(10) var ssrTex: texture_2d<f32>;
@group(0) @binding(11) var dirtTex: texture_2d<f32>;

/** The scene term: colour × AO, blended toward the DoF result by CoC, plus emissive. */
fn scene_at(uv: vec2f) -> vec3f {
  var scene = textureSampleLevel(colorTex, samp, uv, 0.0).rgb;
  if (P.ao.x > 0.5) {
    scene *= textureSampleLevel(aoTex, samp, uv, 0.0).r;
  }
  if (P.dof.x > 0.5) {
    // Alpha holds the signed CoC in uv of the width; blend in the blur from half a scene px up.
    let blur = textureSampleLevel(dofTex, samp, uv, 0.0);
    let px = abs(blur.a) / P.frame.z;
    scene = mix(scene, blur.rgb, smoothstep(0.5, 2.0, px));
  }
  if (P.ssr.x > 0.5) {
    // Premultiplied by its fade and intensity in the SSR pass.
    scene += textureSampleLevel(ssrTex, samp, uv, 0.0).rgb;
  }
  return scene + textureSampleLevel(emissiveTex, samp, uv, 0.0).rgb;
}

fn aces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let uv = in.uv;
  let aspect = P.frame.y;
  let time = P.frame.x;
  let texel = vec2f(P.frame.z, P.frame.w);
  var c: vec3f;
  if (P.aberration.x > 0.0) {
    // Red and blue sampled either side of green along the radius, in scene px.
    let d = (uv - 0.5) * vec2f(aspect, 1.0);
    let r = length(d) / length(vec2f(aspect, 1.0) * 0.5);
    let dir = d / max(length(d), 1e-4);
    let amount = P.aberration.x * select(1.0, r * r, P.aberration.y > 0.5);
    let o = dir * amount * texel;
    c = vec3f(scene_at(uv + o).r, scene_at(uv).g, scene_at(uv - o).b);
  } else {
    c = scene_at(uv);
  }
  if (P.sharpen.x > 0.0) {
    // Unsharp mask: the pixel minus its 4-neighbour mean, clamped so dark rims never go negative.
    let blur = (scene_at(uv + vec2f(texel.x, 0.0)) + scene_at(uv - vec2f(texel.x, 0.0))
      + scene_at(uv + vec2f(0.0, texel.y)) + scene_at(uv - vec2f(0.0, texel.y))) * 0.25;
    c = max(c + (c - blur) * P.sharpen.x, vec3f(0.0));
  }
  if (P.outline.x > 0.5) {
    let edge = textureSampleLevel(outlineTex, samp, uv, 0.0).r;
    c = mix(c, P.outlineColor.rgb, clamp(edge * P.outlineColor.w, 0.0, 1.0));
  }

  var bloom = vec3f(0.0);
  if (P.enables.x > 0.5) {
    bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
    if (P.dirt.x > 0.5) {
      bloom *= 1.0 + textureSampleLevel(dirtTex, samp, uv, 0.0).rgb * P.dirt.y;
    }
  }

  // Floor mist: height mask × two drifting fbm layers, lit by nearby glow.
  if (P.enables.y > 0.5) {
    let span = max(P.fog.y - P.fog.x, 1e-3);
    let h = pow(clamp((uv.y - P.fog.x) / span, 0.0, 1.0), P.fog2.y);
    if (h > 0.0) {
      let p = vec2f(uv.x * aspect, uv.y * 2.2) * P.fog.z;
      let t = time * P.fog.w;
      // Fewer octaves (P.quality.y < 5) lose fine wisps; add back the dropped octaves' mean
      // (0.5 each) so the mist keeps its density.
      let o1 = i32(clamp(P.quality.y, 2.0, 5.0));
      let o2 = max(o1 - 1, 1);
      let m1 = 0.5 * (pow(0.5, f32(o1)) - pow(0.5, 5.0));
      let m2 = 0.5 * (pow(0.5, f32(o2)) - pow(0.5, 4.0));
      let n1 = engine_fbm(p + vec2f(t * 6.0, t * 0.7), o1) + m1;
      let n2 = engine_fbm(p * 1.9 + vec2f(-t * 9.0, t * 1.3) + vec2f(13.7, 4.1), o2) + m2;
      let wisps = smoothstep(0.2, 0.85, n1 * 0.6 + n2 * 0.55);
      let amount = clamp(h * P.fogColor.w * (0.3 + 1.1 * wisps), 0.0, 1.0);
      let lit = P.fogColor.rgb * (0.6 + 0.8 * wisps) + bloom * P.fog2.x;
      c = mix(c, lit, amount);
    }
  }

  c += bloom * P.bloom.x;
  if (P.enables.z > 0.5) {
    c += textureSampleLevel(raysTex, samp, uv, 0.0).rgb;
  }

  if (P.wb0.w > 0.5) {
    // White balance: a 3×3 matrix on the linear colour (ws/post-3).
    c = max(vec3f(dot(P.wb0.rgb, c), dot(P.wb1.rgb, c), dot(P.wb2.rgb, c)), vec3f(0.0));
  }
  c *= P.enables2.w;
  let tm = P.enables2.y;
  if (tm > 0.5 && tm < 1.5) {
    c = aces(c);
  } else if (tm > 1.5) {
    c = c / (1.0 + c);
  }
  c = clamp(c, vec3f(0.0), vec3f(1.0));

  if (P.enables2.x > 0.5) {
    c = c * P.gain.rgb + P.lift.rgb * (1.0 - c);
    c = pow(max(c, vec3f(0.0)), 1.0 / max(P.gamma.rgb, vec3f(1e-3)));
    let l = engine_luma(c);
    c = mix(vec3f(l), c, P.grade.x);
    c = (c - 0.5) * P.grade.y + 0.5;
    c = clamp(c, vec3f(0.0), vec3f(1.0));
  }

  if (P.lut.x > 0.5) {
    // Texel centres: the LUT's first and last texels sit half a texel in from 0 and 1.
    let looked = textureSampleLevel(lutTex, samp, c * P.lut.y + P.lut.w, 0.0).rgb;
    c = clamp(mix(c, looked, P.lut.z), vec3f(0.0), vec3f(1.0));
  }
  if (P.grain.x > 0.0) {
    let cell = floor(in.pos.xy / P.grain.y);
    let n = engine_hash21(cell + vec2f(P.grain.w * 61.0, P.grain.w * 29.0)) - 0.5;
    let response = 1.0 - P.grain.z * engine_luma(c);
    c = clamp(c + n * P.grain.x * response, vec3f(0.0), vec3f(1.0));
  }

  if (P.enables.w > 0.5) {
    let d = length((uv - 0.5) * vec2f(aspect, 1.0)) / length(vec2f(aspect, 1.0) * 0.5);
    let v = smoothstep(P.vignette.y, P.vignette.y + P.vignette.z, d) * P.vignette.x;
    c = mix(c, P.vignetteColor.rgb, v);
  }

  var outc = to_srgb(c);
  if (P.enables2.z > 0.5) {
    outc += (engine_hash21(in.pos.xy) - 0.5) / 255.0;
  }
  return vec4f(outc, 1.0);
}
`;

/**
 * FXAA 3.11, console preset (ws/post-2): one full-res pass over the composite's display-encoded
 * output. Luma from the four texel-corner taps and the centre; the blend direction from their
 * gradient, two taps half a px out and two more up to two px out along it, the longer pair
 * dropped when its luma leaves the local range. `P.fxaa.y` (subpixel) scales the blend;
 * `P.fxaa.z` (edgeThreshold) is the relative contrast below which the pixel is left alone.
 */
export const FXAA_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

const EDGE_SHARPNESS: f32 = 8.0;
const EDGE_THRESHOLD_MIN: f32 = 0.05;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = in.uv;
  let rgbM = tap(uv);
  let lumaM = engine_luma(rgbM);
  let lumaNw = engine_luma(tap(uv + vec2f(-0.5, -0.5) * t)) + 1.0 / 384.0;
  let lumaNe = engine_luma(tap(uv + vec2f(0.5, -0.5) * t));
  let lumaSw = engine_luma(tap(uv + vec2f(-0.5, 0.5) * t));
  let lumaSe = engine_luma(tap(uv + vec2f(0.5, 0.5) * t));
  let lumaMax = max(max(lumaNw, lumaNe), max(lumaSw, lumaSe));
  let lumaMin = min(min(lumaNw, lumaNe), min(lumaSw, lumaSe));
  let range = max(lumaMax, lumaM) - min(lumaMin, lumaM);
  if (range < max(EDGE_THRESHOLD_MIN, lumaMax * P.fxaa.z)) {
    return vec4f(rgbM, 1.0);
  }
  var dir = vec2f(-((lumaNw + lumaNe) - (lumaSw + lumaSe)), (lumaNw + lumaSw) - (lumaNe + lumaSe));
  let dir1 = dir / max(length(dir), 1e-5);
  let rgbN1 = tap(uv - dir1 * 0.5 * t);
  let rgbP1 = tap(uv + dir1 * 0.5 * t);
  let dirAbsMinTimesC = min(abs(dir1.x), abs(dir1.y)) * EDGE_SHARPNESS;
  let dir2 = clamp(dir1 / max(dirAbsMinTimesC, 1e-5), vec2f(-2.0), vec2f(2.0));
  let rgbN2 = tap(uv - dir2 * 2.0 * t);
  let rgbP2 = tap(uv + dir2 * 2.0 * t);
  let rgbA = (rgbN1 + rgbP1) * 0.5;
  let rgbB = (rgbN2 + rgbP2) * 0.25 + rgbA * 0.5;
  let lumaB = engine_luma(rgbB);
  let outside = lumaB < lumaMin || lumaB > lumaMax;
  let aa = select(rgbB, rgbA, outside);
  return vec4f(mix(rgbM, aa, clamp(P.fxaa.y, 0.0, 1.0)), 1.0);
}
`;

/**
 * Outline mask (ws/post-2): a Roberts cross over the linear depth and the normals from depth,
 * at the scene size, written as an edge strength 0..1 (r8unorm) the composite mixes toward
 * `outline.color` before fog. The cross is sampled `P.outline.y` scene px from the pixel.
 * Sky (depth 1) counts as very far, so silhouettes against it are edges.
 */
export const OUTLINE_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
${WGSL_DEPTH_VIEW}

const SKY_Z: f32 = 1.0e6;

/** View position of the texel under \`uv\` (w = raw depth). */
fn fetch(uv: vec2f, dim: vec2f) -> vec4f {
  let tuv = texel_uv(uv, dim);
  let d = textureSampleLevel(depthTex, nearest, tuv, 0u);
  return vec4f(view_pos(tuv, d), d);
}

fn zof(s: vec4f) -> f32 {
  return select(-s.z, SKY_Z, s.w >= 1.0);
}

/** Normal at the texel under \`uv\` from its +x and +y neighbours (a zero vector in the sky). */
fn normal_at(uv: vec2f, dim: vec2f, t: vec2f) -> vec3f {
  let p = fetch(uv, dim);
  let px = fetch(uv + vec2f(t.x, 0.0), dim);
  let py = fetch(uv + vec2f(0.0, t.y), dim);
  if (p.w >= 1.0 || px.w >= 1.0 || py.w >= 1.0) {
    return vec3f(0.0);
  }
  return normalize(cross(px.xyz - p.xyz, py.xyz - p.xyz));
}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(depthTex));
  let uv = texel_uv(in.uv, dim);
  let t = vec2f(max(P.outline.y, 0.5)) / dim;
  let a = fetch(uv - t, dim);
  let b = fetch(uv + t, dim);
  let c = fetch(uv + vec2f(t.x, -t.y), dim);
  let d = fetch(uv + vec2f(-t.x, t.y), dim);
  let za = zof(a);
  let zb = zof(b);
  let zc = zof(c);
  let zd = zof(d);
  let zmin = min(min(za, zb), min(zc, zd));
  if (zmin >= SKY_Z) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  // Depth: the cross's two differences relative to the nearest tap (so far edges count less).
  let dz = length(vec2f(za - zb, zc - zd)) / max(zmin, 1e-3);
  let th = max(P.outline.z, 1e-4);
  let edgeDepth = smoothstep(th, th * 2.0, dz);
  // Normals: the cross over the four taps' normals, in 1 - cos.
  let one = 1.0 / dim;
  let na = normal_at(uv - t, dim, one);
  let nb = normal_at(uv + t, dim, one);
  let nc = normal_at(uv + vec2f(t.x, -t.y), dim, one);
  let nd = normal_at(uv + vec2f(-t.x, t.y), dim, one);
  var dn = 0.0;
  if (dot(na, na) > 0.5 && dot(nb, nb) > 0.5) { dn = max(dn, 1.0 - dot(na, nb)); }
  if (dot(nc, nc) > 0.5 && dot(nd, nd) > 0.5) { dn = max(dn, 1.0 - dot(nc, nd)); }
  let tn = max(P.outline.w, 1e-4);
  let edgeNormal = smoothstep(tn, tn * 1.5, dn);
  let edge = max(edgeDepth, edgeNormal);
  return vec4f(edge, edge, edge, 1.0);
}
`;
