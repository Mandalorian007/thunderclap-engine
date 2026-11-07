/**
 * Temporal anti-aliasing (ws/post-3, on camera jitter since ws/post-4). The stack keeps two
 * scene-size `rgba16float` history textures and ping-pongs between them. While TAA runs the
 * stack declares `wantsJitter` and hands `Taa.jitter` (Halton 2, 3) to the renderer's
 * `setJitter` hook (ws/post-6), which offsets the projection of every camera it draws; the
 * frame arrives jittered by `PostInputs.view.jitter`. The resolve un-jitters it (samples the colour and the
 * depth `P.taa2.xy` uv along the jitter, bilinear), reprojects the history through `P.reproj`
 * (`view.previousViewProj × view.invViewProj`: this frame's jittered clip → last frame's
 * unjittered clip), clamps it to the 3×3 neighbourhood of the current colour (min/max box, or
 * mean ± σ) and blends it in by `P.taa.y` (feedback). `P.taa2.z` (reset) copies the current
 * frame instead: the first frame, and the one after a resize.
 *
 * Since ws/post-5 a frame with a velocity target reprojects each pixel by its own motion
 * (`uv - velocity`) instead, so moving and skinned objects keep their history, and drops the
 * history where last frame's depth or velocity there disagree (`TAA_WGSL`, `taaRejects`).
 *
 * Since ws/post-6 the history is read with a 5-tap Catmull-Rom filter by default
 * (`taa.historyFilter`, `P.taa3.z`; `taaCatmullRomWeights` is the CPU twin of its weights), so
 * a surface moving a fraction of a pixel a frame is not re-blurred by a bilinear tap each frame.
 */
import { type Mat4, mat4 } from '../core/math';
import { WGSL_DEPTH_VIEW } from './ao';
import { WGSL_POST_UNIFORMS } from './settings';

/** Van der Corput radical inverse in `base` of `index` (1-based). */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** Highest history weight: above it the image smears and never settles. */
export const TAA_MAX_FEEDBACK = 0.98;

/** The history weight the resolve uses for `feedback`: clamped to 0..`TAA_MAX_FEEDBACK`. */
export function taaBlendWeight(feedback: number): number {
  if (!Number.isFinite(feedback)) return 0;
  return Math.min(TAA_MAX_FEEDBACK, Math.max(0, feedback));
}

/**
 * The matrix TAA and motion blur reproject by: this frame's clip space to the previous
 * frame's, `out = prevViewProj × invViewProj`. Identity when the camera has not moved.
 */
export function taaReprojection(
  out: Mat4,
  prevViewProj: ArrayLike<number>,
  invViewProj: ArrayLike<number>,
): Mat4 {
  return mat4.multiply(out, prevViewProj, invViewProj);
}

/** The jitter sequence. `PostStack.taa` is one; the stack feeds it to `Renderer.setJitter`. */
export class Taa {
  /** Points in the cycle (8 or 16). */
  readonly samples: 8 | 16;
  private readonly out: [number, number] = [0, 0];

  constructor(samples: 8 | 16 = 8) {
    this.samples = samples;
  }

  /**
   * The sub-pixel offset for `frame` in pixel units (each in -0.5..0.5): Halton (2, 3) over
   * the cycle, centred. The returned pair is reused; copy it to keep it.
   */
  jitter(frame: number): [number, number] {
    const i = (Math.max(0, Math.floor(frame)) % this.samples) + 1;
    this.out[0] = halton(i, 2) - 0.5;
    this.out[1] = halton(i, 3) - 0.5;
    return this.out;
  }
}

/**
 * The Catmull-Rom weights of the four texels around a sample at fraction `f` (0..1) past the
 * second one: `out[0..3]` for the texels at -1, 0, 1, 2. They sum to 1; at `f = 0` they are
 * (0, 1, 0, 0), so a sample on a texel centre reads that texel exactly. The resolve folds the
 * middle two into one bilinear tap per axis and drops the four corner taps (5 taps for 16).
 */
export function taaCatmullRomWeights(
  f: number,
  out: [number, number, number, number] = [0, 0, 0, 0],
): [number, number, number, number] {
  out[0] = f * (-0.5 + f * (1 - 0.5 * f));
  out[1] = 1 + f * f * (-2.5 + 1.5 * f);
  out[2] = f * (0.5 + f * (2 - 1.5 * f));
  out[3] = f * f * (-0.5 + 0.5 * f);
  return out;
}

/** Format of the TAA history aux pair (ws/post-5): velocity (uv) in xy, linear depth in z, 1 in w. */
export const TAA_AUX_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * The CPU twin of the resolve's history rejection (ws/post-5): true when the history sample
 * (velocity `hv` in uv, linear depth `hz`) belongs to a different surface than the pixel
 * (velocity `v`, linear depth `z`) on a `width × height` target: the depths differ by more
 * than `depthReject` of the nearer one, or the velocities by more than `velocityReject` px.
 */
export function taaRejects(
  v: readonly [number, number],
  z: number,
  hv: readonly [number, number],
  hz: number,
  width: number,
  height: number,
  depthReject: number,
  velocityReject: number,
): boolean {
  const dz = Math.abs(hz - z) / Math.max(Math.min(hz, z), 1e-4);
  const dv = Math.hypot((v[0] - hv[0]) * width, (v[1] - hv[1]) * height);
  return dz > depthReject || dv > velocityReject;
}

/**
 * The resolve pass (`DepthPass`, two targets: the HDR resolve and its `TAA_AUX_FORMAT` aux;
 * four textures: `@binding(4)` the current scene colour, `@binding(5)` the previous resolve,
 * `@binding(6)` the velocity target (the scene colour stands in without one; unread),
 * `@binding(7)` the previous aux).
 *
 * Velocity reprojection (ws/post-5, `P.taa2.w`): the pixel takes the velocity of the nearest
 * depth in its 3×3 (so an edge moves with the object in front) and finds its history at
 * `uv - velocity`; where the target holds no motion it falls back to `P.reproj`. The history
 * is dropped when its aux (last frame's velocity and linear depth there) disagrees with the
 * pixel's by more than `P.taa3.x` (relative depth) or `P.taa3.y` (px). Without it the resolve
 * is the ws/post-4 one; the aux is written either way so a switch finds a valid one.
 */
export const TAA_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var colorTex: texture_2d<f32>;
@group(0) @binding(5) var historyTex: texture_2d<f32>;
@group(0) @binding(6) var velocityTex: texture_2d<f32>;
@group(0) @binding(7) var auxTex: texture_2d<f32>;
${WGSL_DEPTH_VIEW}

struct TaaOut {
  @location(0) color: vec4f,
  @location(1) aux: vec4f,
};

fn cur(uv: vec2f) -> vec3f { return textureSampleLevel(colorTex, nearest, uv, 0.0).rgb; }

fn hist(uv: vec2f) -> vec3f { return textureSampleLevel(historyTex, linSamp, uv, 0.0).rgb; }

// The history at uv through a Catmull-Rom filter (ws/post-6): the 4×4 texels around it, the
// middle two of each axis folded into one bilinear tap and the four corners dropped, 5 taps.
// Normalised by the taps' weight, since the corners are gone.
fn hist_catmull_rom(uv: vec2f) -> vec3f {
  let dim = vec2f(textureDimensions(historyTex));
  let p = uv * dim;
  let t1 = floor(p - 0.5) + 0.5;
  let f = p - t1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (t1 - 1.0) / dim;
  let t3 = (t1 + 2.0) / dim;
  let t12 = (t1 + w2 / w12) / dim;
  let a = w12.x * w0.y;
  let b = w0.x * w12.y;
  let c = w12.x * w12.y;
  let d = w3.x * w12.y;
  let e = w12.x * w3.y;
  let sum = hist(vec2f(t12.x, t0.y)) * a + hist(vec2f(t0.x, t12.y)) * b + hist(t12) * c +
    hist(vec2f(t3.x, t12.y)) * d + hist(vec2f(t12.x, t3.y)) * e;
  return sum / (a + b + c + d + e);
}

@fragment fn fs_main(in: FullscreenIn) -> TaaOut {
  let dim = vec2f(textureDimensions(colorTex));
  let t = 1.0 / dim;
  // The camera drew this frame shifted by the jitter (+x right, +y down): what belongs at this
  // pixel sits that far along in the colour and the depth. Un-jitter by sampling there.
  let uv = in.uv + P.taa2.xy;
  let c = textureSampleLevel(colorTex, linSamp, uv, 0.0).rgb;
  let d = textureSampleLevel(depthTex, nearest, uv, 0u);
  let velocityMode = P.taa2.w > 0.5;
  // 3×3 neighbourhood bounds of the current colour around the un-jittered point, and (velocity
  // mode) the nearest depth's texel.
  var mn = vec3f(1e9);
  var mx = vec3f(-1e9);
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var nearD = d;
  var nearUv = uv;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = uv + vec2f(f32(x), f32(y)) * t;
      let s = cur(o);
      mn = min(mn, s);
      mx = max(mx, s);
      m1 += s;
      m2 += s * s;
      if (velocityMode) {
        let sd = textureSampleLevel(depthTex, nearest, o, 0u);
        if (sd < nearD) {
          nearD = sd;
          nearUv = o;
        }
      }
    }
  }
  let mean = m1 / 9.0;
  if (P.taa.w > 0.5) {
    let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
    mn = max(mn, mean - sigma);
    mx = min(mx, mean + sigma);
  }
  // The target holds where the point is minus where it was (uv).
  var vel = vec2f(0.0);
  if (velocityMode) {
    vel = textureSampleLevel(velocityTex, nearest, nearUv, 0.0).xy;
  }
  let z = linear_depth(uv, d);
  var out = c;
  if (P.taa2.z < 0.5) {
    var puv = in.uv - vel;
    var ahead = true;
    if (dot(vel, vel) < 1e-12) {
      // The jittered frame's clip position of that depth sample: P.reproj starts from it.
      let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
      let prev = P.reproj * ndc;
      let pn = prev.xy / max(prev.w, 1e-6);
      puv = vec2f(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5);
      ahead = prev.w > 0.0;
    }
    var keep = ahead && all(puv >= vec2f(0.0)) && all(puv <= vec2f(1.0));
    if (keep && velocityMode) {
      let a = textureSampleLevel(auxTex, nearest, puv, 0.0);
      let dz = abs(a.z - z) / max(min(a.z, z), 1e-4);
      let dv = length((vel - a.xy) * dim);
      keep = a.w > 0.5 && dz <= P.taa3.x && dv <= P.taa3.y;
    }
    if (keep) {
      var hs: vec3f;
      if (P.taa3.z > 0.5) {
        hs = hist_catmull_rom(puv);
      } else {
        hs = hist(puv);
      }
      let h = clamp(hs, mn, mx);
      out = mix(c, h, P.taa.y);
    }
  }
  // Unsharp against the neighbourhood mean, so the blend's softness comes back as detail.
  out = max(out + (out - mean) * P.taa.z, vec3f(0.0));
  return TaaOut(vec4f(out, 1.0), vec4f(vel, z, 1.0));
}
`;
