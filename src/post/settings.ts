/** Post-stack settings. All colours are linear RGB. Mutate in place at runtime; read each frame. */
import { mat4 } from '../core/math';
import { whiteBalanceMatrix } from './white-balance';

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
  /**
   * Lens dirt (ws/post-3): a texture multiplied into the bloom term at the composite
   * (`bloom × (1 + dirt × intensity)`), so glow shows the smudges. `createLensDirtTexture`
   * paints a procedural one; `texture: null` (or no `dirt`) is off and costs nothing.
   */
  dirt?: LensDirtSettings;
}

/** The lens-dirt texture and its strength (ws/post-3). See `BloomSettings.dirt`. */
export interface LensDirtSettings {
  /** An `rgba8unorm` 2D texture sampled over the whole screen, or `null` for none. */
  texture: GPUTexture | null;
  /** How much the dirt brightens the bloom where it is white (0 = none). */
  intensity: number;
}

/**
 * The screen-space floor mist (ws/api-render: `PostSettings.mist`, formerly `fog`): a noisy
 * haze rising from the bottom of the screen, composited after bloom. It is not distance fog;
 * `Lights.fog` (render) fades 3D surfaces with their distance inside the materials. The two
 * stack: the distance fog is already in the scene colour when the mist goes on top.
 */
export interface MistSettings {
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

/** @deprecated (ws/api-render) Use `MistSettings` (the same shape). Removed next minor. */
export type FogSettings = MistSettings;

export interface GodRaySettings {
  enabled: boolean;
  /**
   * Light position in logical coordinates (may be off-screen): the 2D placement, used unless
   * `direction` is set and the frame has a 3D view.
   */
  x: number;
  y: number;
  /**
   * World-space direction the light travels, like `Lights.sun.direction` (ws/api-render). When
   * set and the frame has a 3D view (`PostInputs.view`), the rays come from where that
   * direction's source sits on screen each frame (`godRaySource`) instead of `x`/`y`, and they
   * go out while the sun is behind the camera. `null` or absent: `x`/`y`.
   */
  direction?: RGB | null;
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

/**
 * Temporal anti-aliasing (ws/post-3): the stack keeps a history colour texture at scene res,
 * reprojects it by the previous frame's view-projection against the current depth, clamps it to
 * the current pixel's 3×3 neighbourhood and blends it in by `feedback`. Needs the scene depth
 * and a frame with a view (3D path); when on, FXAA is skipped. Resize and the first frame
 * reset the history. `PostStack.taa.jitter(frame)` gives the frame's sub-pixel offset.
 *
 * Reprojection (ws/post-5): with a velocity target (`PostInputs.velocity`) and `reprojection`
 * `'velocity'` (the default) each pixel finds its history at `uv - velocity` (the velocity of
 * the nearest depth in its 3×3, so a moving or skinned object's edge follows it), falling back
 * to the camera matrix where nothing wrote a velocity; the history is dropped where its depth
 * or velocity disagree with the pixel's by more than `depthReject` / `velocityReject`.
 * Without the target, or in `'camera'`, the camera matrix alone reprojects, as before.
 */
export interface TaaSettings {
  enabled: boolean;
  /** Weight of the (clamped) history in the blend, 0..0.98 (0.9 = ~10 frames of memory). */
  feedback: number;
  /** Unsharp amount on the resolved colour, undoing the blend's softness (0 = none). */
  sharpen: number;
  /** `'aabb'`: clamp the history to the neighbourhood min/max; `'variance'`: to mean ± 1 σ. */
  clampMode: 'aabb' | 'variance';
  /**
   * What finds a pixel's history (ws/post-5): `'velocity'` the velocity target where the frame
   * has one (else the camera), `'camera'` the camera's previous view-projection only.
   */
  reprojection: TaaReprojection;
  /**
   * `'velocity'` only: drop the history where its linear depth differs from the pixel's by more
   * than this fraction of the nearer one (0.1 = 10 %).
   */
  depthReject: number;
  /** `'velocity'` only: drop the history where its velocity differs by more than this, in px. */
  velocityReject: number;
  /**
   * How the resolve reads the history between texels (ws/post-6): `'catmull-rom'` (the
   * default) a 5-tap Catmull-Rom sample, which keeps a slowly moving surface sharp;
   * `'bilinear'` one bilinear tap, which softens it a little more every frame it moves by a
   * fraction of a pixel. Either is clamped to the 3×3 neighbourhood.
   */
  historyFilter: TaaHistoryFilter;
}

/** What TAA reprojects its history by (ws/post-5). See `TaaSettings.reprojection`. */
export type TaaReprojection = 'camera' | 'velocity';

/** How TAA samples its history (ws/post-6). See `TaaSettings.historyFilter`. */
export type TaaHistoryFilter = 'bilinear' | 'catmull-rom';

/**
 * Screen-space reflections (ws/post-3): a half-res view-space ray march over the scene depth
 * from normals derived from it (the AO pass's helper), sampling the scene colour where the ray
 * meets the depth, faded at the screen edges and composited into the scene before bloom.
 * Needs the scene depth. Per surface (ws/post-4): with a rough-metal target
 * (`PostInputs.roughMetal`) each pixel fades by its own roughness against `roughnessCutoff` and
 * is weighted by its metalness (Schlick Fresnel from F0 0.04 for a dielectric, 1 for a metal);
 * without it every surface reads as a smooth mirror at full weight, as before.
 */
export interface SsrSettings {
  enabled: boolean;
  /** Ray-march steps (8..64); `maxDistance / maxSteps` is the step length. */
  maxSteps: number;
  /** Depth thickness (view units) a ray point may sit behind the surface and still hit. */
  thickness: number;
  /** Longest reflected ray in view units. */
  maxDistance: number;
  /** Roughness at and above which no reflection shows (0..1); below it the term fades in. */
  roughnessCutoff: number;
  /** Strength of the reflection added to the scene. */
  intensity: number;
  /** Width of the screen-edge fade in uv (0 = hard cut at the border). */
  fadeEdges: number;
}

/**
 * Exposure (ws/post-3). `'manual'`: `grade.exposure` is the multiplier, as before. `'auto'`:
 * a compute pass builds a 64-bin log-luminance histogram of the scene colour, a second averages
 * the bins between the percentile bounds, and the EV eases toward `log2(keyValue / average)`
 * clamped to `minEv..maxEv` at `speedUp` / `speedDown` per second (`PostInputs.dt`).
 * `PostStack.exposure` reads the current EV (the multiplier is `2^EV`).
 */
export interface ExposureSettings {
  mode: 'manual' | 'auto';
  /** Lowest EV auto mode may settle at (a negative EV darkens). */
  minEv: number;
  /** Highest EV auto mode may settle at. */
  maxEv: number;
  /** Rate (1/s) at which the EV rises toward a brighter target (a dark scene brightening). */
  speedUp: number;
  /** Rate (1/s) at which the EV falls toward a darker target. */
  speedDown: number;
  /** Middle-grey the metered average is mapped to (0.18 = photographic 18 %). */
  keyValue: number;
  /** Lower percentile (0..1) of the histogram the average ignores (dark outliers). */
  histogramLow: number;
  /** Upper percentile (0..1) of the histogram the average ignores (highlights). */
  histogramHigh: number;
}

/**
 * White balance (ws/post-3): a 3×3 colour matrix before the exposure and grade that tints the
 * image toward the colour of a black body at `temperature` (lower = warmer, 6500 K = none),
 * shifted by `tint` (positive toward magenta, negative toward green). Bradford chromatic
 * adaptation from the 6500 K white to the target white, in linear sRGB; see `white-balance.ts`.
 */
export interface WhiteBalanceSettings {
  /** Colour temperature in kelvin (1667..25000); 6500 is the identity. */
  temperature: number;
  /** Green–magenta shift (-1..1); 0 is the identity. */
  tint: number;
}

/**
 * Camera motion blur (ws/post-3): per-pixel velocity from the current depth reprojected by the
 * previous frame's view-projection (the matrix TAA keeps), the scene colour sampled along it
 * before bloom. Needs the scene depth. Objects moving on their own do not blur (no velocity
 * target yet; see the README's wish list).
 */
/** What a motion-blur pixel moves by (ws/post-4). See `MotionBlurSettings.mode`. */
export type MotionBlurMode = 'camera' | 'object';

export interface MotionBlurSettings {
  enabled: boolean;
  /**
   * `'object'` (the default): with a velocity target (`PostInputs.velocity`) each pixel blurs
   * along the velocity the renderer wrote for it, so moving and skinned objects smear under a
   * still camera; pixels with no velocity fall back to the camera's reprojection. Without the
   * target, and in `'camera'`, only the camera's movement blurs (the depth reprojected by the
   * previous view-projection).
   */
  mode: MotionBlurMode;
  /** Scale on the frame-to-frame velocity (1 = the full frame's movement). */
  intensity: number;
  /** Taps along the velocity (2..16). */
  maxSamples: number;
}

export interface PostSettings {
  bloom: BloomSettings;
  /** The screen-space floor mist (not `Lights.fog`, the distance fog). */
  mist: MistSettings;
  /**
   * @deprecated (ws/api-render) Use `mist`: the same section under its old name, a forwarder
   * on every settings object the module builds (`neutralPostSettings`, `cinematicPostSettings`,
   * `clonePostSettings`), and read as `mist` in a patch. Removed next minor.
   */
  fog: MistSettings;
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
  taa: TaaSettings;
  ssr: SsrSettings;
  exposure: ExposureSettings;
  whiteBalance: WhiteBalanceSettings;
  motionBlur: MotionBlurSettings;
}

/**
 * The tuned look the engine shipped with (ws/api-render names it): bloom, a cool floor mist,
 * god rays from the top centre of a 1920×1080 design, a vignette and a slight saturation and
 * contrast lift. `PostStack` and `createGame` start from it. A new settings object each call.
 */
export function cinematicPostSettings(): PostSettings {
  return withMistAlias({
    bloom: {
      enabled: true,
      intensity: 0.9,
      threshold: 1.2,
      knee: 0.5,
      emissiveWeight: 1,
      scatter: 0.75,
      levels: 6,
    },
    mist: {
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
    taa: {
      enabled: false,
      feedback: 0.9,
      sharpen: 0.2,
      clampMode: 'aabb',
      reprojection: 'velocity',
      depthReject: 0.1,
      velocityReject: 2,
      historyFilter: 'catmull-rom',
    },
    ssr: {
      enabled: false,
      maxSteps: 32,
      thickness: 0.5,
      maxDistance: 20,
      roughnessCutoff: 0.6,
      intensity: 1,
      fadeEdges: 0.15,
    },
    exposure: {
      mode: 'manual',
      minEv: -4,
      maxEv: 4,
      speedUp: 3,
      speedDown: 1,
      keyValue: 0.18,
      histogramLow: 0.4,
      histogramHigh: 0.95,
    },
    whiteBalance: { temperature: 6500, tint: 0 },
    motionBlur: { enabled: false, mode: 'object', intensity: 1, maxSamples: 8 },
  } as Omit<PostSettings, 'fog'>);
}

/**
 * A neutral preset (ws/api-render): every pass off but the tone map (ACES, exposure 1, no
 * lift, gamma, gain, saturation or contrast change, dithered), so the image is the scene and
 * nothing else. Start here and turn on what the game wants. A new settings object each call.
 */
export function neutralPostSettings(): PostSettings {
  const s = cinematicPostSettings();
  s.bloom.enabled = false;
  s.mist.enabled = false;
  s.godRays.enabled = false;
  s.vignette.enabled = false;
  s.grade.saturation = 1;
  s.grade.contrast = 1;
  return s;
}

/**
 * @deprecated (ws/api-render) The name does not say which look it is: it returns
 * `cinematicPostSettings()`. Call that, or `neutralPostSettings()` for no look. Removed next
 * minor.
 */
export function defaultPostSettings(): PostSettings {
  return cinematicPostSettings();
}

/** Define the deprecated `fog` forwarder on `s` (not enumerable, so copies and blends skip it). */
function withMistAlias(s: Omit<PostSettings, 'fog'>): PostSettings {
  Object.defineProperty(s, 'fog', {
    get(this: PostSettings) {
      return this.mist;
    },
    set(this: PostSettings, v: MistSettings) {
      this.mist = v;
    },
    enumerable: false,
    configurable: true,
  });
  return s as PostSettings;
}

/** The section a patch key names: the deprecated `fog` is `mist`. */
export function postSection(key: string): keyof PostSettings {
  return (key === 'fog' ? 'mist' : key) as keyof PostSettings;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };
export type PostSettingsPatch = DeepPartial<PostSettings>;

/**
 * A deep copy of `s` (ws/post-4): every section and every array (`RGB`) is new, so mutating
 * the copy or blending it never touches the original. GPU handles (`lut.texture`,
 * `bloom.dirt.texture`) are shared, not copied.
 */
export function clonePostSettings(s: PostSettings): PostSettings {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(s) as (keyof PostSettings)[]) out[key] = cloneValue(s[key]);
  return withMistAlias(out as unknown as Omit<PostSettings, 'fog'>);
}

function cloneValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  // `texture` fields are GPU handles: shared, never copied.
  for (const [k, x] of Object.entries(v)) out[k] = k === 'texture' ? x : cloneValue(x);
  return out;
}

/** Shallow-per-section merge of `patch` into `target` (mutates target). */
export function applyPostPatch(target: PostSettings, patch: PostSettingsPatch): PostSettings {
  for (const key of Object.keys(patch) as (keyof PostSettings)[]) {
    const section = patch[key];
    if (section) Object.assign(target[postSection(key)], section);
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
  /** Allow TAA (ws/post-3); `false` (the XR tier) keeps `taa.enabled` from adding the pass. */
  taa: boolean;
  /** Allow SSR; `false` (the low and XR tiers) keeps it off. */
  ssr: boolean;
  /** Allow the auto-exposure compute passes; `false` leaves `exposure.mode` reading as manual. */
  autoExposure: boolean;
  /** Allow camera motion blur; `false` (the low and XR tiers) keeps it off. */
  motionBlur: boolean;
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
    taa: true,
    ssr: true,
    autoExposure: true,
    motionBlur: true,
  };
}

/**
 * The low tier's caps: fewer bloom levels, samples and octaves; no FXAA, outline, SSR or
 * motion-blur pass. TAA and auto-exposure stay (cheap, and TAA replaces FXAA).
 */
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
    taa: true,
    ssr: false,
    autoExposure: true,
    motionBlur: false,
  };
}

/** A device class for `postQualityFor` (ws/post-3). */
export type PostQualityTier = 'phone' | 'tablet' | 'desktop' | 'xr';

/**
 * The cost caps for a device class (ws/post-3): `'phone'` is `lowPostQuality()`; `'tablet'`
 * trims the samples and skips SSR; `'desktop'` is everything; `'xr'` is full quality with
 * TAA, SSR and motion blur off: the XR path composites one eye at a time through the same
 * stack, so a TAA history or reprojection would mix the two eyes, and SSR costs a march per
 * eye; motion blur in a headset reads as lag.
 */
export function postQualityFor(tier: PostQualityTier): PostQuality {
  switch (tier) {
    case 'phone':
      return lowPostQuality();
    case 'tablet':
      return {
        ...defaultPostQuality(),
        maxBloomLevels: 6,
        raySamples: 48,
        aoSamples: 8,
        dofTaps: 16,
        ssr: false,
      };
    case 'xr':
      return { ...defaultPostQuality(), taa: false, ssr: false, motionBlur: false };
    default:
      return defaultPostQuality();
  }
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
  /**
   * The projection is orthographic (`proj[11] === 0`, ws/post-4): AO and SSR project a view
   * point without the divide by depth, and SSR's eye ray is the view axis.
   */
  ortho?: boolean;
}

/**
 * Per-frame state the temporal passes need (ws/post-3), kept by `PostStack`: the sub-pixel
 * jitter in uv, whether this frame resets the history, the matrix from this frame's clip space
 * to the previous frame's (`prevViewProj × invViewProj`) and the auto-exposure multiplier.
 */
export interface PostFrameState {
  jitterX: number;
  jitterY: number;
  /** 1 on a frame whose history is invalid (first frame, resize): TAA copies the current colour. */
  reset: number;
  /** Current clip → previous clip, column-major. */
  reproj: ArrayLike<number>;
  /** Linear exposure multiplier used while `exposure.mode` is `'auto'` (`2^EV`). */
  autoExposure: number;
  /** 1 when SSR reads the frame's rough-metal target (ws/post-4), else 0 (the constant path). */
  roughMetal?: number;
  /** 1 when motion blur gathers along the frame's velocity target (ws/post-4), else 0. */
  objectVelocity?: number;
  /** 1 when TAA reprojects by the frame's velocity target (ws/post-5), else 0. */
  taaVelocity?: number;
}

/**
 * Uniform layout shared by all post shaders: 22 × vec4f + mat4x4f + 17 × vec4f + mat4x4f +
 * vec4f.
 */
export const POST_UNIFORM_FLOATS = 192;

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
  quality: vec4f,    // ray samples, fog octaves, ortho projection (1, ws/post-4), -
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
  // Post 3 (ws/post-3).
  taa: vec4f,        // enabled (0 without depth), feedback, sharpen, clampMode (0 aabb, 1 variance)
  taa2: vec4f,       // view jitter x (uv), view jitter y (uv), reset (1 = copy the current frame), velocity reprojection (1, ws/post-5)
  ssr: vec4f,        // enabled (0 without depth), maxSteps, thickness, maxDistance
  ssr2: vec4f,       // roughnessCutoff, intensity, fadeEdges (uv), rough-metal target (1)
  exposure: vec4f,   // auto (1), histogramLow, histogramHigh, keyValue
  wb0: vec4f,        // white-balance matrix row 0 (rgb weights), enabled
  wb1: vec4f,        // row 1
  wb2: vec4f,        // row 2
  motionBlur: vec4f, // enabled (0 without depth), intensity, samples, velocity target (1 = object)
  dirt: vec4f,       // enabled, intensity, -, -
  reproj: mat4x4f,   // current clip -> previous frame's clip (identity on a reset)
  // Post 5 (ws/post-5).
  taa3: vec4f,       // depthReject (fraction), velocityReject (px), history filter (1 = Catmull-Rom, ws/post-6), -
};
@group(0) @binding(0) var<uniform> P: PostUniforms;
`;

const TONEMAP_ID: Record<Tonemap, number> = { none: 0, aces: 1, reinhard: 2 };

/**
 * Where a directional light's source sits on screen (ws/api-render): the point at infinity
 * opposite `direction` (the way the light travels) through `viewProj` (column-major), in
 * logical px of a `width × height` view, written to `out` as x, y. Returns 1 when the source is
 * in front of the camera and 0 when it is behind (or the projection is orthographic, which has
 * no point at infinity); `out` is left alone then. No allocation.
 */
export function godRaySource(
  viewProj: ArrayLike<number>,
  direction: ArrayLike<number>,
  width: number,
  height: number,
  out: { 0: number; 1: number } | number[] | Float32Array,
): number {
  const x = -(direction[0] ?? 0);
  const y = -(direction[1] ?? 0);
  const z = -(direction[2] ?? 0);
  const m = viewProj;
  const w = m[3]! * x + m[7]! * y + m[11]! * z;
  if (!(w > 1e-6)) return 0;
  const cx = (m[0]! * x + m[4]! * y + m[8]! * z) / w;
  const cy = (m[1]! * x + m[5]! * y + m[9]! * z) / w;
  out[0] = ((cx + 1) / 2) * width;
  out[1] = ((1 - cy) / 2) * height;
  return 1;
}

/**
 * The god-ray source for this frame: `x`/`y`, or `godRaySource` of `direction` through `view`.
 * Writes x, y and visibility into `out`.
 */
export function resolveGodRays(
  r: GodRaySettings,
  viewProj: ArrayLike<number> | null,
  logicalWidth: number,
  logicalHeight: number,
  out: Float32Array,
): void {
  out[0] = r.x;
  out[1] = r.y;
  out[2] = 1;
  if (r.direction && viewProj) {
    out[2] = godRaySource(viewProj, r.direction, logicalWidth, logicalHeight, out);
  }
}

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
  frame: PostFrameState | null = null,
  rays: Float32Array | null = null,
): void {
  const b = s.bloom;
  const f = s.mist;
  const r = s.godRays;
  const v = s.vignette;
  const g = s.grade;
  const auto = s.exposure.mode === 'auto' && quality.autoExposure && frame !== null;
  let o = 0;
  o = put(out, o, time, width / height, 1 / width, 1 / height);
  o = put(out, o, +b.enabled, +f.enabled, +r.enabled, +v.enabled);
  o = put(
    out,
    o,
    +g.enabled,
    g.enabled ? TONEMAP_ID[g.tonemap] : 1,
    +g.dither,
    auto ? frame.autoExposure : g.exposure,
  );
  o = put(out, o, b.intensity, b.threshold, b.knee, b.emissiveWeight);
  o = put(out, o, b.scatter, 0, 0, 0);
  o = put(out, o, f.color[0], f.color[1], f.color[2], f.density);
  o = put(out, o, f.top, f.bottom, f.noiseScale, f.speed);
  o = put(out, o, f.lightScatter, f.falloff, 0, 0);
  // `rays` (x, y, visibility) is the resolved source when the stack placed it from `direction`.
  const rx = rays ? rays[0]! : r.x;
  const ry = rays ? rays[1]! : r.y;
  const rv = rays ? rays[2]! : 1;
  o = put(out, o, rx / logicalWidth, ry / logicalHeight, r.intensity * rv, r.decay);
  o = put(out, o, r.density, r.weight, r.sourceRadius / logicalHeight, r.sourceIntensity * rv);
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
    depth?.ortho ? 1 : 0,
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
  o = put(out, o, ol.color[0], ol.color[1], ol.color[2], ol.intensity);
  // Post 3 (ws/post-3). The temporal passes need depth and a frame state (a view matrix).
  const temporal = depth !== null && frame !== null;
  const t = s.taa;
  const taa = temporal && t.enabled && quality.taa ? 1 : 0;
  o = put(
    out,
    o,
    taa,
    Math.min(0.98, Math.max(0, t.feedback)),
    Math.max(0, t.sharpen),
    t.clampMode === 'variance' ? 1 : 0,
  );
  o = put(
    out,
    o,
    frame?.jitterX ?? 0,
    frame?.jitterY ?? 0,
    frame?.reset ?? 1,
    taa ? (frame?.taaVelocity ?? 0) : 0,
  );
  const sr = s.ssr;
  const ssr = depth !== null && sr.enabled && quality.ssr ? 1 : 0;
  o = put(
    out,
    o,
    ssr,
    Math.round(Math.min(64, Math.max(8, sr.maxSteps))),
    Math.max(1e-3, sr.thickness),
    Math.max(1e-3, sr.maxDistance),
  );
  o = put(
    out,
    o,
    sr.roughnessCutoff,
    sr.intensity,
    Math.max(0, sr.fadeEdges),
    ssr ? (frame?.roughMetal ?? 0) : 0,
  );
  const ex = s.exposure;
  o = put(out, o, auto ? 1 : 0, ex.histogramLow, ex.histogramHigh, ex.keyValue);
  const wb = s.whiteBalance;
  const wbOn = wb.temperature !== 6500 || wb.tint !== 0;
  if (wbOn) {
    whiteBalanceMatrix(WB, wb.temperature, wb.tint);
    o = put(out, o, WB[0]!, WB[1]!, WB[2]!, 1);
    o = put(out, o, WB[3]!, WB[4]!, WB[5]!, 0);
    o = put(out, o, WB[6]!, WB[7]!, WB[8]!, 0);
  } else {
    o = put(out, o, 1, 0, 0, 0);
    o = put(out, o, 0, 1, 0, 0);
    o = put(out, o, 0, 0, 1, 0);
  }
  const mb = s.motionBlur;
  const mblur = temporal && mb.enabled && quality.motionBlur ? 1 : 0;
  o = put(
    out,
    o,
    mblur,
    mb.intensity,
    Math.round(Math.min(16, Math.max(2, mb.maxSamples))),
    mblur ? (frame?.objectVelocity ?? 0) : 0,
  );
  const dirt = b.dirt;
  o = put(out, o, dirt && dirt.texture !== null ? 1 : 0, dirt?.intensity ?? 0, 0, 0);
  if (frame) {
    for (let i = 0; i < 16; i++) out[o + i] = frame.reproj[i]!;
  } else {
    for (let i = 0; i < 16; i++) out[o + i] = IDENTITY[i]!;
  }
  o += 16;
  put(
    out,
    o,
    Math.max(0, t.depthReject),
    Math.max(0, t.velocityReject),
    t.historyFilter === 'bilinear' ? 0 : 1,
    0,
  );
}

const DEFAULT_QUALITY = defaultPostQuality();
const WB = new Float32Array(9);
const IDENTITY = mat4.create();

function put(out: Float32Array, o: number, x: number, y: number, z: number, w: number): number {
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = w;
  return o + 4;
}
