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

/** Final pass: combine, mist, bloom, rays, exposure, tonemap, grade, vignette, dither, sRGB. */
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
  var c = scene + textureSampleLevel(emissiveTex, samp, uv, 0.0).rgb;

  var bloom = vec3f(0.0);
  if (P.enables.x > 0.5) {
    bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
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
