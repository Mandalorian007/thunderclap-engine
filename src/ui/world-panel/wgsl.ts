import { WGSL_GLOBALS } from '../../render/wgsl';

/** Floats in the panel's uniform: the 3×4 world matrix as three rows, then `size.xy`. */
export const WORLD_PANEL_UNIFORM_FLOATS = 16;
export const WORLD_PANEL_UNIFORM_BYTES = WORLD_PANEL_UNIFORM_FLOATS * 4;

/**
 * The panel quad's shader: six vertices, no vertex buffer. The quad spans `size` world units
 * around the panel's origin in its xy plane (facing +z); its texture is the panel canvas, in
 * premultiplied alpha, so the fragment writes the sample straight out under premultiplied blend.
 * The canvas's row 0 is the panel's top, so v runs 0 at +y.
 *
 * @deprecated (ws/api-core, E-036) Internal: the panel builds its pipeline from it. Leaves the `ui` entry next
 * minor; tests import it from this file.
 */
export const WORLD_PANEL_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
struct WorldPanel {
  m0: vec4f,
  m1: vec4f,
  m2: vec4f,
  size: vec4f,
};
@group(1) @binding(0) var<uniform> panel: WorldPanel;
@group(1) @binding(1) var panel_sampler: sampler;
@group(1) @binding(2) var panel_tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
};
struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
    vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5)
  );
  let q = corners[vi];
  let local = vec4f(q * panel.size.xy, 0.0, 1.0);
  let world = vec3f(dot(panel.m0, local), dot(panel.m1, local), dot(panel.m2, local));
  var o: VSOut;
  o.clip = camera.view_proj * vec4f(world, 1.0);
  o.uv = vec2f(q.x + 0.5, 0.5 - q.y);
  return o;
}

@fragment fn fs(in: VSOut) -> FragOut {
  var o: FragOut;
  o.color = textureSample(panel_tex, panel_sampler, in.uv);
  o.emissive = vec4f(0.0);
  return o;
}
`;
