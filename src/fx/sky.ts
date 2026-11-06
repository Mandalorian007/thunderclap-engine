import type { Camera } from '../render/camera';
import type { Drawable, Frame } from '../render/frame';
import type { Renderer } from '../render/renderer';
import { createShaderModule } from '../render/wgsl';
import { SKY_WGSL } from './sky-wgsl';

/** Floats in the sky's params block (4 × vec4f, 64 bytes). */
export const SKY_PARAMS_FLOATS = 16;

/** Starfield settings (`Sky.stars`). */
export interface SkyStars {
  /** Grid cells per unit of direction; more cells, more and smaller stars. Default 24. */
  density: number;
  /** Shuffles the field. Default 0. */
  seed: number;
}

export interface SkyOptions {
  /** Linear RGB straight up. Default a clear blue. */
  zenith?: ArrayLike<number>;
  /** Linear RGB at the horizon. Default a pale haze. */
  horizon?: ArrayLike<number>;
  /** Linear RGB below the horizon (where no geometry covers the dome). Default a dark earth. */
  ground?: ArrayLike<number>;
  /** Angular radius of the sun disc, radians. Default 0.03. */
  sunSize?: number;
  /** Strength of the glow around the sun (0 for none). Default 1. */
  sunGlow?: number;
  /** Stars at night: `true` for the defaults, or `{ density, seed }`. Default off. */
  stars?: boolean | Partial<SkyStars>;
  /** Multiplier on the whole dome. Default 1. */
  exposure?: number;
  /**
   * How dark the dome goes at night, as a fraction of its daytime colour (the floor of the
   * day/night fade driven by the sun's elevation). Default 0.06. Raise it for brighter nights,
   * lower it towards 0 for black skies behind the stars.
   */
  ambientFloor?: number;
}

const DEFAULT_ZENITH = [0.18, 0.38, 0.85] as const;
const DEFAULT_HORIZON = [0.62, 0.72, 0.9] as const;
const DEFAULT_GROUND = [0.22, 0.2, 0.18] as const;
const DEFAULT_STARS: SkyStars = { density: 24, seed: 0 };

/**
 * A procedural sky: a gradient dome with a sun disc and glow that follow `frame.lights.sun`,
 * horizon haze towards `frame.lights.fog.color`, and stars once the sun sets. One fullscreen
 * triangle, no asset, no instance; `frame.drawable(sky)` draws it.
 *
 * It reads the sun and fog from the lights block the renderer uploads with every view, so its
 * only upload is the 64-byte params block, written once per frame in `prepare`. The fields are
 * live: mutate `zenith`, `sunSize`, `stars`... and the next frame shows it.
 *
 * Depth: under a depth camera the triangle sits at the far plane with depth compare
 * `less-equal` and no depth write (the test-only state, `DepthMode` 1), so geometry drawn before
 * or after it wins wherever it wrote depth and the sky fills the rest. Without depth (a 2D
 * camera) it paints the whole view; give it the lowest `order` then. Nothing to cull.
 */
export class Sky implements Drawable {
  /** Linear RGB straight up. Live. */
  readonly zenith = new Float32Array(3);
  /** Linear RGB at the horizon. Live. */
  readonly horizon = new Float32Array(3);
  /** Linear RGB below the horizon. Live. */
  readonly ground = new Float32Array(3);
  /** Angular radius of the sun disc, radians. Live. */
  sunSize: number;
  /** Glow strength around the sun. Live. */
  sunGlow: number;
  /** Starfield settings, or null for no stars. Live (replace or mutate). */
  stars: SkyStars | null;
  /** Multiplier on the whole dome. Live. */
  exposure: number;
  /** Night brightness as a fraction of day (`SkyOptions.ambientFloor`). Live. */
  ambientFloor: number;

  private readonly device: GPUDevice;
  private readonly params: Float32Array<ArrayBuffer>;
  private readonly paramsBuffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly desc: GPURenderPipelineDescriptor;
  private readonly flatPipeline: GPURenderPipeline;
  /** Per depth format: the same pipeline with a test-only `depthStencil` (built on first use). */
  private readonly depthPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(renderer: Renderer, opts: SkyOptions = {}) {
    const device = renderer.device;
    this.device = device;
    set3(this.zenith, opts.zenith ?? DEFAULT_ZENITH);
    set3(this.horizon, opts.horizon ?? DEFAULT_HORIZON);
    set3(this.ground, opts.ground ?? DEFAULT_GROUND);
    this.sunSize = opts.sunSize ?? 0.03;
    this.sunGlow = opts.sunGlow ?? 1;
    this.exposure = opts.exposure ?? 1;
    this.ambientFloor = opts.ambientFloor ?? 0.06;
    const s = opts.stars;
    this.stars = s
      ? {
          density: (s === true ? undefined : s.density) ?? DEFAULT_STARS.density,
          seed: (s === true ? undefined : s.seed) ?? DEFAULT_STARS.seed,
        }
      : null;

    this.params = new Float32Array(SKY_PARAMS_FLOATS);
    this.paramsBuffer = device.createBuffer({
      label: 'sky-params',
      size: this.params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = device.createBindGroupLayout({
      label: 'sky-layout',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    this.group = device.createBindGroup({
      label: 'sky',
      layout,
      entries: [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    });
    const module = createShaderModule(device, SKY_WGSL, 'sky');
    this.desc = {
      label: 'sky',
      layout: device.createPipelineLayout({ bindGroupLayouts: [renderer.globalsLayout, layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: renderer.sceneFormats.map((format) => ({ format })),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    };
    this.flatPipeline = device.createRenderPipeline(this.desc);
  }

  /**
   * Pack the live fields into the params block (`SKY_PARAMS_FLOATS` floats: zenith rgb +
   * exposure, horizon rgb + sunSize, ground rgb + sunGlow, stars density, seed, enabled,
   * ambientFloor) and
   * upload it. Called by the renderer once per frame. No allocation.
   */
  prepare(_encoder: GPUCommandEncoder, _frame?: Frame): void {
    const p = this.params;
    p[0] = this.zenith[0]!;
    p[1] = this.zenith[1]!;
    p[2] = this.zenith[2]!;
    p[3] = this.exposure;
    p[4] = this.horizon[0]!;
    p[5] = this.horizon[1]!;
    p[6] = this.horizon[2]!;
    p[7] = this.sunSize;
    p[8] = this.ground[0]!;
    p[9] = this.ground[1]!;
    p[10] = this.ground[2]!;
    p[11] = this.sunGlow;
    const s = this.stars;
    p[12] = s ? s.density : 0;
    p[13] = s ? s.seed : 0;
    p[14] = s ? 1 : 0;
    p[15] = this.ambientFloor;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, p);
  }

  /** Draw inside the scene pass: one 3-vertex draw, a depth pipeline when the frame has depth. */
  draw(pass: GPURenderPassEncoder, frame?: Frame): void {
    const fmt = frame?.depthFormat ?? null;
    pass.setPipeline(fmt ? this.depthPipeline(fmt) : this.flatPipeline);
    pass.setBindGroup(1, this.group);
    pass.draw(3);
  }

  private depthPipeline(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.depthPipelines.get(format);
    if (!p) {
      p = this.device.createRenderPipeline({
        ...this.desc,
        label: `sky:${format}`,
        depthStencil: { format, depthWriteEnabled: false, depthCompare: 'less-equal' },
      });
      this.depthPipelines.set(format, p);
    }
    return p;
  }

  destroy(): void {
    this.paramsBuffer.destroy();
  }
}

/**
 * The world-space view direction through clip point (`nx`, `ny`) (NDC, -1..1, y up) of
 * `camera`, into `out` (normalised): the math the sky shader runs per pixel, from the camera's
 * `projection` and `view` alone. A perspective projection is inverted analytically (its
 * off-centre terms included); an orthographic one gives the camera's forward for every pixel.
 */
export function skyRay(camera: Camera, nx: number, ny: number, out: Float32Array): Float32Array {
  const p = camera.projection;
  const v = camera.view;
  // Column-major: p[c * 4 + r].
  const p23 = p[11]!;
  let dx = 0;
  let dy = 0;
  if (p23 !== 0) {
    dx = (p[8]! - p23 * nx) / p[0]!;
    dy = (p[9]! - p23 * ny) / p[5]!;
  }
  // Orthographic: every pixel looks along the camera's forward (+z for the 2D camera).
  const dz = p23 === 0 && p[10]! > 0 ? 1 : -1;
  const wx = v[0]! * dx + v[1]! * dy + v[2]! * dz;
  const wy = v[4]! * dx + v[5]! * dy + v[6]! * dz;
  const wz = v[8]! * dx + v[9]! * dy + v[10]! * dz;
  const k = 1 / Math.hypot(wx, wy, wz);
  out[0] = wx * k;
  out[1] = wy * k;
  out[2] = wz * k;
  return out;
}

function set3(out: Float32Array, v: ArrayLike<number>): void {
  out[0] = v[0] ?? 0;
  out[1] = v[1] ?? 0;
  out[2] = v[2] ?? 0;
}
