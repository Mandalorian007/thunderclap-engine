/**
 * Depth of field (ws/post-depth): a half-res gather over the scene colour weighted by the
 * circle of confusion, which comes from linear depth. The composite blends sharp and blurred
 * by the CoC it reads from this pass's alpha.
 *
 * CoC is signed: negative in front of the focus (near field), positive behind. Without
 * `dof.nearBlur` the near side is clamped to 0. The gather takes `PostQuality.dofTaps` taps on
 * a golden-angle disc (so the pattern has no axis), scaled by the centre's CoC and rotated per
 * pixel by interleaved-gradient noise; each tap counts by how far its own CoC reaches the centre,
 * so a sharp foreground does not bleed into a blurred background.
 */
import { WGSL_DEPTH_VIEW } from './ao';
import { WGSL_POST_UNIFORMS } from './settings';

export const DOF_WGSL = /* wgsl */ `
${WGSL_POST_UNIFORMS}
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var colorTex: texture_2d<f32>;
${WGSL_DEPTH_VIEW}

/** Signed circle of confusion in uv (fraction of the width). */
fn coc_at(uv: vec2f) -> f32 {
  let d = textureSampleLevel(depthTex, nearest, uv, 0u);
  var z = P.dof.y + P.dof.z * 4.0; // sky: past the far side of the range
  if (d < 1.0) {
    z = linear_depth(uv, d);
  }
  var c = clamp((z - P.dof.y) / P.dof.z, -1.0, 1.0);
  if (P.dof2.x < 0.5) {
    c = max(c, 0.0);
  }
  return c * P.dof.w;
}

fn ign(px: vec2f) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
}

@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let uv = in.uv;
  let aspect = P.frame.y;
  let cc = coc_at(uv);
  let r = abs(cc);
  var sum = textureSampleLevel(colorTex, linSamp, uv, 0.0).rgb;
  var wsum = 1.0;
  let count = i32(P.dof2.y);
  let rot = ign(in.pos.xy) * 6.2831853;
  // Taps reach as far as the widest CoC they could meet, so blurred things behind a sharp
  // edge still gather; each tap's own CoC decides whether it belongs.
  let reach = max(r, P.dof.w * 0.5);
  for (var i = 0; i < count; i++) {
    let a = (f32(i) + 0.5) / f32(count);
    let ang = rot + f32(i) * 2.39996323;
    let dist = sqrt(a) * reach;
    let suv = uv + vec2f(cos(ang), sin(ang) * aspect) * dist;
    let sc = coc_at(suv);
    // A sample contributes where its own circle covers this pixel (or ours covers it).
    let cover = max(abs(sc), select(0.0, r, sc > 0.0 && cc > 0.0));
    let w = clamp((cover - dist) / max(P.dof.w * 0.05, 1e-5) + 1.0, 0.0, 1.0);
    sum += textureSampleLevel(colorTex, linSamp, suv, 0.0).rgb * w;
    wsum += w;
  }
  return vec4f(sum / wsum, cc);
}
`;
