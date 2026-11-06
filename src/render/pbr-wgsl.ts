/**
 * Physically based shading helpers for custom materials (`WGSL_PBR`). Appended by
 * `createStandardMaterial`; a game's own material appends the same text after the prelude and
 * calls `engine_pbr` from its `fs_main`. Everything here reads the engine's lighting block
 * (`lights`, `engine_shadow`, `engine_fog` from `WGSL_LIGHTS`) and the camera block, so it only
 * compiles after `materialPrelude`.
 *
 * Model: GGX normal distribution (`engine_d_ggx`), height-correlated Smith-GGX visibility
 * (`engine_v_smith_ggx`), Schlick Fresnel (`engine_f_schlick`) and Lambert diffuse. Radiance is
 * in the same units as `engine_lambert`: a light of colour `c` on a white rough dielectric facing
 * it returns about `c` (the specular lobe is scaled by π to match, so a PBR material and a Lambert
 * one agree on brightness under the same `Lights`).
 *
 * `engine_pbr(base, metallic, roughness, N, V, world_pos, ao, emissive)` sums ambient × `ao`
 * (diffuse plus a roughness-aware Fresnel term so metals are not black in the dark), the sun ×
 * `engine_shadow`, the point lights (the `(1 - d/radius)²` falloff of `engine_point_lights`) and
 * `emissive`, then applies `engine_fog`. `N` and `V` are unit world-space vectors; `V` points
 * from the surface to the eye.
 *
 * `engine_perturb_normal(n, world_pos, uv, map, scale)` applies a tangent-space normal map
 * (`map` is the decoded texel, 0..1; +Y is up in the image, the OpenGL / glTF convention; `scale`
 * scales its xy) using a tangent frame built from screen-space derivatives (`dpdx` / `dpdy` of the
 * world position and the uv), so meshes need no tangent attribute: `VERTEX_LAYOUT_3D` has none
 * (xyz, normal, uv, rgba). It is fragment-stage only. When the uv has no screen-space change
 * (a collapsed uv rect, a sliver) it returns `n`.
 */
export const WGSL_PBR = /* wgsl */ `
const ENGINE_PI: f32 = 3.14159265;
const ENGINE_MIN_ROUGHNESS: f32 = 0.045;

fn engine_d_ggx(n_dot_h: f32, a2: f32) -> f32 {
  let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
  return a2 / (ENGINE_PI * d * d + 1e-7);
}

fn engine_v_smith_ggx(n_dot_v: f32, n_dot_l: f32, a2: f32) -> f32 {
  let gv = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - a2) + a2);
  let gl = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - a2) + a2);
  return 0.5 / (gv + gl + 1e-5);
}

fn engine_f_schlick(f0: vec3f, v_dot_h: f32) -> vec3f {
  let f = pow(1.0 - v_dot_h, 5.0);
  return f0 + (vec3f(1.0) - f0) * f;
}

/** One light's reflected radiance factor: (diffuse + specular) × N·L, before the light colour. */
fn engine_brdf(
  n: vec3f, v: vec3f, l: vec3f, diffuse_color: vec3f, f0: vec3f, a2: f32, n_dot_v: f32,
) -> vec3f {
  let n_dot_l = dot(n, l);
  if (n_dot_l <= 0.0) { return vec3f(0.0); }
  let h = normalize(l + v);
  let n_dot_h = saturate(dot(n, h));
  let v_dot_h = saturate(dot(v, h));
  let d = engine_d_ggx(n_dot_h, a2);
  let vis = engine_v_smith_ggx(n_dot_v, n_dot_l, a2);
  let f = engine_f_schlick(f0, v_dot_h);
  let specular = (d * vis * ENGINE_PI) * f;
  return (diffuse_color + specular) * n_dot_l;
}

fn engine_pbr(
  base: vec3f, metallic: f32, roughness: f32, n: vec3f, v: vec3f, world_pos: vec3f,
  ao: f32, emissive: vec3f,
) -> vec3f {
  let r = clamp(roughness, ENGINE_MIN_ROUGHNESS, 1.0);
  let a = r * r;
  let a2 = a * a;
  let m = saturate(metallic);
  let f0 = mix(vec3f(0.04), base, m);
  let diffuse_color = base * (1.0 - m);
  let n_dot_v = max(dot(n, v), 1e-4);
  // Ambient: diffuse plus a roughness-aware Fresnel so metals keep their colour in the dark.
  let fr = max(vec3f(1.0 - r), f0) - f0;
  let ambient_spec = f0 + fr * pow(1.0 - n_dot_v, 5.0);
  var color = lights.ambient * ao * (diffuse_color + ambient_spec);
  // Sun.
  let sun_l = -lights.sun_dir;
  let sun = engine_brdf(n, v, sun_l, diffuse_color, f0, a2, n_dot_v);
  if (any(sun > vec3f(0.0))) {
    color += lights.sun_color * sun * engine_shadow(world_pos);
  }
  // Point lights, with the falloff of engine_point_lights.
  for (var i = 0u; i < lights.point_count; i++) {
    let p = lights.points[i];
    let to = p.position - world_pos;
    let dist = length(to);
    let falloff = saturate(1.0 - dist / max(p.radius, 1e-4));
    if (falloff <= 0.0) { continue; }
    let l = to / max(dist, 1e-4);
    color += p.color * (falloff * falloff) * engine_brdf(n, v, l, diffuse_color, f0, a2, n_dot_v);
  }
  color += emissive;
  return engine_fog(color, world_pos);
}

fn engine_perturb_normal(n: vec3f, world_pos: vec3f, uv: vec2f, map: vec3f, scale: f32) -> vec3f {
  let dp1 = dpdx(world_pos);
  let dp2 = dpdy(world_pos);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  // Solve dp1 = t du1 + b dv1, dp2 = t du2 + b dv2 for t and b (times |det|: only the sign of
  // the determinant matters, the lengths are normalised away below). Unlike the cross-product
  // frame this does not assume cross(dp1, dp2) points along n, which it does not with a y-down
  // framebuffer.
  let det = duv1.x * duv2.y - duv2.x * duv1.y;
  let s = select(-1.0, 1.0, det >= 0.0);
  var t = (dp1 * duv2.y - dp2 * duv1.y) * s;
  var b = (dp2 * duv1.x - dp1 * duv2.x) * s;
  t -= n * dot(n, t);
  b -= n * dot(n, b);
  let m2 = max(dot(t, t), dot(b, b));
  if (m2 < 1e-16) { return n; }
  let inv = inverseSqrt(m2);
  // uv v runs down the image, so the map's +Y (up in the image) is -b.
  let tn = (map * 2.0 - 1.0) * vec3f(scale, scale, 1.0);
  return normalize(t * inv * tn.x - b * inv * tn.y + n * tn.z);
}
`;
