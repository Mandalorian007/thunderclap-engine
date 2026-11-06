import { WGSL_GLOBALS, WGSL_LIGHTS, WGSL_NOISE } from '../render/wgsl';

/**
 * The sky shader: one fullscreen triangle at the far plane whose fragment reconstructs the view
 * ray from the camera block and shades a procedural dome.
 *
 * View ray. The camera block carries `proj` and `view`, no inverse. A perspective projection
 * (including an off-centre XR one) inverts analytically: with `vz = -1`,
 * `ndc.x = (p00 * vx + p20 * vz) / (p23 * vz)` gives `vx = (p20 - p23 * ndc.x) / p00`, and y the
 * same with `p11`, `p21`. The world direction is the view rotation's transpose applied to that
 * (`dot(view[i].xyz, d)` per component, the view's columns). An orthographic projection
 * (`p23 == 0`) has one view direction, the camera's forward (`-z`, or `+z` when `p22 > 0`, the
 * 2D camera's convention). `skyRay` in `sky.ts` is the same
 * math in TypeScript, tested against `Camera.screenToWorld`.
 *
 * Colour, all in linear space: zenith → horizon → ground by the ray's elevation; a band around
 * the horizon mixes towards `lights.fog` (scaled by its density) so fogged geometry meets the
 * sky; the sun disc (`sun_size` radians of angular radius) and two glow lobes (`sun_glow`) tinted
 * by `lights.sun_color` at `-lights.sun_dir`; when the sun is below the horizon the dome darkens
 * and the stars (a hash of the direction on a grid of `density` cells per unit) appear. Without
 * a sun (colour all zero) the dome is as set and the stars, if on, are full. The sun disc and the
 * stars also go to the emissive target so bloom picks them up.
 */
export const SKY_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
${WGSL_LIGHTS}
${WGSL_NOISE}
struct SkyParams {
  zenith: vec4f,   // rgb, exposure
  horizon: vec4f,  // rgb, sun angular radius (radians)
  ground: vec4f,   // rgb, sun glow
  stars: vec4f,    // density, seed, enabled, pad
};
@group(1) @binding(0) var<uniform> sky: SkyParams;

struct SkyOut {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
};

struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

// One triangle covering clip space, at the far plane (z = 1): with depth compare less-equal
// and no depth write, geometry drawn before or after it always wins.
@vertex fn vs(@builtin(vertex_index) i: u32) -> SkyOut {
  let x = f32(i32(i & 1u) * 4 - 1);
  let y = f32(i32(i >> 1u) * 4 - 1);
  var o: SkyOut;
  o.clip = vec4f(x, y, 1.0, 1.0);
  o.ndc = vec2f(x, y);
  return o;
}

fn sky_ray(ndc: vec2f) -> vec3f {
  let p = camera.proj;
  var d = vec3f(0.0, 0.0, -1.0);
  if (p[2][3] != 0.0) {
    d.x = (p[2][0] - p[2][3] * ndc.x) / p[0][0];
    d.y = (p[2][1] - p[2][3] * ndc.y) / p[1][1];
  } else if (p[2][2] > 0.0) {
    d.z = 1.0; // an orthographic view that looks down +z (the 2D camera)
  }
  let v = camera.view;
  return normalize(vec3f(dot(v[0].xyz, d), dot(v[1].xyz, d), dot(v[2].xyz, d)));
}

fn sky_stars(d: vec3f, density: f32, seed: f32) -> f32 {
  let p = d * density;
  let cell = floor(p);
  let key = cell.xy + vec2f(cell.z * 37.0 + seed, cell.z * 11.0 - seed);
  let h = engine_hash22(key);
  let hz = engine_hash21(key + 17.0);
  let bright = engine_hash21(key + 41.0);
  if (bright < 0.72) { return 0.0; }
  let centre = normalize(cell + 0.5 + (vec3f(h, hz) - 0.5) * 0.8);
  let r = 0.07 / density;
  let c = dot(d, centre);
  let edge = 1.0 - r * r * 0.5;
  let s = smoothstep(edge, edge + r * r * 0.4, c);
  return s * (0.4 + 0.6 * (bright - 0.72) / 0.28);
}

@fragment fn fs(in: SkyOut) -> FragOut {
  let d = sky_ray(in.ndc);
  let up = d.y;
  let exposure = sky.zenith.w;

  // The dome.
  let above = mix(sky.horizon.rgb, sky.zenith.rgb, pow(saturate(up), 0.6));
  let below = mix(sky.horizon.rgb, sky.ground.rgb, smoothstep(0.0, 0.25, -up));
  var col = select(below, above, up >= 0.0);

  // Horizon haze towards the fog colour, so fogged ground meets the sky.
  let haze = saturate(lights.fog.w) * exp(-abs(up) * 6.0);
  col = mix(col, lights.fog.rgb, haze);

  // Day and night from the sun's elevation; no sun at all leaves the dome as set.
  let to_sun = -lights.sun_dir;
  let sun_color = lights.sun_color;
  let has_sun = dot(sun_color, vec3f(1.0)) > 0.0;
  let day = select(1.0, smoothstep(-0.12, 0.08, to_sun.y), has_sun);
  col *= mix(0.06, 1.0, day);

  // Sun disc and glow.
  let cos_a = dot(d, to_sun);
  let cos_disc = cos(sky.horizon.w);
  let disc = smoothstep(cos_disc - 0.0004, cos_disc, cos_a) * smoothstep(-0.02, 0.0, up);
  let glow = sky.ground.w * (0.3 * pow(saturate(cos_a), 16.0) + pow(saturate(cos_a), 256.0));
  let sun = sun_color * (disc * 12.0 + glow);
  col += sun;

  // Stars at night.
  var stars = 0.0;
  if (sky.stars.z > 0.5) {
    stars = sky_stars(d, sky.stars.x, sky.stars.y) * (1.0 - day) * smoothstep(-0.05, 0.05, up);
  }
  col += vec3f(stars * 2.0);

  var o: FragOut;
  o.color = vec4f(col * exposure, 1.0);
  o.emissive = vec4f((sun_color * disc * 2.0 + vec3f(stars * 1.5)) * exposure, 1.0);
  return o;
}
`;
