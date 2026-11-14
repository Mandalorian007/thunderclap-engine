/**
 * The shared quad index buffer (D1 §3.2): one `uint32` index buffer per core, `0 1 2 0 2 3` for
 * every quad, so every mesh made of quads (a voxel section, a box, a sprite strip) draws from it
 * with a base vertex instead of carrying its own indices.
 */

/** Indices per quad (two triangles). */
export const QUAD_INDICES = 6;

/** The quad index pattern for `quads` quads, from quad `first` on. */
export function quadIndices(quads: number, first = 0): Uint32Array {
  const out = new Uint32Array(quads * QUAD_INDICES);
  for (let q = 0; q < quads; q++) {
    const v = (first + q) * 4;
    const o = q * QUAD_INDICES;
    out[o] = v;
    out[o + 1] = v + 1;
    out[o + 2] = v + 2;
    out[o + 3] = v;
    out[o + 4] = v + 2;
    out[o + 5] = v + 3;
  }
  return out;
}

/** A quad index buffer that grows (by doubling) to the most quads asked of it. */
export class QuadIndex {
  /** The buffer, or null before the first `ensure`. */
  buffer: GPUBuffer | null = null;
  /** Quads the buffer holds. */
  quads = 0;
  /** Bumped when the buffer is replaced (anything recorded against it is stale). */
  version = 0;
  private readonly device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** Make room for `quads` quads; returns the buffer. Grows by doubling, never shrinks. */
  ensure(quads: number): GPUBuffer {
    if (this.buffer && quads <= this.quads) return this.buffer;
    let n = Math.max(1024, this.quads);
    while (n < quads) n *= 2;
    const buffer = this.device.createBuffer({
      label: 'core quad index',
      size: n * QUAD_INDICES * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, quadIndices(n) as GPUAllowSharedBufferSource);
    this.buffer?.destroy();
    this.buffer = buffer;
    this.quads = n;
    this.version++;
    return buffer;
  }

  destroy(): void {
    this.buffer?.destroy();
    this.buffer = null;
    this.quads = 0;
    this.version++;
  }
}
