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

/** Room reserved in a mesh's buffers, in vertices and indices. */
export interface MeshCapacity {
  readonly vertices: number;
  readonly indices: number;
}

export interface MeshDesc {
  label?: string;
  /**
   * Interleaved vertices in `layout`: 8 floats each for 2D (x, y, u, v, r, g, b, a), 12 for
   * 3D (x, y, z, nx, ny, nz, u, v, r, g, b, a). Optional when `capacity` is given: the mesh
   * then starts empty (`vertexCount` 0) and is filled by `update()`.
   */
  vertices?: Float32Array;
  /** Vertex layout. Default `VERTEX_LAYOUT_2D`. */
  layout?: VertexLayout;
  indices?: Uint16Array | Uint32Array;
  /**
   * Reserve room for this many vertices and indices so `update()` can rewrite the geometry
   * without reallocating. Defaults to the initial data's size. `indices` > 0 gives the mesh an
   * index buffer even when no initial indices are passed.
   */
  capacity?: { vertices?: number; indices?: number };
  /**
   * Index format of a mesh created with only an index capacity. Default: the format of the
   * initial `indices`, else `uint16` when `capacity.vertices` fits, `uint32` otherwise.
   */
  indexFormat?: GPUIndexFormat;
}

/**
 * One geometry upload. Views are read from their own `ArrayBuffer` (`buffer`, `byteOffset`),
 * so a buffer transferred from a Worker is uploaded in place, with no copy on the main thread.
 * Any view type works; counts default to the view's whole length in the mesh's layout and
 * index format. `vertexCount`/`indexCount` without a view only move the draw range.
 */
export interface MeshUpdate {
  vertices?: ArrayBufferView;
  indices?: ArrayBufferView;
  /** Vertices to upload and draw. Default: all of `vertices`. */
  vertexCount?: number;
  /** Indices to upload and draw. Default: all of `indices`. */
  indexCount?: number;
}

/** 1.5× growth, like a vector: amortised reallocations when a streamed mesh keeps growing. */
const GROWTH = 1.5;

export class Mesh {
  readonly label: string;
  /** Vertex layout of this mesh's buffer; pipelines are keyed by (material, layout). */
  readonly layout: VertexLayout;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer | null = null;
  indexFormat: GPUIndexFormat = 'uint16';
  /** Vertices drawn (non-indexed) and uploaded by the last `update`. */
  vertexCount = 0;
  /**
   * Indices drawn (`drawIndexed`) when > 0. With an index buffer and `indexCount` 0 the renderer
   * skips the draw (no non-indexed fallback), so `update({ indexCount: 0 })` empties the mesh.
   */
  indexCount = 0;
  /**
   * Buffers reallocated so far, by `update()` exceeding `capacity` or changing the index format.
   * A caller that caches `vertexBuffer`/`indexBuffer` (a drawable, a bind group) re-reads them
   * when this changes.
   */
  growths = 0;
  private readonly cap: { vertices: number; indices: number } = { vertices: 0, indices: 0 };
  /** 4-byte scratch for the last index of an odd uint16 count at the end of its buffer. */
  private readonly tail16 = new Uint16Array(2);

  constructor(
    private readonly device: GPUDevice,
    desc: MeshDesc,
  ) {
    this.label = desc.label ?? 'mesh';
    this.layout = desc.layout ?? VERTEX_LAYOUT_2D;
    const vCount = desc.vertices ? desc.vertices.length / this.layout.floats : 0;
    this.cap.vertices = Math.max(vCount, desc.capacity?.vertices ?? 0, 1);
    this.vertexBuffer = this.makeVertexBuffer(this.cap.vertices);
    const iCap = Math.max(desc.indices?.length ?? 0, desc.capacity?.indices ?? 0);
    if (iCap > 0) {
      this.indexFormat =
        desc.indexFormat ??
        (desc.indices ? formatOf(desc.indices) : this.cap.vertices > 0xffff ? 'uint32' : 'uint16');
      this.cap.indices = iCap;
      this.indexBuffer = this.makeIndexBuffer(iCap);
    }
    if (desc.vertices || desc.indices) {
      this.update({ vertices: desc.vertices, indices: desc.indices });
    }
  }

  /** Room in the buffers (vertices, indices); `indices` is 0 for a non-indexed mesh. */
  get capacity(): MeshCapacity {
    return this.cap;
  }

  /**
   * Replace geometry (`MeshUpdate`). Writes with `queue.writeBuffer` straight from each view's
   * buffer and reuses the GPU buffers while the counts fit `capacity`; grows them (1.5×) only
   * when a count exceeds it or the index format changes. Returns true when a buffer was
   * reallocated (`growths` counts them). Allocation-free otherwise.
   */
  update(u: MeshUpdate): boolean {
    let grew = false;
    const { stride } = this.layout;
    if (u.vertices) {
      const count = u.vertexCount ?? Math.floor(u.vertices.byteLength / stride);
      if (count > this.cap.vertices) {
        this.vertexBuffer.destroy();
        this.cap.vertices = Math.ceil(count * GROWTH);
        this.vertexBuffer = this.makeVertexBuffer(this.cap.vertices);
        grew = true;
      }
      this.vertexCount = count;
      if (count > 0) {
        this.device.queue.writeBuffer(
          this.vertexBuffer,
          0,
          u.vertices.buffer,
          u.vertices.byteOffset,
          count * stride,
        );
      }
    } else if (u.vertexCount !== undefined) {
      this.vertexCount = Math.min(u.vertexCount, this.cap.vertices);
    }

    if (u.indices) {
      const fmt = formatOf(u.indices, this.indexFormat);
      const bpi = fmt === 'uint32' ? 4 : 2;
      const count = u.indexCount ?? Math.floor(u.indices.byteLength / bpi);
      if (!this.indexBuffer || count > this.cap.indices || fmt !== this.indexFormat) {
        this.indexBuffer?.destroy();
        this.cap.indices = Math.max(Math.ceil(count * GROWTH), 1);
        this.indexFormat = fmt;
        this.indexBuffer = this.makeIndexBuffer(this.cap.indices);
        grew = true;
      }
      this.indexCount = count;
      this.writeIndices(u.indices, count * bpi);
    } else if (u.indexCount !== undefined && this.indexBuffer) {
      this.indexCount = Math.min(u.indexCount, this.cap.indices);
    }
    if (grew) this.growths++;
    return grew;
  }

  /** `writeBuffer` wants 4-byte sizes and offsets; a uint16 count may be odd. */
  private writeIndices(view: ArrayBufferView, bytes: number): void {
    if (bytes === 0) return;
    const ib = this.indexBuffer!;
    const { buffer, byteOffset } = view;
    const even = bytes & ~3;
    if (even === bytes) {
      this.device.queue.writeBuffer(ib, 0, buffer, byteOffset, bytes);
      return;
    }
    if (byteOffset + bytes + 2 <= buffer.byteLength) {
      // Two bytes of slack after the data: upload them as padding.
      this.device.queue.writeBuffer(ib, 0, buffer, byteOffset, bytes + 2);
      return;
    }
    // The odd index ends its buffer: write the even prefix, then the last index via the scratch.
    if (even > 0) this.device.queue.writeBuffer(ib, 0, buffer, byteOffset, even);
    const bytesView = new DataView(buffer, byteOffset + even, 2);
    this.tail16[0] = bytesView.getUint16(0, true);
    this.device.queue.writeBuffer(ib, even, this.tail16.buffer, 0, 4);
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

/** Index format implied by a typed array; any other view keeps `fallback`. */
function formatOf(view: ArrayBufferView, fallback: GPUIndexFormat = 'uint16'): GPUIndexFormat {
  if (view instanceof Uint32Array) return 'uint32';
  if (view instanceof Uint16Array) return 'uint16';
  return fallback;
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
