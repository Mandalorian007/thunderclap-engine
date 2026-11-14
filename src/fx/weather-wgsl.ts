/**
 * ws/core-effects (B5): the precipitation shader. Up to `WEATHER_MAX_LAYERS` layers share one
 * instanced draw: an instance finds its layer by the layers' first instances, falls through a
 * column of the layer's volume around the anchor (the columns wrap, so the volume follows the
 * camera without popping), and dies below the occlusion height (a flat height, or a height map:
 * a roof, a canopy, the ground). Each eye orients the quad from its own view (`CoreView`, and
 * `CoreViewExtra` for the image plane), so a stereo pair shares one bundle.
 */
import { CORE_DRAWABLE_WGSL, CORE_VIEW_EXTRA_WGSL } from '../render/core/drawable';

/** Layers one `Weather` draws (each a shape, count, volume and colour). */
export const WEATHER_MAX_LAYERS = 4;
/** Floats per layer in the weather uniform. */
export const WEATHER_LAYER_FLOATS = 16;
/** Floats of the weather uniform before the layers. */
export const WEATHER_HEAD_FLOATS = 16;

export const WEATHER_WGSL = /* wgsl */ `
${CORE_DRAWABLE_WGSL}
${CORE_VIEW_EXTRA_WGSL}
struct Layer {
  a: vec4f,   // first instance, instances, radius, height
  b: vec4f,   // fall speed, wind factor, length, width
  c: vec4f,   // rgb, alpha
  d: vec4f,   // shape (0 streak, 1 flake, 2 dust), flutter, seed, unused
};
struct Weather {
  anchor: vec4f,  // xyz (the core's frame), time
  wind: vec4f,    // x, z (units/s), intensity, layer count
  occl: vec4f,    // flat height, map on, map origin x, map origin z
  occl2: vec4f,   // map size x, map size z, near fade, light
  layers: array<Layer, ${WEATHER_MAX_LAYERS}>,
};
@group(1) @binding(0) var<uniform> w: Weather;
@group(1) @binding(1) var<storage, read> extras: array<CoreViewExtra>;
@group(1) @binding(2) var height_map: texture_2d<f32>;

struct WOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) shape: u32,
};

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}

// The occlusion height at xz (the core's frame): the flat height, raised by the map inside it.
fn occlusion(xz: vec2f) -> f32 {
  var h = w.occl.x;
  if (w.occl.y > 0.5) {
    let uv = (xz - w.occl.zw) / w.occl2.xy;
    if (all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
      let dims = vec2f(textureDimensions(height_map));
      let px = vec2i(uv * dims);
      h = max(h, textureLoad(height_map, px, 0).r);
    }
  }
  return h;
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> WOut {
  var o: WOut;
  o.clip = vec4f(0.0, 0.0, 2.0, 1.0);
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );
  let corner = corners[vi];
  // The layer: the last whose first instance is at or below this one.
  let n = u32(w.wind.w);
  var li = 0u;
  for (var k = 1u; k < n; k++) {
    if (f32(ii) >= w.layers[k].a.x) { li = k; }
  }
  let L = w.layers[li];
  let local = f32(ii) - L.a.x;
  if (local >= L.a.y) { return o; }
  let s = local + 0.5 + L.d.z;
  let R = L.a.z;
  let H = L.a.w;
  let speed = max(L.b.x, 1e-3);
  let shape = u32(L.d.x + 0.5);
  let t = w.anchor.w;
  let wv = w.wind.xy * L.b.y;
  let fall = t * speed / H + hash11(s * 9.41 + 1.0);
  let cyc = floor(fall);
  let ph = fract(fall);
  // A new column each cycle, so the pattern never repeats; wrapped around the anchor.
  let start = vec2f(hash11(s * 3.1 + cyc * 7.7), hash11(s * 5.9 + cyc * 3.3)) * 2.0 * R;
  let anchor = w.anchor.xyz;
  let rel = start + wv * ph * H / speed - anchor.xz;
  let wrapped = (fract((rel + R) / (2.0 * R)) * 2.0 - 1.0) * R;
  var p = vec3f(anchor.x + wrapped.x, anchor.y + H * 0.55 - ph * H, anchor.z + wrapped.y);
  let ground = occlusion(p.xz);
  var vel = vec3f(wv.x, -speed, wv.y);
  if (shape == 2u) {
    // Dust streams low over the ground, carried by the wind.
    p.y = max(ground, anchor.y - 3.0) + hash11(s * 2.3 + cyc) * H * 0.7;
    vel = vec3f(wv.x, -0.15 * speed, wv.y);
  }
  if (shape == 1u) {
    p.x += sin(t * 1.3 + s) * L.d.y;
    p.z += cos(t * 1.1 + s * 1.7) * L.d.y;
  }
  let eye = view.position.xyz;
  let d = length(p - eye);
  if (p.y <= ground || d < w.occl2.z) { return o; }
  let e = extras[view.index];
  let to_eye = normalize(eye - p);
  var along = normalize(vel + vec3f(0.0, -1e-4, 0.0));
  var across = normalize(cross(along, to_eye) + vec3f(1e-4, 0.0, 0.0));
  if (shape == 1u) {
    along = e.up.xyz;
    across = e.right.xyz;
  }
  let q = p + along * corner.y * L.b.z * 0.5 + across * corner.x * L.b.w * 0.5;
  o.clip = view.viewProj * vec4f(q, 1.0);
  o.uv = corner;
  let edge = length(p.xz - anchor.xz);
  let fade = smoothstep(w.occl2.z, w.occl2.z + 1.4, d) * (1.0 - smoothstep(R * 0.7, R, edge));
  o.color = vec4f(L.c.rgb * w.occl2.w, L.c.a * fade * mix(0.7, 1.0, hash11(s * 1.7)));
  o.shape = shape;
  return o;
}

@fragment fn fs(in: WOut) -> @location(0) vec4f {
  var r: f32;
  if (in.shape == 0u) {
    r = 1.0 - in.uv.x * in.uv.x;
  } else {
    r = 1.0 - dot(in.uv, in.uv);
  }
  if (r <= 0.0) { discard; }
  let a = clamp(in.color.a * r, 0.0, 1.0);
  return vec4f(in.color.rgb * a, a);
}
`;
