/**
 * Mesh: vertex buffer (+ optional index buffer) in the engine's fixed vertex layout:
 * `pos: vec2f, uv: vec2f, color: vec4f` (8 floats, 32 bytes per vertex).
 *
 * Positions are in the mesh's local space; each draw's instance transform (x, y, w, h,
 * rotation) maps local → logical space as `xy + rotate(pos * wh)`. The built-in quad spans
 * -0.5..0.5 so `w, h` are its size in logical pixels; for arbitrary meshes authored directly
 * in logical pixels, draw with `x = 0, y = 0, w = 1, h = 1`.
 */
export const VERTEX_FLOATS = 8;
export const VERTEX_STRIDE = VERTEX_FLOATS * 4;

export const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' },
    { shaderLocation: 1, offset: 8, format: 'float32x2' },
    { shaderLocation: 2, offset: 16, format: 'float32x4' },
  ],
};

export interface MeshDesc {
  label?: string;
  /** Interleaved vertices, 8 floats each (x, y, u, v, r, g, b, a). */
  vertices: Float32Array;
  indices?: Uint16Array | Uint32Array;
  /** Reserve room for this many vertices/indices so `update()` can grow without realloc. */
  maxVertices?: number;
  maxIndices?: number;
}

export class Mesh {
  readonly label: string;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer | null = null;
  indexFormat: GPUIndexFormat = 'uint16';
  vertexCount = 0;
  indexCount = 0;
  private vertexCapacity: number;
  private indexCapacity = 0;

  constructor(
    private readonly device: GPUDevice,
    desc: MeshDesc,
  ) {
    this.label = desc.label ?? 'mesh';
    const vCount = desc.vertices.length / VERTEX_FLOATS;
    this.vertexCapacity = Math.max(vCount, desc.maxVertices ?? 0, 1);
    this.vertexBuffer = this.makeVertexBuffer(this.vertexCapacity);
    if (desc.indices || desc.maxIndices) {
      this.indexFormat = desc.indices instanceof Uint32Array ? 'uint32' : 'uint16';
      this.indexCapacity = Math.max(desc.indices?.length ?? 0, desc.maxIndices ?? 0, 1);
      this.indexBuffer = this.makeIndexBuffer(this.indexCapacity);
    }
    this.update(desc.vertices, desc.indices);
  }

  /**
   * Replace geometry. Reuses buffers when it fits (no allocation); grows them otherwise.
   * Pass `vertexCount`/`indexCount` to upload only a prefix of the arrays.
   */
  update(
    vertices: Float32Array,
    indices?: Uint16Array | Uint32Array,
    vertexCount = vertices.length / VERTEX_FLOATS,
    indexCount = indices?.length ?? 0,
  ): void {
    if (vertexCount > this.vertexCapacity) {
      this.vertexBuffer.destroy();
      this.vertexCapacity = Math.ceil(vertexCount * 1.5);
      this.vertexBuffer = this.makeVertexBuffer(this.vertexCapacity);
    }
    this.vertexCount = vertexCount;
    if (vertexCount > 0) {
      this.device.queue.writeBuffer(
        this.vertexBuffer,
        0,
        vertices.buffer,
        vertices.byteOffset,
        vertexCount * VERTEX_STRIDE,
      );
    }
    if (indices) {
      const fmt: GPUIndexFormat = indices instanceof Uint32Array ? 'uint32' : 'uint16';
      if (!this.indexBuffer || indexCount > this.indexCapacity || fmt !== this.indexFormat) {
        this.indexBuffer?.destroy();
        this.indexCapacity = Math.max(Math.ceil(indexCount * 1.5), 1);
        this.indexFormat = fmt;
        this.indexBuffer = this.makeIndexBuffer(this.indexCapacity);
      }
      this.indexCount = indexCount;
      const bytes = indexCount * indices.BYTES_PER_ELEMENT;
      // writeBuffer needs a 4-byte multiple size.
      const padded = Math.ceil(bytes / 4) * 4;
      if (padded > 0 && padded <= indices.buffer.byteLength - indices.byteOffset) {
        this.device.queue.writeBuffer(
          this.indexBuffer,
          0,
          indices.buffer,
          indices.byteOffset,
          padded,
        );
      } else if (bytes > 0) {
        const copy = new Uint16Array(Math.ceil(bytes / 4) * 2);
        // Odd uint16 count at the very end of its ArrayBuffer: copy into a padded array.
        copy.set((indices as Uint16Array).subarray(0, indexCount));
        this.device.queue.writeBuffer(this.indexBuffer, 0, copy);
      }
    } else if (!this.indexBuffer) {
      this.indexCount = 0;
    }
  }

  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer?.destroy();
  }

  private makeVertexBuffer(count: number): GPUBuffer {
    return this.device.createBuffer({
      label: `${this.label}-vb`,
      size: count * VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  private makeIndexBuffer(count: number): GPUBuffer {
    const bytes = count * (this.indexFormat === 'uint32' ? 4 : 2);
    return this.device.createBuffer({
      label: `${this.label}-ib`,
      size: Math.ceil(bytes / 4) * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
  }
}

/** Unit quad centred on the origin (-0.5..0.5), uv (0,0) top-left, white. */
export function quadGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  // biome-ignore format: vertex table
  const vertices = new Float32Array([
    -0.5, -0.5, 0, 0, 1, 1, 1, 1,
     0.5, -0.5, 1, 0, 1, 1, 1, 1,
     0.5,  0.5, 1, 1, 1, 1, 1, 1,
    -0.5,  0.5, 0, 1, 1, 1, 1, 1,
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}
