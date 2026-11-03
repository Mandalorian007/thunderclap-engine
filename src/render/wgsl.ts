import { reportGpuError } from './diagnostics';

/**
 * Create a shader module and surface compile errors with file/line context. Compilation is
 * async in the browser; errors are logged as soon as they are known.
 */
export function createShaderModule(
  device: GPUDevice,
  code: string,
  label: string,
): GPUShaderModule {
  const module = device.createShaderModule({ code, label });
  module.getCompilationInfo().then((info) => {
    if (!info.messages.length) return;
    const lines = code.split('\n');
    for (const m of info.messages) {
      const src = lines[m.lineNum - 1] ?? '';
      const caret = `${' '.repeat(Math.max(0, m.linePos - 1))}^`;
      const text = `[wgsl] ${label}:${m.lineNum}:${m.linePos} ${m.type}: ${m.message}\n    ${src}\n    ${caret}`;
      if (m.type === 'error') reportGpuError(text);
      else console.warn(text);
    }
  });
  return module;
}

/** Per-frame globals, bound at @group(0) @binding(0) for every material and drawable. */
export const WGSL_GLOBALS = /* wgsl */ `
struct EngineGlobals {
  viewProj: mat4x4f,
  logicalSize: vec2f,
  targetSize: vec2f,
  time: f32,
  dt: f32,
  _pad: vec2f,
};
@group(0) @binding(0) var<uniform> globals: EngineGlobals;
`;

/** Hash / value-noise / fbm helpers available to every material and fullscreen pass. */
export const WGSL_NOISE = /* wgsl */ `
fn engine_hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn engine_hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
fn engine_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = engine_hash21(i);
  let b = engine_hash21(i + vec2f(1.0, 0.0));
  let c = engine_hash21(i + vec2f(0.0, 1.0));
  let d = engine_hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn engine_fbm(p: vec2f, octaves: i32) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < octaves; i++) {
    v += amp * engine_noise(q);
    q = q * 2.03 + vec2f(17.1, 9.2);
    amp *= 0.5;
  }
  return v;
}
fn engine_luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}
`;

/**
 * Prelude prepended to every material. Declares the vertex/instance layout, the default
 * vertex entry `vs_main`, the `VSOut` varyings and the `FragOut` MRT struct.
 */
export const WGSL_MATERIAL_PRELUDE = /* wgsl */ `
${WGSL_GLOBALS}
${WGSL_NOISE}
struct VertexIn {
  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) xform: vec4f,
  @location(4) misc: vec4f,
  @location(5) uvRect: vec4f,
  @location(6) tint: vec4f,
  @location(7) params: vec4f,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) local: vec2f,
  @location(2) color: vec4f,
  @location(3) params: vec4f,
  @location(4) world: vec2f,
  @location(5) emissive: f32,
  @location(6) size: vec2f,
};

struct FragOut {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

fn engine_vertex(v: VertexIn) -> VSOut {
  let c = cos(v.misc.x);
  let s = sin(v.misc.x);
  let p = v.pos * v.xform.zw;
  let r = vec2f(p.x * c - p.y * s, p.x * s + p.y * c);
  let world = v.xform.xy + r;
  var o: VSOut;
  o.clip = globals.viewProj * vec4f(world, 0.0, 1.0);
  o.uv = mix(v.uvRect.xy, v.uvRect.zw, v.uv);
  o.local = v.uv;
  o.color = v.color * v.tint;
  o.params = v.params;
  o.world = world;
  o.emissive = v.misc.y;
  o.size = v.xform.zw;
  return o;
}

@vertex fn vs_main(v: VertexIn) -> VSOut {
  return engine_vertex(v);
}
`;

/** Prelude for fullscreen passes: `vs_fullscreen` emits one triangle covering the target. */
export const WGSL_FULLSCREEN_PRELUDE = /* wgsl */ `
${WGSL_NOISE}
struct FullscreenIn {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vs_fullscreen(@builtin(vertex_index) i: u32) -> FullscreenIn {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FullscreenIn;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;
