import { type BindingDesc, BindingSet, hasBindings, slotViewDimension } from './bindings';
import { blendState, type RenderBlendMode } from './blend';
import { type PipelineWarmer, pipelineWarmer, type WarmTarget } from './core/warm';
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
  blend?: RenderBlendMode | GPUBlendState;
  fragmentEntry?: string;
  /**
   * Make the shader module and pipeline at `warm()` or the first `encode`, not now (default
   * false; E26). WebKit compiles a pipeline in the GPU process when it is made, and the next
   * submit waits for it: a post pass that is off at load then costs nothing before the game's
   * first view.
   */
  lazy?: boolean;
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
  private pipe: GPURenderPipeline | null = null;
  private readonly make: () => GPURenderPipeline;
  readonly bindings: BindingSet | null;
  private readonly colorAttachment: GPURenderPassColorAttachment;
  private readonly passDesc: GPURenderPassDescriptor;
  private readonly warmer: PipelineWarmer;
  private readonly warmTarget: WarmTarget;
  /** Warmed or drawn: `warm()` does nothing. */
  private primed = false;

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
    const blend =
      typeof desc.blend === 'string' || desc.blend === undefined
        ? blendState(desc.blend ?? 'opaque')
        : desc.blend;
    const layout = this.bindings?.layout;
    const targets = desc.targets.slice();
    this.make = () => {
      const code = `${WGSL_FULLSCREEN_PRELUDE}\n// ---- pass: ${desc.label} ----\n${desc.wgsl}`;
      const module = createShaderModule(device, code, `pass:${desc.label}`);
      return device.createRenderPipeline({
        label: `pass:${desc.label}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: layout ? [layout] : [] }),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module,
          entryPoint: desc.fragmentEntry ?? 'fs_main',
          targets: targets.map((format) => ({ format, blend })),
        },
        primitive: { topology: 'triangle-list' },
      });
    };
    if (!desc.lazy) this.pipe = this.make();
    this.colorAttachment = {
      view: defaultView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    this.passDesc = { label: `pass:${desc.label}`, colorAttachments: [this.colorAttachment] };
    // Its empty first draw (ws/warm-voxel-fit), encoded before the device's next real pass: a
    // pass made at load but first run when enabled mid-play compiles now, not then.
    this.warmer = pipelineWarmer(device);
    // Its own group of scratch views, one of each slot's dimension: the pass's textures may not
    // be set yet (a LUT slot's default view is 2D), and the group is never cached.
    const bindings = this.bindings;
    const warmer = this.warmer;
    this.warmTarget = {
      color: targets,
      bind: bindings
        ? (pass) => {
            const n = desc.textures ?? 0;
            const views: GPUTextureView[] = [];
            for (let i = 0; i < n; i++)
              views.push(warmer.scratchSampled(false, slotViewDimension(desc, i)));
            pass.setBindGroup(0, bindings.createGroup(views));
            return 1;
          }
        : undefined,
    };
    if (!desc.lazy) this.warm();
  }

  /** The pass's pipeline (made now if the pass is `lazy` and it wasn't yet). */
  get pipeline(): GPURenderPipeline {
    this.pipe ??= this.make();
    return this.pipe;
  }

  /**
   * Queue the pipeline's empty first draw, encoded before the device's next real pass (once; a
   * no-op after it or the first `encode`). A `lazy` pass makes its pipeline here.
   */
  warm(): void {
    if (this.primed) return;
    this.primed = true;
    this.warmer.warm(this.pipeline, this.warmTarget);
  }

  /** Whether the pipeline has been made and warmed, or drawn. */
  get warmed(): boolean {
    return this.primed;
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
    this.primed = true;
    this.warmer.encode(encoder);
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
