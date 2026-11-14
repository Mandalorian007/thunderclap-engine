/**
 * Mesh: a vertex buffer (+ optional index buffer) in one of the engine's vertex layouts.
 *
 * - `VERTEX_LAYOUT_2D` (the default): `pos: vec2f, uv: vec2f, color: vec4f`, 8 floats
 *   (`VERTEX_FLOATS`), 32 bytes per vertex.
 * - `VERTEX_LAYOUT_3D`: `pos: vec3f, normal: vec3f, uv: vec2f, color: vec4f`, 12 floats
 *   (`VERTEX3D_FLOATS`), 48 bytes per vertex.
 * - `VERTEX_LAYOUT_3D_TANGENT`: the 3D layout plus `tangent: vec4f` (xyz, handedness w),
 *   16 floats, 64 bytes per vertex.
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
  /**
   * Float offset of x, y, z inside a vertex (0 in every shipped layout), so a layout goes
   * straight to `meshTester(..., { stride: layout.floats, offset: layout.positionOffset })`.
   * Optional for a layout written by hand; read it as `layout.positionOffset ?? 0`.
   */
  readonly positionOffset?: number;
  /**
   * The layout carries joints and weights: `materialPrelude` emits `WGSL_SKIN` (the palette
   * binding and `engine_skin`) so `wgslPosition` / `wgslNormal` may call it. See `skin.ts`.
   */
  readonly skinned?: boolean;
  /**
   * WGSL expression over `v: VertexIn` for the file tangent (`vec4f`: xyz along +u, w the
   * handedness) when the layout carries one; the prelude's `engine_local_tangent(v)` returns it,
   * or `vec4f(0)` (w = 0: "no tangent", the derivative fallback) for a layout without.
   */
  readonly wgslTangent?: string;
  /**
   * WGSL expression over `v: VertexIn` for the second texture coordinate set (`vec2f`), the
   * `uv1` varying (`TEXCOORD_1`); `v.uv` is used when absent.
   */
  readonly wgslUv1?: string;
  /**
   * WGSL expression over `v: VertexIn` for the object-space position of the previous frame as
   * a `vec4f` (w = 0 means "unknown": the velocity target reads zero). Default: the current
   * position with w = 1. A skinned layout reads the palette's previous block.
   */
  readonly wgslPreviousPosition?: string;
}

/** 2D layout: `v.pos` is a `vec2f` (z = 0); the normal faces the viewer, `(0, 0, -1)`. */
export const VERTEX_LAYOUT_2D: VertexLayout = {
  name: '2d',
  positionOffset: 0,
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
  positionOffset: 0,
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

/**
 * Tangent layout (ws/geom-2): the 3D layout's 12 floats followed by a tangent `vec4f` at
 * `@location(13)` (3..9 are the instance buffer, 11 and 12 skinning): xyz the unit tangent
 * along +u, w the handedness ±1, so the bitangent is `w · cross(normal, tangent)`. 16 floats,
 * 64 bytes. `geom`'s `computeTangents` writes it; the prelude reads it like the 3D layout, so a
 * material that ignores `v.tangent` draws unchanged.
 */
export const VERTEX_LAYOUT_3D_TANGENT: VertexLayout = {
  name: '3d-tangent',
  positionOffset: 0,
  floats: 16,
  stride: 64,
  buffer: {
    arrayStride: 64,
    stepMode: 'vertex',
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 10, offset: 12, format: 'float32x3' },
      { shaderLocation: 1, offset: 24, format: 'float32x2' },
      { shaderLocation: 2, offset: 32, format: 'float32x4' },
      { shaderLocation: 13, offset: 48, format: 'float32x4' },
    ],
  },
  wgslFields: `  @location(0) pos: vec3f,
  @location(10) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(13) tangent: vec4f,`,
  wgslPosition: 'v.pos',
  wgslNormal: 'v.normal',
  wgslTangent: 'v.tangent',
};

/** Floats of `VERTEX_LAYOUT_3D_UV2` (the 3D layout plus a second uv). */
export const VERTEX3D_UV2_FLOATS = 14;
export const VERTEX3D_UV2_STRIDE = VERTEX3D_UV2_FLOATS * 4;

/**
 * Two-uv layout (ws/render-4): the 3D layout's 12 floats followed by `uv1: vec2f` at
 * `@location(14)` (glTF `TEXCOORD_1`, the usual home of a light or occlusion map): 14 floats,
 * 56 bytes. The prelude carries it as `VSOut.uv1`; the standard material's maps pick it with
 * `texCoord: 1`. Materials that ignore it draw as with the 3D layout.
 */
export const VERTEX_LAYOUT_3D_UV2: VertexLayout = {
  name: '3d-uv2',
  positionOffset: 0,
  floats: VERTEX3D_UV2_FLOATS,
  stride: VERTEX3D_UV2_STRIDE,
  buffer: {
    arrayStride: VERTEX3D_UV2_STRIDE,
    stepMode: 'vertex',
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 10, offset: 12, format: 'float32x3' },
      { shaderLocation: 1, offset: 24, format: 'float32x2' },
      { shaderLocation: 2, offset: 32, format: 'float32x4' },
      { shaderLocation: 14, offset: 48, format: 'float32x2' },
    ],
  },
  wgslFields: `  @location(0) pos: vec3f,
  @location(10) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(14) uv1: vec2f,`,
  wgslPosition: 'v.pos',
  wgslNormal: 'v.normal',
  wgslUv1: 'v.uv1',
};

/**
 * Skinned layout: the 3D layout's 12 floats followed by four joint indices (`uint8x4`, read as
 * `vec4u`) and four weights (`unorm8x4`, read as `vec4f`), 8 bytes that occupy the slots of
 * floats 12 and 13: 14 "floats" (`VERTEX_SKINNED_FLOATS`), 56 bytes per vertex. Write the
 * joints and weights through a byte view of the vertex buffer (`setVertexSkin` in `skin.ts`),
 * not as floats (a packed value may be a NaN pattern). `materialPrelude` applies the four
 * weighted joint matrices from the material's `SkinPalette` before the instance matrix.
 */
export const VERTEX_SKINNED_FLOATS = 14;
export const VERTEX_SKINNED_STRIDE = VERTEX_SKINNED_FLOATS * 4;
/** Byte offset of the four joint indices inside a skinned vertex. */
export const SKIN_JOINTS_BYTE_OFFSET = 48;
/** Byte offset of the four weights (unorm8) inside a skinned vertex. */
export const SKIN_WEIGHTS_BYTE_OFFSET = 52;

/** The skinned layout's buffer layout: the 3D attributes, joints at 11 and weights at 12. */
export const VERTEX_SKINNED_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_SKINNED_STRIDE,
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 10, offset: 12, format: 'float32x3' },
    { shaderLocation: 1, offset: 24, format: 'float32x2' },
    { shaderLocation: 2, offset: 32, format: 'float32x4' },
    { shaderLocation: 11, offset: SKIN_JOINTS_BYTE_OFFSET, format: 'uint8x4' },
    { shaderLocation: 12, offset: SKIN_WEIGHTS_BYTE_OFFSET, format: 'unorm8x4' },
  ],
};

/**
 * Skinned layout: `v.pos`, `v.normal`, `v.uv`, `v.color` as in 3D plus `v.joints: vec4u` and
 * `v.weights: vec4f`. The prelude's `engine_local_position` / `engine_local_normal` return the
 * skinned position and normal (`engine_skin`), so `engine_vertex` and every material work
 * unchanged. The instance's palette slot travels in `params.w` (see `skin.ts`).
 */
export const VERTEX_LAYOUT_SKINNED: VertexLayout = {
  name: 'skinned',
  positionOffset: 0,
  floats: VERTEX_SKINNED_FLOATS,
  stride: VERTEX_SKINNED_STRIDE,
  buffer: VERTEX_SKINNED_BUFFER_LAYOUT,
  wgslFields: `  @location(0) pos: vec3f,
  @location(10) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(11) joints: vec4u,
  @location(12) weights: vec4f,`,
  wgslPosition: 'engine_skin(v, v.pos, v.normal).position',
  wgslNormal: 'engine_skin(v, v.pos, v.normal).normal',
  wgslPreviousPosition: 'engine_skin_previous(v, v.pos)',
  skinned: true,
};

/** An index sub-range of a mesh: `first` index and `count` indices (`InstanceParams.range`). */
export interface MeshRange {
  first: number;
  count: number;
}

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
  /**
   * Bounding sphere in mesh space, for frustum culling (`camera.cull`). Default: computed from
   * `vertices` when `autoBounds` is on, else unbounded (never culled).
   */
  bounds?: MeshBounds;
  /**
   * Recompute `bounds` from the positions on every `update()` that uploads vertices without
   * passing `bounds`. Default on under `AUTO_BOUNDS_MAX_VERTICES` (65 536) of capacity, off
   * above it, so a chunk pipeline that knows its bounds passes them itself.
   */
  autoBounds?: boolean;
  /**
   * Named index ranges (storage only, ws/render-4): a sub-mesh per material of a file, say.
   * Draw one with `frame.mesh(mesh, material, transform, { range: mesh.ranges.door })`.
   */
  ranges?: Record<string, MeshRange>;
}

/** A bounding sphere: `center` (x, y, z) and `radius`. `radius` Infinity means unbounded. */
export interface MeshBounds {
  center: [number, number, number];
  radius: number;
}

/** Capacity (vertices) up to which `MeshDesc.autoBounds` defaults to on. */
export const AUTO_BOUNDS_MAX_VERTICES = 65536;

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
  /**
   * New bounding sphere (copied). Without it, bounds are recomputed from `vertices` only when
   * the mesh's `autoBounds` is on.
   */
  bounds?: MeshBounds;
}

/**
 * The shape a meshing Worker posts back (`harness/stream.ts`): one `ArrayBuffer` holding
 * `vertexCount` vertices of the mesh's layout from byte 0 and, when `indexCount` is given, that
 * many indices of the mesh's index format at `indexOffset` (default: right after the vertices,
 * rounded up to 4 bytes); an indexed mesh given no `indexCount` draws nothing until the next
 * reply. `Mesh.update` takes it as-is, so the page never builds views over the
 * transferred buffer. Extra fields (a chunk id) are ignored.
 */
export interface MeshReply {
  buffer: ArrayBuffer;
  vertexCount: number;
  indexCount?: number;
  /** Byte offset of the indices in `buffer`. Default: the vertices' byte length, 4-aligned. */
  indexOffset?: number;
  bounds?: MeshBounds;
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
   * skips the draw entirely (no non-indexed fallback, no draw call, nothing in
   * `RenderStats`), so `update({ indexCount: 0 })` empties the mesh.
   */
  indexCount = 0;
  /**
   * Buffers reallocated so far, by `update()` exceeding `capacity` or changing the index format.
   * A caller that caches `vertexBuffer`/`indexBuffer` (a drawable, a bind group) re-reads them
   * when this changes.
   */
  growths = 0;
  /**
   * Bumped by every `update()` and by `destroy()` (ws/core-immediate): the renderer's mesh pool
   * re-copies the geometry it merges into one indirect run when this changes.
   */
  revision = 0;
  /**
   * Bounding sphere in mesh space (the renderer carries it through each draw's instance matrix
   * and culls against `camera.frustum`). From `MeshDesc.bounds`, `MeshUpdate.bounds` or, with
   * `autoBounds`, the positions; `radius` Infinity when unknown (never culled). The object is
   * owned by the mesh; read it, set it through `update({ bounds })`.
   */
  readonly bounds: MeshBounds = { center: [0, 0, 0], radius: Number.POSITIVE_INFINITY };
  /** Whether `update()` recomputes `bounds` from uploaded vertices (`MeshDesc.autoBounds`). */
  readonly autoBounds: boolean;
  /** Named index ranges from `MeshDesc.ranges`; storage only, the renderer never reads it. */
  readonly ranges: Record<string, MeshRange> | undefined;
  /** The layout's position attribute (location 0) has a z component. */
  private readonly pos3: boolean;
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
    this.autoBounds = desc.autoBounds ?? this.cap.vertices < AUTO_BOUNDS_MAX_VERTICES;
    this.ranges = desc.ranges;
    this.pos3 = positionHasZ(this.layout);
    this.vertexBuffer = this.makeVertexBuffer(this.cap.vertices);
    const iCap = Math.max(desc.indices?.length ?? 0, desc.capacity?.indices ?? 0);
    if (iCap > 0) {
      this.indexFormat =
        desc.indexFormat ??
        (desc.indices ? formatOf(desc.indices) : this.cap.vertices > 0xffff ? 'uint32' : 'uint16');
      this.cap.indices = iCap;
      this.indexBuffer = this.makeIndexBuffer(iCap);
    }
    if (desc.vertices || desc.indices || desc.bounds) {
      this.update({ vertices: desc.vertices, indices: desc.indices, bounds: desc.bounds });
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
   * reallocated (`growths` counts them). `bounds` are copied when given, else recomputed from
   * the uploaded positions when `autoBounds` is on (a `Float32Array` view is read in place;
   * any other view type gets one over the same buffer). Allocation-free otherwise.
   *
   * A `MeshReply` (`{ buffer, vertexCount, indexCount?, bounds? }`, a Worker's message) is the
   * same upload read straight out of the one transferred buffer; it allocates the two views.
   */
  update(u: MeshUpdate | MeshReply): boolean {
    if ('buffer' in u && u.buffer instanceof ArrayBuffer) return this.updateFromReply(u);
    return this.updateViews(u as MeshUpdate);
  }

  private updateFromReply(r: MeshReply): boolean {
    const { stride } = this.layout;
    const vBytes = r.vertexCount * stride;
    const vertices = new Uint8Array(r.buffer, 0, vBytes);
    let indices: ArrayBufferView | undefined;
    if (r.indexCount !== undefined) {
      const bpi = this.indexFormat === 'uint32' ? 4 : 2;
      const at = r.indexOffset ?? (vBytes + 3) & ~3;
      indices = new Uint8Array(r.buffer, at, r.indexCount * bpi);
    }
    return this.updateViews({
      vertices,
      indices,
      vertexCount: r.vertexCount,
      // A reply without indices on an indexed mesh draws nothing until the next one.
      indexCount: r.indexCount ?? (this.indexBuffer ? 0 : undefined),
      bounds: r.bounds,
    });
  }

  private updateViews(u: MeshUpdate): boolean {
    let grew = false;
    this.revision++;
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
      if (!u.bounds && this.autoBounds) this.computeBounds(u.vertices, count);
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
    if (u.bounds) {
      const b = this.bounds;
      const c = u.bounds.center;
      b.center[0] = c[0];
      b.center[1] = c[1];
      b.center[2] = c[2];
      b.radius = u.bounds.radius;
    }
    if (grew) this.growths++;
    return grew;
  }

  /**
   * Bounding sphere of the first `count` vertices of `view` in this layout: the centre of their
   * axis-aligned box, the radius the farthest vertex from it. 2D positions have z = 0.
   */
  private computeBounds(view: ArrayBufferView, count: number): void {
    const b = this.bounds;
    if (count === 0) {
      b.center[0] = 0;
      b.center[1] = 0;
      b.center[2] = 0;
      b.radius = 0;
      return;
    }
    const floats = this.layout.floats;
    const f =
      view instanceof Float32Array
        ? view
        : new Float32Array(view.buffer, view.byteOffset, count * floats);
    const has3 = this.pos3;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    const end = count * floats;
    for (let o = 0; o < end; o += floats) {
      const x = f[o]!;
      const y = f[o + 1]!;
      const z = has3 ? f[o + 2]! : 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    let r2 = 0;
    for (let o = 0; o < end; o += floats) {
      const dx = f[o]! - cx;
      const dy = f[o + 1]! - cy;
      const dz = (has3 ? f[o + 2]! : 0) - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    b.center[0] = cx;
    b.center[1] = cy;
    b.center[2] = cz;
    b.radius = Math.sqrt(r2);
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
    this.revision++;
    this.vertexBuffer.destroy();
    this.indexBuffer?.destroy();
  }

  private makeVertexBuffer(count: number): GPUBuffer {
    return this.device.createBuffer({
      label: `${this.label}-vb`,
      size: count * this.layout.stride,
      // COPY_SRC: the renderer copies small meshes into its pool for merged runs.
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  }

  private makeIndexBuffer(count: number): GPUBuffer {
    const bytes = count * (this.indexFormat === 'uint32' ? 4 : 2);
    return this.device.createBuffer({
      label: `${this.label}-ib`,
      size: Math.ceil(bytes / 4) * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  }
}

/** Does the layout's position attribute (shader location 0) carry three components? */
function positionHasZ(layout: VertexLayout): boolean {
  for (const a of layout.buffer.attributes) {
    if (a.shaderLocation === 0) return a.format === 'float32x3' || a.format === 'float32x4';
  }
  return false;
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
