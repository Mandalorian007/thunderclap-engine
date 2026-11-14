import type { RenderCore } from '../render/core/core';
import type { CorePass, CorePassContext } from '../render/core/pass-list';
import { CORE_TARGET, coreColorTargets } from '../render/core/targets';
import { CORE_VIEW_WGSL } from '../render/core/view';
import { createShaderModule, WGSL_NOISE } from '../render/wgsl';
import { packSkyParams, SKY_PARAMS_FLOATS, type SkyLook } from './sky';
import { SKY_PARAMS_WGSL, SKY_SHADE_WGSL } from './sky-wgsl';

/** Floats of the sky pass's light block: sun direction, sun colour, fog (rgb, density). */
export const SKY_PASS_LIGHT_FLOATS = 12;

/**
 * The core's sky (ws/core-passes): the same dome as `Sky`, drawn per view from the core's
 * `CoreView` (the view ray from the inverse of `viewProj`, so an off-centre stereo eye, a
 * cube face or an origin-relative view all work). One full-screen triangle at the far plane,
 * tested `less-equal` against depth and never writing it, so the opaque sets drawn before it
 * win. When the core has extra targets (ws/core-targets) the sun disc and stars go to emissive
 * (bloom) and the dome's motion, a direction at infinity so camera turns only, to velocity.
 */
export const SKY_PASS_WGSL = /* wgsl */ `${CORE_VIEW_WGSL}
@group(0) @binding(0) var<uniform> view: CoreView;
${WGSL_NOISE}
${SKY_PARAMS_WGSL}
struct SkyLight {
  sun_dir: vec4f,   // xyz: the way the light travels
  sun_color: vec4f, // rgb, all zero for no sun
  fog: vec4f,       // rgb, density
};
@group(1) @binding(1) var<uniform> light: SkyLight;
${SKY_SHADE_WGSL}
fn sky_inverse(m: mat4x4f) -> mat4x4f {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
  let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];
  let b00 = a00 * a11 - a01 * a10; let b01 = a00 * a12 - a02 * a10;
  let b02 = a00 * a13 - a03 * a10; let b03 = a01 * a12 - a02 * a11;
  let b04 = a01 * a13 - a03 * a11; let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30; let b07 = a20 * a32 - a22 * a30;
  let b08 = a20 * a33 - a23 * a30; let b09 = a21 * a32 - a22 * a31;
  let b10 = a21 * a33 - a23 * a31; let b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  let r = 1.0 / det;
  return mat4x4f(
    vec4f(a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09,
          a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03) * r,
    vec4f(a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07,
          a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01) * r,
    vec4f(a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06,
          a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00) * r,
    vec4f(a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06,
          a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00) * r,
  );
}

struct SkyPassOut {
  @builtin(position) clip: vec4f,
  // A point on the pixel's view ray, homogeneous: linear in screen space, divided per pixel.
  @location(0) @interpolate(linear) ray: vec4f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> SkyPassOut {
  let x = f32(i32(i & 1u) * 4 - 1);
  let y = f32(i32(i >> 1u) * 4 - 1);
  var o: SkyPassOut;
  o.clip = vec4f(x, y, 1.0, 1.0);
  o.ray = sky_inverse(view.viewProj) * vec4f(x, y, 0.5, 1.0);
  return o;
}

struct SkyPassFrag {
  @location(0) color: vec4f,
  @location(1) emissive: vec4f,
  @location(3) velocity: vec4f,
};

@fragment fn fs(in: SkyPassOut) -> SkyPassFrag {
  let d = normalize(in.ray.xyz / in.ray.w - view.position.xyz);
  let s = sky_shade(d, light.sun_dir.xyz, light.sun_color.rgb, light.fog);
  var o: SkyPassFrag;
  o.color = vec4f(s.color, 1.0);
  o.emissive = vec4f(s.emissive, 1.0);
  // A point at infinity (w = 0): only turning the view moves the sky.
  let q = vec4f(d, 0.0);
  let c = view.viewProj * q;
  let pw = dot(view.prevRows[2], q);
  var vel = vec2f(0.0);
  if (pw > 0.0 && c.w > 0.0) {
    vel = (c.xy / c.w - vec2f(dot(view.prevRows[0], q), dot(view.prevRows[1], q)) / pw) * vec2f(0.5, -0.5);
  }
  o.velocity = vec4f(vel, 0.0, 1.0);
  return o;
}
`;

export interface SkyPassOptions {
  /** The pass id. Default `'sky'`. */
  id?: string;
  /** The pass to follow. Default `'cutout'`: after the opaque sets, before `transparent`. */
  after?: string;
  /** Debug label. Default `'sky pass'`. */
  label?: string;
}

/**
 * The sky as a core pass (ws/core-passes): `createSkyPass(core, sky)` defines a pass that
 * draws `sky`'s dome in every view the core draws. `sky` (a `Sky`, or any `SkyLook`) stays the source of the dome's
 * colours (its live fields are read each `prepare`); the sun and fog come from this pass's
 * `sunDir`, `sunColor` and `fog`, which the game sets as it sets its lights. Call `prepare()`
 * once a frame before the core draws. Survives a device restore.
 */
export class SkyPass {
  /** The light's travel direction (from the sun towards the world). Live. */
  readonly sunDir = new Float32Array([0, -1, 0]);
  /** The sun's linear colour; all zero for no sun. Live. */
  readonly sunColor = new Float32Array([1, 1, 1]);
  /** The fog colour (rgb) and density (w) the horizon hazes towards. Live. */
  readonly fog = new Float32Array(4);
  /** The pass in the core's list. */
  readonly pass: CorePass;
  /** Draws encoded so far (one per view). */
  draws = 0;

  private readonly label: string;
  private readonly data = new Float32Array(SKY_PARAMS_FLOATS + 4 + SKY_PASS_LIGHT_FLOATS);
  private device!: GPUDevice;
  private paramsBuffer!: GPUBuffer;
  private lightBuffer!: GPUBuffer;
  private layout!: GPUBindGroupLayout;
  private group!: GPUBindGroup;
  private module!: GPUShaderModule;
  private pipelineLayout: GPUPipelineLayout | null = null;
  /** Pipelines by colour format, then depth format (`'none'` without depth). */
  /** By colour format, depth format ('none'), then the pass's extra-target mask (0..7). */
  private readonly pipelines = new Map<
    GPUTextureFormat,
    Map<string, (GPURenderPipeline | undefined)[]>
  >();
  private readonly offRestored: () => void;
  private destroyed = false;

  constructor(
    core: RenderCore,
    readonly sky: SkyLook,
    opts: SkyPassOptions = {},
  ) {
    this.label = opts.label ?? 'sky pass';
    this.build(core.device);
    this.pass = core.definePass({
      id: opts.id ?? 'sky',
      after: opts.after ?? 'cutout',
      depth: 'read',
      encode: (pass, ctx) => this.encode(pass, ctx),
    });
    this.offRestored = core.onDeviceRestored((d) => this.build(d));
  }

  /** Pack the sky's and this pass's live fields and upload them. Once a frame; no allocation. */
  prepare(): void {
    if (this.destroyed) return;
    const d = this.data;
    packSkyParams(this.sky, d, 0);
    const o = SKY_PARAMS_FLOATS + 4;
    d[o] = this.sunDir[0]!;
    d[o + 1] = this.sunDir[1]!;
    d[o + 2] = this.sunDir[2]!;
    d[o + 3] = 0;
    d[o + 4] = this.sunColor[0]!;
    d[o + 5] = this.sunColor[1]!;
    d[o + 6] = this.sunColor[2]!;
    d[o + 7] = 0;
    d[o + 8] = this.fog[0]!;
    d[o + 9] = this.fog[1]!;
    d[o + 10] = this.fog[2]!;
    d[o + 11] = this.fog[3]!;
    const q = this.device.queue;
    q.writeBuffer(this.paramsBuffer, 0, d, 0, SKY_PARAMS_FLOATS);
    q.writeBuffer(this.lightBuffer, 0, d, o, SKY_PASS_LIGHT_FLOATS);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offRestored();
    this.paramsBuffer.destroy();
    this.lightBuffer.destroy();
  }

  private encode(pass: GPURenderPassEncoder, ctx: CorePassContext): void {
    if (this.destroyed) return;
    pass.setPipeline(this.pipelineFor(ctx));
    pass.setBindGroup(0, ctx.view);
    pass.setBindGroup(1, this.group);
    pass.draw(3);
    this.draws++;
  }

  private pipelineFor(ctx: CorePassContext): GPURenderPipeline {
    let byDepth = this.pipelines.get(ctx.format);
    if (!byDepth) {
      byDepth = new Map();
      this.pipelines.set(ctx.format, byDepth);
    }
    const key = ctx.depthFormat ?? 'none';
    let byAux = byDepth.get(key);
    if (!byAux) {
      byAux = [];
      byDepth.set(key, byAux);
    }
    const hit = byAux[ctx.aux];
    if (hit) return hit;
    if (!this.pipelineLayout) {
      this.pipelineLayout = this.device.createPipelineLayout({
        label: this.label,
        bindGroupLayouts: [ctx.viewLayout, this.layout],
      });
    }
    const p = this.device.createRenderPipeline({
      label: `${this.label}:${ctx.format}:${key}:${ctx.aux}`,
      layout: this.pipelineLayout,
      vertex: { module: this.module, entryPoint: 'vs' },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: coreColorTargets(
          { format: ctx.format },
          ctx.aux,
          CORE_TARGET.emissive | CORE_TARGET.velocity,
        ),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: ctx.depthFormat
        ? { format: ctx.depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' }
        : undefined,
    });
    byAux[ctx.aux] = p;
    return p;
  }

  /** Every GPU object, on `device` (the constructor's, or a restored one). */
  private build(device: GPUDevice): void {
    this.device = device;
    this.pipelines.clear();
    this.pipelineLayout = null;
    this.paramsBuffer = device.createBuffer({
      label: `${this.label} params`,
      size: SKY_PARAMS_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.lightBuffer = device.createBuffer({
      label: `${this.label} light`,
      size: SKY_PASS_LIGHT_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.layout = device.createBindGroupLayout({
      label: this.label,
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      ],
    });
    this.group = device.createBindGroup({
      label: this.label,
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.lightBuffer } },
      ],
    });
    this.module = createShaderModule(device, SKY_PASS_WGSL, this.label);
  }
}

/** `new SkyPass(core, sky, opts)`: the sky drawn per view as a core pass. */
export function createSkyPass(core: RenderCore, sky: SkyLook, opts?: SkyPassOptions): SkyPass {
  return new SkyPass(core, sky, opts);
}
