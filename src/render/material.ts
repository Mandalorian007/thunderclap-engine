import { type BindingDesc, BindingSet, hasBindings } from './bindings';
import { type BlendMode, blendState } from './blend';
import { VERTEX_LAYOUT_2D, type VertexLayout } from './mesh';
import type { SamplerKind, TextureLike } from './texture';
import { createShaderModule, materialPrelude } from './wgsl';

/**
 * Per-instance data, shared by sprites and meshes: 7 × vec4f = 28 floats = 112 bytes.
 *
 * | floats | WGSL (`VertexIn`) | content |
 * | --- | --- | --- |
 * | 0..3 | `m0` @location(3) | world matrix row 0 (3×4 row-major) |
 * | 4..7 | `m1` @location(4) | world matrix row 1 |
 * | 8..11 | `m2` @location(5) | world matrix row 2 |
 * | 12..15 | `uvRect` @location(6) | u0, v0, u1, v1 |
 * | 16..19 | `tint` @location(7) | linear RGBA |
 * | 20..23 | `params` @location(8) | free vec4 |
 * | 24..27 | `misc` @location(9) | emissive, flags (u32 bits, reserved: 0), size.x, size.y |
 *
 * `size` is `w, h` for `DrawParams` draws and `scale.x, scale.y` for `Transform` draws
 * (`VSOut.size`).
 */
export const INSTANCE_FLOATS = 28;
export const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

/** Float offsets of each field inside one instance (see `INSTANCE_FLOATS`). */
export const INSTANCE_OFFSET = {
  matrix: 0,
  uvRect: 12,
  tint: 16,
  params: 20,
  emissive: 24,
  flags: 25,
  size: 26,
} as const;

export const INSTANCE_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: INSTANCE_STRIDE,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 3, offset: 0, format: 'float32x4' }, // m0
    { shaderLocation: 4, offset: 16, format: 'float32x4' }, // m1
    { shaderLocation: 5, offset: 32, format: 'float32x4' }, // m2
    { shaderLocation: 6, offset: 48, format: 'float32x4' }, // uvRect
    { shaderLocation: 7, offset: 64, format: 'float32x4' }, // tint
    { shaderLocation: 8, offset: 80, format: 'float32x4' }, // params
    { shaderLocation: 9, offset: 96, format: 'float32x4' }, // misc: emissive, flags, size.xy
  ],
};

/** Depth attachment format of the scene pass when the camera asks for depth. */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/**
 * Depth state a pipeline is built for: 0 = no depth attachment (the 2D path), 1 = depth test
 * without writes (blended draws), 2 = depth test and write (opaque draws).
 */
export type DepthMode = 0 | 1 | 2;

export interface MaterialDesc extends BindingDesc {
  label: string;
  /**
   * WGSL appended after the material prelude. Must define
   * `@fragment fn fs_main(in: VSOut) -> FragOut` (or the entry named by `fragmentEntry`).
   * May declare `@group(1)` bindings following the convention in `bindings.ts`, and may define
   * its own vertex entry (set `vertexEntry`), typically wrapping `engine_vertex(v)`.
   */
  wgsl: string;
  blend?: BlendMode;
  vertexEntry?: string;
  fragmentEntry?: string;
  sampler?: SamplerKind;
  /**
   * Allow a separate uniform block per draw: pass `DrawParams.uniforms` to `frame.sprite` /
   * `frame.mesh` and that draw reads its own copy of `@group(1) @binding(0)`. Draws without
   * `uniforms` read the shared block from `setUniforms`. Needs `uniformBytes`. Draws with
   * their own uniforms don't merge into one instanced call. WGSL is unchanged.
   */
  perDrawUniforms?: boolean;
}

/**
 * A material = WGSL module + pipeline + its own bind group (group 1). Created through
 * `renderer.createMaterial()`. Pipelines are built once, at creation.
 */
export class Material {
  readonly label: string;
  /** The 2D pipeline (`VERTEX_LAYOUT_2D`, no depth), built at creation. */
  readonly pipeline: GPURenderPipeline;
  readonly blend: BlendMode;
  readonly bindings: BindingSet | null;
  private readonly device: GPUDevice;
  private readonly desc: MaterialDesc;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly targets: GPUColorTargetState[];
  /** Shader modules per vertex layout (the prelude differs per layout). */
  private readonly modules = new Map<VertexLayout, GPUShaderModule>();
  /** Pipelines per vertex layout, indexed by `DepthMode`. */
  private readonly pipelines = new Map<VertexLayout, (GPURenderPipeline | undefined)[]>();

  constructor(
    device: GPUDevice,
    desc: MaterialDesc,
    globalsLayout: GPUBindGroupLayout,
    targetFormats: readonly GPUTextureFormat[],
    sampler: GPUSampler,
    defaultView: GPUTextureView,
  ) {
    this.device = device;
    this.desc = desc;
    this.label = desc.label;
    this.blend = desc.blend ?? 'alpha';
    this.bindings = hasBindings(desc)
      ? new BindingSet(device, desc, sampler, defaultView, `material:${desc.label}`, {
          perDraw: desc.perDrawUniforms,
        })
      : null;
    if (desc.perDrawUniforms && !this.bindings) {
      throw new Error(`material ${desc.label}: perDrawUniforms needs uniformBytes`);
    }
    const layouts = this.bindings ? [globalsLayout, this.bindings.layout] : [globalsLayout];
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: layouts });
    const blend = blendState(this.blend);
    this.targets = targetFormats.map((format) => ({ format, blend }));
    this.pipeline = this.pipelineFor(VERTEX_LAYOUT_2D, 0);
  }

  /**
   * The pipeline for meshes in `layout` under depth mode `depth` (pipelines are keyed by
   * material, vertex layout and depth state). Built on first use and cached; the 2D,
   * no-depth one is `pipeline`. No allocation once built.
   */
  pipelineFor(layout: VertexLayout, depth: DepthMode): GPURenderPipeline {
    let byDepth = this.pipelines.get(layout);
    const hit = byDepth?.[depth];
    if (hit) return hit;
    if (!byDepth) {
      byDepth = [undefined, undefined, undefined];
      this.pipelines.set(layout, byDepth);
    }
    const desc = this.desc;
    let module = this.modules.get(layout);
    if (!module) {
      const code = `${materialPrelude(layout)}\n// ---- material: ${desc.label} ----\n${desc.wgsl}`;
      const suffix = layout === VERTEX_LAYOUT_2D ? '' : `:${layout.name}`;
      module = createShaderModule(this.device, code, `material:${desc.label}${suffix}`);
      this.modules.set(layout, module);
    }
    const is2d = layout === VERTEX_LAYOUT_2D && depth === 0;
    const pipeline = this.device.createRenderPipeline({
      label: is2d ? `material:${desc.label}` : `material:${desc.label}:${layout.name}:d${depth}`,
      layout: this.pipelineLayout,
      vertex: {
        module,
        entryPoint: desc.vertexEntry ?? 'vs_main',
        buffers: [layout.buffer, INSTANCE_BUFFER_LAYOUT],
      },
      fragment: {
        module,
        entryPoint: desc.fragmentEntry ?? 'fs_main',
        targets: this.targets,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      ...(depth === 0
        ? {}
        : {
            depthStencil: {
              format: DEPTH_FORMAT,
              depthWriteEnabled: depth === 2,
              depthCompare: 'less-equal' as GPUCompareFunction,
            },
          }),
    });
    byDepth[depth] = pipeline;
    return pipeline;
  }

  /** Write the material's uniform block (`@group(1) @binding(0)`). */
  setUniforms(data: BufferSource, byteOffset = 0): void {
    if (!this.bindings) throw new Error(`material ${this.label}: no uniforms declared`);
    this.bindings.setUniforms(data, byteOffset);
  }

  /** Bind a texture to slot `i` (`@group(1) @binding(2 + i)`). Rebuilds the bind group lazily. */
  setTexture(slot: number, tex: TextureLike | GPUTextureView): void {
    if (!this.bindings) throw new Error(`material ${this.label}: no textures declared`);
    this.bindings.setTexture(slot, tex);
  }

  destroy(): void {
    this.bindings?.destroy();
  }
}

/** Built-in textured sprite: `texture * vertexColor * tint`; emissive = colour × emissive. */
export const SPRITE_WGSL = /* wgsl */ `
@group(1) @binding(1) var spriteSampler: sampler;
@group(1) @binding(2) var spriteTex: texture_2d<f32>;

@fragment fn fs_main(in: VSOut) -> FragOut {
  let c = textureSample(spriteTex, spriteSampler, in.uv) * in.color;
  var o: FragOut;
  o.color = c;
  o.emissive = vec4f(c.rgb * in.emissive, c.a);
  return o;
}
`;
