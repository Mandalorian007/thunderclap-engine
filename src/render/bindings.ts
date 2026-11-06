import type { SamplerKind, TextureLike } from './texture';

/**
 * Shared "uniform + sampler + N textures" binding convention used by materials (group 1) and
 * fullscreen passes (group 0):
 *
 * - `@binding(0)` `var<uniform>`: present when `uniformBytes > 0`
 * - `@binding(1)` `sampler`: present when `textures > 0`
 * - `@binding(2 + i)` `texture_2d<f32>`: one per texture slot
 * - `@binding(16 + i)` (`BUFFER_BINDING_BASE`) `var<storage, read>`: one per `buffers` entry
 */
export interface BindingDesc {
  uniformBytes?: number;
  textures?: number;
  sampler?: SamplerKind;
  /** Which stages see the bindings. Default fragment + vertex. */
  visibility?: GPUShaderStageFlags;
  /**
   * Read-only storage buffers, bound whole at `@binding(BUFFER_BINDING_BASE + i)` (a
   * `SkinPalette.buffer`, a lookup table). Swap one later with `BindingSet.setBuffer`.
   */
  buffers?: readonly GPUBuffer[];
}

/** First binding of `BindingDesc.buffers` (textures stop at 15, so up to 14 texture slots). */
export const BUFFER_BINDING_BASE = 16;

/** Extra `BindingSet` behaviour. */
export interface BindingSetOptions {
  /**
   * Per-draw uniform blocks: the uniform binding uses a dynamic offset into a growable buffer.
   * Slot 0 holds the shared block (`setUniforms`); `pushDrawUniforms` appends one block per
   * draw for the current frame. Needs `uniformBytes > 0`.
   */
  perDraw?: boolean;
}

export function hasBindings(desc: BindingDesc): boolean {
  return (
    (desc.uniformBytes ?? 0) > 0 || (desc.textures ?? 0) > 0 || (desc.buffers?.length ?? 0) > 0
  );
}

export function createBindingLayout(
  device: GPUDevice,
  desc: BindingDesc,
  label: string,
  dynamicUniform = false,
): GPUBindGroupLayout {
  const vis = desc.visibility ?? GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX;
  const entries: GPUBindGroupLayoutEntry[] = [];
  if ((desc.uniformBytes ?? 0) > 0) {
    entries.push({
      binding: 0,
      visibility: vis,
      buffer: dynamicUniform ? { hasDynamicOffset: true } : {},
    });
  }
  const n = desc.textures ?? 0;
  if (n > 0) {
    entries.push({ binding: 1, visibility: vis, sampler: {} });
    for (let i = 0; i < n; i++) {
      entries.push({ binding: 2 + i, visibility: vis, texture: { sampleType: 'float' } });
    }
  }
  const nb = desc.buffers?.length ?? 0;
  for (let i = 0; i < nb; i++) {
    entries.push({
      binding: BUFFER_BINDING_BASE + i,
      visibility: vis,
      buffer: { type: 'read-only-storage' },
    });
  }
  return device.createBindGroupLayout({ label, entries });
}

/** Bind groups kept for recently used view sets (ping-pong flips between two). */
const GROUP_CACHE = 4;
/** Initial per-draw slots (including the shared slot 0). Grows by doubling. */
const INITIAL_DRAW_SLOTS = 16;

/**
 * Owns the uniform buffer + bind group for one binding set; rebuilds the group lazily.
 * Bind groups for the last few texture sets are cached, so alternating textures (ping-pong)
 * allocates nothing after the first round.
 */
export class BindingSet {
  readonly layout: GPUBindGroupLayout;
  /** Replaced when a per-draw set grows. */
  uniformBuffer: GPUBuffer | null;
  /** True when the uniform binding takes a dynamic offset (see `BindingSetOptions.perDraw`). */
  readonly perDraw: boolean;
  /** Uniform block size in bytes (rounded up to 16), 0 when there is none. */
  readonly blockBytes: number;
  /** Byte distance between per-draw blocks (block size rounded up to the offset alignment). */
  readonly stride: number;
  private readonly views: GPUTextureView[];
  private readonly buffers: GPUBuffer[];
  private group: GPUBindGroup | null = null;
  private readonly cache: { views: GPUTextureView[]; group: GPUBindGroup }[] = [];
  private staging: Uint8Array<ArrayBuffer> | null = null;
  private stagingF32: Float32Array<ArrayBuffer> | null = null;
  private drawSlots = 0;

  constructor(
    private readonly device: GPUDevice,
    desc: BindingDesc,
    private readonly sampler: GPUSampler,
    defaultView: GPUTextureView,
    private readonly label: string,
    opts: BindingSetOptions = {},
  ) {
    const bytes = desc.uniformBytes ?? 0;
    this.blockBytes = Math.ceil(bytes / 16) * 16;
    this.perDraw = !!opts.perDraw;
    if (this.perDraw && bytes <= 0) {
      throw new Error(`${label}: perDraw uniforms need uniformBytes > 0`);
    }
    const align = device.limits?.minUniformBufferOffsetAlignment ?? 256;
    this.stride = this.perDraw ? Math.ceil(this.blockBytes / align) * align : this.blockBytes;
    this.layout = createBindingLayout(device, desc, `${label}-layout`, this.perDraw);
    if (this.perDraw) {
      this.staging = new Uint8Array(this.stride * INITIAL_DRAW_SLOTS);
      this.stagingF32 = new Float32Array(this.staging.buffer);
    }
    this.uniformBuffer = bytes > 0 ? this.makeUniformBuffer() : null;
    this.views = new Array(desc.textures ?? 0).fill(defaultView);
    this.buffers = desc.buffers ? [...desc.buffers] : [];
  }

  setUniforms(data: BufferSource, byteOffset = 0): void {
    if (!this.uniformBuffer) throw new Error(`${this.label}: no uniforms declared`);
    if (ArrayBuffer.isView(data)) {
      this.device.queue.writeBuffer(
        this.uniformBuffer,
        byteOffset,
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      // Keep slot 0 on the CPU too, so a grown buffer can be refilled.
      if (this.staging) this.stageShared(data.buffer, data.byteOffset, data.byteLength, byteOffset);
    } else {
      this.device.queue.writeBuffer(this.uniformBuffer, byteOffset, data);
      if (this.staging) this.stageShared(data, 0, data.byteLength, byteOffset);
    }
  }

  /** Per-draw blocks recorded since the last flush. */
  get drawCount(): number {
    return this.drawSlots;
  }

  /**
   * Stage one per-draw uniform block (f32s; the rest of the block reads 0) and return its
   * dynamic offset. Uploaded by `flushDrawUniforms`, normally called by the renderer.
   */
  pushDrawUniforms(data: ArrayLike<number>): number {
    if (!this.perDraw) throw new Error(`${this.label}: per-draw uniforms not enabled`);
    if (data.length * 4 > this.blockBytes) {
      throw new Error(
        `${this.label}: per-draw uniforms are ${data.length * 4} bytes, block is ${this.blockBytes}`,
      );
    }
    const slot = ++this.drawSlots;
    const offset = slot * this.stride;
    if (offset + this.stride > this.staging!.byteLength) {
      const next = new Uint8Array(this.staging!.byteLength * 2);
      next.set(this.staging!);
      this.staging = next;
      this.stagingF32 = new Float32Array(next.buffer);
    }
    const f = this.stagingF32!;
    const o = offset / 4;
    const n = data.length;
    for (let i = 0; i < n; i++) f[o + i] = data[i]!;
    f.fill(0, o + n, o + this.blockBytes / 4);
    return offset;
  }

  /** Upload this frame's per-draw blocks (growing the buffer if needed) and reset the count. */
  flushDrawUniforms(): void {
    const n = this.drawSlots;
    if (n === 0 || !this.staging) return;
    this.drawSlots = 0;
    const needed = (n + 1) * this.stride;
    if (needed > this.uniformBuffer!.size) {
      this.uniformBuffer!.destroy();
      this.uniformBuffer = this.makeUniformBuffer();
      this.invalidateGroups();
      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.staging.buffer, 0, needed);
      return;
    }
    this.device.queue.writeBuffer(
      this.uniformBuffer!,
      this.stride,
      this.staging.buffer,
      this.stride,
      n * this.stride,
    );
  }

  /** Drop this frame's per-draw blocks without uploading. */
  discardDrawUniforms(): void {
    this.drawSlots = 0;
  }

  setTexture(slot: number, tex: TextureLike | GPUTextureView): void {
    if (slot < 0 || slot >= this.views.length) {
      throw new Error(`${this.label}: texture slot ${slot} out of range`);
    }
    const view = 'view' in tex ? tex.view : tex;
    if (this.views[slot] === view) return;
    this.views[slot] = view;
    this.group = null;
  }

  /** Rebind storage buffer slot `i` (`@binding(BUFFER_BINDING_BASE + i)`); groups rebuild lazily. */
  setBuffer(slot: number, buffer: GPUBuffer): void {
    if (slot < 0 || slot >= this.buffers.length) {
      throw new Error(`${this.label}: buffer slot ${slot} out of range`);
    }
    if (this.buffers[slot] === buffer) return;
    this.buffers[slot] = buffer;
    this.invalidateGroups();
  }

  /** Build a bind group for an explicit set of views (callers cache it). */
  createGroup(views: readonly GPUTextureView[] = this.views): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [];
    if (this.uniformBuffer) {
      entries.push({
        binding: 0,
        resource: this.perDraw
          ? { buffer: this.uniformBuffer, size: this.blockBytes }
          : { buffer: this.uniformBuffer },
      });
    }
    if (views.length) {
      entries.push({ binding: 1, resource: this.sampler });
      views.forEach((v, i) => {
        entries.push({ binding: 2 + i, resource: v });
      });
    }
    this.buffers.forEach((b, i) => {
      entries.push({ binding: BUFFER_BINDING_BASE + i, resource: { buffer: b } });
    });
    return this.device.createBindGroup({
      label: `${this.label}-group`,
      layout: this.layout,
      entries,
    });
  }

  get bindGroup(): GPUBindGroup {
    if (!this.group) this.group = this.cachedGroup();
    return this.group;
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
  }

  private cachedGroup(): GPUBindGroup {
    const views = this.views;
    const cache = this.cache;
    for (let i = 0; i < cache.length; i++) {
      const c = cache[i]!;
      let same = true;
      for (let j = 0; j < views.length; j++) {
        if (c.views[j] !== views[j]) {
          same = false;
          break;
        }
      }
      if (same) return c.group;
    }
    const group = this.createGroup();
    if (cache.length >= GROUP_CACHE) cache.shift();
    cache.push({ views: views.slice(), group });
    return group;
  }

  private stageShared(src: ArrayBufferLike, srcOffset: number, bytes: number, at: number): void {
    const n = Math.max(0, Math.min(bytes, this.stride - at));
    if (n > 0) this.staging!.set(new Uint8Array(src, srcOffset, n), at);
  }

  private invalidateGroups(): void {
    this.group = null;
    this.cache.length = 0;
  }

  private makeUniformBuffer(): GPUBuffer {
    return this.device.createBuffer({
      label: `${this.label}-uniforms`,
      size: this.staging ? this.staging.byteLength : this.blockBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
}
