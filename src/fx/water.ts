import { plane } from '../geom';
import type { RenderCore } from '../render/core/core';
import type { Drawable, Frame, ViewInfo } from '../render/frame';
import { Mesh, VERTEX_LAYOUT_3D } from '../render/mesh';
import type { Renderer } from '../render/renderer';
import { auxSuffix, ScenePipelineCache, sceneVariant } from '../render/scene-pipelines';
import type { SceneTarget } from '../render/scene-target';
import { createShaderModule } from '../render/wgsl';
import { type WaterLook, WaterOnCore } from './water-core';
import { WATER_DEPTH_COPY_WGSL, WATER_MAX_WAVES, WATER_WGSL } from './water-wgsl';

/** Floats in the water's params block: 5 vec4 + `WATER_MAX_WAVES` vec4 (144 bytes). */
export const WATER_PARAMS_FLOATS = 20 + WATER_MAX_WAVES * 4;

const DEPTH_COPY_FORMAT: GPUTextureFormat = 'depth32float';

/** One scrolling wave layer (`WaterOptions.waves`, `Water.waves`). */
export interface WaterWave {
  /** World units → field units (bigger is choppier). */
  scale: number;
  /** Field units scrolled per second. */
  speed: number;
  /** Normal strength (and, times `displace`, height) of the layer. */
  amplitude: number;
  /** Scroll direction in the xz plane; normalised when packed. */
  direction: [number, number];
}

/** Foam settings (`WaterOptions.foam`, `Water.foam`); `null` for none. */
export interface WaterFoam {
  /** World units of water depth under which foam forms. Default 0.4. */
  width: number;
  /** Linear RGB. Default near white. */
  color: ArrayLike<number>;
}

export interface WaterOptions {
  /** Plane extent along x and z (one number for a square). Default 100. Fixed at construction. */
  size?: number | [number, number];
  /** Grid subdivisions; `displace` needs more than 1 to show. Default 1. Fixed at construction. */
  segments?: number | [number, number];
  /** Surface height (y), relative to `origin`. Default 0. */
  level?: number;
  /**
   * World position of the plane's centre: x and z are baked into the mesh, y is added to
   * `level` (a world whose corner is the origin puts its water at `[sizeX / 2, 0, sizeZ / 2]`).
   * Default `[0, 0, 0]`. Fixed at construction.
   */
  origin?: ArrayLike<number>;
  /** Linear RGB where the water is shallow. */
  shallowColor?: ArrayLike<number>;
  /** Linear RGB at full depth. */
  deepColor?: ArrayLike<number>;
  /** World units of water depth at which the tint reaches `deepColor`. Default 4. */
  depthFade?: number;
  /** Reflection strength, 0..1 (the weight of the sky colour at grazing angles). Default 0.6. */
  fresnel?: number;
  /** Roughness of the sun highlight. Default 0.08. */
  roughness?: number;
  /** Wave layers (up to `WATER_MAX_WAVES`). Default two layers. */
  waves?: WaterWave[];
  /** Foam where the surface meets geometry; `null` for none. Default on, width 0.4. */
  foam?: Partial<WaterFoam> | null;
  /** Vertex height amplitude of the summed layers. Default 0 (flat mesh, normals still move). */
  displace?: number;
  /** Alpha away from the shoreline. Default 0.85. */
  opacity?: number;
  /** Where to copy the scene depth from (`renderer.target` by default). */
  depthTarget?: SceneTarget;
  /**
   * Take this frame's opaque depth from the renderer's depth hook (`Drawable.readsDepth`,
   * ws/render-hooks) instead of copying the previous frame's in `prepare`: the view splits its
   * scene pass and the water samples the renderer's copy. Only a view with `depthTest` splits;
   * elsewhere the water is then deep everywhere (no copy of its own). Default false.
   */
  readsDepth?: boolean;
  /**
   * On a render core: how far the scene behind the surface (the core's colour copy) is bent by
   * the waves; 0 tints by depth only, as on a `Renderer`. Default 1.
   */
  refraction?: number;
  /**
   * On a render core: steps of the screen-space reflection march (0: the sky gradient only).
   * Default 16. With `refraction`, makes the water read the core's colour (`readsColor`): the
   * target then needs `CoreTarget.texture` with `COPY_SRC`.
   */
  reflectionSteps?: number;
  /** On a render core: how far the reflection march reaches (world units). Default 30. */
  reflectionReach?: number;
  /** On a render core: the direction to the sun (normalised when packed). Default `[0.4, 0.8, 0.3]`. */
  sunDirection?: ArrayLike<number>;
  /** On a render core: the sun's linear colour (zero: no sun). Default `[1.6, 1.5, 1.3]`. */
  sunColor?: ArrayLike<number>;
  /** On a render core: the reflected sky's horizon colour. Default a pale haze. */
  skyColor?: ArrayLike<number>;
  /**
   * On a render core: draw the plane (ws/scene-read-fit). False keeps the water for its looks
   * only (`Water.look`: the game's own geometry shaded as this water); its block and clock still
   * update each frame. Default true. Live (`Water.plane`).
   */
  plane?: boolean;
  /**
   * On a render core: the game's own water shading (B24), WGSL declaring
   * `fn water_shade(frag: vec2f, ndc: vec2f, world: vec3f, up: vec3f) -> WaterShade` (and any
   * helpers) in place of the engine's; the plane and every look (`Water.look`) call it. In scope:
   * `WaterShade` (premultiplied `color`, `rough_metal`, `velocity`), the params `water` and core
   * block `wc`, `scene_depth` and `scene_color` (1×1 when there is none), `extras`, `view`,
   * `water_field`, `engine_noise`, the `fx_depth_` helpers, `w_ggx`, `w_schlick`, `w_unproject`
   * and the engine's own shading as `water_shade_engine`. A look's set may declare groups of its
   * own that the shading reads. Call it in uniform control flow. Fixed at construction. Default
   * the engine's.
   */
  shade?: string;
}

const DEFAULT_SUN_DIR = [0.4, 0.8, 0.3] as const;
const DEFAULT_SUN_COLOR = [1.6, 1.5, 1.3] as const;
const DEFAULT_SKY = [0.62, 0.72, 0.9] as const;

const DEFAULT_SHALLOW = [0.1, 0.45, 0.45] as const;
const DEFAULT_DEEP = [0.01, 0.07, 0.14] as const;
const DEFAULT_FOAM_COLOR = [0.9, 0.95, 0.97] as const;
const DEFAULT_WAVES = (): WaterWave[] => [
  { scale: 0.35, speed: 0.6, amplitude: 0.25, direction: [1, 0.3] },
  { scale: 0.9, speed: 0.9, amplitude: 0.12, direction: [-0.4, 1] },
];

const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/**
 * An animated water surface: a plane from `geom`'s `plane` whose shader sums scrolling
 * analytic wave layers for the normal (and the height when `displace` > 0), lerps a depth-tinted
 * refraction colour towards a sky reflection by Fresnel, adds the sun's GGX highlight (also to
 * the emissive target), fades to transparent at the shoreline and foams where the water is
 * shallower than `foam.width`. `frame.drawable(water, order)` draws it after opaque geometry
 * (drawables sort as blended); `update(dt)` advances the waves.
 *
 * Every field is live; `prepare` packs them into one `WATER_PARAMS_FLOATS` params block per
 * frame. The sun, its colour and the fog colour (the horizon of the reflection) come from
 * `frame.lights`; `Sky` present or not.
 *
 * Depth: under a depth camera the water tests and writes depth (`less-equal`), so particles and
 * trails sort against it, and `prepare` copies the scene depth (`depthTarget ?? renderer.target`,
 * its `SceneTarget.depth`) into its own `depth32float` texture for the depth fade, the shoreline
 * alpha and the foam. The copy runs before this frame's scene pass, so it holds what the target
 * held then: the previous frame's depth (which includes this water's own surface, read as "no
 * information": deep, no foam) or that of an earlier `renderer.render` call this frame. For a
 * shoreline, draw the water on its own layer in a second view of the same camera, after the
 * opaque view (`harness/water.ts` does). Without a depth camera there is no copy: the surface is
 * deep everywhere, foam off, and the pipeline has no depth state.
 */
export class Water implements Drawable {
  /** Surface height (y) above `origin`. Live. */
  level: number;
  /** World position of the plane's centre (`WaterOptions.origin`). Fixed. */
  readonly origin = new Float32Array(3);
  /** Linear RGB where the water is shallow. Live. */
  readonly shallowColor = new Float32Array(3);
  /** Linear RGB at full depth. Live. */
  readonly deepColor = new Float32Array(3);
  /** World units of water depth to full `deepColor`. Live. */
  depthFade: number;
  /** Reflection strength, 0..1. Live. */
  fresnel: number;
  /** Roughness of the sun highlight. Live. */
  roughness: number;
  /** Wave layers; the first `WATER_MAX_WAVES` are uploaded. Live (replace or mutate). */
  waves: WaterWave[];
  /** Foam settings, or null for none. Live (replace or mutate). */
  foam: WaterFoam | null;
  /** Vertex height amplitude. Live. */
  displace: number;
  /** Alpha away from the shoreline. Live. */
  opacity: number;
  /** Where the scene depth is copied from; null for `renderer.target`. Live. */
  depthTarget: SceneTarget | null;
  /** See `WaterOptions.readsDepth`. Live. */
  readsDepth: boolean;
  /** Seconds `update` has advanced; the waves' clock. */
  time = 0;
  /** The plane, owned; drawn through this drawable's own pipeline. */
  readonly mesh: Mesh;
  /** On a render core: see `WaterOptions.refraction`. Live. */
  refraction: number;
  /** On a render core: see `WaterOptions.reflectionSteps` (the `waterReflectionKnob`). Live. */
  reflectionSteps: number;
  /** On a render core: see `WaterOptions.reflectionReach`. Live. */
  reflectionReach: number;
  /** On a render core: the direction to the sun. Live. */
  readonly sunDirection = new Float32Array(3);
  /** On a render core: the sun's linear colour. Live. */
  readonly sunColor = new Float32Array(3);
  /** On a render core: the reflected sky's horizon colour. Live. */
  readonly skyColor = new Float32Array(3);
  /** On a render core: see `WaterOptions.plane`. Live. */
  plane: boolean;
  /** On a render core (B5): the core drawable that draws the water in every view (else null). */
  readonly coreDrawable: WaterOnCore | null = null;

  private readonly renderer: Renderer | null;
  private readonly device: GPUDevice;
  private readonly params: Float32Array<ArrayBuffer>;
  private readonly paramsBuffer: GPUBuffer;
  private readonly layout!: GPUBindGroupLayout;
  private readonly dummy!: GPUTexture;
  private readonly dummyGroup!: GPUBindGroup;
  private readonly desc!: GPURenderPipelineDescriptor;
  /**
   * Pipelines per depth format (null: none; a depth one writes depth) × the view target's aux
   * key, built on first use from `renderer.sceneTargets` (ws/render-10).
   */
  private readonly pipelines = new ScenePipelineCache();
  private readonly copyLayout!: GPUBindGroupLayout;
  private readonly copyPipeline!: GPURenderPipeline;
  private readonly copyAtt!: GPURenderPassDepthStencilAttachment;
  private readonly copyPass!: GPURenderPassDescriptor;
  private copy: GPUTexture | null = null;
  private copyGroup: GPUBindGroup | null = null;
  private src: object | null = null;
  private srcGroup: GPUBindGroup | null = null;
  /** The depth copy ran this frame (`draw` binds it and the shader reads it). */
  private depthOn = false;
  /** The renderer's `depthCopy` view the hook group was made for (`readsDepth`). */
  private hookView: GPUTextureView | null = null;
  private hookGroup: GPUBindGroup | null = null;
  /** The group `draw` binds: own copy, the renderer's copy, or the 1×1 stand-in. */
  private depthGroup: GPUBindGroup | null = null;

  /**
   * On a `Renderer` (a `Drawable`: `frame.drawable(water)`), or on a `RenderCore` (B5): added
   * to the core as a drawable in its `'transparent'` pass, drawn in every view, its depth and
   * (with `refraction` or `reflectionSteps`) colour read from the core.
   */
  constructor(renderer: Renderer | RenderCore, opts: WaterOptions = {}) {
    const device = renderer.device;
    const core = 'addDrawable' in renderer ? (renderer as RenderCore) : null; // no value import: fx without the core stays small
    this.renderer = core ? null : (renderer as Renderer);
    this.device = device;
    this.refraction = opts.refraction ?? 1;
    this.reflectionSteps = opts.reflectionSteps ?? 16;
    this.reflectionReach = opts.reflectionReach ?? 30;
    this.plane = opts.plane ?? true;
    set3(this.sunDirection, opts.sunDirection ?? DEFAULT_SUN_DIR);
    set3(this.sunColor, opts.sunColor ?? DEFAULT_SUN_COLOR);
    set3(this.skyColor, opts.skyColor ?? DEFAULT_SKY);
    this.level = opts.level ?? 0;
    set3(this.shallowColor, opts.shallowColor ?? DEFAULT_SHALLOW);
    set3(this.deepColor, opts.deepColor ?? DEFAULT_DEEP);
    this.depthFade = opts.depthFade ?? 4;
    this.fresnel = opts.fresnel ?? 0.6;
    this.roughness = opts.roughness ?? 0.08;
    this.waves = opts.waves ?? DEFAULT_WAVES();
    const foam = opts.foam;
    this.foam =
      foam === null
        ? null
        : { width: foam?.width ?? 0.4, color: foam?.color ?? DEFAULT_FOAM_COLOR };
    this.displace = opts.displace ?? 0;
    this.opacity = opts.opacity ?? 0.85;
    this.depthTarget = opts.depthTarget ?? null;
    this.readsDepth = opts.readsDepth ?? false;

    if (opts.origin) set3(this.origin, opts.origin);
    const geometry = plane({ size: opts.size ?? 100, segments: opts.segments ?? 1 });
    const ox = this.origin[0]!;
    const oz = this.origin[2]!;
    if (ox !== 0 || oz !== 0) {
      const v = geometry.vertices;
      const stride = geometry.layout.floats;
      for (let i = 0; i < v.length; i += stride) {
        v[i] = v[i]! + ox;
        v[i + 2] = v[i + 2]! + oz;
      }
      geometry.bounds.center[0] += ox;
      geometry.bounds.center[2] += oz;
    }
    this.mesh = core
      ? new Mesh(device, { ...geometry, label: 'water' })
      : (renderer as Renderer).createMesh({ ...geometry, label: 'water' });

    this.params = new Float32Array(WATER_PARAMS_FLOATS);
    this.paramsBuffer = device.createBuffer({
      label: 'water-params',
      size: this.params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    if (core) {
      this.coreDrawable = new WaterOnCore(core, this, this.paramsBuffer, {
        readsColor: this.refraction > 0 || this.reflectionSteps > 0,
        shade: opts.shade,
      });
      core.addDrawable(this.coreDrawable);
      return;
    }
    const host = renderer as Renderer;
    this.layout = device.createBindGroupLayout({
      label: 'water-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
    this.dummy = device.createTexture({
      label: 'water-depth-none',
      size: [1, 1],
      format: DEPTH_COPY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dummyGroup = this.makeGroup('water', this.dummy.createView());

    const module = createShaderModule(device, WATER_WGSL, 'water');
    this.desc = {
      label: 'water',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [host.globalsLayout, this.layout],
      }),
      vertex: { module, entryPoint: 'vs', buffers: [VERTEX_LAYOUT_3D.buffer] },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: host.sceneTargets(PREMULTIPLIED),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    };
    this.pipelines.set(null, host.target.auxKey, device.createRenderPipeline(this.desc));

    this.copyLayout = device.createBindGroupLayout({
      label: 'water-depth-copy-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
    const copyModule = createShaderModule(device, WATER_DEPTH_COPY_WGSL, 'water-depth-copy');
    this.copyPipeline = device.createRenderPipeline({
      label: 'water-depth-copy',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.copyLayout] }),
      vertex: { module: copyModule, entryPoint: 'vs' },
      fragment: { module: copyModule, entryPoint: 'fs', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: DEPTH_COPY_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
    });
    this.copyAtt = {
      view: undefined as unknown as GPUTextureView,
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    };
    this.copyPass = {
      label: 'water-depth-copy',
      colorAttachments: [],
      depthStencilAttachment: this.copyAtt,
    };
  }

  /** Advance the waves' clock. */
  update(dt: number): void {
    this.time += dt;
  }

  /**
   * Copy the scene depth (under a depth camera) and pack the live fields into the params block
   * (`WATER_PARAMS_FLOATS` floats: shallow rgb + opacity, deep rgb + depthFade, fresnel,
   * roughness, displace, level, foam rgb + width, time, wave count, depth copy on, 0, then
   * scale, speed, amplitude, direction angle per wave). Called by the renderer once per frame.
   * No allocation in steady state.
   */
  prepare(encoder: GPUCommandEncoder, frame?: Frame): void {
    // With `readsDepth` the renderer's hook (`afterOpaque`) supplies this frame's depth; on a
    // core the draw reads the core's own.
    this.depthOn = this.coreDrawable
      ? true
      : this.readsDepth
        ? false
        : this.copyDepth(encoder, frame);
    this.depthGroup = this.depthOn ? this.copyGroup : null;
    const p = this.params;
    p[0] = this.shallowColor[0]!;
    p[1] = this.shallowColor[1]!;
    p[2] = this.shallowColor[2]!;
    p[3] = this.opacity;
    p[4] = this.deepColor[0]!;
    p[5] = this.deepColor[1]!;
    p[6] = this.deepColor[2]!;
    p[7] = this.depthFade;
    p[8] = this.fresnel;
    p[9] = this.roughness;
    p[10] = this.displace;
    p[11] = this.level;
    const foam = this.foam;
    p[12] = foam ? (foam.color[0] ?? 0) : 0;
    p[13] = foam ? (foam.color[1] ?? 0) : 0;
    p[14] = foam ? (foam.color[2] ?? 0) : 0;
    p[15] = foam ? foam.width : 0;
    const count = Math.min(this.waves.length, WATER_MAX_WAVES);
    p[16] = this.time;
    p[17] = count;
    p[18] = this.depthOn ? 1 : 0;
    p[19] = this.origin[1]!;
    for (let i = 0; i < WATER_MAX_WAVES; i++) {
      const o = 20 + i * 4;
      const w = i < count ? this.waves[i]! : null;
      p[o] = w ? w.scale : 0;
      p[o + 1] = w ? w.speed : 0;
      p[o + 2] = w ? w.amplitude : 0;
      p[o + 3] = w ? Math.atan2(w.direction[1], w.direction[0]) : 0;
    }
    this.device.queue.writeBuffer(this.paramsBuffer, 0, p);
  }

  /** Draw inside the scene pass: the plane, a depth-writing pipeline when the frame has depth. */
  draw(pass: GPURenderPassEncoder, frame?: Frame): void {
    const mesh = this.mesh;
    if (mesh.indexCount <= 0) return;
    const fmt = frame?.depthFormat ?? null;
    pass.setPipeline(this.pipelineFor(fmt, frame ? frame.auxKey : this.renderer!.target.auxKey));
    pass.setBindGroup(1, this.depthGroup ?? this.dummyGroup);
    pass.setVertexBuffer(0, mesh.vertexBuffer);
    pass.setIndexBuffer(mesh.indexBuffer!, mesh.indexFormat);
    pass.drawIndexed(mesh.indexCount);
  }

  /**
   * The renderer's depth hook (`readsDepth`): bind this frame's opaque depth copy and flip the
   * shader's depth flag on (a 4-byte write; `queue.writeBuffer` lands before the frame's
   * commands run). A new bind group only when the copy texture changed (resize).
   */
  afterOpaque(_encoder: GPUCommandEncoder, view: ViewInfo): void {
    if (view.depthView !== this.hookView) {
      this.hookView = view.depthView;
      this.hookGroup = this.makeGroup('water-hook', view.depthView);
    }
    this.depthOn = true;
    this.depthGroup = this.hookGroup;
    const p = this.params;
    p[18] = 1;
    this.device.queue.writeBuffer(this.paramsBuffer, 18 * 4, p.buffer, 18 * 4, 4);
  }

  private copyDepth(encoder: GPUCommandEncoder, frame: Frame | undefined): boolean {
    if (!frame?.depthFormat) return false;
    const src = (this.depthTarget ?? this.renderer!.target).depth;
    if (!src) return false;
    const device = this.device;
    if (!this.copy || this.copy.width !== src.width || this.copy.height !== src.height) {
      this.copy?.destroy();
      this.copy = device.createTexture({
        label: 'water-depth',
        size: [src.width, src.height],
        format: DEPTH_COPY_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      const view = this.copy.createView();
      this.copyAtt.view = view;
      this.copyGroup = this.makeGroup('water-soft', view);
    }
    if (this.src !== src) {
      this.src = src;
      this.srcGroup = device.createBindGroup({
        label: 'water-depth-copy',
        layout: this.copyLayout,
        entries: [{ binding: 0, resource: src.view }],
      });
    }
    const pass = encoder.beginRenderPass(this.copyPass);
    pass.setPipeline(this.copyPipeline);
    pass.setBindGroup(0, this.srcGroup!);
    pass.draw(3);
    pass.end();
    return true;
  }

  private makeGroup(label: string, depth: GPUTextureView): GPUBindGroup {
    return this.device.createBindGroup({
      label,
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: depth },
      ],
    });
  }

  private pipelineFor(format: GPUTextureFormat | null, aux: number): GPURenderPipeline {
    const p = this.pipelines.get(format, aux);
    if (p) return p;
    return this.pipelines.set(
      format,
      aux,
      this.device.createRenderPipeline(
        sceneVariant(
          this.desc,
          this.renderer!.sceneTargets(PREMULTIPLIED, aux),
          `water${format ? `:${format}` : ''}${auxSuffix(aux)}`,
          format ? { format, depthWriteEnabled: true, depthCompare: 'less-equal' } : undefined,
        ),
      ),
    );
  }

  /**
   * On a render core (ws/scene-read-fit): this water as a look over the game's own geometry,
   * whose bind group sits at `group` in the set's layout (`1 + ` its index in the set's
   * `bindGroups`). The set takes the look's blend, writes, `readsDepth` and `readsColor`,
   * draws in `'transparent'`, and its fragment returns `water_look_out(water_look(...))`.
   * One look per group index, kept for the water's life. Throws on a `Renderer`.
   */
  look(group = 1): WaterLook {
    if (!this.coreDrawable) throw new Error('Water.look: needs a render core');
    return this.coreDrawable.look(group);
  }

  destroy(): void {
    const cd = this.coreDrawable;
    if (cd) {
      cd.core.removeDrawable(cd);
      cd.destroy();
    }
    this.paramsBuffer.destroy();
    this.dummy?.destroy();
    this.copy?.destroy();
    this.copy = null;
    this.mesh.destroy();
  }
}

/**
 * One wave layer's value and gradient at field point (`px`, `py`): the shader's `water_wave`.
 * Writes `[value, d/dx, d/dy]` into `out`.
 */
function wave(px: number, py: number, out: Float32Array | number[]): void {
  const a = px + 0.6 * Math.sin(1.3 * py);
  const b = 0.8 * py + 0.5 * Math.sin(0.9 * px);
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const sb = Math.sin(b);
  const cb = Math.cos(b);
  out[0] = sa * cb;
  out[1] = ca * cb - sa * sb * 0.45 * Math.cos(0.9 * px);
  out[2] = ca * cb * 0.78 * Math.cos(1.3 * py) - sa * sb * 0.8;
}

const waveOut = [0, 0, 0];

/**
 * The surface height at world (`x`, `z`) at time `t` (default `water.time`): the origin's y
 * plus `level` plus `displace` times the summed wave layers, the formula the vertex shader
 * runs. Pure; no allocation. With `displace` 0 it is `origin[1] + level`.
 */
export function waterHeight(water: Water, x: number, z: number, t = water.time): number {
  let h = 0;
  const n = Math.min(water.waves.length, WATER_MAX_WAVES);
  for (let i = 0; i < n; i++) {
    const w = water.waves[i]!;
    const angle = Math.atan2(w.direction[1], w.direction[0]);
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    wave(x * w.scale + dx * t * w.speed, z * w.scale + dz * t * w.speed, waveOut);
    h += w.amplitude * waveOut[0]!;
  }
  return water.origin[1]! + water.level + water.displace * h;
}

function set3(out: Float32Array, v: ArrayLike<number>): void {
  out[0] = v[0] ?? 0;
  out[1] = v[1] ?? 0;
  out[2] = v[2] ?? 0;
}
