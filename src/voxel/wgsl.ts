/**
 * WGSL helpers for a block material over the mesher's vertex convention. Prepend `VOXEL_WGSL`
 * to the material's `wgsl` (after any `@group(1)` declarations it needs) and read:
 *
 * - `voxel_layer(in.color)`: the texture-array layer the mesher wrote to colour.a
 *   (`u32(round(a))`, exact through interpolation because every vertex of a quad carries the
 *   same layer);
 * - `voxel_ao(in.color)`: the baked ambient occlusion in colour.r;
 * - `voxel_uv_wrap(in.uv)`: the uv wrapped into 0..1 for a clamping sampler or an atlas;
 *   the quad's uv spans whole block units, so `fract` tiles the face. Sample with
 *   `textureSampleGrad(tex, s, voxel_uv_wrap(in.uv), layer, dpdx(in.uv), dpdy(in.uv))`: the
 *   derivatives of the unwrapped uv keep the mip selection continuous across the wrap seam.
 *   With the `'nearest-mip-repeat'` sampler kind the wrap is the sampler's and
 *   `textureSample(tex, s, in.uv, layer)` is enough.
 */
export const VOXEL_WGSL = /* wgsl */ `
fn voxel_layer(color: vec4f) -> u32 {
  return u32(round(max(color.a, 0.0)));
}

fn voxel_ao(color: vec4f) -> f32 {
  return color.r;
}

fn voxel_uv_wrap(uv: vec2f) -> vec2f {
  return fract(uv);
}
`;
