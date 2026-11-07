import { type BindingDesc, BindingSet, hasBindings } from './bindings';
import { type BlendMode, blendState } from './blend';
import { VERTEX_LAYOUT_2D, type VertexLayout } from './mesh';
import type { SceneTarget } from './scene-target';
import type { SamplerKind, TextureLike } from './texture';
import {
  createShaderModule,
  materialPrelude,
  PLAIN_VARIANT,
  type PreludeVariant,
  prevLaneBufferLayout,
} from './wgsl';

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
 * | 24..27 | `misc` @location(9) | emissive, flags (bit 0 = no shadow, bits 1..23 = layers), size.x, size.y |
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
  /** Pipeline / bind group label. Default: `name`, else `'material'`. */
  label?: string;
  /** A name for the material (a file's material name); `Material.name`. Default: `label`. */
  name?: string;
  /**
   * Depth-test the draws (default true). False draws over whatever the scene holds at its
   * `order`, never writing depth: a world-space panel or marker inside geometry. Only the depth
   * compare changes; the draw still sorts with its order and group.
   */
  depthTest?: boolean;
  /**
   * The material writes the aux outputs of a target that has them (`SceneTargetDesc.aux`)
   * through `engine_write_aux` (the standard material does). Default false: the aux
   * attachments are masked off for this material's draws and its shader text never changes.
   */
  aux?: boolean;
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
  /**
   * A fragment entry for the sun's shadow pass (ws/render-5): `@fragment fn name(in: VSOut)`,
   * no outputs, that `discard`s what the material's own fragment discards (a dissolve, an
   * alpha cutout), so the shadow has the same holes. The shadow pipeline is then built from
   * this material's module with its group 1 bound. Default: none (the shadow pass is
   * depth-only, every caster casts a full shadow).
   */
  shadowFragmentEntry?: string;
  sampler?: SamplerKind;
  /**
   * Allow a separate uniform block per draw: pass `DrawParams.uniforms` to `frame.sprite` /
   * `frame.mesh` and that draw reads its own copy of `@group(1) @binding(0)`. Draws without
   * `uniforms` read the shared block from `setUniforms`. Needs `uniformBytes`. Draws with
   * their own uniforms don't merge into one instanced call. WGSL is unchanged.
   */
  perDrawUniforms?: boolean;
}

/** Index of a pipeline variant: depth mode × aux key × previous-matrix lane. */
const VARIANTS = 3 * 4 * 2;

/**
 * A material = WGSL module + pipeline + its own bind group (group 1). Created through
 * `renderer.createMaterial()`. Pipelines are built lazily, on first use per (vertex layout,
 * depth mode, target aux set, previous-matrix lane) and cached.
 */
export class Material {
  readonly label: string;
  /** `MaterialDesc.name` (a file's material name), else the label. */
  readonly name: string;
  /** `MaterialDesc.depthTest`: false draws over the scene on its layer. */
  readonly depthTest: boolean;
  readonly blend: BlendMode;
  readonly bindings: BindingSet | null;
  /** True when the material has a `shadowFragmentEntry` (its own shadow pipelines). */
  readonly shadowFragment: boolean;
  /** `MaterialDesc.aux`: the material writes a target's aux outputs (velocity among them). */
  readonly aux: boolean;
  private readonly device: GPUDevice;
  private readonly desc: MaterialDesc;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly targetFormats: readonly GPUTextureFormat[];
  private readonly blendState: GPUBlendState | undefined;
  /** Colour target states per aux key (0 none, 1 rough-metal, 2 velocity, 3 both). */
  private readonly targetsByAux: (GPUColorTargetState[] | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  /** Shader modules per vertex layout and prelude variant (`variantKey`). */
  private readonly modules = new Map<VertexLayout, (GPUShaderModule | undefined)[]>();
  /** Pipelines per vertex layout, indexed by variant (see `VARIANTS`). */
  private readonly pipelines = new Map<VertexLayout, (GPURenderPipeline | undefined)[]>();
  /** Shadow pipelines per vertex layout (`shadowFragmentEntry`). */
  private readonly shadowPipelines = new Map<VertexLayout, GPURenderPipeline>();
  private readonly scratchVariant: { roughMetal: boolean; velocity: boolean; prevLane: boolean } = {
    roughMetal: false,
    velocity: false,
    prevLane: false,
  };

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
    this.label = desc.label ?? desc.name ?? 'material';
    this.name = desc.name ?? this.label;
    this.depthTest = desc.depthTest !== false;
    this.blend = desc.blend ?? 'alpha';
    this.shadowFragment = desc.shadowFragmentEntry !== undefined;
    this.aux = desc.aux === true;
    this.bindings = hasBindings(desc)
      ? new BindingSet(device, desc, sampler, defaultView, `material:${this.label}`, {
          perDraw: desc.perDrawUniforms,
        })
      : null;
    if (desc.perDrawUniforms && !this.bindings) {
      throw new Error(`material ${this.label}: perDrawUniforms needs uniformBytes`);
    }
    const layouts = this.bindings ? [globalsLayout, this.bindings.layout] : [globalsLayout];
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: layouts });
    this.blendState = blendState(this.blend);
    this.targetFormats = targetFormats;
  }

  /**
   * The 2D pipeline (`VERTEX_LAYOUT_2D`, no depth), built on the first 2D draw (ws/render-4:
   * a material only ever drawn on 3D meshes compiles no 2D module).
   */
  get pipeline(): GPURenderPipeline {
    return this.pipelineFor(VERTEX_LAYOUT_2D, 0);
  }

  /**
   * The pipeline for meshes in `layout` under depth mode `depth` into `target` (its aux
   * attachments, `SceneTargetDesc.aux`; none without one), with `prevLane` a third vertex
   * buffer of previous instance matrices (an `InstanceList` with `velocity`). Keyed by
   * material, layout, depth state, aux set and lane; built on first use and cached; the 2D,
   * no-depth one is `pipeline`. No allocation once built.
   */
  pipelineFor(
    layout: VertexLayout,
    depth: DepthMode,
    target?: SceneTarget | null,
    prevLane = false,
  ): GPURenderPipeline {
    const aux = target ? target.auxKey : 0;
    const lane = prevLane && aux >= 2 && this.desc.aux === true;
    const key = depth + 3 * aux + 12 * (lane ? 1 : 0);
    let byKey = this.pipelines.get(layout);
    const hit = byKey?.[key];
    if (hit) return hit;
    if (!byKey) {
      byKey = new Array<GPURenderPipeline | undefined>(VARIANTS).fill(undefined);
      this.pipelines.set(layout, byKey);
    }
    const desc = this.desc;
    const module = this.moduleFor(layout, aux, lane);
    const is2d = layout === VERTEX_LAYOUT_2D && depth === 0 && aux === 0;
    const buffers: GPUVertexBufferLayout[] = lane
      ? [layout.buffer, INSTANCE_BUFFER_LAYOUT, prevLaneBufferLayout(layout)]
      : [layout.buffer, INSTANCE_BUFFER_LAYOUT];
    const pipeline = this.device.createRenderPipeline({
      label: is2d
        ? `material:${this.label}`
        : `material:${this.label}:${layout.name}:d${depth}${aux ? `:aux${aux}` : ''}${lane ? ':p' : ''}`,
      layout: this.pipelineLayout,
      vertex: {
        module,
        entryPoint: desc.vertexEntry ?? 'vs_main',
        buffers,
      },
      fragment: {
        module,
        entryPoint: desc.fragmentEntry ?? 'fs_main',
        targets: this.targetsFor(aux),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      ...(depth === 0
        ? {}
        : {
            depthStencil: {
              format: DEPTH_FORMAT,
              depthWriteEnabled: depth === 2 && this.depthTest,
              depthCompare: (this.depthTest ? 'less-equal' : 'always') as GPUCompareFunction,
            },
          }),
    });
    byKey[key] = pipeline;
    return pipeline;
  }

  /**
   * The shader module for `layout` and a target with aux key `aux` (`lane`: the previous-matrix
   * lane), built on first use: a material that does not write aux outputs compiles the plain
   * module for every target.
   */
  private moduleFor(layout: VertexLayout, aux: number, lane: boolean): GPUShaderModule {
    const desc = this.desc;
    const moduleKey = desc.aux ? aux + 4 * (lane ? 1 : 0) : 0;
    let modules = this.modules.get(layout);
    if (!modules) {
      modules = new Array<GPUShaderModule | undefined>(8).fill(undefined);
      this.modules.set(layout, modules);
    }
    let module = modules[moduleKey];
    if (!module) {
      let variant: PreludeVariant = PLAIN_VARIANT;
      if (moduleKey !== 0) {
        const v = this.scratchVariant;
        v.roughMetal = (aux & 1) !== 0;
        v.velocity = (aux & 2) !== 0;
        v.prevLane = lane;
        variant = v;
      }
      const code = `${materialPrelude(layout, variant)}\n// ---- material: ${this.label} ----\n${desc.wgsl}`;
      const suffix =
        (layout === VERTEX_LAYOUT_2D ? '' : `:${layout.name}`) +
        (moduleKey === 0 ? '' : `:aux${aux}${lane ? 'p' : ''}`);
      module = createShaderModule(this.device, code, `material:${this.label}${suffix}`);
      modules[moduleKey] = module;
    }
    return module;
  }

  /**
   * The sun's shadow pipeline for meshes in `layout` (`shadowFragmentEntry` set; throws
   * otherwise): the plain module's vertex entry and the shadow fragment entry, no colour
   * targets, depth write into `format` (the renderer's shadow map) with `less`, this material's
   * pipeline layout (group 1 bound by the shadow pass). Built on first use and cached.
   */
  shadowPipelineFor(layout: VertexLayout, format: GPUTextureFormat): GPURenderPipeline {
    const hit = this.shadowPipelines.get(layout);
    if (hit) return hit;
    const desc = this.desc;
    const entry = desc.shadowFragmentEntry;
    if (entry === undefined) {
      throw new Error(`material ${this.label}: no shadowFragmentEntry`);
    }
    const module = this.moduleFor(layout, 0, false);
    const pipeline = this.device.createRenderPipeline({
      label: `material-shadow:${this.label}:${layout.name}`,
      layout: this.pipelineLayout,
      vertex: {
        module,
        entryPoint: desc.vertexEntry ?? 'vs_main',
        buffers: [layout.buffer, INSTANCE_BUFFER_LAYOUT],
      },
      fragment: { module, entryPoint: entry, targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.shadowPipelines.set(layout, pipeline);
    return pipeline;
  }

  /**
   * Colour target states for a target with aux key `aux`: the scene formats with this
   * material's blend, then the aux attachments (`rg8unorm` rough-metal, `rg16float`
   * velocity), unblended, masked off unless the material declares `aux`.
   */
  private targetsFor(aux: number): GPUColorTargetState[] {
    const hit = this.targetsByAux[aux];
    if (hit) return hit;
    const blend = this.blendState;
    const targets: GPUColorTargetState[] = this.targetFormats.map((format) => ({ format, blend }));
    const writes = this.desc.aux === true;
    if (aux & 1) targets.push({ format: 'rg8unorm', writeMask: writes ? 0xf : 0 });
    if (aux & 2) targets.push({ format: 'rg16float', writeMask: writes ? 0xf : 0 });
    this.targetsByAux[aux] = targets;
    return targets;
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
