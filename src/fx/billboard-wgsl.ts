import { WGSL_GLOBALS } from '../render/wgsl';

/** Floats per billboard instance in the storage buffer (`BILLBOARD_BYTES` / 4). */
export const BILLBOARD_FLOATS = 20;
export const BILLBOARD_BYTES = BILLBOARD_FLOATS * 4;

/** Instance flag bits, in `pos.w` as a float. */
export const BB_FLAG_PX = 1;
export const BB_FLAG_YAW = 2;
export const BB_FLAG_TEXTURED = 4;
export const BB_FLAG_BAR = 8;

/**
 * The billboard batch's shader: six vertices per instance, read from a storage buffer.
 *
 * - `pos.xyz` is the world anchor (position plus offset); `pos.w` carries the flags above.
 * - `size.xy` is the quad size: world units, or logical px with `BB_FLAG_PX` (then the quad is
 *   screen-aligned and sized from `globals.logicalSize`, `globals.targetSize` and the view's
 *   `camera.viewport`, so it keeps its px size at any distance). `size.z` is the bar fraction.
 * - World-unit quads face the camera (`camera.view` rows 0 and 1), or turn only about y with
 *   `BB_FLAG_YAW` (right = the view's right flattened onto xz, up = +y).
 * - `color` multiplies the atlas sample (`BB_FLAG_TEXTURED`) or stands alone; with `BB_FLAG_BAR`
 *   the fragment is `color` where `uv.x < size.z` and `color2` beyond.
 */
export const BILLBOARD_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
struct Billboard {
  pos: vec4f,
  size: vec4f,
  uv: vec4f,
  color: vec4f,
  color2: vec4f,
};
@group(1) @binding(0) var<storage, read> billboards: array<Billboard>;
@group(1) @binding(1) var atlas_sampler: sampler;
@group(1) @binding(2) var atlas: texture_2d<f32>;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) q: vec2f,
  @location(2) color: vec4f,
  @location(3) color2: vec4f,
  @location(4) @interpolate(flat) flags: u32,
  @location(5) fraction: f32,
};
struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

fn view_row(r: u32) -> vec3f {
  return vec3f(camera.view[0][r], camera.view[1][r], camera.view[2][r]);
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var o: VSOut;
  let b = billboards[ii];
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );
  let q = corners[vi];
  let flags = u32(b.pos.w + 0.5);
  let half = b.size.xy * 0.5;
  if ((flags & ${BB_FLAG_PX}u) != 0u) {
    var clip = camera.view_proj * vec4f(b.pos.xyz, 1.0);
    // Logical px → target px → NDC, scaled by w so the division leaves the px size intact.
    let px_per_logical = globals.targetSize / globals.logicalSize;
    let ndc = (q * half * px_per_logical) / max(camera.viewport.zw, vec2f(1.0)) * 2.0;
    clip = vec4f(clip.xy + ndc * clip.w, clip.zw);
    o.clip = clip;
  } else {
    var right = view_row(0u);
    var up = view_row(1u);
    if ((flags & ${BB_FLAG_YAW}u) != 0u) {
      let flat = vec3f(right.x, 0.0, right.z);
      let len = length(flat);
      right = select(vec3f(1.0, 0.0, 0.0), flat / max(len, 1e-6), len > 1e-6);
      up = vec3f(0.0, 1.0, 0.0);
    }
    let world = b.pos.xyz + right * (q.x * half.x) + up * (q.y * half.y);
    o.clip = camera.view_proj * vec4f(world, 1.0);
  }
  // Canvas uv: v grows downward, so the top of the quad (q.y = 1) samples v0.
  let t = q * 0.5 + 0.5;
  o.uv = vec2f(mix(b.uv.x, b.uv.z, t.x), mix(b.uv.w, b.uv.y, t.y));
  o.q = t;
  o.color = b.color;
  o.color2 = b.color2;
  o.flags = flags;
  o.fraction = b.size.z;
  return o;
}

@fragment fn fs(in: VSOut) -> FragOut {
  var c = in.color;
  if ((in.flags & ${BB_FLAG_BAR}u) != 0u) {
    c = select(in.color2, in.color, in.q.x < in.fraction);
  }
  // Sampled unconditionally: textureSample needs uniform control flow.
  let s = textureSample(atlas, atlas_sampler, in.uv);
  c *= select(vec4f(1.0), s, (in.flags & ${BB_FLAG_TEXTURED}u) != 0u);
  var o: FragOut;
  o.color = c;
  o.emissive = vec4f(0.0, 0.0, 0.0, c.a);
  return o;
}
`;
