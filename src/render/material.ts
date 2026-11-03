import { type BindingDesc, BindingSet, hasBindings } from './bindings';
import { type BlendMode, blendState } from './blend';
import { VERTEX_BUFFER_LAYOUT } from './mesh';
import type { SamplerKind, TextureLike } from './texture';
import { createShaderModule, WGSL_MATERIAL_PRELUDE } from './wgsl';

/** Per-instance data: 5 × vec4f = 20 floats = 80 bytes. */
export const INSTANCE_FLOATS = 20;
export const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

export const INSTANCE_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: INSTANCE_STRIDE,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 3, offset: 0, format: 'float32x4' }, // xform: x, y, w, h
    { shaderLocation: 4, offset: 16, format: 'float32x4' }, // misc: rotation, emissive, -, -
    { shaderLocation: 5, offset: 32, format: 'float32x4' }, // uvRect
    { shaderLocation: 6, offset: 48, format: 'float32x4' }, // tint
    { shaderLocation: 7, offset: 64, format: 'float32x4' }, // params
  ],
};

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
  readonly pipeline: GPURenderPipeline;
  readonly blend: BlendMode;
  readonly bindings: BindingSet | null;

  constructor(
    device: GPUDevice,
    desc: MaterialDesc,
    globalsLayout: GPUBindGroupLayout,
    targetFormats: readonly GPUTextureFormat[],
    sampler: GPUSampler,
    defaultView: GPUTextureView,
  ) {
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
    const code = `${WGSL_MATERIAL_PRELUDE}\n// ---- material: ${desc.label} ----\n${desc.wgsl}`;
    const module = createShaderModule(device, code, `material:${desc.label}`);
    const layouts = this.bindings ? [globalsLayout, this.bindings.layout] : [globalsLayout];
    const blend = blendState(this.blend);
    this.pipeline = device.createRenderPipeline({
      label: `material:${desc.label}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: {
        module,
        entryPoint: desc.vertexEntry ?? 'vs_main',
        buffers: [VERTEX_BUFFER_LAYOUT, INSTANCE_BUFFER_LAYOUT],
      },
      fragment: {
        module,
        entryPoint: desc.fragmentEntry ?? 'fs_main',
        targets: targetFormats.map((format) => ({ format, blend })),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
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
