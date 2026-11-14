/**
 * ws/core-decals (B6): `Decals` on the render core. Every live decal draws in the core's
 * `'transparent'` pass, before the water (order -2), for every view from one bundle a cull group:
 * one `drawIndexedIndirect` whose instance count the decals write once a frame, so adding or
 * removing decals never re-records the bundle and the GPU call count stays flat in decal count.
 * Box decals read the core's depth (`readsDepth`) and unproject it per eye with `CoreViewExtras`;
 * quad decals depth-test against it. One bounding sphere over every live decal culls the drawable
 * once per cull group (a stereo pair: once for both eyes). The CPU copy of every decal lives on
 * `Decals`, so a device restore re-uploads them all (`restore`).
 */

import { blendState } from '../render/blend';
import type { RenderCore } from '../render/core/core';
import {
  type CoreDrawable,
  type CoreDrawableEncoder,
  type CoreDrawContext,
  CoreViewExtras,
  DrawablePipelines,
} from '../render/core/drawable';
import { Mesh, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS, VERTEX3D_STRIDE } from '../render/mesh';
import type { TextureLike } from '../render/texture';
import { createShaderModule } from '../render/wgsl';
import { DECAL_CORE_BOX_WGSL, DECAL_CORE_QUAD_WGSL } from './decals-core-wgsl';

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

/** What `DecalsOnCore` draws from: the CPU side of a `Decals` (it implements this). */
export interface DecalsOnCoreSource {
  /** Instance floats, the live decals first (`DECAL_INSTANCE_FLOATS` each). */
  readonly instanceData: Float32Array<ArrayBuffer>;
  /** Live decals (compacted to the front of `instanceData`). */
  readonly count: number;
  /** Bumped whenever `instanceData` changes (a re-upload). */
  readonly instanceRevision: number;
  /** Bumped whenever a decal is added or leaves (the bounds are recomputed). */
  readonly memberRevision: number;
  /** Compact removed decals out before an upload. */
  flush(): void;
  readonly normalBias: number;
  readonly fadeEdge: number;
  readonly offset: number;
  readonly fade: readonly [number, number];
  /** The atlas (re-bound when it changes, e.g. after a device restore). */
  readonly texture: TextureLike;
}

/** Options for `DecalsOnCore`. */
export interface DecalsOnCoreOptions {
  /** `box` reads the core's depth; `quad` lies on the surface. */
  mode: 'box' | 'quad';
  blend: 'alpha' | 'multiply' | 'additive';
  capacity: number;
}

const F = DECAL_INSTANCE_FLOATS;

/** The core drawable behind a `Decals` made on a `RenderCore`. */
export class DecalsOnCore implements CoreDrawable {
  readonly label = 'decals';
  readonly pass = 'transparent';
  /** Before the water (-1) and particles (0): decals lie on the opaque scene. */
  readonly order = -2;
  readonly readsDepth: boolean;
  readonly mode: 'box' | 'quad';
  version = 0;
  active = false;
  /** One sphere around every live decal (`[x, y, z, r]`). */
  readonly bounds = new Float32Array(4);
  /** Draw calls a record makes (1: every decal in one indirect instanced draw). */
  static readonly CALLS = 1;
  private readonly capacity: number;
  private readonly multiply: boolean;
  private readonly blend: GPUBlendState | undefined;
  private readonly params = new Float32Array(DECAL_PARAMS_FLOATS);
  private readonly args = new Uint32Array(5);
  private gpu!: DecalsGpu;
  private pipes!: DrawablePipelines;
  private group: GPUBindGroup | null = null;
  private groupTargets = -1;
  private groupTexture: TextureLike | null = null;
  private uploaded = -1;
  private members = -1;
  private argCount = -1;

  constructor(
    readonly core: RenderCore,
    private readonly src: DecalsOnCoreSource,
    opts: DecalsOnCoreOptions,
  ) {
    this.mode = opts.mode;
    this.readsDepth = opts.mode === 'box';
    this.capacity = opts.capacity;
    this.multiply = opts.blend === 'multiply';
    this.blend = opts.blend === 'multiply' ? MULTIPLY_BLEND : blendState(opts.blend);
    this.build();
  }

  /** Make every GPU resource on the core's current device (first use and after a restore). */
  private build(): void {
    const core = this.core;
    const device = core.device;
    const box = this.mode === 'box';
    this.gpu = {
      device,
      extras: CoreViewExtras.of(core),
      instances: device.createBuffer({
        label: 'decals-core-instances',
        size: this.capacity * F * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
      params: device.createBuffer({
        label: 'decals-core-params',
        size: this.params.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      args: device.createBuffer({
        label: 'decals-core-args',
        size: this.args.byteLength,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      }),
      mesh: new Mesh(device, {
        ...(box ? unitBox() : unitQuad()),
        layout: VERTEX_LAYOUT_3D,
        label: box ? 'decal-core-box' : 'decal-core-quad',
      }),
      sampler: device.createSampler({
        label: 'decals-core',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      dummyDepth: device.createTexture({
        label: 'decals-core-no-depth',
        size: [1, 1],
        format: 'depth32float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      }),
      layout: device.createBindGroupLayout({
        label: 'decals-core-layout',
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: {},
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
          {
            binding: 4,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'read-only-storage' },
          },
        ],
      }),
    };
    const g = this.gpu;
    const module = createShaderModule(
      device,
      box ? DECAL_CORE_BOX_WGSL : DECAL_CORE_QUAD_WGSL,
      box ? 'decals-core-box' : 'decals-core-quad',
    );
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [core.viewLayout, g.layout],
    });
    this.pipes = new DrawablePipelines((color, depth) =>
      device.createRenderPipeline({
        label: `decals-core:${this.mode}`,
        layout,
        vertex: { module, entryPoint: 'vs', buffers: [POSITION_LAYOUT, INSTANCE_LAYOUT] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: color, blend: this.blend }] },
        // Box: back faces only, so an eye inside the box still covers what it projects onto.
        primitive: { topology: 'triangle-list', cullMode: box ? 'front' : 'none' },
        depthStencil: depth
          ? {
              format: depth,
              depthWriteEnabled: false,
              depthCompare: box ? 'always' : 'less-equal',
            }
          : undefined,
      }),
    );
    this.group = null;
    this.groupTargets = -1;
    this.uploaded = -1;
    this.members = -1;
    this.argCount = -1;
  }

  /**
   * After the core's device was restored: re-make every GPU resource on the new device and
   * re-upload every live decal (their CPU copy is kept). The bundles re-record (`version`).
   */
  restore(): void {
    this.build();
    this.version++;
  }

  prepare(): void {
    const src = this.src;
    const g = this.gpu;
    src.flush();
    // A new atlas: re-record with a new bind group.
    if (this.group && src.texture !== this.groupTexture) this.version++;
    if (this.readsDepth) g.extras.update();
    const n = src.count;
    this.active = n > 0;
    if (src.memberRevision !== this.members) {
      this.members = src.memberRevision;
      this.computeBounds();
    }
    if (n > 0 && src.instanceRevision !== this.uploaded) {
      this.uploaded = src.instanceRevision;
      g.device.queue.writeBuffer(g.instances, 0, src.instanceData.buffer, 0, n * F * 4);
    }
    if (n !== this.argCount) {
      this.argCount = n;
      const a = this.args;
      a[0] = g.mesh.indexCount;
      a[1] = n;
      g.device.queue.writeBuffer(g.args, 0, a);
    }
    const p = this.params;
    p[16] = src.normalBias;
    p[17] = src.fadeEdge;
    p[18] = src.offset;
    p[19] = this.multiply ? 1 : 0;
    p[20] = src.fade[0];
    p[21] = src.fade[1];
    g.device.queue.writeBuffer(g.params, 0, p);
  }

  record(enc: CoreDrawableEncoder, ctx: CoreDrawContext): number {
    const g = this.gpu;
    enc.setPipeline(this.pipes.get(ctx));
    enc.setBindGroup(0, ctx.viewGroup);
    enc.setBindGroup(1, this.bindGroup());
    enc.setVertexBuffer(0, g.mesh.vertexBuffer);
    enc.setVertexBuffer(1, g.instances);
    enc.setIndexBuffer(g.mesh.indexBuffer!, g.mesh.indexFormat);
    enc.drawIndexedIndirect(g.args, 0);
    return DecalsOnCore.CALLS;
  }

  /** The bind group, re-made when the core's depth or the atlas is re-made. */
  private bindGroup(): GPUBindGroup {
    const core = this.core;
    const tex = this.src.texture;
    if (this.group && this.groupTargets === core.targetsVersion && this.groupTexture === tex) {
      return this.group;
    }
    const g = this.gpu;
    this.groupTargets = core.targetsVersion;
    this.groupTexture = tex;
    const depth = this.readsDepth ? core.sceneDepthView : null;
    this.group = g.device.createBindGroup({
      label: 'decals-core',
      layout: g.layout,
      entries: [
        { binding: 0, resource: { buffer: g.params } },
        { binding: 1, resource: g.sampler },
        { binding: 2, resource: tex.view },
        { binding: 3, resource: depth ?? g.dummyDepth.createView() },
        { binding: 4, resource: { buffer: g.extras.buffer } },
      ],
    });
    return this.group;
  }

  /**
   * One sphere around every live decal's box (centre ± half its diagonal): the box of the
   * spheres, then the farthest reach from its centre. Only when membership changes.
   */
  private computeBounds(): void {
    const src = this.src;
    const d = src.instanceData;
    const n = src.count;
    const b = this.bounds;
    if (n === 0) {
      b.fill(0);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      decalSphere(d, i * F, sphere);
      const r = sphere[3]!;
      minX = Math.min(minX, sphere[0]! - r);
      minY = Math.min(minY, sphere[1]! - r);
      minZ = Math.min(minZ, sphere[2]! - r);
      maxX = Math.max(maxX, sphere[0]! + r);
      maxY = Math.max(maxY, sphere[1]! + r);
      maxZ = Math.max(maxZ, sphere[2]! + r);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    let reach = 0;
    for (let i = 0; i < n; i++) {
      decalSphere(d, i * F, sphere);
      const dist = Math.hypot(sphere[0]! - cx, sphere[1]! - cy, sphere[2]! - cz) + sphere[3]!;
      if (dist > reach) reach = dist;
    }
    b[0] = cx;
    b[1] = cy;
    b[2] = cz;
    b[3] = reach;
  }

  destroy(): void {
    const g = this.gpu;
    g.instances.destroy();
    g.params.destroy();
    g.args.destroy();
    g.mesh.destroy();
    g.dummyDepth.destroy();
    this.group = null;
  }
}

/** The GPU side of `DecalsOnCore`, re-made as a whole on a device restore. */
interface DecalsGpu {
  device: GPUDevice;
  extras: CoreViewExtras;
  instances: GPUBuffer;
  params: GPUBuffer;
  args: GPUBuffer;
  mesh: Mesh;
  sampler: GPUSampler;
  dummyDepth: GPUTexture;
  layout: GPUBindGroupLayout;
}

const sphere = new Float64Array(4);

/**
 * The world sphere of the decal at float `o` (its box's centre and half diagonal), from its
 * world → local rows (`axis_i / s_i`, `-dot(axis_i, p) / s_i`, one size `s` on every axis).
 */
export function decalSphere(d: ArrayLike<number>, o: number, out: Float64Array): void {
  let x = 0;
  let y = 0;
  let z = 0;
  let r = 0;
  for (let k = 0; k < 3; k++) {
    const a = d[o + k * 4]!;
    const b = d[o + k * 4 + 1]!;
    const c = d[o + k * 4 + 2]!;
    const w = d[o + k * 4 + 3]!;
    const l2 = a * a + b * b + c * c || 1;
    // local → world: origin = -sum(axis_i * s_i * w_i) where axis_i * s_i = row_i.xyz / |row_i|².
    x -= (a / l2) * w;
    y -= (b / l2) * w;
    z -= (c / l2) * w;
    r += 1 / l2; // s_i²
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = 0.5 * Math.sqrt(r);
}

/** `dst × lerp(1, src, a)`: the shader outputs the lerp, the blend multiplies. */
export const MULTIPLY_BLEND: GPUBlendState = {
  color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

/** The mesh's position only (the 3D layout's location 0); the rest of the vertex is skipped. */
export const POSITION_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX3D_STRIDE,
  stepMode: 'vertex',
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
};

export const INSTANCE_LAYOUT: GPUVertexBufferLayout = {
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
export function unitBox(): { vertices: Float32Array; indices: Uint16Array } {
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
export function unitQuad(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array(4 * VERTEX3D_FLOATS);
  vertex(vertices, 0, -0.5, -0.5, 0);
  vertex(vertices, 1, 0.5, -0.5, 0);
  vertex(vertices, 2, 0.5, 0.5, 0);
  vertex(vertices, 3, -0.5, 0.5, 0);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}
