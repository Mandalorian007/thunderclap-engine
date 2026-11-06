/**
 * Motion blur (ws/post-3, object velocity since ws/post-4): a scene-size `DepthPass` that
 * averages `P.motionBlur.z` taps of the scene colour along each pixel's velocity, scaled by
 * `P.motionBlur.y`. The composite reads the result as its scene colour, so the blur sits
 * before bloom.
 *
 * The velocity: in `'object'` mode with a velocity target (`P.motionBlur.w`, `@binding(5)`,
 * `PostInputs.velocity`, uv motion since last frame) the pixel's own value, so a moving or
 * skinned object smears under a still camera; a pixel the target holds no motion for (zero:
 * nothing that writes velocity drew there) falls back to the camera: its depth reprojected
 * through `P.reproj` (current clip → previous clip, the matrix TAA keeps). Without the target,
 * and in `'camera'` mode, every pixel takes the camera's.
 */
import { mat4 } from '../core/math';
import { WGSL_POST_UNIFORMS } from './settings';

const clip = new Float32Array(3);

/**
 * The screen-space velocity (uv units, +x right, +y down) of the pixel at `(u, v)` with clip
 * depth `depth`, through `reproj` (current clip → previous clip): where the point was minus
 * where it is. Written to `out[0..1]`; the shader's `velocity` does the same.
 */
export function motionVelocity(
  out: { [i: number]: number },
  reproj: ArrayLike<number>,
  u: number,
  v: number,
  depth: number,
): typeof out {
  const w = mat4.transformPoint(clip, reproj, u * 2 - 1, 1 - v * 2, depth);
  if (w <= 0) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const pu = clip[0]! * 0.5 + 0.5;
  const pv = 0.5 - clip[1]! * 0.5;
  out[0] = pu - u;
  out[1] = pv - v;
  return out;
}

export const MOTION_BLUR_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var colorTex: texture_2d<f32>;
@group(0) @binding(5) var velocityTex: texture_2d<f32>;

fn velocity(uv: vec2f, d: f32) -> vec2f {
  let prev = P.reproj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  if (prev.w <= 0.0) {
    return vec2f(0.0);
  }
  let pn = prev.xy / prev.w;
  return vec2f(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5) - uv;
}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let uv = in.uv;
  let d = textureSampleLevel(depthTex, nearest, uv, 0u);
  var v = vec2f(0.0);
  if (P.motionBlur.w > 0.5) {
    // The target holds where the pixel is minus where it was; the gather is symmetric, but keep
    // the camera path's sign (where it was minus where it is).
    v = -textureSampleLevel(velocityTex, nearest, uv, 0.0).xy;
  }
  if (dot(v, v) < 1e-12) {
    v = velocity(uv, d);
  }
  var vel = v * P.motionBlur.y;
  // Cap the smear at a tenth of the screen so a teleport does not wipe the frame.
  let len = length(vel);
  if (len > 0.1) {
    vel *= 0.1 / len;
  }
  let n = i32(P.motionBlur.z);
  var sum = vec3f(0.0);
  for (var i = 0; i < n; i++) {
    let f = (f32(i) + 0.5) / f32(n) - 0.5;
    sum += textureSampleLevel(colorTex, linSamp, uv + vel * f, 0.0).rgb;
  }
  return vec4f(sum / f32(n), 1.0);
}
`;
