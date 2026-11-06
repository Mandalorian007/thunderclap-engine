/**
 * Camera motion blur (ws/post-3): a scene-size `DepthPass` that reprojects each pixel's depth
 * through `P.reproj` (current clip → previous clip, the matrix TAA keeps), takes the screen
 * delta as the velocity, and averages `P.motionBlur.z` taps of the scene colour along it,
 * scaled by `P.motionBlur.y`. The composite reads the result as its scene colour, so the blur
 * sits before bloom. Only the camera moves it: objects moving on their own would need a
 * velocity target from the renderer (README wish).
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
  var vel = velocity(uv, d) * P.motionBlur.y;
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
