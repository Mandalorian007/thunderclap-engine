/**
 * Test-only fake WebGPU device. It records resource creation, queue writes and pass commands,
 * and applies the validation rules the engine has tripped over before (e.g. `writeBuffer`
 * into a buffer without `COPY_DST`). Buffers hold their bytes: `writeBuffer` stores them,
 * `copyBufferToBuffer`, `clearBuffer` and `resolveQuerySet` apply at `queue.submit`, and a
 * `MAP_READ` buffer maps them back (ws/render-9). Not exported from `@thunderclap-engine/engine/render`;
 * tests import it from `@thunderclap-engine/engine/testing`.
 */

import { sceneColorTargets } from './material';

const BUFFER_USAGE = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
};
const TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};
const SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
const MAP_MODE = { READ: 0x1, WRITE: 0x2 };

/** Install the WebGPU flag globals (`GPUBufferUsage` …) when running outside a browser. */
export function installGpuGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= BUFFER_USAGE;
  g.GPUTextureUsage ??= TEXTURE_USAGE;
  g.GPUShaderStage ??= SHADER_STAGE;
  g.GPUMapMode ??= MAP_MODE;
}

/**
 * What the fake throws for a usage-flag mistake a real device rejects (a missing `COPY_SRC`,
 * `COPY_DST`, `MAP_READ`, `MAP_WRITE` or `QUERY_RESOLVE`), named like WebGPU's
 * `GPUValidationError` (ws/render-9). The message is also pushed to `FakeDevice.errors`.
 */
export class FakeGpuValidationError extends Error {
  override readonly name = 'GPUValidationError';
}

export interface FakeBuffer {
  label?: string;
  size: number;
  usage: number;
  destroyed: boolean;
  /** As `GPUBuffer.mapState`. */
  readonly mapState: GPUBufferMapState;
  /**
   * The buffer's bytes (`size` long, zeroed, made on first use). `writeBuffer` fills them and a
   * submitted copy moves them; a test writes here to stand in for what a shader would write.
   */
  readonly data: Uint8Array;
  /**
   * As `GPUBuffer.mapAsync`: throws `FakeGpuValidationError` without `MAP_READ` (mode `READ`)
   * or `MAP_WRITE` (mode `WRITE`); rejects when the buffer is not unmapped. Resolves a
   * microtask later, by when every copy submitted before it has landed.
   */
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  /** A copy of the mapped bytes; `unmap` detaches it (a `WRITE` map's range is written back). */
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

/** A fake `GPUQuerySet`: `values` is what `resolveQuerySet` writes (a test fills it). */
export interface FakeQuerySet {
  label?: string;
  type: GPUQueryType;
  count: number;
  readonly values: BigUint64Array;
  destroyed: boolean;
  destroy(): void;
}

/** One `copyBufferToBuffer`, as encoded. */
export interface FakeBufferCopy {
  src: FakeBuffer;
  srcOffset: number;
  dst: FakeBuffer;
  dstOffset: number;
  size: number;
}

export interface FakeTexture {
  label?: string;
  width: number;
  height: number;
  format: GPUTextureFormat;
  mipLevelCount: number;
  usage: number;
  destroyed: boolean;
  createView(desc?: { label?: string }): FakeView;
  destroy(): void;
}

export interface FakeView {
  texture: FakeTexture;
  label?: string;
}

export interface FakeBindGroup {
  label?: string;
  layout: { label?: string; entries: GPUBindGroupLayoutEntry[] };
  entries: GPUBindGroupEntry[];
}

export type PassCommand =
  | { op: 'setPipeline'; pipeline: unknown }
  | { op: 'setBindGroup'; index: number; group: unknown; offsets: number[] }
  | { op: 'draw'; vertices: number; instances: number; firstInstance: number }
  | {
      op: 'drawIndexed';
      indices: number;
      instances: number;
      firstInstance: number;
      /** Recorded when non-zero (an `InstanceParams.range` draw). */
      firstIndex?: number;
    }
  | { op: 'dispatch'; x: number; y: number }
  | {
      op: 'other';
      name: string;
      args?: number[];
      slot?: number;
      buffer?: unknown;
      /** `setVertexBuffer`'s byte offset, recorded when passed. */
      offset?: number;
    };

export interface FakePass {
  kind: 'render' | 'compute';
  label?: string;
  desc: unknown;
  commands: PassCommand[];
}

export interface FakeDevice {
  /** Cast to `GPUDevice` for engine constructors. */
  readonly device: GPUDevice;
  readonly buffers: FakeBuffer[];
  readonly textures: FakeTexture[];
  readonly bindGroups: FakeBindGroup[];
  readonly writes: { buffer: FakeBuffer; offset: number; bytes: number }[];
  /**
   * The source of each `writes` entry, index for index: the caller's data (live, not a copy)
   * and its `dataOffset` (bytes for an `ArrayBuffer`, elements for a typed array).
   */
  readonly writeData: { data: ArrayBuffer | ArrayBufferView; dataOffset: number }[];
  readonly textureWrites: {
    texture: FakeTexture;
    bytesPerRow: number;
    /** `rowsPerImage` of the layout (0 when not given). */
    rowsPerImage: number;
    /** The destination mip level (0 when not given). */
    mipLevel: number;
    size: number[];
    data: ArrayBufferView | ArrayBuffer;
  }[];
  readonly passes: FakePass[];
  /**
   * `copyTextureToTexture` calls (ws/render-hooks): source, destination and how many passes
   * had been begun when the copy was encoded, so a test can place it between two passes.
   */
  readonly textureCopies: { src: FakeTexture; dst: FakeTexture; afterPasses: number }[];
  /** `copyBufferToBuffer` calls in encoding order (ws/render-9); the bytes move at submit. */
  readonly bufferCopies: FakeBufferCopy[];
  readonly querySets: FakeQuerySet[];
  /** `queue.submit` calls so far. */
  readonly submits: number;
  /**
   * Stands in for the shaders (ws/render-9): called with each render or compute pass when its
   * command buffer is submitted, in order with the encoder's copies and clears, so a test can
   * write what a dispatch would into a buffer's `data`. Null (default): passes change nothing.
   */
  runPass: ((pass: FakePass) => void) | null;
  /** Validation errors that a real device would raise. */
  readonly errors: string[];
  /**
   * `device.lost` (ws/testing-2): pending until `loseDevice` or `device.destroy()` resolves it
   * once with a `GPUDeviceLostInfo`, as a real device's does. The same promise as `device.lost`.
   */
  readonly lost: Promise<GPUDeviceLostInfo>;
  /**
   * Simulate a device loss (ws/testing-2): resolve `lost` with `{ reason, message }`. Default
   * reason `'unknown'` (a driver crash or reset); `'destroyed'` is what `device.destroy()` sends,
   * which the engine treats as no loss. Only the first loss counts; later calls do nothing.
   */
  loseDevice(reason?: GPUDeviceLostReason, message?: string): void;
}

/** A recorded command that changes buffer bytes when its command buffer is submitted. */
type BufferOp =
  | { op: 'pass'; pass: FakePass }
  | { op: 'copy'; copy: FakeBufferCopy }
  | { op: 'clear'; buffer: FakeBuffer; offset: number; size: number }
  | {
      op: 'resolve';
      set: FakeQuerySet;
      first: number;
      count: number;
      dst: FakeBuffer;
      offset: number;
    };

/** Byte view of `writeBuffer`'s source: `dataOffset`/`dataSize` are elements for a typed array. */
function sourceBytes(
  data: ArrayBuffer | ArrayBufferView,
  dataOffset: number,
  dataSize: number | undefined,
): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    const bpe = (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    const n = dataSize ?? data.byteLength / bpe - dataOffset;
    return new Uint8Array(data.buffer, data.byteOffset + dataOffset * bpe, n * bpe);
  }
  return new Uint8Array(data, dataOffset, dataSize ?? data.byteLength - dataOffset);
}

/**
 * Create a fake device. `limits` overrides defaults (e.g. `minUniformBufferOffsetAlignment`);
 * `features` is its feature set (`device.features`, empty by default).
 */
export function createFakeDevice(
  limits: Partial<Record<string, number>> = {},
  features: Iterable<string> = [],
): FakeDevice {
  installGpuGlobals();
  const buffers: FakeBuffer[] = [];
  const textures: FakeTexture[] = [];
  const bindGroups: FakeBindGroup[] = [];
  const writes: FakeDevice['writes'] = [];
  const writeData: FakeDevice['writeData'] = [];
  const textureWrites: FakeDevice['textureWrites'] = [];
  const passes: FakePass[] = [];
  const textureCopies: FakeDevice['textureCopies'] = [];
  const bufferCopies: FakeBufferCopy[] = [];
  const querySets: FakeQuerySet[] = [];
  const errors: string[] = [];
  let submits = 0;
  let resolveLost: ((info: GPUDeviceLostInfo) => void) | null = null;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    resolveLost = resolve;
  });
  const loseDevice = (reason: GPUDeviceLostReason = 'unknown', message = 'fake device lost') => {
    const resolve = resolveLost;
    resolveLost = null;
    resolve?.({ reason, message } as GPUDeviceLostInfo);
  };

  /** Record and throw a usage-flag error, as a real device rejects it. */
  const needs = (b: FakeBuffer, flag: keyof typeof BUFFER_USAGE, where: string): void => {
    if (b.usage & BUFFER_USAGE[flag]) return;
    const msg = `${where}: ${b.label} lacks ${flag}`;
    errors.push(msg);
    throw new FakeGpuValidationError(msg);
  };

  const makeBuffer = (desc: GPUBufferDescriptor): FakeBuffer => {
    let bytes: Uint8Array | null = null;
    let state: GPUBufferMapState = 'unmapped';
    let mapMode = 0;
    /** Bumped by every unmap, so a map pending across one rejects. */
    let epoch = 0;
    const ranges: { ab: ArrayBuffer; offset: number }[] = [];
    const store = (): Uint8Array => {
      bytes ??= new Uint8Array(desc.size);
      return bytes;
    };
    const unmap = (): void => {
      if (mapMode === MAP_MODE.WRITE) {
        for (const r of ranges) store().set(new Uint8Array(r.ab), r.offset);
      }
      // Detach every range handed out, as a real unmap does.
      for (const r of ranges) structuredClone(r.ab, { transfer: [r.ab] });
      ranges.length = 0;
      state = 'unmapped';
      mapMode = 0;
      epoch++;
    };
    if (desc.mappedAtCreation) {
      state = 'mapped';
      mapMode = MAP_MODE.WRITE;
    }
    const b: FakeBuffer = {
      label: desc.label,
      size: desc.size,
      usage: desc.usage,
      destroyed: false,
      get mapState() {
        return state;
      },
      get data() {
        return store();
      },
      mapAsync(mode: number, offset = 0, size?: number): Promise<void> {
        if (mode & MAP_MODE.READ) needs(b, 'MAP_READ', 'mapAsync');
        if (mode & MAP_MODE.WRITE) needs(b, 'MAP_WRITE', 'mapAsync');
        const end = offset + (size ?? b.size - offset);
        if (b.destroyed || state !== 'unmapped' || end > b.size) {
          const why = b.destroyed ? 'destroyed' : state !== 'unmapped' ? state : 'out of range';
          const msg = `mapAsync: ${b.label} is ${why}`;
          errors.push(msg);
          return Promise.reject(new Error(msg));
        }
        state = 'pending';
        const at = epoch;
        return Promise.resolve().then(() => {
          if (epoch !== at || b.destroyed) {
            throw new Error(`mapAsync: ${b.label} unmapped before it mapped`);
          }
          state = 'mapped';
          mapMode = mode;
        });
      },
      getMappedRange(offset = 0, size?: number): ArrayBuffer {
        const n = size ?? b.size - offset;
        if (state !== 'mapped') throw new Error(`getMappedRange: ${b.label} is ${state}`);
        if (offset % 8 !== 0 || n % 4 !== 0 || offset + n > b.size) {
          throw new Error(`getMappedRange: ${b.label} range ${offset}+${n} of ${b.size}`);
        }
        const ab = store().slice(offset, offset + n).buffer;
        ranges.push({ ab, offset });
        return ab;
      },
      unmap,
      destroy() {
        if (state !== 'unmapped') unmap();
        b.destroyed = true;
      },
    };
    return b;
  };

  const runOps = (ops: BufferOp[]): void => {
    for (const o of ops) {
      if (o.op === 'copy') {
        const c = o.copy;
        for (const x of [c.src, c.dst]) {
          if (x.mapState !== 'unmapped') errors.push(`submit: ${x.label} is ${x.mapState}`);
          if (x.destroyed) errors.push(`submit: ${x.label} is destroyed`);
        }
        c.dst.data.set(c.src.data.subarray(c.srcOffset, c.srcOffset + c.size), c.dstOffset);
      } else if (o.op === 'pass') {
        fake.runPass?.(o.pass);
      } else if (o.op === 'clear') {
        o.buffer.data.fill(0, o.offset, o.offset + o.size);
      } else {
        o.dst.data.set(new Uint8Array(o.set.values.buffer, o.first * 8, o.count * 8), o.offset);
      }
    }
  };

  const makePass = (
    ops: BufferOp[],
    kind: FakePass['kind'],
    desc: { label?: string } | undefined,
  ) => {
    const p: FakePass = { kind, label: desc?.label, desc, commands: [] };
    passes.push(p);
    ops.push({ op: 'pass', pass: p });
    const cmd = (c: PassCommand) => p.commands.push(c);
    return {
      setPipeline: (pipeline: unknown) => cmd({ op: 'setPipeline', pipeline }),
      setBindGroup: (index: number, group: unknown, offsets?: Iterable<number>) =>
        cmd({ op: 'setBindGroup', index, group, offsets: offsets ? [...offsets] : [] }),
      draw: (vertices: number, instances = 1, _fv = 0, firstInstance = 0) =>
        cmd({ op: 'draw', vertices, instances, firstInstance }),
      drawIndexed: (indices: number, instances = 1, firstIndex = 0, _bv = 0, firstInstance = 0) =>
        cmd(
          firstIndex === 0
            ? { op: 'drawIndexed', indices, instances, firstInstance }
            : { op: 'drawIndexed', indices, instances, firstInstance, firstIndex },
        ),
      dispatchWorkgroups: (x: number, y = 1) => cmd({ op: 'dispatch', x, y }),
      setVertexBuffer: (slot: number, buffer: unknown, offset?: number) =>
        cmd(
          offset === undefined
            ? { op: 'other', name: 'setVertexBuffer', slot, buffer }
            : { op: 'other', name: 'setVertexBuffer', slot, buffer, offset },
        ),
      setIndexBuffer: () => cmd({ op: 'other', name: 'setIndexBuffer' }),
      setBlendConstant: () => cmd({ op: 'other', name: 'setBlendConstant' }),
      setViewport: (...args: number[]) => cmd({ op: 'other', name: 'setViewport', args }),
      setScissorRect: (...args: number[]) => cmd({ op: 'other', name: 'setScissorRect', args }),
      end: () => cmd({ op: 'other', name: 'end' }),
    };
  };

  const device = {
    limits: { minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536, ...limits },
    features: new Set<string>(features),
    lost,
    destroy: () => loseDevice('destroyed', 'device destroyed'),
    addEventListener() {},
    createBuffer(desc: GPUBufferDescriptor) {
      const b = makeBuffer(desc);
      buffers.push(b);
      return b;
    },
    createQuerySet(desc: GPUQuerySetDescriptor) {
      const q: FakeQuerySet = {
        label: desc.label,
        type: desc.type,
        count: desc.count,
        values: new BigUint64Array(desc.count),
        destroyed: false,
        destroy() {
          q.destroyed = true;
        },
      };
      querySets.push(q);
      return q;
    },
    createTexture(desc: GPUTextureDescriptor) {
      const size = desc.size as number[];
      const t: FakeTexture = {
        label: desc.label,
        width: size[0]!,
        height: size[1] ?? 1,
        format: desc.format,
        mipLevelCount: desc.mipLevelCount ?? 1,
        usage: desc.usage,
        destroyed: false,
        createView: (d) => ({ texture: t, label: d?.label }),
        destroy() {
          t.destroyed = true;
        },
      };
      textures.push(t);
      return t;
    },
    createSampler: (desc?: GPUSamplerDescriptor) => ({ label: desc?.label }),
    createBindGroupLayout: (desc: GPUBindGroupLayoutDescriptor) => ({
      label: desc.label,
      entries: [...desc.entries],
    }),
    createPipelineLayout: (desc: GPUPipelineLayoutDescriptor) => ({ ...desc }),
    createBindGroup(desc: GPUBindGroupDescriptor) {
      const g = {
        label: desc.label,
        layout: desc.layout as unknown as FakeBindGroup['layout'],
        entries: [...desc.entries],
      };
      bindGroups.push(g);
      return g;
    },
    createShaderModule: (desc: GPUShaderModuleDescriptor) => ({
      label: desc.label,
      code: desc.code,
      getCompilationInfo: async () => ({ messages: [] }),
    }),
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => ({ label: desc.label, desc }),
    createComputePipeline: (desc: GPUComputePipelineDescriptor) => ({ label: desc.label, desc }),
    createCommandEncoder: (desc?: GPUCommandEncoderDescriptor) => {
      const ops: BufferOp[] = [];
      return {
        label: desc?.label,
        beginRenderPass: (d: GPURenderPassDescriptor) => makePass(ops, 'render', d),
        beginComputePass: (d?: GPUComputePassDescriptor) => makePass(ops, 'compute', d),
        copyTextureToTexture(src: { texture: FakeTexture }, dst: { texture: FakeTexture }) {
          if (!(src.texture.usage & TEXTURE_USAGE.COPY_SRC)) {
            errors.push(`copyTextureToTexture: ${src.texture.label} lacks COPY_SRC`);
          }
          if (!(dst.texture.usage & TEXTURE_USAGE.COPY_DST)) {
            errors.push(`copyTextureToTexture: ${dst.texture.label} lacks COPY_DST`);
          }
          if (src.texture.format !== dst.texture.format) {
            errors.push(
              `copyTextureToTexture: ${src.texture.label} → ${dst.texture.label} formats differ`,
            );
          }
          textureCopies.push({ src: src.texture, dst: dst.texture, afterPasses: passes.length });
        },
        copyBufferToBuffer(
          src: FakeBuffer,
          a: number | FakeBuffer,
          b?: number | FakeBuffer,
          c?: number,
          d?: number,
        ) {
          // (src, srcOffset, dst, dstOffset, size?) or the short (src, dst, size?).
          const short = typeof a === 'object';
          const srcOffset = short ? 0 : (a as number);
          const dst = (short ? a : b) as FakeBuffer;
          const dstOffset = short ? 0 : (c ?? 0);
          const size = (short ? (b as number | undefined) : d) ?? src.size - srcOffset;
          needs(src, 'COPY_SRC', 'copyBufferToBuffer');
          needs(dst, 'COPY_DST', 'copyBufferToBuffer');
          if (src === dst) errors.push(`copyBufferToBuffer: ${src.label} onto itself`);
          if (srcOffset % 4 || dstOffset % 4 || size % 4) {
            errors.push(`copyBufferToBuffer: ${src.label} → ${dst.label} not 4-byte aligned`);
          }
          if (srcOffset + size > src.size || dstOffset + size > dst.size) {
            errors.push(`copyBufferToBuffer: ${src.label} → ${dst.label} out of range`);
            return;
          }
          const copy = { src, srcOffset, dst, dstOffset, size };
          bufferCopies.push(copy);
          ops.push({ op: 'copy', copy });
        },
        clearBuffer(buffer: FakeBuffer, offset = 0, size?: number) {
          if (!(buffer.usage & BUFFER_USAGE.COPY_DST)) {
            errors.push(`clearBuffer: ${buffer.label} lacks COPY_DST`);
          }
          ops.push({ op: 'clear', buffer, offset, size: size ?? buffer.size - offset });
        },
        resolveQuerySet(
          set: FakeQuerySet,
          first: number,
          count: number,
          dst: FakeBuffer,
          offset: number,
        ) {
          needs(dst, 'QUERY_RESOLVE', 'resolveQuerySet');
          if (offset % 256) errors.push(`resolveQuerySet: offset ${offset} not 256-aligned`);
          if (first + count > set.count || offset + count * 8 > dst.size) {
            errors.push(`resolveQuerySet: ${set.label} → ${dst.label} out of range`);
            return;
          }
          ops.push({ op: 'resolve', set, first, count, dst, offset });
        },
        finish: () => ({ ops }),
      };
    },
    queue: {
      writeBuffer(
        buffer: FakeBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset?: number,
        dataSize?: number,
      ) {
        needs(buffer, 'COPY_DST', 'writeBuffer');
        if (buffer.destroyed) errors.push(`writeBuffer: ${buffer.label} is destroyed`);
        if (buffer.mapState !== 'unmapped') {
          errors.push(`writeBuffer: ${buffer.label} is ${buffer.mapState}`);
        }
        const src = sourceBytes(data, dataOffset ?? 0, dataSize);
        const size = src.byteLength;
        if (offset + size > buffer.size) {
          errors.push(`writeBuffer: ${buffer.label} overflow (${offset}+${size}>${buffer.size})`);
        } else {
          buffer.data.set(src, offset);
        }
        writes.push({ buffer, offset, bytes: size });
        writeData.push({ data, dataOffset: dataOffset ?? 0 });
      },
      writeTexture(
        dst: { texture: FakeTexture; mipLevel?: number },
        data: ArrayBufferView | ArrayBuffer,
        layout: GPUTexelCopyBufferLayout,
        size: number[],
      ) {
        if (!(dst.texture.usage & TEXTURE_USAGE.COPY_DST)) {
          errors.push(`writeTexture: ${dst.texture.label} lacks COPY_DST`);
        }
        textureWrites.push({
          texture: dst.texture,
          bytesPerRow: layout.bytesPerRow ?? 0,
          rowsPerImage: layout.rowsPerImage ?? 0,
          mipLevel: dst.mipLevel ?? 0,
          size,
          data,
        });
      },
      copyExternalImageToTexture() {},
      submit(cmds: Iterable<{ ops?: BufferOp[] }>) {
        submits++;
        for (const cb of cmds) if (cb?.ops) runOps(cb.ops);
      },
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };

  const fake: FakeDevice = {
    device: device as unknown as GPUDevice,
    buffers,
    textures,
    bindGroups,
    writes,
    writeData,
    textureWrites,
    passes,
    textureCopies,
    bufferCopies,
    querySets,
    get submits() {
      return submits;
    },
    runPass: null,
    errors,
    lost,
    loseDevice,
  };
  return fake;
}

/** `{ device, context, format }` for `new Renderer(...)` on a fake device. */
export function fakeRendererGpu(fake: FakeDevice): {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
} {
  return { device: fake.device, context: fakeCanvasContext(fake), format: 'bgra8unorm' };
}

/** A fake canvas context good enough for `new Renderer(...)`. */
export function fakeCanvasContext(fake: FakeDevice): GPUCanvasContext {
  const tex = fake.device.createTexture({
    label: 'swapchain',
    size: [1, 1],
    format: 'bgra8unorm',
    usage: TEXTURE_USAGE.RENDER_ATTACHMENT,
  });
  return { getCurrentTexture: () => tex } as unknown as GPUCanvasContext;
}

/**
 * `renderer.sceneTargets` for a stub renderer in a drawable's unit test (ws/render-10): the
 * same lists a real renderer hands out, without one.
 */
export function fakeSceneTargets(blend?: GPUBlendState, aux = 0): GPUColorTargetState[] {
  return sceneColorTargets(['rgba16float', 'rgba16float'], aux, blend, false);
}
