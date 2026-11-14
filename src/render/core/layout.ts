/**
 * Vertex and instance layouts (D1 §3.2): any byte layout a game declares, packed integer formats
 * included, so an 8-byte vertex (two `u32`s a shader unpacks) is as expressible as a float one.
 * A layout turns into the `GPUVertexBufferLayout` a pipeline needs and the WGSL input fields its
 * shader reads; what the bytes mean is the game's (its `wgslDecode`).
 */

/** One attribute: a WGSL-visible name, a vertex format and its byte offset in the stride. */
export interface LayoutAttribute {
  /** The field name in the generated WGSL input struct. */
  name: string;
  format: GPUVertexFormat;
  offset: number;
}

export interface LayoutDesc {
  /** Bytes per vertex (or per instance); a multiple of 4. */
  stride: number;
  attributes: readonly LayoutAttribute[];
  /**
   * Optional WGSL the game supplies to decode these fields (functions taking the generated
   * input struct). The core only carries it; a shader includes `layout.wgsl`.
   */
  wgslDecode?: string;
}

/** A declared layout, ready for a pipeline. */
export interface BufferLayout {
  readonly stride: number;
  readonly stepMode: GPUVertexStepMode;
  readonly attributes: readonly LayoutAttribute[];
  readonly wgslDecode: string;
  /** The pipeline's buffer layout, with shader locations from `firstLocation` on. */
  buffer(firstLocation: number): GPUVertexBufferLayout;
  /** WGSL struct fields (`@location(n) name: type,` lines) from `firstLocation` on. */
  wgslFields(firstLocation: number): string;
}

/** Bytes and WGSL type of every vertex format. */
const FORMATS: Record<string, [bytes: number, wgsl: string]> = {
  uint8: [1, 'u32'],
  uint8x2: [2, 'vec2u'],
  uint8x4: [4, 'vec4u'],
  sint8: [1, 'i32'],
  sint8x2: [2, 'vec2i'],
  sint8x4: [4, 'vec4i'],
  unorm8: [1, 'f32'],
  unorm8x2: [2, 'vec2f'],
  unorm8x4: [4, 'vec4f'],
  snorm8: [1, 'f32'],
  snorm8x2: [2, 'vec2f'],
  snorm8x4: [4, 'vec4f'],
  'unorm8x4-bgra': [4, 'vec4f'],
  uint16: [2, 'u32'],
  uint16x2: [4, 'vec2u'],
  uint16x4: [8, 'vec4u'],
  sint16: [2, 'i32'],
  sint16x2: [4, 'vec2i'],
  sint16x4: [8, 'vec4i'],
  unorm16: [2, 'f32'],
  unorm16x2: [4, 'vec2f'],
  unorm16x4: [8, 'vec4f'],
  snorm16: [2, 'f32'],
  snorm16x2: [4, 'vec2f'],
  snorm16x4: [8, 'vec4f'],
  float16: [2, 'f32'],
  float16x2: [4, 'vec2f'],
  float16x4: [8, 'vec4f'],
  float32: [4, 'f32'],
  float32x2: [8, 'vec2f'],
  float32x3: [12, 'vec3f'],
  float32x4: [16, 'vec4f'],
  uint32: [4, 'u32'],
  uint32x2: [8, 'vec2u'],
  uint32x3: [12, 'vec3u'],
  uint32x4: [16, 'vec4u'],
  sint32: [4, 'i32'],
  sint32x2: [8, 'vec2i'],
  sint32x3: [12, 'vec3i'],
  sint32x4: [16, 'vec4i'],
  'unorm10-10-10-2': [4, 'vec4f'],
};

/** Bytes a vertex format takes. Throws on an unknown format. */
export function vertexFormatBytes(format: GPUVertexFormat): number {
  const f = FORMATS[format];
  if (!f) throw new Error(`unknown vertex format ${format}`);
  return f[0];
}

function makeLayout(desc: LayoutDesc, stepMode: GPUVertexStepMode, what: string): BufferLayout {
  const { stride } = desc;
  if (!(stride > 0) || stride % 4 !== 0) {
    throw new Error(`${what} layout: stride ${stride} is not a positive multiple of 4`);
  }
  const names = new Set<string>();
  for (const a of desc.attributes) {
    const f = FORMATS[a.format];
    if (!f) throw new Error(`${what} layout: unknown format ${a.format}`);
    if (a.offset < 0 || a.offset + f[0] > stride) {
      throw new Error(
        `${what} layout: ${a.name} (${a.format} at ${a.offset}) past stride ${stride}`,
      );
    }
    if (a.offset % Math.min(4, f[0]) !== 0) {
      throw new Error(`${what} layout: ${a.name} at ${a.offset} is not aligned`);
    }
    if (names.has(a.name)) throw new Error(`${what} layout: ${a.name} declared twice`);
    names.add(a.name);
  }
  const attributes = desc.attributes.map((a) => ({ ...a }));
  return {
    stride,
    stepMode,
    attributes,
    wgslDecode: desc.wgslDecode ?? '',
    buffer(firstLocation) {
      return {
        arrayStride: stride,
        stepMode,
        attributes: attributes.map((a, i) => ({
          format: a.format,
          offset: a.offset,
          shaderLocation: firstLocation + i,
        })),
      };
    },
    wgslFields(firstLocation) {
      return attributes
        .map((a, i) => `@location(${firstLocation + i}) ${a.name}: ${FORMATS[a.format]![1]},`)
        .join('\n  ');
    },
  };
}

/**
 * A per-vertex layout. An 8-byte packed vertex is
 * `createVertexLayout({ stride: 8, attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }] })`.
 */
export function createVertexLayout(desc: LayoutDesc): BufferLayout {
  return makeLayout(desc, 'vertex', 'vertex');
}

/** A per-instance layout (stepped once per instance). */
export function createInstanceLayout(desc: LayoutDesc): BufferLayout {
  return makeLayout(desc, 'instance', 'instance');
}
