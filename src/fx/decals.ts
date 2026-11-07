import type { Random } from '../core/random';
import { blendState } from '../render/blend';
import type { Camera } from '../render/camera';
import type { Drawable, Frame, ViewInfo } from '../render/frame';
import { Mesh, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS, VERTEX3D_STRIDE } from '../render/mesh';
import type { Renderer } from '../render/renderer';
import { auxSuffix, ScenePipelineCache } from '../render/scene-pipelines';
import type { TextureLike } from '../render/texture';
import { createShaderModule } from '../render/wgsl';
import { WGSL_DECAL_BOX, WGSL_DECAL_DEPTH_COPY, WGSL_DECAL_QUAD } from './decals-wgsl';
import { defaultFxRandom } from './random';

/**
 * Floats per decal instance (6 × vec4f = 96 bytes):
 *
 * | floats | WGSL (`DecalVertex`) | content |
 * | --- | --- | --- |
 * | 0..11 | `m0..m2` @location(3..5) | world → local 3×4 matrix, row-major (unit box) |
 * | 12..15 | `uv_rect` @location(6) | atlas rect: u0, v0, du, dv |
 * | 16..19 | `color` @location(7) | linear RGBA multiplier |
 * | 20..23 | `life` @location(8) | age / lifetime (0 when infinite), lifetime, 0, 0 |
 */
export const DECAL_INSTANCE_FLOATS = 24;
/** Floats in the decals' params block: `inv_view_proj` (16), `shape` (4), `fade` (4). */
export const DECAL_PARAMS_FLOATS = 24;

/** How decals mix with what is under them. */
export type DecalBlend = 'alpha' | 'multiply' | 'additive';
/** `box` projects through the scene depth, `quad` lies on the surface, `auto` picks by camera. */
export type DecalMode = 'auto' | 'box' | 'quad';

export interface DecalsOptions {
  /** Decals kept at once; the oldest is overwritten when full. Default 256. */
  capacity?: number;
  /** The atlas every decal samples. */
  texture: TextureLike;
  /** Atlas grid (`tile` indexes it row-major). Default 1×1. */
  atlas?: { columns: number; rows: number };
  /** Default `alpha`. */
  blend?: DecalBlend;
  /** Alpha over normalised age (0 → 1). Default `[1, 0]`; ignored for infinite lifetimes. */
  fade?: [number, number];
  /** Default lifetime, seconds. Default Infinity. */
  lifetime?: number;
  /** Default `auto`: `box` under a depth camera, else `quad`. */
  mode?: DecalMode;
  /** Quad mode: lift along the normal, world units. Default 0.01. */
  offset?: number;
  /** Box mode: reject surfaces whose normal's cosine against the decal's is below this. Default 0.3. */
  normalBias?: number;
  /** Box mode: fade over this share of the box's half depth at each end. Default 0.2. */
  fadeEdge?: number;
  /**
   * Box mode: read this frame's opaque depth from the renderer's depth hook
   * (`Drawable.readsDepth`, ws/fx-4). Default true (false for `mode: 'quad'`, which reads no
   * depth). `false` is the fallback: `prepare` copies the
   * scene depth before the scene pass, so the box samples the **previous frame's** depth (a
   * moving surface trails by a frame). The fallback is also taken automatically when the
   * renderer cannot copy its depth (an adopted XR depth without `COPY_SRC`).
   */
  readsDepth?: boolean;
  /**
   * The stream `rotation: 'random'` and `tile: 'random'` draw from (ws/fx-4). Default: a fork
   * of the fx module default (`FX_DEFAULT_SEED`), named by creation order.
   */
  random?: Random;
}

/** One decal to place (`Decals.add`). */
export interface DecalDesc {
  x: number;
  y: number;
  z: number;
  /** Surface normal the decal faces along (need not be unit). */
  nx: number;
  ny: number;
  nz: number;
  /** Width and height (and box depth), world units. */
  size: number;
  /** Spin about the normal, radians, or `'random'` (drawn from `Decals.random`). Default 0. */
  rotation?: number | 'random';
  /** Atlas tile, row-major, or `'random'` (any tile of the atlas, from `Decals.random`). Default 0. */
  tile?: number | 'random';
  /** Linear RGBA multiplier. Default white. */
  color?: ArrayLike<number>;
  /** Seconds, overriding the system default. */
  lifetime?: number;
}

const DEPTH_COPY_FORMAT: GPUTextureFormat = 'depth32float';
const F = DECAL_INSTANCE_FLOATS;

/**
 * Projected decals: an atlas stamped onto scenery, every live decal in one instanced draw.
 * `frame.drawable(decals, order)` draws them; `update(dt)` ages them.
 *
 * Two implementations behind one API. **Box** (under a depth camera): each decal is a unit box
 * in its own frame; the fragment shader reconstructs the world position under the pixel from a
 * copy of the scene depth, rejects what is outside the box and samples the atlas by the local
 * xy, so the decal wraps whatever it covers (depth test and write off). The depth is this
 * frame's opaque depth, from the renderer's depth hook (`readsDepth`, `afterOpaque`), so a decal
 * on a moving surface stays on it. With `readsDepth: false` (or a target whose depth cannot be
 * copied) the fallback copy is taken in `prepare`, before the scene pass, and holds the
 * **previous frame's** depth: a decal placed this frame appears next frame. **Quad**
 * (no depth, or `mode: 'quad'`): a camera-independent quad lifted along the normal by `offset`
 * (depth test on, write off).
 *
 * Handles are monotonic ids; `remove` marks a decal dead and the next `update` (or `prepare`)
 * compacts the live ones to the front, keeping the id → slot map. Nothing allocates per frame
 * when nothing died.
 */
export class Decals implements Drawable {
  readonly capacity: number;
  readonly mode: DecalMode;
  /** The mode the last `prepare` resolved (`auto` → by the frame's depth); null before. */
  activeMode: 'box' | 'quad' | null = null;
  /** Default lifetime for `add` (seconds). Live. */
  lifetime: number;
  /** Quad lift along the normal. Live. */
  offset: number;
  /** Box: minimum cosine between the surface and decal normals. Live. */
  normalBias: number;
  /** Box: share of the half depth faded at each end. Live. */
  fadeEdge: number;
  /** Alpha at age 0 and at the lifetime. Live. */
  readonly fade: [number, number];
  /** Box: take this frame's depth from the renderer's hook (see `DecalsOptions`). Live. */
  readsDepth: boolean;
  /** The stream `'random'` rotations and tiles draw from. Live. */
  random: Random;

  private readonly renderer: Renderer;
  private readonly device: GPUDevice;
  private readonly columns: number;
  private readonly rows: number;
  private readonly multiply: boolean;
  private readonly data: Float32Array<ArrayBuffer>;
  private readonly ages: Float32Array;
  private readonly lives: Float32Array;
  private readonly ids: Float64Array;
  private readonly alive: Uint8Array;
  private readonly slotOf = new Map<number, number>();
  private live = 0;
  /** Slots in use, dead ones included until the next compaction. */
  private used = 0;
  private dirty = false;
  private nextId = 1;

  private readonly params: Float32Array<ArrayBuffer>;
  private readonly paramsBuffer: GPUBuffer;
  private readonly instanceBuffer: GPUBuffer;
  private readonly box: Mesh;
  private readonly quad: Mesh;
  private readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly texture: TextureLike;
  private readonly dummyDepth: GPUTexture;
  private group: GPUBindGroup;
  private readonly boxModule: GPUShaderModule;
  private readonly quadModule: GPUShaderModule;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly blend: GPUBlendState | undefined;
  /**
   * Pipelines per mode: depth format (null: none) × the view target's aux key, built on first
   * use from `renderer.sceneTargets` (ws/render-10).
   */
  private readonly boxPipelines = new ScenePipelineCache();
  private readonly quadPipelines = new ScenePipelineCache();
  // Depth copy (box mode).
  private readonly copyLayout: GPUBindGroupLayout;
  private readonly copyPipeline: GPURenderPipeline;
  private readonly copyAtt: GPURenderPassDepthStencilAttachment;
  private readonly copyPass: GPURenderPassDescriptor;
  private copyTex: GPUTexture | null = null;
  private copySrc: TextureLike | null = null;
  private copySrcGroup: GPUBindGroup | null = null;
  /** The box draw has a depth copy to read this frame. */
  private depthReady = false;
  /** The bind group over the fallback copy (`copyTex`). */
  private copyGroup: GPUBindGroup | null = null;
  /** The renderer's `depthCopy` view the hook group was made for. */
  private hookView: GPUTextureView | null = null;
  private hookGroup: GPUBindGroup | null = null;
  private readonly noDepthGroup: GPUBindGroup;

  constructor(renderer: Renderer, opts: DecalsOptions) {
    const device = renderer.device;
    this.renderer = renderer;
    this.device = device;
    this.capacity = Math.max(1, Math.floor(opts.capacity ?? 256));
    this.mode = opts.mode ?? 'auto';
    this.lifetime = opts.lifetime ?? Number.POSITIVE_INFINITY;
    this.offset = opts.offset ?? 0.01;
    this.normalBias = opts.normalBias ?? 0.3;
    this.fadeEdge = opts.fadeEdge ?? 0.2;
    this.fade = [opts.fade?.[0] ?? 1, opts.fade?.[1] ?? 0];
    this.readsDepth = opts.readsDepth ?? this.mode !== 'quad';
    this.random = opts.random ?? defaultFxRandom('decals');
    this.columns = Math.max(1, opts.atlas?.columns ?? 1);
    this.rows = Math.max(1, opts.atlas?.rows ?? 1);
    const blend = opts.blend ?? 'alpha';
    this.multiply = blend === 'multiply';
    this.texture = opts.texture;

    const cap = this.capacity;
    this.data = new Float32Array(cap * F);
    this.ages = new Float32Array(cap);
    this.lives = new Float32Array(cap);
    this.ids = new Float64Array(cap);
    this.alive = new Uint8Array(cap);

    this.params = new Float32Array(DECAL_PARAMS_FLOATS);
    this.paramsBuffer = device.createBuffer({
      label: 'decals-params',
      size: this.params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instanceBuffer = device.createBuffer({
      label: 'decals-instances',
      size: this.data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.box = new Mesh(device, { ...unitBox(), layout: VERTEX_LAYOUT_3D, label: 'decal-box' });
    this.quad = new Mesh(device, { ...unitQuad(), layout: VERTEX_LAYOUT_3D, label: 'decal-quad' });

    this.sampler = device.createSampler({
      label: 'decals',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.dummyDepth = device.createTexture({
      label: 'decals-depth-none',
      size: [1, 1],
      format: DEPTH_COPY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.layout = device.createBindGroupLayout({
      label: 'decals-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {},
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
    this.noDepthGroup = this.makeGroup(this.dummyDepth.createView());
    this.group = this.noDepthGroup;
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [renderer.globalsLayout, this.layout],
    });
    this.blend = blend === 'multiply' ? MULTIPLY_BLEND : blendState(blend);
    this.boxModule = createShaderModule(device, WGSL_DECAL_BOX, 'decals-box');
    this.quadModule = createShaderModule(device, WGSL_DECAL_QUAD, 'decals-quad');

    this.copyLayout = device.createBindGroupLayout({
      label: 'decals-depth-copy-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
    const copyModule = createShaderModule(device, WGSL_DECAL_DEPTH_COPY, 'decals-depth-copy');
    this.copyPipeline = device.createRenderPipeline({
      label: 'decals-depth-copy',
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
      label: 'decals-depth-copy',
      colorAttachments: [],
      depthStencilAttachment: this.copyAtt,
    };
  }

  /** Live decals. */
  get count(): number {
    return this.live;
  }

  /** Whether `handle` is still live. */
  has(handle: number): boolean {
    return this.slotOf.has(handle);
  }

  /**
   * Place a decal at (`x`, `y`, `z`) facing along (`nx`, `ny`, `nz`), `size` wide. Returns its
   * handle. When the system is full the oldest live decal is overwritten.
   */
  add(d: DecalDesc): number {
    if (this.dirty) this.compact();
    if (this.used === this.capacity) this.dropOldest();
    const slot = this.used++;
    const id = this.nextId++;
    this.ids[slot] = id;
    this.alive[slot] = 1;
    this.ages[slot] = 0;
    const life = d.lifetime ?? this.lifetime;
    this.lives[slot] = life;
    this.slotOf.set(id, slot);
    this.live++;
    this.writeInstance(slot, d, life);
    return id;
  }

  /** Remove a decal; false when the handle is not live. Compacted on the next `update`. */
  remove(handle: number): boolean {
    const slot = this.slotOf.get(handle);
    if (slot === undefined) return false;
    this.alive[slot] = 0;
    this.slotOf.delete(handle);
    this.live--;
    this.dirty = true;
    return true;
  }

  /** Remove every decal. */
  clear(): void {
    this.slotOf.clear();
    this.live = 0;
    this.used = 0;
    this.dirty = false;
  }

  /** Age every decal by `dt` seconds, expire the ones past their lifetime and compact. */
  update(dt: number): void {
    const n = this.used;
    for (let i = 0; i < n; i++) {
      if (!this.alive[i]) continue;
      const age = this.ages[i]! + dt;
      this.ages[i] = age;
      const life = this.lives[i]!;
      if (age >= life) {
        this.alive[i] = 0;
        this.slotOf.delete(this.ids[i]!);
        this.live--;
        this.dirty = true;
      } else {
        this.data[i * F + 20] = Number.isFinite(life) ? age / life : 0;
      }
    }
    if (this.dirty) this.compact();
  }

  /** Age of the decal at `handle`, seconds; -1 when not live. */
  ageOf(handle: number): number {
    const slot = this.slotOf.get(handle);
    return slot === undefined ? -1 : this.ages[slot]!;
  }

  /**
   * Whether the box draw is waiting on the renderer's depth hook this frame: `readsDepth` on and
   * the target's depth copyable. Otherwise `prepare` takes the fallback copy.
   */
  private get hooked(): boolean {
    return this.readsDepth && (this.renderer.target?.canCopyDepth ?? false);
  }

  /**
   * Resolve the mode for this frame, upload the params block and the live instances. Box mode
   * waits for the depth hook (`afterOpaque`), or takes the fallback copy of last frame's depth.
   * Called by the renderer once per frame. No allocation.
   */
  prepare(encoder: GPUCommandEncoder, frame?: Frame): void {
    if (this.dirty) this.compact();
    const depth = frame?.depthFormat ?? null;
    const mode = this.mode === 'auto' ? (depth ? 'box' : 'quad') : this.mode;
    this.activeMode = mode === 'box' && !depth ? 'quad' : mode;
    if (this.activeMode !== 'box') {
      this.depthReady = false;
    } else if (this.hooked) {
      // `afterOpaque` binds this frame's depth; until it runs the box draws nothing.
      this.depthReady = false;
      this.group = this.noDepthGroup;
    } else {
      this.depthReady = this.copyDepth(encoder);
      this.group = this.depthReady ? this.copyGroup! : this.noDepthGroup;
    }

    const p = this.params;
    const camera = this.renderer.camera as Camera | undefined;
    if (camera) p.set(camera.invViewProj, 0);
    else p.set(IDENTITY, 0);
    p[16] = this.normalBias;
    p[17] = this.fadeEdge;
    p[18] = this.offset;
    p[19] = this.multiply ? 1 : 0;
    p[20] = this.fade[0];
    p[21] = this.fade[1];
    p[22] = 0;
    p[23] = 0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, p);
    if (this.live > 0) {
      this.device.queue.writeBuffer(this.instanceBuffer, 0, this.data.buffer, 0, this.live * F * 4);
    }
  }

  /**
   * The renderer's depth hook (`readsDepth`): bind this frame's opaque depth copy. The bind
   * group is rebuilt only when the renderer's copy changes (a resize).
   */
  afterOpaque(_encoder: GPUCommandEncoder, view: ViewInfo): void {
    if (this.activeMode !== 'box' || !this.readsDepth) return;
    if (view.depthView !== this.hookView) {
      this.hookView = view.depthView;
      this.hookGroup = this.makeGroup(view.depthView);
    }
    this.group = this.hookGroup!;
    this.depthReady = true;
  }

  /** Draw every live decal in one instanced draw (nothing in box mode until depth exists). */
  draw(pass: GPURenderPassEncoder, frame?: Frame): void {
    if (this.live === 0) return;
    const mode = this.activeMode ?? 'quad';
    if (mode === 'box' && !this.depthReady) return;
    const depth = frame?.depthFormat ?? null;
    pass.setPipeline(
      this.pipelineFor(mode, depth, frame ? frame.auxKey : (this.renderer.target?.auxKey ?? 0)),
    );
    pass.setBindGroup(1, this.group);
    const mesh = mode === 'box' ? this.box : this.quad;
    pass.setVertexBuffer(0, mesh.vertexBuffer);
    pass.setVertexBuffer(1, this.instanceBuffer);
    pass.setIndexBuffer(mesh.indexBuffer!, mesh.indexFormat);
    pass.drawIndexed(mesh.indexCount, this.live);
  }

  destroy(): void {
    this.paramsBuffer.destroy();
    this.instanceBuffer.destroy();
    this.box.destroy();
    this.quad.destroy();
    this.dummyDepth.destroy();
    this.copyTex?.destroy();
  }

  private writeInstance(slot: number, d: DecalDesc, life: number): void {
    const o = slot * F;
    const data = this.data;
    // Frame: z along the normal, x and y tangent, spun by `rotation`.
    let nx = d.nx;
    let ny = d.ny;
    let nz = d.nz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // Tangent x = helper × normal, the helper world up (so wall decals stand upright) or, for a
    // floor or ceiling, -z (so a floor decal's x is world x and its y points away from +z).
    const flat = Math.abs(ny) > 0.99;
    const hy = flat ? 0 : 1;
    const hz = flat ? -1 : 0;
    let tx = hy * nz - hz * ny;
    let ty = hz * nx;
    let tz = -hy * nx;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;
    const rot = d.rotation === 'random' ? this.random.float(0, Math.PI * 2) : (d.rotation ?? 0);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const ax = tx * c + bx * s;
    const ay = ty * c + by * s;
    const az = tz * c + bz * s;
    const yx = bx * c - tx * s;
    const yy = by * c - ty * s;
    const yz = bz * c - tz * s;
    const inv = 1 / (d.size || 1);
    // Rows of world → local: axis / size, -dot(axis, p) / size.
    data[o] = ax * inv;
    data[o + 1] = ay * inv;
    data[o + 2] = az * inv;
    data[o + 3] = -(ax * d.x + ay * d.y + az * d.z) * inv;
    data[o + 4] = yx * inv;
    data[o + 5] = yy * inv;
    data[o + 6] = yz * inv;
    data[o + 7] = -(yx * d.x + yy * d.y + yz * d.z) * inv;
    data[o + 8] = nx * inv;
    data[o + 9] = ny * inv;
    data[o + 10] = nz * inv;
    data[o + 11] = -(nx * d.x + ny * d.y + nz * d.z) * inv;
    const tile =
      d.tile === 'random'
        ? this.random.int(0, this.columns * this.rows - 1)
        : Math.max(0, Math.floor(d.tile ?? 0));
    const col = tile % this.columns;
    const row = Math.floor(tile / this.columns) % this.rows;
    data[o + 12] = col / this.columns;
    data[o + 13] = row / this.rows;
    data[o + 14] = 1 / this.columns;
    data[o + 15] = 1 / this.rows;
    const color = d.color;
    data[o + 16] = color?.[0] ?? 1;
    data[o + 17] = color?.[1] ?? 1;
    data[o + 18] = color?.[2] ?? 1;
    data[o + 19] = color?.[3] ?? 1;
    data[o + 20] = 0;
    data[o + 21] = life;
    data[o + 22] = 0;
    data[o + 23] = 0;
  }

  /** Move the live slots to the front, in order, and remap their handles. */
  private compact(): void {
    let w = 0;
    const n = this.used;
    for (let r = 0; r < n; r++) {
      if (!this.alive[r]) continue;
      if (w !== r) {
        this.data.copyWithin(w * F, r * F, r * F + F);
        this.ages[w] = this.ages[r]!;
        this.lives[w] = this.lives[r]!;
        this.ids[w] = this.ids[r]!;
        this.alive[w] = 1;
        this.slotOf.set(this.ids[w]!, w);
      }
      w++;
    }
    this.used = w;
    this.live = w;
    this.dirty = false;
  }

  /** Full and compact: drop slot 0 (the oldest) and shift the rest down. */
  private dropOldest(): void {
    const n = this.used;
    this.slotOf.delete(this.ids[0]!);
    this.data.copyWithin(0, F, n * F);
    this.ages.copyWithin(0, 1, n);
    this.lives.copyWithin(0, 1, n);
    this.ids.copyWithin(0, 1, n);
    for (let i = 0; i < n - 1; i++) this.slotOf.set(this.ids[i]!, i);
    this.used = n - 1;
    this.live = n - 1;
  }

  /** Copy the scene depth into our own texture; false when there is none yet. */
  private copyDepth(encoder: GPUCommandEncoder): boolean {
    const src = this.renderer.target?.depth ?? null;
    if (!src) return false;
    const device = this.device;
    if (!this.copyTex || this.copyTex.width !== src.width || this.copyTex.height !== src.height) {
      this.copyTex?.destroy();
      this.copyTex = device.createTexture({
        label: 'decals-depth',
        size: [src.width, src.height],
        format: DEPTH_COPY_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      const view = this.copyTex.createView();
      this.copyAtt.view = view;
      this.copyGroup = this.makeGroup(view);
    }
    if (this.copySrc !== src) {
      this.copySrc = src;
      this.copySrcGroup = device.createBindGroup({
        label: 'decals-depth-copy',
        layout: this.copyLayout,
        entries: [{ binding: 0, resource: src.view }],
      });
    }
    const pass = encoder.beginRenderPass(this.copyPass);
    pass.setPipeline(this.copyPipeline);
    pass.setBindGroup(0, this.copySrcGroup!);
    pass.draw(3);
    pass.end();
    return true;
  }

  private makeGroup(depthView: GPUTextureView): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'decals',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.texture.view },
        { binding: 3, resource: depthView },
      ],
    });
  }

  private pipelineFor(
    mode: 'box' | 'quad',
    depth: GPUTextureFormat | null,
    aux: number,
  ): GPURenderPipeline {
    const box = mode === 'box';
    const cache = box ? this.boxPipelines : this.quadPipelines;
    const hit = cache.get(depth, aux);
    if (hit) return hit;
    const module = box ? this.boxModule : this.quadModule;
    const p = this.device.createRenderPipeline({
      label: `decals:${mode}:${depth ?? 'none'}${auxSuffix(aux)}`,
      layout: this.pipelineLayout,
      vertex: { module, entryPoint: 'vs', buffers: [POSITION_LAYOUT, INSTANCE_LAYOUT] },
      fragment: { module, entryPoint: 'fs', targets: this.renderer.sceneTargets(this.blend, aux) },
      primitive: { topology: 'triangle-list', cullMode: box ? 'front' : 'none' },
      ...(depth
        ? {
            depthStencil: {
              format: depth,
              depthWriteEnabled: false,
              depthCompare: box ? 'always' : 'less-equal',
            },
          }
        : {}),
    });
    return cache.set(depth, aux, p);
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** `dst × lerp(1, src, a)`: the shader outputs the lerp, the blend multiplies. */
const MULTIPLY_BLEND: GPUBlendState = {
  color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

/** The mesh's position only (the 3D layout's location 0); the rest of the vertex is skipped. */
const POSITION_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX3D_STRIDE,
  stepMode: 'vertex',
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
};

const INSTANCE_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: DECAL_INSTANCE_FLOATS * 4,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 3, offset: 0, format: 'float32x4' },
    { shaderLocation: 4, offset: 16, format: 'float32x4' },
    { shaderLocation: 5, offset: 32, format: 'float32x4' },
    { shaderLocation: 6, offset: 48, format: 'float32x4' },
    { shaderLocation: 7, offset: 64, format: 'float32x4' },
    { shaderLocation: 8, offset: 80, format: 'float32x4' },
  ],
};

/** A vertex in the 3D layout: position, normal, uv, white. */
function vertex(out: Float32Array, i: number, x: number, y: number, z: number): void {
  const o = i * VERTEX3D_FLOATS;
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = 0;
  out[o + 4] = 0;
  out[o + 5] = 1;
  out[o + 6] = x + 0.5;
  out[o + 7] = 0.5 - y;
  out[o + 8] = out[o + 9] = out[o + 10] = out[o + 11] = 1;
}

/** Unit box centred on the origin: 8 vertices, 12 triangles wound outward. */
function unitBox(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array(8 * VERTEX3D_FLOATS);
  for (let i = 0; i < 8; i++) {
    vertex(vertices, i, i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5);
  }
  // biome-ignore format: one face per line
  const indices = new Uint16Array([
    4, 5, 7, 4, 7, 6, // +z
    1, 0, 2, 1, 2, 3, // -z
    5, 1, 3, 5, 3, 7, // +x
    0, 4, 6, 0, 6, 2, // -x
    6, 7, 3, 6, 3, 2, // +y
    0, 1, 5, 0, 5, 4, // -y
  ]);
  return { vertices, indices };
}

/** Unit quad in the xy plane facing +z. */
function unitQuad(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array(4 * VERTEX3D_FLOATS);
  vertex(vertices, 0, -0.5, -0.5, 0);
  vertex(vertices, 1, 0.5, -0.5, 0);
  vertex(vertices, 2, 0.5, 0.5, 0);
  vertex(vertices, 3, -0.5, 0.5, 0);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}
