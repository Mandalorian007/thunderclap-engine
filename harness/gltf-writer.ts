/**
 * A tiny GLB writer for the glTF demo page (harness/gltf.html): builds the sample scene in the
 * browser so the page needs no asset files. Not engine code; the engine only parses. The default
 * scene is the one `src/assets/gltf.test.ts` builds: a textured cube placed by a `matrix` node
 * and an untextured plane (no normals, no uv, no indices) placed by a TRS node. `buildPbrGlb`
 * is the `?pbr` scene: every material slot, tangents, a texture transform and a skinned mesh.
 * The ws/assets-3 builders at the end (`buildQuantGlb`, `buildMeshoptGlbs`, `buildLightsGlb`,
 * `buildVariantsGlb`, `buildCacheGlb`) feed harness/gltf3.html.
 */

import { encodeIndexBuffer, encodeVertexBuffer } from './gltf3-encode';

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
  normalized?: boolean;
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
    this.json.bufferViews.push({
      buffer: 0,
      byteOffset: 0,
      byteLength: bytes.byteLength,
    });
    return this.json.bufferViews.length - 1;
  }

  floats(
    data: number[],
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4',
    minMax = true,
  ): number {
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
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

  /** `JOINTS_0`: four joint bytes per vertex. */
  joints8(data: number[]): number {
    const bv = this.view(new Uint8Array(data));
    this.json.accessors.push({
      bufferView: bv,
      componentType: 5121,
      count: data.length / 4,
      type: 'VEC4',
    });
    return this.json.accessors.length - 1;
  }

  /** An accessor over raw `bytes` of any component type (quantized attributes; `stride` pads). */
  typed(
    bytes: Uint8Array,
    componentType: number,
    count: number,
    type: string,
    extra: { normalized?: boolean; stride?: number; min?: number[]; max?: number[] } = {},
  ): number {
    const { stride, ...rest } = extra;
    const bv = this.view(bytes);
    if (stride !== undefined) {
      (this.json.bufferViews[bv] as { byteStride?: number }).byteStride = stride;
    }
    this.json.accessors.push({ bufferView: bv, componentType, count, type, ...rest });
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

// ---------------------------------------------------------------- PBR scene (?pbr)

/** The metallic-roughness grid: 3 columns of roughness × 3 rows of metallic. */
export const PBR_ROUGHNESS = [0.1, 0.5, 1] as const;
export const PBR_METALLIC = [0, 0.5, 1] as const;
export const PBR_SPHERE_RADIUS = 0.42;
/** Sphere (column c, row r) centre. */
export function pbrSphereCenter(c: number, r: number): [number, number, number] {
  return [-5.5 + c, 0.5 + r, 0];
}
export const PBR_TILE_CENTER = [-1.3, 1.5, 0] as const;
export const PBR_GLOW_CENTER = [1.6, 3.2, 0] as const;
/** Empty space just below the glowing strip (between it and the transformed quad). */
export const PBR_GLOW_SURROUND = [1.6, 2.6, 0] as const;
export const PBR_SHIFTED_CENTER = [1.6, 1.2, 0] as const;
export const PBR_CYLINDER_X = 4.5;
export const PBR_CYLINDER_BASE_Y = 0.3;
export const PBR_CYLINDER_HEIGHT = 2;
/** The metallic-roughness map: R unused, G roughness by column, B metallic by row. */
function metalRoughMap(): Uint8Array {
  const rgba = new Uint8Array(9 * 4);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const o = (r * 3 + c) * 4;
      rgba[o] = 255;
      rgba[o + 1] = Math.round(PBR_ROUGHNESS[c]! * 255);
      rgba[o + 2] = Math.round(PBR_METALLIC[r]! * 255);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** A 32×32 tangent-space normal map: a dome bump in the middle, flat elsewhere (+Y up). */
function bumpNormalMap(): Uint8Array {
  const n = 32;
  const rgba = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Image y runs down, so "up" in the image is -y here.
      const dx = (x + 0.5) / n - 0.5;
      const dy = 0.5 - (y + 0.5) / n;
      const d2 = (dx * dx + dy * dy) / (0.4 * 0.4);
      let nx = 0;
      let ny = 0;
      let nz = 1;
      if (d2 < 1) {
        const k = Math.sqrt(d2);
        const slope = Math.sin(k * Math.PI) * 0.85;
        nx = k > 0 ? (dx / k) * slope : 0;
        ny = k > 0 ? (dy / k) * slope : 0;
        nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      }
      const o = (y * n + x) * 4;
      rgba[o] = Math.round((nx * 0.5 + 0.5) * 255);
      rgba[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgba[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** The emissive strip's map: an even orange. */
export const PBR_GLOW_RGB = [255, 160, 40] as const;
function glowMap(): Uint8Array {
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) rgba.set([...PBR_GLOW_RGB, 255], i * 4);
  return rgba;
}

/** Horizontal stripes for the cylinder's base colour (sRGB) and its occlusion (R only). */
function stripes(a: readonly number[], b: readonly number[]): Uint8Array {
  const n = 8;
  const rgba = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) rgba.set(y & 1 ? a : b, (y * n + x) * 4);
  }
  return rgba;
}

/** A UV sphere whose every vertex carries the same uv (so one texel colours it). */
function sphere(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  u: number,
  v: number,
  base: number,
  out: { pos: number[]; nrm: number[]; uv: number[]; idx: number[] },
): void {
  const rings = 12;
  const segs = 18;
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const y = Math.cos(phi);
    const s = Math.sin(phi);
    for (let g = 0; g <= segs; g++) {
      const th = (g / segs) * Math.PI * 2;
      const x = Math.cos(th) * s;
      const z = Math.sin(th) * s;
      out.pos.push(cx + x * radius, cy + y * radius, cz + z * radius);
      out.nrm.push(x, y, z);
      out.uv.push(u, v);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let g = 0; g < segs; g++) {
      const a = base + r * (segs + 1) + g;
      const b = a + segs + 1;
      out.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/** A quad facing +z: u along +x, v down (image rows), tangent +x with w = +1 (bitangent = image up). */
function quad(
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
): {
  pos: number[];
  nrm: number[];
  uv: number[];
  tan: number[];
  idx: number[];
} {
  const hw = w / 2;
  const hh = h / 2;
  return {
    pos: [cx - hw, cy - hh, cz, cx + hw, cy - hh, cz, cx + hw, cy + hh, cz, cx - hw, cy + hh, cz],
    nrm: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uv: [0, 1, 1, 1, 1, 0, 0, 0],
    tan: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
    idx: [0, 1, 2, 0, 2, 3],
  };
}

/** A vertical cylinder in world space, weighted between joint 0 (base) and joint 1 (half way up). */
function cylinder(): {
  pos: number[];
  nrm: number[];
  uv: number[];
  joints: number[];
  weights: number[];
  idx: number[];
} {
  const segs = 16;
  const rings = 8;
  const radius = 0.3;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const y = PBR_CYLINDER_BASE_Y + t * PBR_CYLINDER_HEIGHT;
    // The tip joint sits half way up; the weight ramps over the middle third.
    const w1 = Math.min(1, Math.max(0, (t - 0.33) / 0.34));
    for (let g = 0; g <= segs; g++) {
      const th = (g / segs) * Math.PI * 2;
      const x = Math.cos(th);
      const z = Math.sin(th);
      pos.push(PBR_CYLINDER_X + x * radius, y, z * radius);
      nrm.push(x, 0, z);
      uv.push(g / segs, 1 - t);
      joints.push(0, 1, 0, 0);
      weights.push(1 - w1, w1, 0, 0);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let g = 0; g < segs; g++) {
      const a = r * (segs + 1) + g;
      const b = a + segs + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return { pos, nrm, uv, joints, weights, idx };
}

/** Column-major translation matrix (glTF `MAT4`). */
function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/**
 * The `?pbr` scene: five materials over six images. A 3×3 sphere grid reads metallic and
 * roughness from one map (material `spheres`); a tile with a base colour and a normal map
 * carries `TANGENT` and `TEXCOORD_1` (`tile`); a black strip glows through an emissive map ×
 * `KHR_materials_emissive_strength` 2 (`glow`); a quad reuses the checker with a
 * `KHR_texture_transform` (`shifted`); a two-bone cylinder with stripes and an occlusion map is
 * skinned and animated (`skinned`, skin `arm`, clip `wave`).
 */
export function buildPbrGlb(): ArrayBuffer {
  const w = new GlbWriter();
  const grid = {
    pos: [] as number[],
    nrm: [] as number[],
    uv: [] as number[],
    idx: [] as number[],
  };
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const [x, y, z] = pbrSphereCenter(c, r);
      sphere(x, y, z, PBR_SPHERE_RADIUS, (c + 0.5) / 3, (r + 0.5) / 3, grid.pos.length / 3, grid);
    }
  }
  const spheres = {
    attributes: {
      POSITION: w.floats(grid.pos, 'VEC3'),
      NORMAL: w.floats(grid.nrm, 'VEC3', false),
      TEXCOORD_0: w.floats(grid.uv, 'VEC2', false),
    },
    indices: w.indices16(grid.idx),
    material: 0,
  };
  const t = quad(PBR_TILE_CENTER[0], PBR_TILE_CENTER[1], PBR_TILE_CENTER[2], 2, 2);
  const tile = {
    attributes: {
      POSITION: w.floats(t.pos, 'VEC3'),
      NORMAL: w.floats(t.nrm, 'VEC3', false),
      TEXCOORD_0: w.floats(t.uv, 'VEC2', false),
      TEXCOORD_1: w.floats(
        t.uv.map((x) => x * 2),
        'VEC2',
        false,
      ),
      TANGENT: w.floats(t.tan, 'VEC4', false),
    },
    indices: w.indices16(t.idx),
    material: 1,
  };
  const g = quad(PBR_GLOW_CENTER[0], PBR_GLOW_CENTER[1], PBR_GLOW_CENTER[2], 2, 0.3);
  const glow = {
    attributes: {
      POSITION: w.floats(g.pos, 'VEC3'),
      NORMAL: w.floats(g.nrm, 'VEC3', false),
      TEXCOORD_0: w.floats(g.uv, 'VEC2', false),
    },
    indices: w.indices16(g.idx),
    material: 2,
  };
  const sh = quad(PBR_SHIFTED_CENTER[0], PBR_SHIFTED_CENTER[1], PBR_SHIFTED_CENTER[2], 1.5, 1.5);
  const shifted = {
    attributes: {
      POSITION: w.floats(sh.pos, 'VEC3'),
      NORMAL: w.floats(sh.nrm, 'VEC3', false),
      TEXCOORD_0: w.floats(sh.uv, 'VEC2', false),
    },
    indices: w.indices16(sh.idx),
    material: 3,
  };
  const cy = cylinder();
  const skinned = {
    attributes: {
      POSITION: w.floats(cy.pos, 'VEC3'),
      NORMAL: w.floats(cy.nrm, 'VEC3', false),
      TEXCOORD_0: w.floats(cy.uv, 'VEC2', false),
      JOINTS_0: w.joints8(cy.joints),
      WEIGHTS_0: w.floats(cy.weights, 'VEC4', false),
    },
    indices: w.indices16(cy.idx),
    material: 4,
  };
  const tipY = PBR_CYLINDER_BASE_Y + PBR_CYLINDER_HEIGHT / 2;
  const inverseBind = w.floats(
    [
      ...translation(-PBR_CYLINDER_X, -PBR_CYLINDER_BASE_Y, 0),
      ...translation(-PBR_CYLINDER_X, -tipY, 0),
    ],
    'MAT4',
    false,
  );
  const swing = 0.6;
  const q = (a: number) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
  const times = w.floats([0, 1, 2], 'SCALAR');
  const rotations = w.floats([...q(-swing), ...q(swing), ...q(-swing)], 'VEC4', false);
  const image = (name: string, size: number, rgba: Uint8Array) => ({
    name,
    bufferView: w.view(encodePng(size, size, rgba)),
    mimeType: 'image/png',
  });
  Object.assign(w.json, {
    extensionsUsed: ['KHR_texture_transform', 'KHR_materials_emissive_strength'],
    meshes: [
      { name: 'spheres', primitives: [spheres] },
      { name: 'tile', primitives: [tile] },
      { name: 'glow', primitives: [glow] },
      { name: 'shifted', primitives: [shifted] },
      { name: 'cylinder', primitives: [skinned] },
    ],
    images: [
      image('checker', CHECKER_SIZE, checker()),
      image('metalRough', 3, metalRoughMap()),
      image('bump', 32, bumpNormalMap()),
      image('glow', 4, glowMap()),
      image('stripes', 8, stripes([230, 225, 210, 255], [40, 90, 200, 255])),
      image('occlusion', 8, stripes([255, 255, 255, 255], [60, 60, 60, 255])),
    ],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
    textures: [
      { source: 0, sampler: 0 },
      { source: 1 },
      { source: 2 },
      { source: 3 },
      { source: 4, sampler: 0 },
      { source: 5 },
    ],
    materials: [
      {
        name: 'spheres',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 0.76, 0.3, 1],
          metallicFactor: 1,
          roughnessFactor: 1,
          metallicRoughnessTexture: { index: 1 },
        },
      },
      {
        name: 'tile',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 0.6,
        },
        normalTexture: { index: 2, scale: 1 },
      },
      {
        name: 'glow',
        pbrMetallicRoughness: {
          baseColorFactor: [0, 0, 0, 1],
          metallicFactor: 0,
        },
        emissiveTexture: { index: 3 },
        emissiveFactor: [1, 1, 1],
        extensions: {
          KHR_materials_emissive_strength: { emissiveStrength: 2 },
        },
      },
      {
        name: 'shifted',
        pbrMetallicRoughness: {
          baseColorTexture: {
            index: 0,
            extensions: {
              KHR_texture_transform: {
                offset: [0.25, 0.1],
                rotation: Math.PI / 6,
                scale: [2, 2],
              },
            },
          },
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
        doubleSided: true,
      },
      {
        name: 'skinned',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 4 },
          metallicFactor: 0,
          roughnessFactor: 0.7,
        },
        occlusionTexture: { index: 5 },
      },
    ],
    skins: [
      {
        name: 'arm',
        joints: [5, 6],
        skeleton: 5,
        inverseBindMatrices: inverseBind,
      },
    ],
    animations: [
      {
        name: 'wave',
        samplers: [{ input: times, output: rotations, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 6, path: 'rotation' } }],
      },
    ],
    nodes: [
      { name: 'spheres', mesh: 0 },
      { name: 'tile', mesh: 1 },
      { name: 'glow', mesh: 2 },
      { name: 'shifted', mesh: 3 },
      { name: 'cylinder', mesh: 4, skin: 0 },
      {
        name: 'root',
        translation: [PBR_CYLINDER_X, PBR_CYLINDER_BASE_Y, 0],
        children: [6],
      },
      { name: 'tip', translation: [0, PBR_CYLINDER_HEIGHT / 2, 0] },
    ],
    scenes: [{ nodes: [0, 1, 2, 3, 4, 5] }],
    scene: 0,
  });
  return w.finish();
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
  const planePrim = {
    attributes: { POSITION: w.floats(planePos, 'VEC3', false) },
    material: 1,
  };
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
      {
        name: 'checkered',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
      },
      {
        name: 'moss',
        pbrMetallicRoughness: {
          baseColorFactor: [0.2, 0.6, 0.3, 1],
          metallicFactor: 0,
        },
        doubleSided: true,
      },
    ],
    nodes: [
      {
        name: 'cube',
        mesh: 0,
        matrix: [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, cx, cy, cz, 1],
      },
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

// ---------------------------------------------------------------- ws/assets-3 (harness/gltf3)

/** A GLB from a JSON object and its BIN chunk; the JSON's `buffers[0]` must describe the chunk. */
export function packGlb(json: unknown, bin: Uint8Array): ArrayBuffer {
  const binLength = Math.ceil(bin.byteLength / 4) * 4;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
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

/** `?quant`: the two cubes sit at ∓`QUANT_CUBE_X` (quantized left, float right), side 1. */
export const QUANT_CUBE_X = 1.1;
export const QUANT_CUBE_Y = 0.5;
export const QUANT_BASE_COLOR = [0.85, 0.45, 0.15, 1] as const;

/**
 * `?quant`: one GLB, two nodes drawing the same unit cube. Mesh 0 is `KHR_mesh_quantization`:
 * normalized SHORT positions (±32767 = ±1, the node's scale 0.5 brings them back to ±0.5, 8-byte
 * stride), normalized BYTE normals (4-byte stride) and normalized USHORT uvs, with min / max as
 * the raw integers gltfpack writes. Mesh 1 is the float twin.
 */
export function buildQuantGlb(): ArrayBuffer {
  const w = new GlbWriter();
  const c = cube();
  const n = c.pos.length / 3;
  const pos = new Int16Array(n * 4);
  const nrm = new Int8Array(n * 4);
  const uv = new Uint16Array(n * 2);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      pos[i * 4 + k] = Math.round(c.pos[i * 3 + k]! * 2 * 32767);
      nrm[i * 4 + k] = Math.round(c.nrm[i * 3 + k]! * 127);
    }
    uv[i * 2] = Math.round(c.uv[i * 2]! * 65535);
    uv[i * 2 + 1] = Math.round(c.uv[i * 2 + 1]! * 65535);
  }
  const quant = {
    attributes: {
      POSITION: w.typed(new Uint8Array(pos.buffer), 5122, n, 'VEC3', {
        normalized: true,
        stride: 8,
        min: [-32767, -32767, -32767],
        max: [32767, 32767, 32767],
      }),
      NORMAL: w.typed(new Uint8Array(nrm.buffer), 5120, n, 'VEC3', { normalized: true, stride: 4 }),
      TEXCOORD_0: w.typed(new Uint8Array(uv.buffer), 5123, n, 'VEC2', { normalized: true }),
    },
    indices: w.indices16(c.idx),
    material: 0,
  };
  const float = {
    attributes: {
      POSITION: w.floats(c.pos, 'VEC3'),
      NORMAL: w.floats(c.nrm, 'VEC3'),
      TEXCOORD_0: w.floats(c.uv, 'VEC2'),
    },
    indices: w.indices16(c.idx),
    material: 0,
  };
  Object.assign(w.json, {
    extensionsUsed: ['KHR_mesh_quantization'],
    extensionsRequired: ['KHR_mesh_quantization'],
    meshes: [
      { name: 'quantized', primitives: [quant] },
      { name: 'float', primitives: [float] },
    ],
    materials: [
      {
        name: 'clay',
        pbrMetallicRoughness: {
          baseColorFactor: [...QUANT_BASE_COLOR],
          metallicFactor: 0,
          roughnessFactor: 0.7,
        },
      },
    ],
    nodes: [
      {
        name: 'quantized',
        mesh: 0,
        translation: [-QUANT_CUBE_X, QUANT_CUBE_Y, 0],
        scale: [0.5, 0.5, 0.5],
      },
      { name: 'float', mesh: 1, translation: [QUANT_CUBE_X, QUANT_CUBE_Y, 0] },
    ],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
  });
  return w.finish();
}

/** `?meshopt`: a lumpy icosphere (deterministic), radius about `ROCK_RADIUS`, at the origin. */
export const ROCK_RADIUS = 1;

function rock(): { pos: number[]; nrm: number[]; idx: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    return [v[0]! / l, v[1]! / l, v[2]! / l];
  });
  // biome-ignore format: the icosahedron's faces, one triangle per row of three
  let faces = [0,11,5, 0,5,1, 0,1,7, 0,7,10, 0,10,11, 1,5,9, 5,11,4, 11,10,2, 10,7,6, 7,1,8,
    3,9,4, 3,4,2, 3,2,6, 3,6,8, 3,8,9, 4,9,5, 2,4,11, 6,2,10, 8,6,7, 9,8,1];
  for (let level = 0; level < 3; level++) {
    const mid = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const known = mid.get(key);
      if (known !== undefined) return known;
      const p = verts[a]!;
      const q = verts[b]!;
      const m = [(p[0]! + q[0]!) / 2, (p[1]! + q[1]!) / 2, (p[2]! + q[2]!) / 2];
      const l = Math.hypot(m[0]!, m[1]!, m[2]!);
      verts = [...verts, [m[0]! / l, m[1]! / l, m[2]! / l]];
      mid.set(key, verts.length - 1);
      return verts.length - 1;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f]!;
      const b = faces[f + 1]!;
      const c = faces[f + 2]!;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  const pos: number[] = [];
  for (const [x, y, z] of verts) {
    const r =
      ROCK_RADIUS *
      (1 + 0.16 * Math.sin(3 * x! + 1) * Math.sin(4 * y! + 2) * Math.sin(5 * z! + 0.5));
    pos.push(x! * r, y! * r * 0.8, z! * r);
  }
  const nrm = new Array<number>(pos.length).fill(0);
  for (let f = 0; f < faces.length; f += 3) {
    const [a, b, c] = [faces[f]! * 3, faces[f + 1]! * 3, faces[f + 2]! * 3];
    const e1 = [pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!];
    const e2 = [pos[c]! - pos[a]!, pos[c + 1]! - pos[a + 1]!, pos[c + 2]! - pos[a + 2]!];
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) nrm[v + k]! += n[k]!;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i]!, nrm[i + 1]!, nrm[i + 2]!) || 1;
    nrm[i]! /= l;
    nrm[i + 1]! /= l;
    nrm[i + 2]! /= l;
  }
  return { pos, nrm, idx: faces };
}

export const ROCK_BASE_COLOR = [0.55, 0.5, 0.45, 1] as const;

/**
 * `?meshopt`: the rock twice. `plain` is a float GLB (interleaved position + normal, 24-byte
 * stride, u16 indices); `packed` stores the same views through `EXT_meshopt_compression`
 * (`ATTRIBUTES` for the vertices, `TRIANGLES` for the indices) in the BIN chunk, against a
 * fallback buffer with no data.
 */
export function buildMeshoptGlbs(): { plain: ArrayBuffer; packed: ArrayBuffer } {
  const r = rock();
  const count = r.pos.length / 3;
  const verts = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      verts[i * 6 + k] = r.pos[i * 3 + k]!;
      verts[i * 6 + 3 + k] = r.nrm[i * 3 + k]!;
    }
  }
  const vBytes = new Uint8Array(verts.buffer);
  const iBytes = new Uint8Array(new Uint16Array(r.idx).buffer);
  const iAt = vBytes.byteLength;
  const rawLength = iAt + Math.ceil(iBytes.byteLength / 4) * 4;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, verts[i * 6 + k]!);
      max[k] = Math.max(max[k]!, verts[i * 6 + k]!);
    }
  }
  const base = {
    asset: { version: '2.0', generator: 'thunderclap-harness' },
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: r.idx.length, type: 'SCALAR' },
    ],
    meshes: [
      {
        name: 'rock',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
      },
    ],
    materials: [
      {
        name: 'stone',
        pbrMetallicRoughness: {
          baseColorFactor: [...ROCK_BASE_COLOR],
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
      },
    ],
    nodes: [{ name: 'rock', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const plainBin = new Uint8Array(rawLength);
  plainBin.set(vBytes);
  plainBin.set(iBytes, iAt);
  const plain = packGlb(
    {
      ...base,
      buffers: [{ byteLength: rawLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: vBytes.byteLength, byteStride: 24 },
        { buffer: 0, byteOffset: iAt, byteLength: iBytes.byteLength },
      ],
    },
    plainBin,
  );
  const vEnc = encodeVertexBuffer(vBytes, count, 24);
  const iEnc = encodeIndexBuffer(r.idx);
  const vLen = Math.ceil(vEnc.byteLength / 4) * 4;
  const packedBin = new Uint8Array(vLen + iEnc.byteLength);
  packedBin.set(vEnc);
  packedBin.set(iEnc, vLen);
  const packed = packGlb(
    {
      ...base,
      extensionsUsed: ['EXT_meshopt_compression'],
      extensionsRequired: ['EXT_meshopt_compression'],
      buffers: [
        { byteLength: Math.ceil(packedBin.byteLength / 4) * 4 },
        { byteLength: rawLength, extensions: { EXT_meshopt_compression: { fallback: true } } },
      ],
      bufferViews: [
        {
          buffer: 1,
          byteOffset: 0,
          byteLength: vBytes.byteLength,
          byteStride: 24,
          extensions: {
            EXT_meshopt_compression: {
              buffer: 0,
              byteOffset: 0,
              byteLength: vEnc.byteLength,
              byteStride: 24,
              count,
              mode: 'ATTRIBUTES',
            },
          },
        },
        {
          buffer: 1,
          byteOffset: iAt,
          byteLength: iBytes.byteLength,
          extensions: {
            EXT_meshopt_compression: {
              buffer: 0,
              byteOffset: vLen,
              byteLength: iEnc.byteLength,
              byteStride: 2,
              count: r.idx.length,
              mode: 'TRIANGLES',
            },
          },
        },
      ],
    },
    packedBin,
  );
  return { plain, packed };
}

/** `?lights`: where the file's point (red) and spot (blue) lights stand, and the ground's half size. */
export const LIGHTS_POINT_AT = [-1.8, 0.5, 0.6] as const;
export const LIGHTS_SPOT_AT = [1.8, 2.4, 0.6] as const;
export const LIGHTS_GROUND_HALF = 5;

/**
 * `?lights`: a grey ground and a cube lit only by the file's `KHR_lights_punctual` lights (a dim
 * directional, a red point light low over the ground on the left, a blue spot pointing straight
 * down on the right), seen through the file's own perspective camera.
 */
export function buildLightsGlb(): ArrayBuffer {
  const w = new GlbWriter();
  const c = cube();
  const h = LIGHTS_GROUND_HALF;
  const ground = {
    attributes: {
      POSITION: w.floats([-h, 0, h, h, 0, h, h, 0, -h, -h, 0, -h], 'VEC3'),
      NORMAL: w.floats([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 'VEC3'),
    },
    indices: w.indices16([0, 1, 2, 0, 2, 3]),
    material: 0,
  };
  const box = {
    attributes: { POSITION: w.floats(c.pos, 'VEC3'), NORMAL: w.floats(c.nrm, 'VEC3') },
    indices: w.indices16(c.idx),
    material: 0,
  };
  // Light and camera nodes look down their local -Z; -90° about X points it at -Y.
  const down = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const pitch = -Math.atan2(3, 7);
  Object.assign(w.json, {
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          { name: 'sky', type: 'directional', color: [1, 1, 1], intensity: 0.25 },
          { name: 'ember', type: 'point', color: [1, 0.15, 0.1], intensity: 3, range: 3 },
          {
            name: 'beam',
            type: 'spot',
            color: [0.15, 0.3, 1],
            intensity: 6,
            range: 6,
            spot: { innerConeAngle: 0.25, outerConeAngle: 0.5 },
          },
        ],
      },
    },
    cameras: [
      {
        name: 'view',
        type: 'perspective',
        perspective: { yfov: 0.9, znear: 0.1, zfar: 100 },
      },
    ],
    meshes: [
      { name: 'ground', primitives: [ground] },
      { name: 'box', primitives: [box] },
    ],
    materials: [
      {
        name: 'plaster',
        pbrMetallicRoughness: {
          baseColorFactor: [0.8, 0.8, 0.8, 1],
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
      },
    ],
    nodes: [
      { name: 'ground', mesh: 0 },
      { name: 'box', mesh: 1, translation: [0, 0.5, -0.5] },
      {
        name: 'sky',
        rotation: [-0.3, 0.2, 0, 0.93],
        extensions: { KHR_lights_punctual: { light: 0 } },
      },
      {
        name: 'ember',
        translation: [...LIGHTS_POINT_AT],
        extensions: { KHR_lights_punctual: { light: 1 } },
      },
      {
        name: 'beam',
        translation: [...LIGHTS_SPOT_AT],
        rotation: down,
        extensions: { KHR_lights_punctual: { light: 2 } },
      },
      {
        name: 'eye',
        camera: 0,
        translation: [0, 3, 7],
        rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)],
      },
    ],
    scenes: [{ nodes: [0, 1, 2, 3, 4, 5] }],
    scene: 0,
  });
  return w.finish();
}

/** `?variants`: the variant names and each one's body colour, in file order. */
export const VARIANT_NAMES = ['ember', 'moss', 'tide'] as const;
export const VARIANT_COLORS = [
  [0.9, 0.15, 0.1, 1],
  [0.15, 0.75, 0.2, 1],
  [0.15, 0.3, 0.95, 1],
] as const;
/** The figure's torso centre (world). */
export const VARIANT_BODY_AT = [0, 1.1, 0] as const;

/**
 * `?variants`: a figure (a box torso on two box legs, a sphere head) whose torso and legs carry
 * `KHR_materials_variants` mappings: three variants, each binding one colour material (1..3);
 * with no variant they draw the grey material 0. The head keeps its own material (4).
 */
export function buildVariantsGlb(): ArrayBuffer {
  const w = new GlbWriter();
  const c = cube();
  const head = {
    pos: [] as number[],
    nrm: [] as number[],
    uv: [] as number[],
    idx: [] as number[],
  };
  sphere(0, 0, 0, 0.5, 0.5, 0.5, 0, head);
  const mappings = VARIANT_NAMES.map((_, v) => ({ material: v + 1, variants: [v] }));
  const boxPrim = {
    attributes: { POSITION: w.floats(c.pos, 'VEC3'), NORMAL: w.floats(c.nrm, 'VEC3') },
    indices: w.indices16(c.idx),
    material: 0,
    extensions: { KHR_materials_variants: { mappings } },
  };
  const headPrim = {
    attributes: { POSITION: w.floats(head.pos, 'VEC3'), NORMAL: w.floats(head.nrm, 'VEC3') },
    indices: w.indices16(head.idx),
    material: 4,
  };
  const flat = (name: string, rgba: readonly number[]) => ({
    name,
    pbrMetallicRoughness: { baseColorFactor: [...rgba], metallicFactor: 0, roughnessFactor: 0.8 },
  });
  const [bx, by, bz] = VARIANT_BODY_AT;
  Object.assign(w.json, {
    extensionsUsed: ['KHR_materials_variants'],
    extensions: { KHR_materials_variants: { variants: VARIANT_NAMES.map((name) => ({ name })) } },
    meshes: [
      { name: 'cloth', primitives: [boxPrim] },
      { name: 'head', primitives: [headPrim] },
    ],
    materials: [
      flat('plain', [0.5, 0.5, 0.5, 1]),
      ...VARIANT_NAMES.map((n, i) => flat(n, VARIANT_COLORS[i]!)),
      flat('skin', [0.9, 0.75, 0.6, 1]),
    ],
    nodes: [
      { name: 'torso', mesh: 0, translation: [bx, by, bz], scale: [0.9, 0.9, 0.5] },
      { name: 'leg.l', mesh: 0, translation: [bx - 0.25, by - 0.8, bz], scale: [0.3, 0.7, 0.3] },
      { name: 'leg.r', mesh: 0, translation: [bx + 0.25, by - 0.8, bz], scale: [0.3, 0.7, 0.3] },
      { name: 'head', mesh: 1, translation: [bx, by + 0.85, bz], scale: [0.7, 0.7, 0.7] },
    ],
    scenes: [{ nodes: [0, 1, 2, 3] }],
    scene: 0,
  });
  return w.finish();
}

/** `?cache`: how many assets the page loads, and where asset `i`'s cube stands (x). */
export const CACHE_ASSETS = 10;
export function cacheAssetX(i: number): number {
  return (i - (CACHE_ASSETS - 1) / 2) * 0.9;
}

/** `?cache`: asset `i`, a small cube at `cacheAssetX(i)` in a hue of its own. */
export function buildCacheGlb(i: number): ArrayBuffer {
  const w = new GlbWriter();
  const c = cube();
  const hue = (i / CACHE_ASSETS) * Math.PI * 2;
  const rgb = [0, 2, 4].map((o) => 0.55 + 0.4 * Math.cos(hue - (o * Math.PI) / 3));
  Object.assign(w.json, {
    meshes: [
      {
        name: `asset-${i}`,
        primitives: [
          {
            attributes: { POSITION: w.floats(c.pos, 'VEC3'), NORMAL: w.floats(c.nrm, 'VEC3') },
            indices: w.indices16(c.idx),
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: `hue-${i}`,
        pbrMetallicRoughness: {
          baseColorFactor: [...rgb, 1],
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
      },
    ],
    nodes: [
      {
        name: `asset-${i}`,
        mesh: 0,
        translation: [cacheAssetX(i), 0.4, 0],
        scale: [0.6, 0.6, 0.6],
      },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
  });
  return w.finish();
}
