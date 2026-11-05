/**
 * Mesh: a vertex buffer (+ optional index buffer) in one of the engine's vertex layouts.
 *
 * - `VERTEX_LAYOUT_2D` (the default): `pos: vec2f, uv: vec2f, color: vec4f`, 8 floats
 *   (`VERTEX_FLOATS`), 32 bytes per vertex.
 * - `VERTEX_LAYOUT_3D`: `pos: vec3f, normal: vec3f, uv: vec2f, color: vec4f`, 12 floats
 *   (`VERTEX3D_FLOATS`), 48 bytes per vertex.
 *
 * Positions are in the mesh's local space; each draw's 3×4 instance matrix (built from
 * `DrawParams` x, y, w, h, rotation, or taken from a `Transform`) maps local → world space.
 * For `DrawParams` that is `xy + rotate(pos * wh)`: the built-in quad spans -0.5..0.5 so
 * `w, h` are its size in logical pixels; for arbitrary meshes authored directly in logical
 * pixels, draw with `x = 0, y = 0, w = 1, h = 1`.
 *
 * Materials build one pipeline per (vertex layout, depth mode), lazily, on first use.
 */
export const VERTEX_FLOATS = 8;
export const VERTEX_STRIDE = VERTEX_FLOATS * 4;
export const VERTEX3D_FLOATS = 12;
export const VERTEX3D_STRIDE = VERTEX3D_FLOATS * 4;

/** The 2D layout's buffer layout (locations 0..2). */
export const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' },
    { shaderLocation: 1, offset: 8, format: 'float32x2' },
    { shaderLocation: 2, offset: 16, format: 'float32x4' },
  ],
};

/** The 3D layout's buffer layout: position 0, normal 10, uv 1, colour 2. */
export const VERTEX3D_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX3D_STRIDE,
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 10, offset: 12, format: 'float32x3' },
    { shaderLocation: 1, offset: 24, format: 'float32x2' },
    { shaderLocation: 2, offset: 32, format: 'float32x4' },
  ],
};

/**
 * A vertex layout: the GPU buffer layout plus the WGSL that reads it. The material prelude is
 * generated per layout (`materialPrelude(layout)`), so `engine_vertex`, `VSOut` and the
 * fragment side are the same for every layout. Layouts compare by identity.
 */
export interface VertexLayout {
  /** Short name, used in pipeline labels. */
  readonly name: string;
  readonly floats: number;
  readonly stride: number;
  readonly buffer: GPUVertexBufferLayout;
  /** The vertex-attribute fields of WGSL `VertexIn` (the instance fields follow them). */
  readonly wgslFields: string;
  /** WGSL expression over `v: VertexIn` for the object-space position (`vec3f`). */
  readonly wgslPosition: string;
  /** WGSL expression over `v: VertexIn` for the object-space normal (`vec3f`). */
  readonly wgslNormal: string;
}

/** 2D layout: `v.pos` is a `vec2f` (z = 0); the normal faces the viewer, `(0, 0, -1)`. */
export const VERTEX_LAYOUT_2D: VertexLayout = {
  name: '2d',
  floats: VERTEX_FLOATS,
  stride: VERTEX_STRIDE,
  buffer: VERTEX_BUFFER_LAYOUT,
  wgslFields: `  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,`,
  wgslPosition: 'vec3f(v.pos, 0.0)',
  wgslNormal: 'vec3f(0.0, 0.0, -1.0)',
};

/** 3D layout: `v.pos` and `v.normal` are `vec3f`. */
export const VERTEX_LAYOUT_3D: VertexLayout = {
  name: '3d',
  floats: VERTEX3D_FLOATS,
  stride: VERTEX3D_STRIDE,
  buffer: VERTEX3D_BUFFER_LAYOUT,
  wgslFields: `  @location(0) pos: vec3f,
  @location(10) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,`,
  wgslPosition: 'v.pos',
  wgslNormal: 'v.normal',
};

export interface MeshDesc {
  label?: string;
  /**
   * Interleaved vertices in `layout`: 8 floats each for 2D (x, y, u, v, r, g, b, a), 12 for
   * 3D (x, y, z, nx, ny, nz, u, v, r, g, b, a).
   */
  vertices: Float32Array;
  /** Vertex layout. Default `VERTEX_LAYOUT_2D`. */
  layout?: VertexLayout;
  indices?: Uint16Array | Uint32Array;
  /** Reserve room for this many vertices/indices so `update()` can grow without realloc. */
  maxVertices?: number;
  maxIndices?: number;
}

export class Mesh {
  readonly label: string;
  /** Vertex layout of this mesh's buffer; pipelines are keyed by (material, layout). */
  readonly layout: VertexLayout;
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
    this.layout = desc.layout ?? VERTEX_LAYOUT_2D;
    const vCount = desc.vertices.length / this.layout.floats;
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
    vertexCount = vertices.length / this.layout.floats,
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
        vertexCount * this.layout.stride,
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

  /** The `GPUVertexBufferLayout` of `layout` (buffer slot 0 of every pipeline drawing it). */
  get vertexBufferLayout(): GPUVertexBufferLayout {
    return this.layout.buffer;
  }

  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer?.destroy();
  }

  private makeVertexBuffer(count: number): GPUBuffer {
    return this.device.createBuffer({
      label: `${this.label}-vb`,
      size: count * this.layout.stride,
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
