/**
 * Test-only fake WebGPU device. It records resource creation, queue writes and pass commands,
 * and applies the validation rules the engine has tripped over before (e.g. `writeBuffer`
 * into a buffer without `COPY_DST`). Not exported from `@thunderclap/engine/render`; tests import it from `@thunderclap/engine/testing`.
 */

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

/** Install the WebGPU flag globals (`GPUBufferUsage` …) when running outside a browser. */
export function installGpuGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= BUFFER_USAGE;
  g.GPUTextureUsage ??= TEXTURE_USAGE;
  g.GPUShaderStage ??= SHADER_STAGE;
}

export interface FakeBuffer {
  label?: string;
  size: number;
  usage: number;
  destroyed: boolean;
  destroy(): void;
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
  | { op: 'other'; name: string; args?: number[]; slot?: number; buffer?: unknown };

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
  /** Validation errors that a real device would raise. */
  readonly errors: string[];
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
  const textureWrites: FakeDevice['textureWrites'] = [];
  const passes: FakePass[] = [];
  const textureCopies: FakeDevice['textureCopies'] = [];
  const errors: string[] = [];

  const makePass = (kind: FakePass['kind'], desc: { label?: string } | undefined) => {
    const p: FakePass = { kind, label: desc?.label, desc, commands: [] };
    passes.push(p);
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
      setVertexBuffer: (slot: number, buffer: unknown) =>
        cmd({ op: 'other', name: 'setVertexBuffer', slot, buffer }),
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
    addEventListener() {},
    createBuffer(desc: GPUBufferDescriptor) {
      const b: FakeBuffer = {
        label: desc.label,
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
        destroy() {
          b.destroyed = true;
        },
      };
      buffers.push(b);
      return b;
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
    createCommandEncoder: (desc?: GPUCommandEncoderDescriptor) => ({
      label: desc?.label,
      beginRenderPass: (d: GPURenderPassDescriptor) => makePass('render', d),
      beginComputePass: (d?: GPUComputePassDescriptor) => makePass('compute', d),
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
      copyBufferToBuffer() {},
      clearBuffer(buffer: FakeBuffer) {
        if (!(buffer.usage & BUFFER_USAGE.COPY_DST)) {
          errors.push(`clearBuffer: ${buffer.label} lacks COPY_DST`);
        }
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(
        buffer: FakeBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView,
        _dataOffset?: number,
        dataSize?: number,
      ) {
        if (!(buffer.usage & BUFFER_USAGE.COPY_DST)) {
          errors.push(`writeBuffer: ${buffer.label} lacks COPY_DST`);
        }
        if (buffer.destroyed) errors.push(`writeBuffer: ${buffer.label} is destroyed`);
        const size = dataSize ?? data.byteLength;
        if (offset + size > buffer.size) {
          errors.push(`writeBuffer: ${buffer.label} overflow (${offset}+${size}>${buffer.size})`);
        }
        writes.push({ buffer, offset, bytes: size });
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
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };

  return {
    device: device as unknown as GPUDevice,
    buffers,
    textures,
    bindGroups,
    writes,
    textureWrites,
    passes,
    textureCopies,
    errors,
  };
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
