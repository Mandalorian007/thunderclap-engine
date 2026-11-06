import { WGSL_GLOBALS } from '../render/wgsl';

/**
 * The debug line shader: a vertex is a world position and an RGBA colour (7 floats); the
 * vertex stage projects through the engine camera (`@group(0)`), the fragment writes the colour
 * to the scene's colour target and nothing (alpha 0) to the emissive one. No lighting, no
 * texture. The pipeline draws a `'line-list'`, so a segment is two of these vertices.
 */
export const DEBUG_DRAW_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec4f,
};
struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

@vertex fn vs(@location(0) position: vec3f, @location(1) color: vec4f) -> VSOut {
  var o: VSOut;
  o.clip = camera.view_proj * vec4f(position, 1.0);
  o.color = color;
  return o;
}

@fragment fn fs(in: VSOut) -> FragOut {
  var o: FragOut;
  o.color = in.color;
  o.emissive = vec4f(0.0);
  return o;
}
`;
