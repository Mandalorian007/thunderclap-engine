/**
 * ws/fx-fit: lightning on the render core. `strike(x, z)` throws a bolt from the sky to the
 * ground: a few strands of jagged segments (a random walk down from `height` above the ground,
 * strands branching off the main one), grown top down over `growTime` and faded over `fadeTime`,
 * drawn additively into colour and emissive (so bloom catches it) in the `'transparent'` pass.
 * `flash` is the strike's light, 0..1, flickering as it fades: the game scales its sky and sun
 * by it. A strike writes the bolt's points once (no per-frame allocation); one bundle, both eyes.
 */
import type { RenderCore } from '../render/core/core';
import {
  CORE_DRAWABLE_WGSL,
  type CoreDrawable,
  type CoreDrawableEncoder,
  type CoreDrawContext,
  DrawablePipelines,
} from '../render/core/drawable';
import { coreDepthCompare } from '../render/core/pass-list';
import { CORE_TARGET, coreColorTargets } from '../render/core/targets';
import { createShaderModule } from '../render/wgsl';

/** Strands a bolt has at most (the main one and its branches). */
export const LIGHTNING_STRANDS = 3;
/** Segments per strand. */
export const LIGHTNING_SEGMENTS = 24;
/** Floats of the lightning uniform: a head of 8, then each strand's points (xyz, w unused). */
export const LIGHTNING_FLOATS = 8 + LIGHTNING_STRANDS * (LIGHTNING_SEGMENTS + 1) * 4;

export const LIGHTNING_WGSL = /* wgsl */ `
${CORE_DRAWABLE_WGSL}
struct Bolt {
  look: vec4f,  // rgb, width
  state: vec4f, // grown (0..1), brightness, strands, unused
  points: array<vec4f, ${LIGHTNING_STRANDS * (LIGHTNING_SEGMENTS + 1)}>,
};
@group(1) @binding(0) var<uniform> bolt: Bolt;

struct BOut {
  @builtin(position) clip: vec4f,
  @location(0) across: f32,
  @location(1) light: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  var o: BOut;
  o.clip = vec4f(2.0, 2.0, 2.0, 1.0);
  let strand = ii / ${LIGHTNING_SEGMENTS}u;
  let seg = ii % ${LIGHTNING_SEGMENTS}u;
  if (f32(strand) >= bolt.state.z) { return o; }
  // Grown top down: a segment shows once the strike reaches it.
  if (f32(seg) >= bolt.state.x * ${LIGHTNING_SEGMENTS}.0) { return o; }
  let base = strand * ${LIGHTNING_SEGMENTS + 1}u;
  let a = bolt.points[base + seg].xyz;
  let b = bolt.points[base + seg + 1u].xyz;
  var ends = array<f32, 6>(0.0, 0.0, 1.0, 0.0, 1.0, 1.0);
  var sides = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0);
  let p = mix(a, b, ends[vi]);
  let along = normalize(b - a + vec3f(0.0, 1e-5, 0.0));
  let to_eye = normalize(view.position.xyz - p);
  let side = normalize(cross(along, to_eye) + vec3f(1e-5, 0.0, 0.0));
  // Branches are thinner and dimmer than the main strand.
  let main = select(0.5, 1.0, strand == 0u);
  let q = p + side * sides[vi] * bolt.look.w * main * 0.5;
  o.clip = view.viewProj * vec4f(q, 1.0);
  o.across = sides[vi];
  o.light = bolt.state.y * main;
  return o;
}

struct BFrag {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
};

@fragment fn fs(in: BOut) -> BFrag {
  // A hot core with a soft edge.
  let k = 1.0 - abs(in.across);
  let core = smoothstep(0.0, 0.6, k);
  let c = bolt.look.rgb * in.light * (0.35 + 0.65 * core);
  var o: BFrag;
  o.color = vec4f(c, 0.0);
  o.emissive = vec4f(c, 0.0);
  return o;
}
`;

/** Options for `Lightning`. */
export interface LightningOptions {
  /** The bolt's linear colour (bright: it reaches bloom). Default `[3, 3.4, 4]`. */
  color?: readonly [number, number, number];
  /** The main strand's width (world units). Default 0.6. */
  width?: number;
  /** How far above the ground a bolt starts (world units). Default 140. */
  height?: number;
  /** Seconds the bolt takes to reach the ground. Default 0.1. */
  growTime?: number;
  /** Seconds it then takes to fade. Default 0.55. */
  fadeTime?: number;
  /** Seconds the flash lasts. Default 0.45. */
  flashTime?: number;
  /** Strands per bolt, 1..3 (the main one and its branches). Default 3. */
  strands?: number;
  /** Pass to draw in. Default `'transparent'`. */
  pass?: string;
}

/**
 * A lightning bolt and flash on a render core: `new Lightning(core)`, then `strike(x, groundY, z)`
 * when the storm wants one, and `update(dt)` each frame. Read `flash` for the sky's light.
 */
export class Lightning implements CoreDrawable {
  readonly label = 'lightning';
  readonly pass: string;
  readonly order = 11;
  readonly encoding = 'bundle';
  version = 0;
  /** True while a bolt shows. */
  active = false;
  /** The strike's light, 0..1, flickering as it fades: scale the sky, sun or ambient by it. */
  flash = 0;
  /** Seconds since the last strike (Infinity before one). */
  age = Number.POSITIVE_INFINITY;
  readonly color: Float32Array;
  width: number;
  height: number;
  growTime: number;
  fadeTime: number;
  flashTime: number;
  strands: number;

  private readonly core: RenderCore;
  private readonly uniform: GPUBuffer;
  private readonly data = new Float32Array(LIGHTNING_FLOATS);
  private readonly layout: GPUBindGroupLayout;
  private readonly pipes: DrawablePipelines;
  private group: GPUBindGroup | null = null;
  private dirtyPoints = false;
  private strikes = 0;

  constructor(core: RenderCore, opts: LightningOptions = {}) {
    const device = core.device;
    this.core = core;
    this.pass = opts.pass ?? 'transparent';
    this.color = new Float32Array(opts.color ?? [3, 3.4, 4]);
    this.width = opts.width ?? 0.6;
    this.height = opts.height ?? 140;
    this.growTime = opts.growTime ?? 0.1;
    this.fadeTime = opts.fadeTime ?? 0.55;
    this.flashTime = opts.flashTime ?? 0.45;
    this.strands = Math.max(1, Math.min(LIGHTNING_STRANDS, Math.floor(opts.strands ?? 3)));
    this.uniform = device.createBuffer({
      label: 'lightning',
      size: this.data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'lightning',
      entries: [{ binding: 0, visibility: V | F, buffer: {} }],
    });
    const module = createShaderModule(device, LIGHTNING_WGSL, 'lightning');
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [core.viewLayout, this.layout],
    });
    const add: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one' },
      alpha: { srcFactor: 'zero', dstFactor: 'one' },
    };
    this.pipes = new DrawablePipelines((color, depth, _readOnly, aux, reversedZ) =>
      device.createRenderPipeline({
        label: 'lightning',
        layout,
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: coreColorTargets({ format: color, blend: add }, aux, CORE_TARGET.emissive),
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
    core.addDrawable(this);
  }

  /**
   * Strike at world (`x`, `z`), the bolt ending at height `groundY`, its shape from `seed`
   * (default: the strike count, so each one differs and a replay repeats). Writes the bolt's points; the next `prepare` uploads them.
   */
  strike(x: number, groundY: number, z: number, seed?: number): void {
    const d = this.data;
    this.strikes++;
    let s = Math.floor(seed ?? this.strikes * 7919 + 17) >>> 0 || 1;
    const rand = (): number => {
      // xorshift32: the same bolt for the same seed.
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    const N = LIGHTNING_SEGMENTS;
    const step = this.height / N;
    const jag = step * 0.55;
    // The main strand walks down to (x, z) from a point drifted off it.
    let px = x + (rand() - 0.5) * this.height * 0.15;
    let pz = z + (rand() - 0.5) * this.height * 0.15;
    for (let i = 0; i <= N; i++) {
      const at = 8 + i * 4;
      const t = i / N;
      // Pulled towards the strike point as it nears the ground.
      px += (x - px) * t * 0.5 + (rand() - 0.5) * jag;
      pz += (z - pz) * t * 0.5 + (rand() - 0.5) * jag;
      if (i === N) {
        px = x;
        pz = z;
      }
      d[at] = px;
      d[at + 1] = groundY + this.height * (1 - t);
      d[at + 2] = pz;
      d[at + 3] = 0;
    }
    // Branches leave the main strand partway down and wander off, shorter (they stop in the air).
    for (let b = 1; b < LIGHTNING_STRANDS; b++) {
      const from = 3 + Math.floor(rand() * (N / 2));
      const src = 8 + from * 4;
      let bx = d[src]!;
      let by = d[src + 1]!;
      let bz = d[src + 2]!;
      const dx = (rand() - 0.5) * 2;
      const dz = (rand() - 0.5) * 2;
      for (let i = 0; i <= N; i++) {
        const at = 8 + (b * (N + 1) + i) * 4;
        if (i > 0) {
          bx += dx * step * 0.5 + (rand() - 0.5) * jag;
          bz += dz * step * 0.5 + (rand() - 0.5) * jag;
          by -= step * 0.45;
        }
        d[at] = bx;
        d[at + 1] = by;
        d[at + 2] = bz;
        d[at + 3] = 0;
      }
    }
    this.age = 0;
    this.dirtyPoints = true;
    this.active = true;
    this.flash = 1;
  }

  /** Advance the strike by `dt` seconds: the bolt grows, fades, and the flash flickers out. */
  update(dt: number): void {
    if (!Number.isFinite(this.age)) return;
    this.age += dt;
    this.flash = lightningFlash(this.age, this.flashTime);
    if (this.age >= this.growTime + this.fadeTime) {
      this.active = false;
      this.age = Number.POSITIVE_INFINITY;
      this.flash = 0;
    }
  }

  prepare(): void {
    if (!this.active) return;
    const d = this.data;
    const grown = this.growTime > 0 ? Math.min(1, this.age / this.growTime) : 1;
    const fading = Math.max(0, this.age - this.growTime);
    const fade = this.fadeTime > 0 ? Math.max(0, 1 - fading / this.fadeTime) : 0;
    // A flicker over the fade, as the flash.
    const bright = fade * (0.7 + 0.3 * Math.cos(this.age * 40));
    // Points relative to the core's origin.
    const o = this.core.origin;
    d[0] = this.color[0]!;
    d[1] = this.color[1]!;
    d[2] = this.color[2]!;
    d[3] = this.width;
    d[4] = grown;
    d[5] = bright;
    d[6] = this.strands;
    d[7] = 0;
    const q = this.core.device.queue;
    if (this.dirtyPoints) {
      this.dirtyPoints = false;
      const ox = o[0]!;
      const oy = o[1]!;
      const oz = o[2]!;
      for (let at = 8; at < LIGHTNING_FLOATS; at += 4) {
        d[at] = d[at]! - ox;
        d[at + 1] = d[at + 1]! - oy;
        d[at + 2] = d[at + 2]! - oz;
      }
      q.writeBuffer(this.uniform, 0, d);
    } else {
      q.writeBuffer(this.uniform, 0, d, 0, 8);
    }
  }

  record(enc: CoreDrawableEncoder, ctx: CoreDrawContext): number {
    enc.setPipeline(this.pipes.get(ctx));
    enc.setBindGroup(0, ctx.viewGroup);
    enc.setBindGroup(1, this.bindGroup());
    enc.draw(6, LIGHTNING_STRANDS * LIGHTNING_SEGMENTS);
    return 1;
  }

  private bindGroup(): GPUBindGroup {
    if (this.group) return this.group;
    this.group = this.core.device.createBindGroup({
      label: 'lightning',
      layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.uniform } }],
    });
    return this.group;
  }

  destroy(): void {
    this.core.removeDrawable(this);
    this.uniform.destroy();
    this.group = null;
  }
}

/**
 * The flash of a strike `age` seconds ago that lasts `duration`: a decay with a fast flicker,
 * `(1 - a)(0.65 + 0.35 cos 40a)` for `a = age / duration`, 0 after.
 */
export function lightningFlash(age: number, duration = 0.45): number {
  if (!(age >= 0) || age >= duration || duration <= 0) return 0;
  const a = age / duration;
  return (1 - a) * (0.65 + 0.35 * Math.cos(a * 40));
}
