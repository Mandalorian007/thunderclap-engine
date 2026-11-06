import { type BindingDesc, BindingSet, hasBindings } from './bindings';
import { type BlendMode, blendState } from './blend';
import type { TextureLike } from './texture';
import { createShaderModule, WGSL_FULLSCREEN_PRELUDE } from './wgsl';

export interface FullscreenPassDesc extends BindingDesc {
  label: string;
  /**
   * WGSL appended after the fullscreen prelude. Must define
   * `@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f` (or a struct for MRT).
   * Bindings live in `@group(0)` following the convention in `bindings.ts`.
   */
  wgsl: string;
  /** Colour target formats. */
  targets: GPUTextureFormat[];
  blend?: BlendMode | GPUBlendState;
  fragmentEntry?: string;
}

export interface FullscreenEncodeOptions {
  /** Clear colour; omit to clear to transparent black, `null` to load existing contents. */
  clear?: GPUColor | null;
  /** Use an explicit bind group (see `createBindGroup`) instead of the managed one. */
  bindGroup?: GPUBindGroup;
  blendConstant?: GPUColor;
  /** Timestamp writes for this pass (see `GpuTimer.pass`). */
  timestampWrites?: GPURenderPassTimestampWrites;
  /**
   * Draw into this part of `target` only (texture px): viewport and scissor. Pair it with
   * `clear: null`, since a clear covers the whole attachment (ws/xr-post: one eye of a layer).
   */
  viewport?: { x: number; y: number; width: number; height: number };
}

/**
 * A fragment shader run over a whole render target. Used by the post stack, procedural
 * texture generation and game passes (e.g. a fluid sim into a render target).
 */
export class FullscreenPass {
  readonly label: string;
  readonly pipeline: GPURenderPipeline;
  readonly bindings: BindingSet | null;
  private readonly colorAttachment: GPURenderPassColorAttachment;
  private readonly passDesc: GPURenderPassDescriptor;

  constructor(
    device: GPUDevice,
    desc: FullscreenPassDesc,
    sampler: GPUSampler,
    defaultView: GPUTextureView,
  ) {
    this.label = desc.label;
    this.bindings = hasBindings(desc)
      ? new BindingSet(
          device,
          { ...desc, visibility: GPUShaderStage.FRAGMENT },
          sampler,
          defaultView,
          `pass:${desc.label}`,
        )
      : null;
    const code = `${WGSL_FULLSCREEN_PRELUDE}\n// ---- pass: ${desc.label} ----\n${desc.wgsl}`;
    const module = createShaderModule(device, code, `pass:${desc.label}`);
    const blend =
      typeof desc.blend === 'string' || desc.blend === undefined
        ? blendState(desc.blend ?? 'opaque')
        : desc.blend;
    this.pipeline = device.createRenderPipeline({
      label: `pass:${desc.label}`,
      layout: device.createPipelineLayout({
        bindGroupLayouts: this.bindings ? [this.bindings.layout] : [],
      }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: desc.fragmentEntry ?? 'fs_main',
        targets: desc.targets.map((format) => ({ format, blend })),
      },
      primitive: { topology: 'triangle-list' },
    });
    this.colorAttachment = {
      view: defaultView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    this.passDesc = { label: `pass:${desc.label}`, colorAttachments: [this.colorAttachment] };
  }

  setUniforms(data: BufferSource, byteOffset = 0): void {
    if (!this.bindings) throw new Error(`pass ${this.label}: no uniforms declared`);
    this.bindings.setUniforms(data, byteOffset);
  }

  setTexture(slot: number, tex: TextureLike | GPUTextureView): void {
    if (!this.bindings) throw new Error(`pass ${this.label}: no textures declared`);
    this.bindings.setTexture(slot, tex);
  }

  /** Create a bind group for a fixed set of input views. Cache the result (e.g. per resize). */
  createBindGroup(views: readonly GPUTextureView[]): GPUBindGroup {
    if (!this.bindings) throw new Error(`pass ${this.label}: no bindings declared`);
    return this.bindings.createGroup(views);
  }

  /** Record the pass into `encoder`, drawing into `target` (single colour attachment). */
  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    opts: FullscreenEncodeOptions = {},
  ): void {
    const ca = this.colorAttachment;
    ca.view = target;
    if (opts.clear === null) {
      ca.loadOp = 'load';
    } else {
      ca.loadOp = 'clear';
      ca.clearValue = opts.clear ?? { r: 0, g: 0, b: 0, a: 0 };
    }
    this.passDesc.timestampWrites = opts.timestampWrites;
    const pass = encoder.beginRenderPass(this.passDesc);
    pass.setPipeline(this.pipeline);
    const vp = opts.viewport;
    if (vp) {
      pass.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
      pass.setScissorRect(vp.x, vp.y, vp.width, vp.height);
    }
    const group = opts.bindGroup ?? this.bindings?.bindGroup;
    if (group) pass.setBindGroup(0, group);
    if (opts.blendConstant) pass.setBlendConstant(opts.blendConstant);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.bindings?.destroy();
  }
}
