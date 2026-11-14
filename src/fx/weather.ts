/**
 * ws/core-effects (B5): weather on the render core. Precipitation volumes that follow the camera
 * (rain streaks, snow flakes, wind-blown dust), stopped by an occlusion height, pushed by a wind
 * vector and scaled by an intensity knob. Rain, snow and a dust storm are configs of the same
 * drawable (`WEATHER_RAIN`, `WEATHER_SNOW`, `WEATHER_DUST_STORM`).
 *
 * One instanced `drawIndirect` draws every layer, its instance count written in `prepare`, so
 * the recorded bundle stays put while counts, wind and intensity change, and both eyes of a
 * stereo pair execute it.
 */
import type { Knob } from '../quality/governor';
import { stepKnob } from '../quality/knobs';
import type { RenderCore } from '../render/core/core';
import {
  type CoreDrawable,
  type CoreDrawableEncoder,
  type CoreDrawContext,
  CoreViewExtras,
  DrawablePipelines,
} from '../render/core/drawable';
import { coreDepthCompare } from '../render/core/pass-list';
import { coreColorTargets } from '../render/core/targets';
import { VIEW_SLOT } from '../render/core/view';
import { createShaderModule } from '../render/wgsl';
import {
  WEATHER_HEAD_FLOATS,
  WEATHER_LAYER_FLOATS,
  WEATHER_MAX_LAYERS,
  WEATHER_WGSL,
} from './weather-wgsl';

/**
 * How one layer's pieces are drawn. `'splash'` (ws/fx-fit): rings on the occluding surface
 * (the flat height or the map) around the anchor; `length` is the ring's radius at its widest,
 * `speed` how many times a second each one replays, `height` unused. No surface (no flat height
 * and no map): none drawn.
 */
export type PrecipShape = 'streak' | 'flake' | 'dust' | 'splash';

/** One precipitation layer: a volume of falling (or blowing) pieces around the anchor. */
export interface PrecipLayer {
  shape: PrecipShape;
  /** Pieces at intensity 1 and density 1. */
  count: number;
  /** Half the volume's width (world units). */
  radius: number;
  /** The volume's height (world units). */
  height: number;
  /** Fall speed (units/s; dust: how fast it cycles). */
  speed: number;
  /** How much of the wind the layer takes (0..1+). Default 0.3. */
  windFactor?: number;
  /** Piece length along its motion (streak) or size (flake, dust). */
  length: number;
  /** Piece width. Default `length`. */
  width?: number;
  /** Linear rgb, premultiplied at draw. */
  color: readonly [number, number, number];
  alpha: number;
  /** Flakes: sideways drift (units). Default 0. */
  flutter?: number;
}

/** A weather config: its layers, wind and intensity. */
export interface WeatherConfig {
  layers: readonly PrecipLayer[];
  /** Wind on the ground plane, `[x, z]` units/s. Default `[0, 0]`. */
  wind?: readonly [number, number];
  /** 0..1: scales every layer's count. Default 1. */
  intensity?: number;
}

/** A height map that stops precipitation: an r32float texture over a rectangle of the xz plane. */
export interface WeatherOcclusionMap {
  texture: GPUTexture;
  /** World x, z of the texture's (0, 0) corner. */
  origin: readonly [number, number];
  /** World extent the texture covers, x and z. */
  size: readonly [number, number];
  /**
   * ws/fx-fit: the map tiles the plane (texel `floor((xz - origin) / size * dims)` modulo its
   * size), so a map kept around the eye, written in place as it moves (a ring buffer), covers an
   * endless world. Default false: outside the rectangle only the flat height stops anything.
   */
  wrap?: boolean;
}

export interface WeatherOptions extends Partial<WeatherConfig> {
  /** Pieces die below this world height. Default -Infinity. */
  occlusionHeight?: number;
  /** A height map raising the occlusion height where it covers. */
  occlusionMap?: WeatherOcclusionMap | null;
  /** 0..1: the quality knob's share of every count. Default 1. */
  density?: number;
  /** A multiplier on every layer's colour (the scene's light). Default 1. */
  light?: number;
  /** Pieces nearer the eye than this are skipped (units). Default 0.6. */
  nearFade?: number;
  /** Pass to draw in. Default `'transparent'`. */
  pass?: string;
}

const MAX_HEIGHT = 1e9;

/** Rain: fast thin streaks (Forge Wilds' rain, as a config). */
export const WEATHER_RAIN: WeatherConfig = {
  layers: [
    {
      shape: 'streak',
      count: 6000,
      radius: 26,
      height: 34,
      speed: 13,
      windFactor: 0.3,
      length: 0.65,
      width: 0.014,
      color: [0.7, 0.75, 0.82],
      alpha: 0.45,
    },
  ],
  wind: [1, 0.4],
};

/** Snow: slow fluttering flakes. */
export const WEATHER_SNOW: WeatherConfig = {
  layers: [
    {
      shape: 'flake',
      count: 5000,
      radius: 16,
      height: 22,
      speed: 1.5,
      windFactor: 0.45,
      length: 0.1,
      color: [0.95, 0.97, 1],
      alpha: 0.9,
      flutter: 0.35,
    },
  ],
  wind: [0.6, 0.2],
};

/** A desert dust storm: low dense dust in a strong wind, with coarse grit streaking through. */
export const WEATHER_DUST_STORM: WeatherConfig = {
  layers: [
    {
      shape: 'dust',
      count: 7000,
      radius: 22,
      height: 8,
      speed: 2,
      windFactor: 1,
      length: 0.45,
      width: 0.05,
      color: [0.78, 0.6, 0.38],
      alpha: 0.22,
    },
    {
      shape: 'streak',
      count: 2500,
      radius: 14,
      height: 6,
      speed: 1.2,
      windFactor: 1.4,
      length: 0.35,
      width: 0.02,
      color: [0.62, 0.48, 0.3],
      alpha: 0.35,
    },
  ],
  wind: [9, 3],
};

const SHAPES: Record<PrecipShape, number> = { streak: 0, flake: 1, dust: 2, splash: 3 };

/** Rain with splashes: `WEATHER_RAIN`'s streaks and rings where they land (ws/fx-fit). */
export const WEATHER_RAIN_SPLASHES: WeatherConfig = {
  layers: [
    ...WEATHER_RAIN.layers,
    {
      shape: 'splash',
      count: 400,
      radius: 12,
      height: 0,
      speed: 1.4,
      length: 0.16,
      color: [0.8, 0.85, 0.9],
      alpha: 0.5,
    },
  ],
  wind: WEATHER_RAIN.wind,
};

/**
 * Precipitation on a render core: `new Weather(core, WEATHER_RAIN)`. It adds itself as a core
 * drawable; call `update(dt)` each frame and `configure` to change the weather.
 */
export class Weather implements CoreDrawable {
  readonly label = 'weather';
  readonly pass: string;
  readonly order = 10;
  readonly encoding = 'bundle';
  version = 0;
  /** Drawn when there is anything to draw (`instances > 0`). */
  active = false;
  /** Wind `[x, z]` units/s. Live. */
  readonly wind = new Float32Array(2);
  /** 0..1, scales every count. Live. */
  intensity = 1;
  /** 0..1, the quality share of every count (the `weatherDensityKnob`). Live. */
  density = 1;
  /** Pieces die below this world height. Live. */
  occlusionHeight: number;
  /** A colour multiplier (the scene's light). Live. */
  light: number;
  /** Near-eye skip distance. Live. */
  nearFade: number;
  /**
   * World position the volumes follow; null (default) follows view 0's eye, which both eyes of a
   * pair share, so the columns are the same in each eye.
   */
  anchor: [number, number, number] | null = null;
  /** Instances drawn last `prepare`. */
  instances = 0;
  /** Seconds of simulated time. */
  time = 0;

  private readonly core: RenderCore;
  private readonly extras: CoreViewExtras;
  private readonly uniform: GPUBuffer;
  private readonly data = new Float32Array(
    WEATHER_HEAD_FLOATS + WEATHER_MAX_LAYERS * WEATHER_LAYER_FLOATS,
  );
  private readonly args: GPUBuffer;
  private readonly argData = new Uint32Array(4);
  private readonly layout: GPUBindGroupLayout;
  private readonly pipes: DrawablePipelines;
  private readonly noMap: GPUTexture;
  private layers: PrecipLayer[] = [];
  private map: WeatherOcclusionMap | null;
  private group: GPUBindGroup | null = null;
  private lastInstances = -1;

  constructor(core: RenderCore, opts: WeatherOptions = {}) {
    const device = core.device;
    this.core = core;
    this.pass = opts.pass ?? 'transparent';
    this.occlusionHeight = opts.occlusionHeight ?? -Infinity;
    this.map = opts.occlusionMap ?? null;
    this.density = opts.density ?? 1;
    this.light = opts.light ?? 1;
    this.nearFade = opts.nearFade ?? 0.6;
    this.extras = CoreViewExtras.of(core);
    this.uniform = device.createBuffer({
      label: 'weather',
      size: this.data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.args = device.createBuffer({
      label: 'weather args',
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    this.noMap = device.createTexture({
      label: 'weather no map',
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const V = GPUShaderStage.VERTEX;
    this.layout = device.createBindGroupLayout({
      label: 'weather',
      entries: [
        { binding: 0, visibility: V, buffer: {} },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: V, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const module = createShaderModule(device, WEATHER_WGSL, 'weather');
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [core.viewLayout, this.layout],
    });
    this.pipes = new DrawablePipelines((color, depth, _readOnly, aux, reversedZ) =>
      device.createRenderPipeline({
        label: 'weather',
        layout,
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          // Rain and snow write colour only: the core's extra targets keep what is behind.
          targets: coreColorTargets(
            {
              format: color,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
            aux,
          ),
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: depth
          ? {
              format: depth,
              depthWriteEnabled: false,
              depthCompare: coreDepthCompare(reversedZ, true),
            }
          : undefined,
      }),
    );
    this.configure({ layers: opts.layers ?? [], wind: opts.wind, intensity: opts.intensity });
    core.addDrawable(this);
  }

  /** Switch to `config` (its layers, and its wind and intensity when given). */
  configure(config: WeatherConfig): void {
    if (config.layers.length > WEATHER_MAX_LAYERS) {
      throw new RangeError(`Weather: at most ${WEATHER_MAX_LAYERS} layers`);
    }
    this.layers = config.layers.map((l) => ({ ...l }));
    if (config.wind) this.wind.set(config.wind);
    if (config.intensity !== undefined) this.intensity = config.intensity;
  }

  /** Layers in the current config (change them with `configure`). */
  get layerCount(): number {
    return this.layers.length;
  }

  /**
   * A height map that stops precipitation (null: the flat `occlusionHeight` only). Moving a
   * wrapping map's `origin` needs no call: `prepare` reads it each frame.
   */
  setOcclusionMap(map: WeatherOcclusionMap | null): void {
    if (map === this.map) return;
    this.map = map;
    this.group = null;
    this.version++;
  }

  /** Advance the fall by `dt` seconds. */
  update(dt: number): void {
    this.time += dt;
  }

  prepare(): void {
    const d = this.data;
    const core = this.core;
    const o = core.origin;
    // The anchor in the core's frame: view 0's eye (already there), or a world point less the origin.
    const a = this.anchor;
    if (a) {
      d[0] = a[0] - o[0]!;
      d[1] = a[1] - o[1]!;
      d[2] = a[2] - o[2]!;
    } else {
      const v = core.viewData;
      d[0] = v[VIEW_SLOT.position]!;
      d[1] = v[VIEW_SLOT.position + 1]!;
      d[2] = v[VIEW_SLOT.position + 2]!;
    }
    // Wrapped so the hash stays precise over a long session (each column's phase repeats).
    d[3] = this.time % 3600;
    const layers = this.layers;
    d[4] = this.wind[0]!;
    d[5] = this.wind[1]!;
    d[6] = this.intensity;
    d[7] = layers.length;
    const occl = this.occlusionHeight;
    d[8] = Number.isFinite(occl) ? occl - o[1]! : -MAX_HEIGHT;
    const map = this.map;
    d[9] = map ? (map.wrap ? 2 : 1) : 0;
    d[10] = map ? map.origin[0] - o[0]! : 0;
    d[11] = map ? map.origin[1] - o[2]! : 0;
    d[12] = map ? map.size[0] : 1;
    d[13] = map ? map.size[1] : 1;
    d[14] = this.nearFade;
    d[15] = this.light;
    const share = clamp01(this.intensity) * clamp01(this.density);
    let first = 0;
    for (let i = 0; i < WEATHER_MAX_LAYERS; i++) {
      const at = WEATHER_HEAD_FLOATS + i * WEATHER_LAYER_FLOATS;
      const l = layers[i];
      if (!l) {
        d.fill(0, at, at + WEATHER_LAYER_FLOATS);
        d[at] = MAX_HEIGHT;
        continue;
      }
      const n = Math.round(l.count * share);
      d[at] = first;
      d[at + 1] = n;
      d[at + 2] = l.radius;
      d[at + 3] = l.height;
      d[at + 4] = l.speed;
      d[at + 5] = l.windFactor ?? 0.3;
      d[at + 6] = l.length;
      d[at + 7] = l.width ?? l.length;
      d[at + 8] = l.color[0];
      d[at + 9] = l.color[1];
      d[at + 10] = l.color[2];
      d[at + 11] = l.alpha;
      d[at + 12] = SHAPES[l.shape];
      d[at + 13] = l.flutter ?? 0;
      d[at + 14] = i * 7919.5;
      d[at + 15] = 0;
      first += n;
    }
    this.instances = first;
    this.active = first > 0;
    if (!this.active) return;
    this.extras.update();
    const q = core.device.queue;
    q.writeBuffer(this.uniform, 0, d);
    if (first !== this.lastInstances) {
      this.lastInstances = first;
      const args = this.argData;
      args[0] = 6;
      args[1] = first;
      args[2] = 0;
      args[3] = 0;
      q.writeBuffer(this.args, 0, args);
    }
  }

  /** Its pipeline's empty first draw (`CoreDrawable.warm`, ws/warm-voxel-fit). */
  warm(enc: GPURenderPassEncoder, ctx: CoreDrawContext): number {
    enc.setPipeline(this.pipes.get(ctx));
    enc.setBindGroup(0, ctx.viewGroup);
    enc.setBindGroup(1, this.bindGroup());
    enc.draw(0);
    return 4;
  }

  record(enc: CoreDrawableEncoder, ctx: CoreDrawContext): number {
    enc.setPipeline(this.pipes.get(ctx));
    enc.setBindGroup(0, ctx.viewGroup);
    enc.setBindGroup(1, this.bindGroup());
    enc.drawIndirect(this.args, 0);
    return 1;
  }

  private bindGroup(): GPUBindGroup {
    if (this.group) return this.group;
    this.group = this.core.device.createBindGroup({
      label: 'weather',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.extras.buffer } },
        { binding: 2, resource: (this.map?.texture ?? this.noMap).createView() },
      ],
    });
    return this.group;
  }

  destroy(): void {
    this.core.removeDrawable(this);
    this.uniform.destroy();
    this.args.destroy();
    this.noMap.destroy();
    this.group = null;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Options for `weatherDensityKnob`. */
export interface WeatherDensityKnobOptions {
  /** The lowest density. Default 0.25. */
  min?: number;
  /** Change per step. Default 0.25. */
  step?: number;
  /** Default `'weather density'`. */
  name?: string;
  cost?: number;
}

/**
 * Weather density as a governor knob (C7): each step moves `density` (1 down to `min`), which
 * thins every layer's count while `intensity` stays the scene's call. Live: the indirect count
 * changes, the bundle does not.
 */
export function weatherDensityKnob(
  weather: { density: number },
  opts: WeatherDensityKnobOptions = {},
): Knob {
  return stepKnob({
    name: opts.name ?? 'weather density',
    cost: opts.cost,
    get: () => weather.density,
    set: (v) => {
      weather.density = v;
    },
    min: opts.min ?? 0.25,
    max: 1,
    step: opts.step ?? 0.25,
  });
}
