/** Post-stack settings. All colours are linear RGB. Mutate in place at runtime; read each frame. */

export type RGB = [number, number, number];

export interface BloomSettings {
  enabled: boolean;
  /** Strength of the bloom added to the image. */
  intensity: number;
  /** Scene-colour brightness above which non-emissive pixels also bloom. */
  threshold: number;
  /** Soft knee width around the threshold. */
  knee: number;
  /** Multiplier on the emissive target (the main bloom source). */
  emissiveWeight: number;
  /** 0..1: how much each coarser level is added back on the way up (bigger = wider glow). */
  scatter: number;
  /** Mip levels (2..8). Changing it takes effect on next resize. */
  levels: number;
}

export interface FogSettings {
  enabled: boolean;
  /** Mist colour (linear, HDR ok). */
  color: RGB;
  /** Max opacity of the mist at the bottom (0..1). */
  density: number;
  /** Screen height (0 = top, 1 = bottom) where mist starts. */
  top: number;
  /** Screen height where mist reaches full density. */
  bottom: number;
  /** Shape curve of the height falloff (>1 hugs the floor). */
  falloff: number;
  /** Noise frequency (bigger = smaller wisps). */
  noiseScale: number;
  /** Drift speed. */
  speed: number;
  /** How much nearby glow (bloom) lights the mist. */
  lightScatter: number;
}

export interface GodRaySettings {
  enabled: boolean;
  /** Light position in logical coordinates (may be off-screen). */
  x: number;
  y: number;
  intensity: number;
  /** Per-sample falloff (0.9..0.99). */
  decay: number;
  /** Ray length as a fraction of the distance to the light (0..1). */
  density: number;
  /** Per-sample weight. */
  weight: number;
  color: RGB;
  /** Radius (logical px) of the bright disc at the light position. 0 disables it. */
  sourceRadius: number;
  /** Brightness of the disc. */
  sourceIntensity: number;
  /** How much the scene's bloom also casts rays (glowing things shed shafts). */
  bloomSource: number;
}

export interface VignetteSettings {
  enabled: boolean;
  intensity: number;
  /** Distance from centre (0..1, 1 = corner) where darkening starts. */
  radius: number;
  softness: number;
  color: RGB;
}

export type Tonemap = 'aces' | 'reinhard' | 'none';

export interface GradeSettings {
  enabled: boolean;
  /** Linear exposure multiplier before tonemapping. */
  exposure: number;
  tonemap: Tonemap;
  lift: RGB;
  gamma: RGB;
  gain: RGB;
  saturation: number;
  contrast: number;
  /** Ordered-noise dither to kill banding in dark gradients. */
  dither: boolean;
}

/**
 * Screen-space ambient occlusion over the scene depth (ws/post-depth). Needs a frame with a
 * depth buffer (`PostInputs.depth`); the 2D path has none and the pass is skipped.
 */
export interface AoSettings {
  enabled: boolean;
  /** Sample radius in world units. */
  radius: number;
  /** Strength of the darkening (0 = none). */
  intensity: number;
  /** Depth tolerance (world units along the normal) before a sample counts as occluding. */
  bias: number;
  /** Contrast of the occlusion term (>1 deepens creases). */
  power: number;
}

/** Depth of field from linear depth (ws/post-depth): sharp at `focusDistance`, blurred by CoC. */
export interface DofSettings {
  enabled: boolean;
  /** Distance from the eye (world units) in sharp focus. */
  focusDistance: number;
  /** Depth either side of the focus distance over which the blur ramps to `maxBlur`. */
  focusRange: number;
  /** Largest circle of confusion, in px at the output resolution. */
  maxBlur: number;
  /** Blur what is closer than the focus too (off: only the far side blurs). */
  nearBlur: boolean;
}

/**
 * FXAA 3.11 (console preset) over the composite's output (ws/post-2): one extra full-res pass,
 * recorded only while enabled.
 */
export interface FxaaSettings {
  enabled: boolean;
  /** How much of the anti-aliased result replaces the pixel (0..1). */
  subpixel: number;
  /** Local contrast (0..1 of the brightest luma) below which a pixel is left alone. */
  edgeThreshold: number;
}

/** A 3D colour lookup applied after the grade (ws/post-2). `texture: null` means off. */
export interface LutSettings {
  /** A `size`³ `rgba8unorm` 3D texture (`createLutTexture`, `identityLut`), or `null` for none. */
  texture: GPUTexture | null;
  /** Texels per axis of `texture`. */
  size: 16 | 32;
  /** Blend between the graded colour (0) and the looked-up colour (1). */
  intensity: number;
}

/** Film grain after the grade (ws/post-2). `intensity` 0 is off. */
export interface GrainSettings {
  /** Peak noise amplitude (display units, 0..1). */
  intensity: number;
  /** Grain cell size in output px (1 = per pixel). */
  size: number;
  /** 0..1: how much less grain bright pixels get (1 = none in white). */
  luminanceResponse: number;
  /** Re-seed every frame; off, the grain is a fixed pattern. */
  animated: boolean;
}

/** Chromatic aberration: red and blue sampled radially either side of green (ws/post-2). */
export interface AberrationSettings {
  /** Largest channel offset in output px (reached at the corners when `radialOnly`). 0 is off. */
  intensity: number;
  /** Grow the offset with the squared distance from the centre, so the centre stays clean. */
  radialOnly: boolean;
}

/** Unsharp mask on the scene colour (ws/post-2). `amount` 0 is off. */
export interface SharpenSettings {
  /** Strength of the 5-tap unsharp mask (0..2 is sensible). */
  amount: number;
}

/**
 * A depth and normal outline for toon looks (ws/post-2): a Roberts cross over the linear depth
 * and the normals from depth, mixed into the scene colour before fog. Needs the scene depth;
 * without one the pass is off (one warning).
 */
export interface OutlineSettings {
  enabled: boolean;
  /** Line colour (linear). */
  color: RGB;
  /** Line width in output px (the cross is sampled at this distance). */
  thickness: number;
  /** Relative depth step (fraction of the nearer depth) that counts as an edge. */
  depthThreshold: number;
  /** Normal difference (1 - cos of the angle) that counts as an edge. */
  normalThreshold: number;
  /** Opacity of the line (0..1). */
  intensity: number;
}

export interface PostSettings {
  bloom: BloomSettings;
  fog: FogSettings;
  godRays: GodRaySettings;
  vignette: VignetteSettings;
  grade: GradeSettings;
  ao: AoSettings;
  dof: DofSettings;
  fxaa: FxaaSettings;
  lut: LutSettings;
  grain: GrainSettings;
  aberration: AberrationSettings;
  sharpen: SharpenSettings;
  outline: OutlineSettings;
}

export function defaultPostSettings(): PostSettings {
  return {
    bloom: {
      enabled: true,
      intensity: 0.9,
      threshold: 1.2,
      knee: 0.5,
      emissiveWeight: 1,
      scatter: 0.75,
      levels: 6,
    },
    fog: {
      enabled: true,
      color: [0.11, 0.13, 0.19],
      density: 0.65,
      top: 0.55,
      bottom: 1.0,
      falloff: 1.6,
      noiseScale: 3.0,
      speed: 0.04,
      lightScatter: 0.6,
    },
    godRays: {
      enabled: true,
      x: 960,
      y: -80,
      intensity: 0.45,
      decay: 0.965,
      density: 0.85,
      weight: 0.035,
      color: [0.7, 0.85, 1.0],
      sourceRadius: 160,
      sourceIntensity: 1.0,
      bloomSource: 0.35,
    },
    vignette: { enabled: true, intensity: 0.65, radius: 0.55, softness: 0.55, color: [0, 0, 0] },
    grade: {
      enabled: true,
      exposure: 1,
      tonemap: 'aces',
      lift: [0, 0, 0],
      gamma: [1, 1, 1],
      gain: [1, 1, 1],
      saturation: 1.1,
      contrast: 1.05,
      dither: true,
    },
    ao: { enabled: false, radius: 0.5, intensity: 1, bias: 0.02, power: 1.5 },
    dof: { enabled: false, focusDistance: 10, focusRange: 6, maxBlur: 8, nearBlur: true },
    fxaa: { enabled: false, subpixel: 0.75, edgeThreshold: 0.125 },
    lut: { texture: null, size: 32, intensity: 1 },
    grain: { intensity: 0, size: 1, luminanceResponse: 0.5, animated: true },
    aberration: { intensity: 0, radialOnly: true },
    sharpen: { amount: 0 },
    outline: {
      enabled: false,
      color: [0, 0, 0],
      thickness: 1.5,
      depthThreshold: 0.03,
      normalThreshold: 0.4,
      intensity: 1,
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };
export type PostSettingsPatch = DeepPartial<PostSettings>;

/** Shallow-per-section merge of `patch` into `target` (mutates target). */
export function applyPostPatch(target: PostSettings, patch: PostSettingsPatch): PostSettings {
  for (const key of Object.keys(patch) as (keyof PostSettings)[]) {
    const section = patch[key];
    if (section) Object.assign(target[key], section);
  }
  return target;
}

/**
 * Cost caps, separate from the look settings so presets and `blendTo` never undo them.
 * Defaults are full quality. See `PostStack.quality`.
 */
export interface PostQuality {
  /** Upper bound on `bloom.levels` (2..8). Fewer levels = less wide halo, fewer passes. */
  maxBloomLevels: number;
  /** God-ray march samples (8..64). Fewer samples are re-weighted to keep the same reach. */
  raySamples: number;
  /** Floor-mist fbm octaves for the main layer (2..5); the second layer uses one fewer. */
  fogOctaves: number;
  /**
   * Run the composite (mist, tonemap, grade, dither) at the scene's resolution and upscale
   * the result with one bilinear fetch, instead of compositing every output pixel. Only acts
   * when the scene is smaller than the output (reduced resolution). Softer mist and dither;
   * saves most of the composite's fill at high DPR.
   */
  compositeAtScene: boolean;
  /** Ambient-occlusion spiral samples per pixel (4..16). */
  aoSamples: number;
  /** Depth-of-field gather taps per pixel (8..32). */
  dofTaps: number;
  /** Allow the FXAA pass; `false` (the low tier) keeps `fxaa.enabled` from adding a pass. */
  fxaa: boolean;
  /** Allow the outline pass; `false` (the low tier) keeps it off. */
  outline: boolean;
}

export function defaultPostQuality(): PostQuality {
  return {
    maxBloomLevels: 8,
    raySamples: 64,
    fogOctaves: 5,
    compositeAtScene: false,
    aoSamples: 12,
    dofTaps: 24,
    fxaa: true,
    outline: true,
  };
}

/** The low tier's caps: fewer bloom levels, samples and octaves; no FXAA or outline pass. */
export function lowPostQuality(): PostQuality {
  return {
    maxBloomLevels: 4,
    raySamples: 24,
    fogOctaves: 3,
    compositeAtScene: true,
    aoSamples: 6,
    dofTaps: 12,
    fxaa: false,
    outline: false,
  };
}

/**
 * What the depth passes need from the frame's projection (ws/post-depth): the clip → view
 * inverse, the clip planes and the output width (`dof.maxBlur` is in output px). `null` when
 * the frame rendered no depth; the packed uniforms then turn AO and DoF off.
 */
export interface PostDepthInfo {
  near: number;
  far: number;
  /** Inverse of the projection, column-major. */
  invProj: ArrayLike<number>;
  /** The projection's own x/y scale (`proj[0]`, `proj[5]`), to project a world radius. */
  projX: number;
  projY: number;
  outputWidth: number;
}

/** Uniform layout shared by all post shaders: 22 × vec4f + mat4x4f + 7 × vec4f. */
export const POST_UNIFORM_FLOATS = 132;

export const WGSL_POST_UNIFORMS = /* wgsl */ `
struct PostUniforms {
  frame: vec4f,      // time, aspect, 1/width, 1/height
  enables: vec4f,    // bloom, fog, rays, vignette
  enables2: vec4f,   // grade, tonemap (0 none, 1 aces, 2 reinhard), dither, exposure
  bloom: vec4f,      // intensity, threshold, knee, emissiveWeight
  bloom2: vec4f,     // scatter, -, -, -
  fogColor: vec4f,   // rgb, density
  fog: vec4f,        // top, bottom, noiseScale, speed
  fog2: vec4f,       // lightScatter, falloff, -, -
  rays: vec4f,       // light uv x, y, intensity, decay
  rays2: vec4f,      // density, weight, source radius (uv-y units), source intensity
  raysColor: vec4f,  // rgb, bloomSource
  vignette: vec4f,   // intensity, radius, softness, -
  vignetteColor: vec4f,
  lift: vec4f,
  gamma: vec4f,
  gain: vec4f,
  grade: vec4f,      // saturation, contrast, -, -
  quality: vec4f,    // ray samples, fog octaves, -, -
  ao: vec4f,         // enabled (0 without depth), radius, intensity, bias
  ao2: vec4f,        // power, samples, proj x scale, proj y scale
  dof: vec4f,        // enabled (0 without depth), focus distance, focus range, max blur (uv of width)
  dof2: vec4f,       // near blur, taps, near plane, far plane
  invProj: mat4x4f,  // clip -> view
  fxaa: vec4f,       // enabled, subpixel, edgeThreshold, -
  lut: vec4f,        // enabled, (size-1)/size, intensity, 0.5/size
  grain: vec4f,      // intensity, cell size (px), luminanceResponse, seed
  aberration: vec4f, // intensity (px), radialOnly, -, -
  sharpen: vec4f,    // amount, -, -, -
  outline: vec4f,    // enabled (0 without depth), thickness (scene px), depthThreshold, normalThreshold
  outlineColor: vec4f, // rgb, intensity
};
@group(0) @binding(0) var<uniform> P: PostUniforms;
`;

const TONEMAP_ID: Record<Tonemap, number> = { none: 0, aces: 1, reinhard: 2 };

/** Pack settings into the uniform array (no allocation). */
export function packPostUniforms(
  out: Float32Array,
  s: PostSettings,
  time: number,
  width: number,
  height: number,
  logicalWidth: number,
  logicalHeight: number,
  quality: PostQuality = DEFAULT_QUALITY,
  depth: PostDepthInfo | null = null,
  grainSeed = 0,
): void {
  const b = s.bloom;
  const f = s.fog;
  const r = s.godRays;
  const v = s.vignette;
  const g = s.grade;
  let o = 0;
  o = put(out, o, time, width / height, 1 / width, 1 / height);
  o = put(out, o, +b.enabled, +f.enabled, +r.enabled, +v.enabled);
  o = put(out, o, +g.enabled, g.enabled ? TONEMAP_ID[g.tonemap] : 1, +g.dither, g.exposure);
  o = put(out, o, b.intensity, b.threshold, b.knee, b.emissiveWeight);
  o = put(out, o, b.scatter, 0, 0, 0);
  o = put(out, o, f.color[0], f.color[1], f.color[2], f.density);
  o = put(out, o, f.top, f.bottom, f.noiseScale, f.speed);
  o = put(out, o, f.lightScatter, f.falloff, 0, 0);
  o = put(out, o, r.x / logicalWidth, r.y / logicalHeight, r.intensity, r.decay);
  o = put(out, o, r.density, r.weight, r.sourceRadius / logicalHeight, r.sourceIntensity);
  o = put(out, o, r.color[0], r.color[1], r.color[2], r.bloomSource);
  o = put(out, o, v.intensity, v.radius, v.softness, 0);
  o = put(out, o, v.color[0], v.color[1], v.color[2], 0);
  o = put(out, o, g.lift[0], g.lift[1], g.lift[2], 0);
  o = put(out, o, g.gamma[0], g.gamma[1], g.gamma[2], 0);
  o = put(out, o, g.gain[0], g.gain[1], g.gain[2], 0);
  o = put(out, o, g.saturation, g.contrast, 0, 0);
  o = put(
    out,
    o,
    Math.round(Math.min(64, Math.max(8, quality.raySamples))),
    Math.round(Math.min(5, Math.max(2, quality.fogOctaves))),
    0,
    0,
  );
  const a = s.ao;
  const d = s.dof;
  const ao = depth !== null && a.enabled ? 1 : 0;
  const dof = depth !== null && d.enabled ? 1 : 0;
  o = put(out, o, ao, a.radius, a.intensity, a.bias);
  o = put(
    out,
    o,
    a.power,
    Math.round(Math.min(16, Math.max(4, quality.aoSamples))),
    depth?.projX ?? 1,
    depth?.projY ?? 1,
  );
  const blurUv = depth ? d.maxBlur / Math.max(1, depth.outputWidth) : 0;
  o = put(out, o, dof, d.focusDistance, Math.max(1e-3, d.focusRange), blurUv);
  o = put(
    out,
    o,
    +d.nearBlur,
    Math.round(Math.min(32, Math.max(8, quality.dofTaps))),
    depth?.near ?? 0,
    depth?.far ?? 0,
  );
  if (depth) {
    for (let i = 0; i < 16; i++) out[o + i] = depth.invProj[i]!;
  } else {
    for (let i = 0; i < 16; i++) out[o + i] = 0;
  }
  o += 16;
  // Finishing passes (ws/post-2).
  const x = s.fxaa;
  const l = s.lut;
  const gr = s.grain;
  const ab = s.aberration;
  const ol = s.outline;
  o = put(out, o, x.enabled && quality.fxaa ? 1 : 0, x.subpixel, x.edgeThreshold, 0);
  const n = Math.max(2, l.size);
  o = put(out, o, l.texture !== null ? 1 : 0, (n - 1) / n, l.intensity, 0.5 / n);
  o = put(
    out,
    o,
    gr.intensity,
    Math.max(1, gr.size),
    gr.luminanceResponse,
    gr.animated ? grainSeed : 0,
  );
  o = put(out, o, ab.intensity, +ab.radialOnly, 0, 0);
  o = put(out, o, s.sharpen.amount, 0, 0, 0);
  const outline = depth !== null && ol.enabled && quality.outline ? 1 : 0;
  // `thickness` is in output px; the outline pass runs at the scene size.
  const thick = depth ? (ol.thickness * width) / Math.max(1, depth.outputWidth) : ol.thickness;
  o = put(out, o, outline, thick, ol.depthThreshold, ol.normalThreshold);
  put(out, o, ol.color[0], ol.color[1], ol.color[2], ol.intensity);
}

const DEFAULT_QUALITY = defaultPostQuality();

function put(out: Float32Array, o: number, x: number, y: number, z: number, w: number): number {
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = w;
  return o + 4;
}
