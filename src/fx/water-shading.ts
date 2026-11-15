/**
 * ws/water-split (E18): the water's shading without its plane. `WaterShading` keeps a water's
 * settings, clock and blocks on a render core for its looks (`WaterLook`: a game's own geometry
 * shaded as this water), and imports none of the plane's code (`Mesh`, `geom`'s `plane`, the
 * `Renderer`'s scene pipelines, the plane's shaders): a game that shades its own water bundles
 * the look alone. `Water` packs its blocks and makes its looks with the same functions.
 */

import type { RenderCore } from '../render/core/core';
import { type CoreDrawable, CoreViewExtras } from '../render/core/drawable';
import type { CoreTargetName } from '../render/core/targets';
import { fxDepthCode } from './depth';
import type { WaterOptions } from './water';
import { WATER_CORE_FLOATS, WATER_MAX_WAVES, waterLookWgsl } from './water-shade-wgsl';

/** Floats in the water's params block: 5 vec4 + `WATER_MAX_WAVES` vec4 (144 bytes). */
export const WATER_PARAMS_FLOATS = 20 + WATER_MAX_WAVES * 4;

/** One scrolling wave layer (`WaterOptions.waves`, `Water.waves`). */
export interface WaterWave {
  /** World units → field units (bigger is choppier). */
  scale: number;
  /** Field units scrolled per second. */
  speed: number;
  /** Normal strength (and, times `displace`, height) of the layer. */
  amplitude: number;
  /** Scroll direction in the xz plane; normalised when packed. */
  direction: [number, number];
}

/** Foam settings (`WaterOptions.foam`, `Water.foam`); `null` for none. */
export interface WaterFoam {
  /** World units of water depth under which foam forms. Default 0.4. */
  width: number;
  /** Linear RGB. Default near white. */
  color: ArrayLike<number>;
}

/**
 * The water as a look over a game's own geometry (`Water.look`, `WaterShading.look`,
 * ws/scene-read-fit): what a draw set (or a `VoxelMaterial`) that shades its surfaces as this
 * water takes. The set reads the core's scene depth (and colour, with `readsColor`) through the
 * core's scene-read group, in a pass that does not write depth (`'transparent'`).
 */
export interface WaterLook {
  /**
   * WGSL to put after the set's prelude, before its fragment: the water's group at the look's
   * index, `water_look(frag, rel, up) -> WaterShade` (`frag` the fragment's builtin
   * position, `rel` its core-frame position, `up` its normal; the waves bend what faces up)
   * and `water_look_out(s) -> WaterLookOut` (colour, rough-metal, velocity at the core's
   * locations). Call `water_look` in uniform control flow (it takes screen derivatives). It
   * declares `water`, `wc`, `extras` and the engine's noise helpers.
   */
  readonly wgsl: string;
  /** The water's bind group, for the set's `bindGroups` at the look's index. */
  readonly bindGroup: { readonly layout: GPUBindGroupLayout; readonly group: GPUBindGroup };
  /** Premultiplied alpha (the shading's colour is premultiplied). */
  readonly blend: GPUBlendState;
  /** The core targets `water_look_out` writes. */
  readonly writes: readonly CoreTargetName[];
  /** Always true: the shoreline, depth tint and foam read the scene depth. */
  readonly readsDepth: true;
  /** True when the water refracts or reflects the scene (`WaterOptions.refraction` > 0 or reflection steps). */
  readonly readsColor: boolean;
}

/**
 * Options for `WaterShading`: `WaterOptions`' shading settings (the plane's own, `size`,
 * `segments`, `origin`, `displace`, `plane`, and the `Renderer`'s, `depthTarget` and
 * `readsDepth`, have no use without a plane). `level` is the surface's world height.
 */
export interface WaterShadingOptions
  extends Pick<
    WaterOptions,
    | 'level'
    | 'shallowColor'
    | 'deepColor'
    | 'depthFade'
    | 'fresnel'
    | 'roughness'
    | 'waves'
    | 'foam'
    | 'opacity'
    | 'refraction'
    | 'reflectionSteps'
    | 'reflectionReach'
    | 'sunDirection'
    | 'sunColor'
    | 'skyColor'
    | 'shade'
  > {
  /**
   * Which of its blocks `prepare` keeps current. `'shade'` (the default): those the water's
   * `water_shade` reads, found in its WGSL (`WaterShading.reads`; the engine's shading reads
   * all three), so a game's own `shade` that reads none of `water`, `wc` and `extras` costs no
   * upload a frame. `'all'`: every block, for a set whose own WGSL reads those directly.
   */
  blocks?: 'shade' | 'all';
}

/** Which of a water look's blocks its shading reads (`WaterShading.reads`, ws/g6-asks). */
export interface WaterBlockReads {
  /** The params block (`water`: colours, foam, clock, waves). */
  readonly params: boolean;
  /** The core block (`wc`: sun, sky, refraction and reflection). */
  readonly core: boolean;
  /** The core's view extras (`extras`: each view's inverse view-projection and axes). */
  readonly view: boolean;
}

const READS_ALL: WaterBlockReads = { params: true, core: true, view: true };

/**
 * @internal The blocks `water_shade` reaches: the functions it calls, transitively, in `shade`
 * and the look's WGSL (the engine's water helpers), scanned for `water`, `wc` and `extras` (comments stripped;
 * any mention counts, so it errs toward uploading). The engine's shading (`shade` undefined)
 * reads all three.
 */
export function waterShadeReads(shade: string | undefined): WaterBlockReads {
  if (shade === undefined) return READS_ALL;
  const src = waterLookWgsl(0, shade)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const bodies = new Map<string, string>();
  const fn = /\bfn\s+([A-Za-z_]\w*)\s*\(/g;
  for (let m = fn.exec(src); m; m = fn.exec(src)) {
    let depth = 0;
    let end = src.indexOf('{', fn.lastIndex);
    for (; end >= 0 && end < src.length; end++) {
      const c = src[end];
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    bodies.set(m[1]!, src.slice(fn.lastIndex, end < 0 ? src.length : end + 1));
  }
  let params = false;
  let core = false;
  let view = false;
  const seen = new Set<string>();
  const todo = ['water_shade'];
  while (todo.length > 0) {
    const name = todo.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const t of bodies.get(name)?.match(/[A-Za-z_]\w*/g) ?? []) {
      if (t === 'water') params = true;
      else if (t === 'wc') core = true;
      else if (t === 'extras') view = true;
      else if (bodies.has(t)) todo.push(t);
    }
  }
  return { params, core, view };
}

/**
 * @internal Copy `src` into `last` and say whether any value differed (`last` starts NaN, so a
 * first call differs). No allocation.
 */
export function blockChanged(src: Float32Array, last: Float32Array): boolean {
  let changed = false;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (last[i] !== v) {
      last[i] = v;
      changed = true;
    }
  }
  return changed;
}

/** @internal Defaults `Water` and `WaterShading` share. */
export const WATER_DEFAULTS = {
  sunDirection: [0.4, 0.8, 0.3],
  sunColor: [1.6, 1.5, 1.3],
  sky: [0.62, 0.72, 0.9],
  shallow: [0.1, 0.45, 0.45],
  deep: [0.01, 0.07, 0.14],
  foamColor: [0.9, 0.95, 0.97],
} as const;

/** @internal The default wave layers (a new array each call: the water owns and may mutate it). */
export function defaultWaterWaves(): WaterWave[] {
  return [
    { scale: 0.35, speed: 0.6, amplitude: 0.25, direction: [1, 0.3] },
    { scale: 0.9, speed: 0.9, amplitude: 0.12, direction: [-0.4, 1] },
  ];
}

/** @internal `WaterOptions.foam` as the water keeps it. */
export function waterFoam(foam: Partial<WaterFoam> | null | undefined): WaterFoam | null {
  return foam === null
    ? null
    : { width: foam?.width ?? 0.4, color: foam?.color ?? WATER_DEFAULTS.foamColor };
}

/** @internal What the params block packs. */
export interface WaterParamsSource {
  readonly shallowColor: ArrayLike<number>;
  readonly deepColor: ArrayLike<number>;
  readonly opacity: number;
  readonly depthFade: number;
  readonly fresnel: number;
  readonly roughness: number;
  readonly level: number;
  readonly foam: WaterFoam | null;
  readonly time: number;
  readonly waves: readonly WaterWave[];
}

/**
 * @internal Pack the params block (`WATER_PARAMS_FLOATS`: shallow rgb + opacity, deep rgb +
 * depthFade, fresnel, roughness, `displace`, level, foam rgb + width, time, wave count, `depthOn`,
 * `originY`, then scale, speed, amplitude, direction angle per wave). No allocation.
 */
export function packWaterParams(
  w: WaterParamsSource,
  p: Float32Array,
  displace: number,
  depthOn: boolean,
  originY: number,
): void {
  p[0] = w.shallowColor[0]!;
  p[1] = w.shallowColor[1]!;
  p[2] = w.shallowColor[2]!;
  p[3] = w.opacity;
  p[4] = w.deepColor[0]!;
  p[5] = w.deepColor[1]!;
  p[6] = w.deepColor[2]!;
  p[7] = w.depthFade;
  p[8] = w.fresnel;
  p[9] = w.roughness;
  p[10] = displace;
  p[11] = w.level;
  const foam = w.foam;
  p[12] = foam ? (foam.color[0] ?? 0) : 0;
  p[13] = foam ? (foam.color[1] ?? 0) : 0;
  p[14] = foam ? (foam.color[2] ?? 0) : 0;
  p[15] = foam ? foam.width : 0;
  const count = Math.min(w.waves.length, WATER_MAX_WAVES);
  p[16] = w.time;
  p[17] = count;
  p[18] = depthOn ? 1 : 0;
  p[19] = originY;
  for (let i = 0; i < WATER_MAX_WAVES; i++) {
    const o = 20 + i * 4;
    const wave = i < count ? w.waves[i]! : null;
    p[o] = wave ? wave.scale : 0;
    p[o + 1] = wave ? wave.speed : 0;
    p[o + 2] = wave ? wave.amplitude : 0;
    p[o + 3] = wave ? Math.atan2(wave.direction[1], wave.direction[0]) : 0;
  }
}

/** @internal What the core block packs. */
export interface WaterCoreSource {
  readonly sunDirection: ArrayLike<number>;
  readonly sunColor: ArrayLike<number>;
  readonly skyColor: ArrayLike<number>;
  readonly refraction: number;
  readonly reflectionSteps: number;
  readonly reflectionReach: number;
}

/**
 * @internal Pack the core block (`WATER_CORE_FLOATS`: sun direction + on, sun colour, sky,
 * refraction, reflection steps, reach). Without the colour copy (`readsColor` false),
 * refraction falls back in the shader (1×1 input). No allocation.
 */
export function packWaterCore(w: WaterCoreSource, b: Float32Array, readsColor: boolean): void {
  const s = w.sunDirection;
  const len = Math.hypot(s[0]!, s[1]!, s[2]!) || 1;
  b[0] = s[0]! / len;
  b[1] = s[1]! / len;
  b[2] = s[2]! / len;
  b[3] = w.sunColor[0]! + w.sunColor[1]! + w.sunColor[2]! > 0 ? 1 : 0;
  b[4] = w.sunColor[0]!;
  b[5] = w.sunColor[1]!;
  b[6] = w.sunColor[2]!;
  b[8] = w.skyColor[0]!;
  b[9] = w.skyColor[1]!;
  b[10] = w.skyColor[2]!;
  b[12] = readsColor ? Math.max(0, w.refraction) : 0;
  b[13] = Math.max(0, Math.floor(w.reflectionSteps));
  b[14] = w.reflectionReach;
}

/** @internal The premultiplied blend a water's colour takes. */
export const WATER_PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const LOOK_WRITES: readonly CoreTargetName[] = ['roughMetal', 'velocity'];

/** @internal A water look at `group` over the water's params, core block and view extras. */
export function makeWaterLook(
  core: RenderCore,
  group: number,
  shade: string | undefined,
  params: GPUBuffer,
  block: GPUBuffer,
  extras: GPUBuffer,
  readsColor: boolean,
): WaterLook {
  const device = core.device;
  const V = GPUShaderStage.VERTEX;
  const F = GPUShaderStage.FRAGMENT;
  const layout = device.createBindGroupLayout({
    label: 'water-look-layout',
    entries: [
      { binding: 0, visibility: V | F, buffer: {} },
      { binding: 1, visibility: F, buffer: {} },
      { binding: 2, visibility: F, buffer: { type: 'read-only-storage' } },
    ],
  });
  return {
    wgsl: fxDepthCode(waterLookWgsl(group, shade), core.passes.reversedZ),
    bindGroup: {
      layout,
      group: device.createBindGroup({
        label: 'water-look',
        layout,
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: block } },
          { binding: 2, resource: { buffer: extras } },
        ],
      }),
    },
    blend: WATER_PREMULTIPLIED,
    writes: LOOK_WRITES,
    readsDepth: true,
    readsColor,
  };
}

/**
 * A water's shading on a render core without a plane (ws/water-split, E18): the settings,
 * clock and blocks behind its looks (`look`: a game's own geometry, such as a voxel world's
 * water faces, shaded as this water). It joins the core as a drawable that never draws and
 * uploads its blocks in `core.prepare`: only those its shading reads (`reads`), and each only
 * when a value in it changed (ws/g6-asks), so a still water on a still camera uploads nothing.
 * `update(dt)` advances the waves. Every field is live, as on `Water`. It bundles none of the plane's code: a game that draws its own water
 * surface takes this, not `Water` with `plane: false`.
 */
export class WaterShading implements CoreDrawable {
  readonly label = 'water-shading';
  readonly pass = 'transparent';
  readonly version = 0;
  /** Never: it draws nothing; its looks draw in the game's own sets. */
  readonly active = false;
  /** Surface height (y, world). Live. */
  level: number;
  /** Linear RGB where the water is shallow. Live. */
  readonly shallowColor = new Float32Array(3);
  /** Linear RGB at full depth. Live. */
  readonly deepColor = new Float32Array(3);
  /** World units of water depth to full `deepColor`. Live. */
  depthFade: number;
  /** Reflection strength, 0..1. Live. */
  fresnel: number;
  /** Roughness of the sun highlight. Live. */
  roughness: number;
  /** Wave layers; the first `WATER_MAX_WAVES` are uploaded. Live (replace or mutate). */
  waves: WaterWave[];
  /** Foam settings, or null for none. Live (replace or mutate). */
  foam: WaterFoam | null;
  /** Alpha away from the shoreline. Live. */
  opacity: number;
  /** Seconds `update` has advanced; the waves' clock. */
  time = 0;
  /** See `WaterOptions.refraction`. Live. */
  refraction: number;
  /** See `WaterOptions.reflectionSteps` (the `waterReflectionKnob`). Live. */
  reflectionSteps: number;
  /** See `WaterOptions.reflectionReach`. Live. */
  reflectionReach: number;
  /** The direction to the sun. Live. */
  readonly sunDirection = new Float32Array(3);
  /** The sun's linear colour. Live. */
  readonly sunColor = new Float32Array(3);
  /** The reflected sky's horizon colour. Live. */
  readonly skyColor = new Float32Array(3);
  /** Its looks sample the core's colour copy: refraction or reflection was on when made. */
  readonly readsColor: boolean;
  /**
   * The blocks `prepare` keeps current: what its `water_shade` reads (all three for the
   * engine's), or all with `blocks: 'all'`.
   */
  readonly reads: WaterBlockReads;

  private readonly shade: string | undefined;
  private readonly params = new Float32Array(WATER_PARAMS_FLOATS);
  private readonly paramsSent = new Float32Array(WATER_PARAMS_FLOATS).fill(Number.NaN);
  private readonly paramsBuffer: GPUBuffer;
  private readonly block = new Float32Array(WATER_CORE_FLOATS);
  private readonly blockSent = new Float32Array(WATER_CORE_FLOATS).fill(Number.NaN);
  private readonly blockBuffer: GPUBuffer;
  private readonly extras: CoreViewExtras;
  private readonly looks = new Map<number, WaterLook>();

  /** Added to `core` as a drawable (removed by `destroy`). */
  constructor(
    readonly core: RenderCore,
    opts: WaterShadingOptions = {},
  ) {
    const device = core.device;
    this.level = opts.level ?? 0;
    set3(this.shallowColor, opts.shallowColor ?? WATER_DEFAULTS.shallow);
    set3(this.deepColor, opts.deepColor ?? WATER_DEFAULTS.deep);
    this.depthFade = opts.depthFade ?? 4;
    this.fresnel = opts.fresnel ?? 0.6;
    this.roughness = opts.roughness ?? 0.08;
    this.waves = opts.waves ?? defaultWaterWaves();
    this.foam = waterFoam(opts.foam);
    this.opacity = opts.opacity ?? 0.85;
    this.refraction = opts.refraction ?? 1;
    this.reflectionSteps = opts.reflectionSteps ?? 16;
    this.reflectionReach = opts.reflectionReach ?? 30;
    set3(this.sunDirection, opts.sunDirection ?? WATER_DEFAULTS.sunDirection);
    set3(this.sunColor, opts.sunColor ?? WATER_DEFAULTS.sunColor);
    set3(this.skyColor, opts.skyColor ?? WATER_DEFAULTS.sky);
    this.readsColor = this.refraction > 0 || this.reflectionSteps > 0;
    this.shade = opts.shade;
    this.reads = opts.blocks === 'all' ? READS_ALL : waterShadeReads(opts.shade);
    this.extras = CoreViewExtras.of(core);
    this.paramsBuffer = device.createBuffer({
      label: 'water-params',
      size: this.params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.blockBuffer = device.createBuffer({
      label: 'water-core',
      size: this.block.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    core.addDrawable(this);
  }

  /** Advance the waves' clock. */
  update(dt: number): void {
    this.time += dt;
  }

  /**
   * Upload the blocks its shading reads (`reads`), each only when it changed (`core.prepare`
   * calls it). No allocation.
   */
  prepare(): void {
    const reads = this.reads;
    if (reads.view) this.extras.update();
    const queue = this.core.device.queue;
    if (reads.params) {
      packWaterParams(this, this.params, 0, true, 0);
      if (blockChanged(this.params, this.paramsSent)) {
        queue.writeBuffer(this.paramsBuffer, 0, this.params);
      }
    }
    if (reads.core) {
      packWaterCore(this, this.block, this.readsColor);
      if (blockChanged(this.block, this.blockSent)) {
        queue.writeBuffer(this.blockBuffer, 0, this.block);
      }
    }
  }

  /** Draws nothing (never active). */
  record(): number {
    return 0;
  }

  /**
   * This water as a look whose bind group sits at `group` in the set's layout (`1 + ` its
   * index in the set's `bindGroups`), as `Water.look`. One look per group index, kept.
   */
  look(group = 1): WaterLook {
    let look = this.looks.get(group);
    if (look) return look;
    look = makeWaterLook(
      this.core,
      group,
      this.shade,
      this.paramsBuffer,
      this.blockBuffer,
      this.extras.buffer,
      this.readsColor,
    );
    this.looks.set(group, look);
    return look;
  }

  /** Leave the core and free the blocks (its looks' groups then read freed buffers). */
  destroy(): void {
    this.core.removeDrawable(this);
    this.paramsBuffer.destroy();
    this.blockBuffer.destroy();
  }
}

/** @internal */
export function set3(out: Float32Array, v: ArrayLike<number>): void {
  out[0] = v[0] ?? 0;
  out[1] = v[1] ?? 0;
  out[2] = v[2] ?? 0;
}
