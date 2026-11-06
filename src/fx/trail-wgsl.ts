/**
 * The trail material: unlit vertex colour, soft across the ribbon, no lighting block reads.
 *
 * The ribbon's vertex colour already carries the age fade (alpha) from the CPU; here the
 * fragment fades toward the two long edges. `in.local.y` is 0 on one edge and 1 on the other
 * (the raw vertex v, untouched by `uvRect`); `in.params.x` is the edge softness (0..1, the
 * share of the half width that fades). Emissive is colour × `in.emissive`, like the sprite.
 */
export const TRAIL_WGSL = /* wgsl */ `
fn trail_edge(local_v: f32, softness: f32) -> f32 {
  let edge = abs(local_v - 0.5) * 2.0;
  return 1.0 - smoothstep(1.0 - max(softness, 1e-4), 1.0, edge);
}

@fragment fn fs_main(in: VSOut) -> FragOut {
  let a = in.color.a * trail_edge(in.local.y, in.params.x);
  var o: FragOut;
  o.color = vec4f(in.color.rgb, a);
  o.emissive = vec4f(in.color.rgb * in.emissive, a);
  return o;
}
`;

/** Same, times a texture: `u` runs along the ribbon (stretched or tiled), `v` across it. */
export const TRAIL_TEXTURED_WGSL = /* wgsl */ `
@group(1) @binding(1) var trailSampler: sampler;
@group(1) @binding(2) var trailTex: texture_2d<f32>;

fn trail_edge(local_v: f32, softness: f32) -> f32 {
  let edge = abs(local_v - 0.5) * 2.0;
  return 1.0 - smoothstep(1.0 - max(softness, 1e-4), 1.0, edge);
}

@fragment fn fs_main(in: VSOut) -> FragOut {
  let t = textureSample(trailTex, trailSampler, in.uv);
  let rgb = in.color.rgb * t.rgb;
  let a = in.color.a * t.a * trail_edge(in.local.y, in.params.x);
  var o: FragOut;
  o.color = vec4f(rgb, a);
  o.emissive = vec4f(rgb * in.emissive, a);
  return o;
}
`;
