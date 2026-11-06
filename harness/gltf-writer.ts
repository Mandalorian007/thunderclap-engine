/**
 * A tiny GLB writer for the glTF demo page (harness/gltf.html): builds the sample scene in the
 * browser so the page needs no asset files. Not engine code; the engine only parses. The scene
 * is the one `src/assets/gltf.test.ts` builds: a textured cube placed by a `matrix` node and an
 * untextured plane (no normals, no uv, no indices) placed by a TRS node.
 */

// ---------------------------------------------------------------- PNG (stored deflate)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode tightly packed RGBA as an uncompressed PNG (one stored deflate block; small images only). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const z = new Uint8Array(2 + 5 + raw.length + 4);
  const zv = new DataView(z.buffer);
  z[0] = 0x78;
  z[1] = 0x01;
  z[2] = 1; // final, stored
  zv.setUint16(3, raw.length, true);
  zv.setUint16(5, ~raw.length & 0xffff, true);
  z.set(raw, 7);
  zv.setUint32(7 + raw.length, adler32(raw));
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', z),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- GLB

interface Accessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

class GlbWriter {
  readonly json: Record<string, unknown> & {
    accessors: Accessor[];
    bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
  } = {
    asset: { version: '2.0', generator: 'thunderclap-harness' },
    accessors: [],
    bufferViews: [],
  };
  private readonly parts: Uint8Array[] = [];

  view(bytes: Uint8Array): number {
    this.parts.push(bytes);
    this.json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength });
    return this.json.bufferViews.length - 1;
  }

  floats(data: number[], type: 'VEC2' | 'VEC3', minMax = true): number {
    const n = type === 'VEC2' ? 2 : 3;
    const f = new Float32Array(data);
    const bv = this.view(new Uint8Array(f.buffer));
    const count = data.length / n;
    const min = Array.from({ length: n }, () => Infinity);
    const max = Array.from({ length: n }, () => -Infinity);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < n; k++) {
        min[k] = Math.min(min[k]!, data[i * n + k]!);
        max[k] = Math.max(max[k]!, data[i * n + k]!);
      }
    }
    this.json.accessors.push({
      bufferView: bv,
      componentType: 5126,
      count,
      type,
      ...(minMax ? { min, max } : {}),
    });
    return this.json.accessors.length - 1;
  }

  indices16(data: number[]): number {
    const u = new Uint16Array(data);
    const bv = this.view(new Uint8Array(u.buffer));
    this.json.accessors.push({
      bufferView: bv,
      componentType: 5123,
      count: data.length,
      type: 'SCALAR',
    });
    return this.json.accessors.length - 1;
  }

  finish(): ArrayBuffer {
    const offsets: number[] = [];
    let binLength = 0;
    for (const p of this.parts) {
      offsets.push(binLength);
      binLength += Math.ceil(p.byteLength / 4) * 4;
    }
    this.json.bufferViews.forEach((bv, i) => {
      bv.byteOffset = offsets[i]!;
    });
    this.json.buffers = [{ byteLength: binLength }];
    const bin = new Uint8Array(binLength);
    this.parts.forEach((p, i) => {
      bin.set(p, offsets[i]!);
    });
    const jsonBytes = new TextEncoder().encode(JSON.stringify(this.json));
    const jsonLength = Math.ceil(jsonBytes.byteLength / 4) * 4;
    const total = 12 + 8 + jsonLength + 8 + binLength;
    const out = new ArrayBuffer(total);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    u8.set(jsonBytes, 20);
    u8.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
    const binAt = 20 + jsonLength;
    dv.setUint32(binAt, binLength, true);
    dv.setUint32(binAt + 4, 0x004e4942, true);
    u8.set(bin, binAt + 8);
    return out;
  }
}

/** Unit cube, 24 vertices (a normal per face), 36 indices; uv per face. */
function cube(): { pos: number[]; nrm: number[]; uv: number[]; idx: number[] } {
  const faces: [number[], number[], number[]][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const [n, r, u] of faces) {
    const base = pos.length / 3;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) pos.push((n[k]! + sx * r[k]! + sy * u[k]!) * 0.5);
      nrm.push(...n);
      uv.push((sx + 1) / 2, (1 - sy) / 2);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nrm, uv, idx };
}

/** The cube's texture: an 8×8 checker of orange and cream, both far from the page's dark clear. */
export const CHECKER_SIZE = 8;
export const CHECKER_A = [255, 140, 20, 255] as const;
export const CHECKER_B = [245, 240, 225, 255] as const;

function checker(): Uint8Array {
  const n = CHECKER_SIZE;
  const rgba = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const c = ((x >> 1) + (y >> 1)) & 1 ? CHECKER_A : CHECKER_B;
      rgba.set(c, (y * n + x) * 4);
    }
  }
  return rgba;
}

/** Where the sample scene puts the cube (its centre) and how big the plane is. */
export const SAMPLE_CUBE_CENTER = [0, 0.75, 0] as const;
export const SAMPLE_CUBE_SCALE = 1.5;
export const SAMPLE_PLANE_SCALE = 8;

/**
 * Two nodes: the textured cube (material 0, a PNG in the BIN chunk) placed by a column-major
 * `matrix`, and a mossy plane with no normals, uv or indices placed by TRS (90° about Y, 8×1×8).
 */
export function buildSampleGlb(): ArrayBuffer {
  const w = new GlbWriter();
  const c = cube();
  const cubePrim = {
    attributes: {
      POSITION: w.floats(c.pos, 'VEC3'),
      NORMAL: w.floats(c.nrm, 'VEC3'),
      TEXCOORD_0: w.floats(c.uv, 'VEC2'),
    },
    indices: w.indices16(c.idx),
    material: 0,
  };
  const planePos = [
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, -0.5,
  ];
  const planePrim = { attributes: { POSITION: w.floats(planePos, 'VEC3', false) }, material: 1 };
  const s = SAMPLE_CUBE_SCALE;
  const [cx, cy, cz] = SAMPLE_CUBE_CENTER;
  Object.assign(w.json, {
    meshes: [
      { name: 'cube', primitives: [cubePrim] },
      { name: 'plane', primitives: [planePrim] },
    ],
    images: [
      {
        name: 'checker',
        bufferView: w.view(encodePng(CHECKER_SIZE, CHECKER_SIZE, checker())),
        mimeType: 'image/png',
      },
    ],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
    textures: [{ source: 0, sampler: 0 }],
    materials: [
      { name: 'checkered', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      {
        name: 'moss',
        pbrMetallicRoughness: { baseColorFactor: [0.2, 0.6, 0.3, 1] },
        doubleSided: true,
      },
    ],
    nodes: [
      { name: 'cube', mesh: 0, matrix: [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, cx, cy, cz, 1] },
      {
        name: 'plane',
        mesh: 1,
        translation: [0, 0, 0],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        scale: [SAMPLE_PLANE_SCALE, 1, SAMPLE_PLANE_SCALE],
      },
    ],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
  });
  return w.finish();
}
