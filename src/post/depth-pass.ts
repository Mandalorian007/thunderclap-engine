import { type PipelineWarmer, pipelineWarmer, type WarmTarget } from '../render/core/warm';
import { createShaderModule, WGSL_FULLSCREEN_PRELUDE } from '../render/wgsl';
import type { PostHost } from './host';
import { POST_UNIFORM_FLOATS } from './settings';

/**
 * A fullscreen pass that reads the scene's depth buffer (ws/post-depth). `FullscreenPass` binds
 * `texture_2d<f32>` only, so the two depth passes build their own layout:
 *
 * - `@binding(0)` the post uniforms (`WGSL_POST_UNIFORMS`),
 * - `@binding(1)` a nearest-clamp sampler, `@binding(2)` a linear-clamp sampler,
 * - `@binding(3)` the depth as `texture_depth_2d`,
 * - `@binding(4 + i)` `textures` further `texture_2d<f32>` inputs.
 *
 * `format` may list several targets (ws/post-5: the TAA resolve also writes its history aux);
 * `encode` then takes the targets after the first in `extraTargets`.
 *
 * One uniform buffer per pass, written with `setUniforms` (or copied into on the encoder,
 * `uniformBuffer`, when several XR eyes share one submit). Bind groups come from
 * `createBindGroup` and are cached by the caller, as with `FullscreenPass`.
 */
export class DepthPass {
  readonly label: string;
  private readonly device: GPUDevice;
  private pipe: GPURenderPipeline | null = null;
  private readonly make: () => GPURenderPipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly uniforms: GPUBuffer;
  private readonly nearest: GPUSampler;
  private readonly linear: GPUSampler;
  private readonly textures: number;
  private readonly colorAttachments: GPURenderPassColorAttachment[];
  private readonly passDesc: GPURenderPassDescriptor;
  private readonly entries: GPUBindGroupEntry[];
  private readonly warmer: PipelineWarmer;
  private readonly warmTarget: WarmTarget;
  /** Warmed or drawn: `warm()` does nothing. */
  private primed = false;

  constructor(
    renderer: PostHost,
    desc: {
      label: string;
      wgsl: string;
      format: GPUTextureFormat | readonly GPUTextureFormat[];
      textures: number;
      /** Make the pipeline at `warm()` or the first `encode` (see `FullscreenPassDesc.lazy`). */
      lazy?: boolean;
    },
  ) {
    const formats: readonly GPUTextureFormat[] =
      typeof desc.format === 'string' ? [desc.format] : desc.format;
    const device = renderer.device;
    this.device = device;
    this.label = desc.label;
    this.textures = desc.textures;
    this.nearest = renderer.samplers['nearest-clamp'];
    this.linear = renderer.samplers['linear-clamp'];
    const frag = GPUShaderStage.FRAGMENT;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: frag, buffer: {} },
      { binding: 1, visibility: frag, sampler: { type: 'non-filtering' } },
      { binding: 2, visibility: frag, sampler: {} },
      { binding: 3, visibility: frag, texture: { sampleType: 'depth' } },
    ];
    for (let i = 0; i < desc.textures; i++) {
      entries.push({ binding: 4 + i, visibility: frag, texture: { sampleType: 'float' } });
    }
    this.layout = device.createBindGroupLayout({ label: `pass:${desc.label}`, entries });
    this.uniforms = device.createBuffer({
      label: `pass:${desc.label}-uniforms`,
      size: POST_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = this.layout;
    this.make = () => {
      const code = `${WGSL_FULLSCREEN_PRELUDE}\n// ---- pass: ${desc.label} ----\n${desc.wgsl}`;
      const module = createShaderModule(device, code, `pass:${desc.label}`);
      return device.createRenderPipeline({
        label: `pass:${desc.label}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_main', targets: formats.map((format) => ({ format })) },
        primitive: { topology: 'triangle-list' },
      });
    };
    if (!desc.lazy) this.pipe = this.make();
    this.entries = [
      { binding: 0, resource: { buffer: this.uniforms } },
      { binding: 1, resource: this.nearest },
      { binding: 2, resource: this.linear },
    ];
    this.colorAttachments = formats.map(() => ({
      view: undefined as unknown as GPUTextureView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 1, g: 1, b: 1, a: 1 },
    }));
    this.passDesc = { label: `pass:${desc.label}`, colorAttachments: this.colorAttachments };
    // Its empty first draw (ws/warm-voxel-fit) with scratch inputs, encoded before the device's
    // next real pass: a depth pass enabled mid-play (outline, AO, DOF) compiles at load.
    const warmer = pipelineWarmer(device);
    this.warmer = warmer;
    this.warmTarget = {
      color: formats,
      bind: (pass) => {
        const views: GPUTextureView[] = [];
        for (let i = 0; i < this.textures; i++) views.push(warmer.scratchSampled());
        pass.setBindGroup(0, this.group(warmer.scratchSampled(true), views, `warm:${this.label}`));
        return 1;
      },
    };
    if (!desc.lazy) this.warm();
  }

  private get pipeline(): GPURenderPipeline {
    this.pipe ??= this.make();
    return this.pipe;
  }

  /** Queue the empty first draw (once; a no-op after it or the first `encode`); a `lazy` pass makes its pipeline here. */
  warm(): void {
    if (this.primed) return;
    this.primed = true;
    this.warmer.warm(this.pipeline, this.warmTarget);
  }

  /** Whether the pipeline has been made and warmed, or drawn. */
  get warmed(): boolean {
    return this.primed;
  }

  /** The pass's uniform buffer, for an encoder-ordered copy (ws/render-12: one per XR eye). */
  get uniformBuffer(): GPUBuffer {
    return this.uniforms;
  }

  setUniforms(data: Float32Array): void {
    this.device.queue.writeBuffer(this.uniforms, 0, data.buffer, data.byteOffset, data.byteLength);
  }

  /** A bind group for `depth` and `textures` further inputs (cache it; rebuild on change). */
  createBindGroup(depth: GPUTextureView, views: readonly GPUTextureView[]): GPUBindGroup {
    if (views.length !== this.textures) {
      throw new Error(
        `pass ${this.label}: expected ${this.textures} textures, got ${views.length}`,
      );
    }
    return this.group(depth, views, `pass:${this.label}`);
  }

  private group(
    depth: GPUTextureView,
    views: readonly GPUTextureView[],
    label: string,
  ): GPUBindGroup {
    const entries = this.entries.slice();
    entries.push({ binding: 3, resource: depth });
    for (let i = 0; i < views.length; i++) entries.push({ binding: 4 + i, resource: views[i]! });
    return this.device.createBindGroup({ label, layout: this.layout, entries });
  }

  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    group: GPUBindGroup,
    timestampWrites?: GPURenderPassTimestampWrites,
    extraTargets?: readonly GPUTextureView[],
  ): void {
    const atts = this.colorAttachments;
    atts[0]!.view = target;
    for (let i = 1; i < atts.length; i++) {
      const view = extraTargets?.[i - 1];
      if (!view) throw new Error(`pass ${this.label}: expected ${atts.length} targets`);
      atts[i]!.view = view;
    }
    this.passDesc.timestampWrites = timestampWrites;
    this.primed = true;
    this.warmer.encode(encoder);
    const pass = encoder.beginRenderPass(this.passDesc);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.uniforms.destroy();
  }
}
