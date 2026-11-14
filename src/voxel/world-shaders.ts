/**
 * The voxel world's WGSL: the vertex stage every stream shares (a section vertex decoded by the
 * format's generated `decode_voxel_vertex`, placed at its section's origin) and the engine's
 * plain default look. A game's material is a fragment entry over `VoxelVarying`.
 */
import type { VoxelFormat } from './format';
import { vertexField, vertexSchemaWgsl } from './schema';

/** The three streams a section draws in. */
export type VoxelStream = 'opaque' | 'foliage' | 'liquid';

/**
 * What the vertex stage hands the fragment: `world` position, `normal`, `light` (x ambient
 * occlusion 0..1, y sky 0..1, z block light 0..1, interpolated), `uv` (block units across the
 * face) and the raw vertex words (`w0`, `w1`, flat: decode them with `decode_voxel_vertex` for
 * the block id and the game's own fields).
 */
export const VOXEL_VARYING_WGSL = /* wgsl */ `
struct VoxelVarying {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) light: vec3f,
  @location(3) uv: vec2f,
  @location(4) @interpolate(flat) w0: u32,
  @location(5) @interpolate(flat) w1: u32,
}
`;

/** The vertex stage for a format (`vs`), with the decode include and `VoxelVarying`. */
export function voxelVertexWgsl(format: VoxelFormat): string {
  const has = (name: string): boolean => vertexField(format.vertex, name) !== undefined;
  const corner = has('side') ? 'v.side & 3u' : 'vi & 3u';
  const quad = has('quad') ? 'v.quad' : '(vi >> 2u)';
  return /* wgsl */ `${vertexSchemaWgsl(format.vertex)}
${VOXEL_VARYING_WGSL}
const VOXEL_NORMALS = array<vec3f, 7>(
  vec3f(-1.0, 0.0, 0.0), vec3f(1.0, 0.0, 0.0), vec3f(0.0, -1.0, 0.0),
  vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, -1.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0),
);

@vertex fn vs(in: VertexIn, @builtin(vertex_index) vi: u32) -> VoxelVarying {
  let v = decode_voxel_vertex(in.packed.x, in.packed.y);
  var local = vec3f(f32(v.x), f32(v.y), f32(v.z));
  let face = min(v.face, 6u);
  var uv: vec2f;
  if (face == 6u) {
    // A cross quad: (x, y, z) is its cell; the corner and the quad's diagonal place it.
    let c = ${corner};
    let u = f32(c & 1u);
    let w = f32((c >> 1u) & 1u);
    let k = ${quad} & 1u;
    let across = select(u, 1.0 - u, k == 1u);
    local = local + vec3f(u, w, across);
    uv = vec2f(u, 1.0 - w);
  } else if (face < 2u) {
    uv = vec2f(local.z, -local.y);
  } else if (face < 4u) {
    uv = vec2f(local.x, local.z);
  } else {
    uv = vec2f(local.x, -local.y);
  }
  var out: VoxelVarying;
  out.world = in.origin.xyz + local;
  out.clip = view.viewProj * vec4f(out.world, 1.0);
  out.normal = VOXEL_NORMALS[face];
  out.light = vec3f(f32(v.ao) / 3.0, f32(v.sky) / 60.0, f32(v.block) / 30.0);
  out.uv = uv;
  out.w0 = in.packed.x;
  out.w1 = in.packed.y;
  return out;
}
`;
}

/** The engine's plain look: a colour per block id, sun and sky shading, AO, distance haze. */
const DEFAULT_COMMON = /* wgsl */ `
fn voxel_default_tint(id: u32) -> vec3f {
  var h = id * 2654435761u;
  h = h ^ (h >> 15u);
  let r = f32(h & 255u) / 255.0;
  let g = f32((h >> 8u) & 255u) / 255.0;
  let b = f32((h >> 16u) & 255u) / 255.0;
  return mix(vec3f(0.42, 0.40, 0.36), vec3f(r, g, b), 0.55);
}

fn voxel_default_shade(in: VoxelVarying, base: vec3f) -> vec3f {
  let sun = 0.6 + 0.4 * max(dot(in.normal, normalize(vec3f(0.35, 1.0, 0.2))), 0.0);
  let ao = mix(0.45, 1.0, in.light.x);
  let lit = max(mix(0.12, 1.0, in.light.y) * sun, in.light.z);
  let c = base * lit * ao;
  let d = distance(in.world, view.position.xyz);
  return mix(c, vec3f(0.62, 0.72, 0.82), clamp((d - 96.0) / 220.0, 0.0, 0.85));
}
`;

/** The default fragment for each stream (`fs`). */
export const VOXEL_DEFAULT_FRAGMENT: Readonly<Record<VoxelStream, string>> = {
  opaque: /* wgsl */ `${DEFAULT_COMMON}
@fragment fn fs(in: VoxelVarying) -> @location(0) vec4f {
  let v = decode_voxel_vertex(in.w0, in.w1);
  return vec4f(voxel_default_shade(in, voxel_default_tint(v.id)), 1.0);
}
`,
  foliage: /* wgsl */ `${DEFAULT_COMMON}
@fragment fn fs(in: VoxelVarying) -> @location(0) vec4f {
  let v = decode_voxel_vertex(in.w0, in.w1);
  let base = mix(voxel_default_tint(v.id), vec3f(0.25, 0.55, 0.2), 0.6);
  return vec4f(voxel_default_shade(in, base), 1.0);
}
`,
  liquid: /* wgsl */ `${DEFAULT_COMMON}
@fragment fn fs(in: VoxelVarying) -> @location(0) vec4f {
  return vec4f(voxel_default_shade(in, vec3f(0.18, 0.38, 0.62)), 0.7);
}
`,
};
