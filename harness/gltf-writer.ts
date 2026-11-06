/**
 * A tiny GLB writer for the glTF demo page (harness/gltf.html): builds the sample scene in the
 * browser so the page needs no asset files. Not engine code; the engine only parses. The default
 * scene is the one `src/assets/gltf.test.ts` builds: a textured cube placed by a `matrix` node
 * and an untextured plane (no normals, no uv, no indices) placed by a TRS node. `buildPbrGlb`
 * is the `?pbr` scene: every material slot, tangents, a texture transform and a skinned mesh.
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
