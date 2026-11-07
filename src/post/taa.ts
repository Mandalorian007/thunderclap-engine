/**
 * Temporal anti-aliasing (ws/post-3, on camera jitter since ws/post-4). The stack keeps two
 * scene-size `rgba16float` history textures and ping-pongs between them. While TAA runs the
 * stack declares `wantsJitter`, so the renderer offsets each camera's projection by the
 * `Camera.setJitter` the stack drives from `Taa.jitter` (Halton 2, 3); the frame arrives
 * jittered by `PostInputs.view.jitter`. The resolve un-jitters it (samples the colour and the
 * depth `P.taa2.xy` uv along the jitter, bilinear), reprojects the history through `P.reproj`
 * (`view.previousViewProj × view.invViewProj`: this frame's jittered clip → last frame's
 * unjittered clip), clamps it to the 3×3 neighbourhood of the current colour (min/max box, or
 * mean ± σ) and blends it in by `P.taa.y` (feedback). `P.taa2.z` (reset) copies the current
 * frame instead: the first frame, and the one after a resize.
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

/** The jitter sequence. `PostStack.taa` is one; the stack feeds it to `Camera.setJitter`. */
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
 * The resolve pass (`DepthPass`, HDR, two textures: `@binding(4)` the current scene colour,
 * `@binding(5)` the previous resolve).
 */
export const TAA_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var colorTex: texture_2d<f32>;
@group(0) @binding(5) var historyTex: texture_2d<f32>;
${WGSL_DEPTH_VIEW}

fn cur(uv: vec2f) -> vec3f { return textureSampleLevel(colorTex, nearest, uv, 0.0).rgb; }

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(colorTex));
  let t = 1.0 / dim;
  // The camera drew this frame shifted by the jitter (+x right, +y down): what belongs at this
  // pixel sits that far along in the colour and the depth. Un-jitter by sampling there.
  let uv = in.uv + P.taa2.xy;
  let c = textureSampleLevel(colorTex, linSamp, uv, 0.0).rgb;
  // 3×3 neighbourhood bounds of the current colour around the un-jittered point.
  var mn = vec3f(1e9);
  var mx = vec3f(-1e9);
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let s = cur(uv + vec2f(f32(x), f32(y)) * t);
      mn = min(mn, s);
      mx = max(mx, s);
      m1 += s;
      m2 += s * s;
    }
  }
  let mean = m1 / 9.0;
  if (P.taa.w > 0.5) {
    let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
    mn = max(mn, mean - sigma);
    mx = min(mx, mean + sigma);
  }
  var out = c;
  if (P.taa2.z < 0.5) {
    let d = textureSampleLevel(depthTex, nearest, uv, 0u);
    // The jittered frame's clip position of that depth sample: P.reproj starts from it.
    let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
    let prev = P.reproj * ndc;
    let pn = prev.xy / max(prev.w, 1e-6);
    let puv = vec2f(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5);
    let inside = prev.w > 0.0 && all(puv >= vec2f(0.0)) && all(puv <= vec2f(1.0));
    if (inside) {
      let h = clamp(textureSampleLevel(historyTex, linSamp, puv, 0.0).rgb, mn, mx);
      out = mix(c, h, P.taa.y);
    }
  }
  // Unsharp against the neighbourhood mean, so the blend's softness comes back as detail.
  out = max(out + (out - mean) * P.taa.z, vec3f(0.0));
  return vec4f(out, 1.0);
}
`;
