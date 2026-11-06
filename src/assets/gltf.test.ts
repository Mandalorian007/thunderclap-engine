import { describe, expect, it } from 'vitest';
import { composeTrs, decodeDataUri, GltfError, type GltfJson, parseGltf } from './gltf';

// ---------------------------------------------------------------- a tiny GLB writer

interface BinPart {
  bytes: Uint8Array;
  /** Set when written: offset into the BIN chunk. */
  offset?: number;
}

/** Collects buffer views into one BIN chunk (4-byte aligned) and emits the GLB. */
class GlbWriter {
  readonly json: GltfJson = {
    asset: { version: '2.0' },
    accessors: [],
    bufferViews: [],
    buffers: [],
    meshes: [],
    nodes: [],
    materials: [],
    textures: [],
    images: [],
    scenes: [],
  };
  private readonly parts: BinPart[] = [];

  view(bytes: Uint8Array, byteStride?: number): number {
    const part: BinPart = { bytes };
    this.parts.push(part);
    this.json.bufferViews!.push({
      buffer: 0,
      byteOffset: 0,
      byteLength: bytes.byteLength,
      ...(byteStride ? { byteStride } : {}),
    });
    return this.json.bufferViews!.length - 1;
  }

  accessor(a: GltfJson['accessors'] extends (infer T)[] | undefined ? T : never): number {
    this.json.accessors!.push(a);
    return this.json.accessors!.length - 1;
  }

  /** A float accessor in its own tightly packed view, with min/max. */
  floats(data: number[], type: 'VEC2' | 'VEC3' | 'VEC4', minMax = true): number {
    const n = { VEC2: 2, VEC3: 3, VEC4: 4 }[type];
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
    return this.accessor({
      bufferView: bv,
      componentType: 5126,
      count,
      type,
      ...(minMax ? { min, max } : {}),
    });
  }

  indices16(data: number[]): number {
    const u = new Uint16Array(data);
    const bv = this.view(new Uint8Array(u.buffer));
    return this.accessor({
      bufferView: bv,
      componentType: 5123,
      count: data.length,
      type: 'SCALAR',
    });
  }

  finish(): ArrayBuffer {
    let binLength = 0;
    for (const p of this.parts) {
      p.offset = binLength;
      binLength += Math.ceil(p.bytes.byteLength / 4) * 4;
    }
    this.json.bufferViews!.forEach((bv, i) => {
      bv.byteOffset = this.parts[i]!.offset;
    });
    this.json.buffers = [{ byteLength: binLength }];
    const bin = new Uint8Array(binLength);
    for (const p of this.parts) bin.set(p.bytes, p.offset!);
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

const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Rotation of 90° about +Y as a quaternion. */
const ROT_Y90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

/**
 * Two nodes: a textured cube placed by a `matrix` (scale 1.5, up 0.75) and an untextured plane
 * (no normals, no uv, no indices) placed by TRS (rotated 90° about Y, scaled 8×1×8).
 */
function sampleGlb(): { glb: ArrayBuffer; w: GlbWriter } {
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
  // The plane as 2 triangles, 6 unindexed vertices, in the XZ plane facing +Y (CCW from above).
  const planePos = [
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, -0.5,
  ];
  const planePrim = {
    attributes: { POSITION: w.floats(planePos, 'VEC3', false) },
    material: 1,
  };
  w.json.meshes = [
    { name: 'cube', primitives: [cubePrim] },
    { name: 'plane', primitives: [planePrim] },
  ];
  w.json.images = [{ name: 'checker', bufferView: w.view(FAKE_PNG), mimeType: 'image/png' }];
  w.json.textures = [{ source: 0, sampler: 0 }];
  w.json.samplers = [{ magFilter: 9728, wrapS: 33071, wrapT: 10497 }];
  w.json.materials = [
    {
      name: 'checkered',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 0.5, 0.25, 1] },
    },
    {
      name: 'moss',
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.6, 0.3, 1] },
      doubleSided: true,
      alphaMode: 'MASK',
      alphaCutoff: 0.3,
    },
  ];
  // Column-major: scale 1.5 and translate (0, 0.75, 0).
  w.json.nodes = [
    { name: 'cube', mesh: 0, matrix: [1.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1.5, 0, 0, 0.75, 0, 1] },
    { name: 'plane', mesh: 1, translation: [0, 0, 0], rotation: ROT_Y90, scale: [8, 1, 8] },
  ];
  w.json.scenes = [{ nodes: [0, 1] }];
  w.json.scene = 0;
  return { glb: w.finish(), w };
}

// ---------------------------------------------------------------- tests

describe('parseGltf (GLB)', () => {
  const { glb } = sampleGlb();
  const doc = parseGltf(glb);

  it('reads the container, scene and node hierarchy', () => {
    expect(doc.version).toBe('2.0');
    expect(doc.scene).toEqual([0, 1]);
    expect(doc.sceneNodes).toEqual([0, 1]);
    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes[0]!.name).toBe('cube');
    expect(doc.nodes[0]!.mesh).toBe(0);
    expect(doc.nodes[0]!.parent).toBeNull();
    expect(doc.nodes[1]!.mesh).toBe(1);
    expect(doc.warnings).toEqual([]);
    expect(doc.externalUris).toEqual([]);
  });

  it('resolves a matrix node to TRS and a 3×4 row-major local matrix', () => {
    const n = doc.nodes[0]!;
    expect([...n.translation]).toEqual([0, 0.75, 0]);
    expect([...n.scale]).toEqual([1.5, 1.5, 1.5]);
    expect([...n.rotation]).toEqual([0, 0, 0, 1]);
    expect([...n.local]).toEqual([1.5, 0, 0, 0, 0, 1.5, 0, 0.75, 0, 0, 1.5, 0]);
    expect([...n.world]).toEqual([...n.local]);
  });

  it('resolves a TRS node to the same matrix Transform would build', () => {
    const n = doc.nodes[1]!;
    const expected = new Float32Array(12);
    composeTrs([0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2], [8, 1, 8], expected);
    expect([...n.local]).toEqual([...expected]);
    // 90° about Y: local +X maps to world -Z, scaled by 8.
    expect(n.local[8]).toBeCloseTo(-8, 5);
    expect(n.local[2]).toBeCloseTo(8, 5);
    expect(n.local[5]).toBeCloseTo(1, 5);
  });

  it('reads the textured cube: positions, normals, uv, indices, material, bounds', () => {
    const p = doc.meshes[0]!.primitives[0]!;
    const c = cube();
    expect(doc.meshes[0]!.name).toBe('cube');
    expect(p.vertexCount).toBe(24);
    expect(p.hadNormals).toBe(true);
    expect([...p.position]).toEqual(c.pos);
    expect([...p.normal]).toEqual(c.nrm);
    expect([...p.uv0]).toEqual(c.uv);
    expect(p.color0).toHaveLength(24 * 4);
    expect(p.color0.every((v) => v === 1)).toBe(true);
    expect(p.indices).toBeInstanceOf(Uint16Array);
    expect([...p.indices]).toEqual(c.idx);
    expect(p.material).toBe(0);
    expect(p.bounds.min).toEqual([-0.5, -0.5, -0.5]);
    expect(p.bounds.max).toEqual([0.5, 0.5, 0.5]);
    expect(p.bounds.center).toEqual([0, 0, 0]);
    expect(p.bounds.radius).toBeCloseTo(Math.sqrt(3) / 2, 6);
  });

  it('generates flat normals, zero uv, white colour and indices for the bare plane', () => {
    const p = doc.meshes[1]!.primitives[0]!;
    expect(p.hadNormals).toBe(false);
    expect(p.vertexCount).toBe(6);
    expect([...p.indices]).toEqual([0, 1, 2, 3, 4, 5]);
    for (let i = 0; i < 6; i++) {
      expect([...p.normal.slice(i * 3, i * 3 + 3)].map((v) => v + 0)).toEqual([0, 1, 0]);
    }
    expect(p.uv0.every((v) => v === 0)).toBe(true);
    expect(p.color0.every((v) => v === 1)).toBe(true);
    expect(p.material).toBe(1);
    // No min/max in the file: bounds computed from the data.
    expect(p.bounds.min).toEqual([-0.5, 0, -0.5]);
    expect(p.bounds.max).toEqual([0.5, 0, 0.5]);
  });

  it('reads materials, textures and the embedded image', () => {
    expect(doc.materials).toEqual([
      {
        name: 'checkered',
        baseColorFactor: [1, 0.5, 0.25, 1],
        baseColorTexture: 0,
        texCoord: 0,
        doubleSided: false,
        alphaMode: 'OPAQUE',
        alphaCutoff: 0.5,
      },
      {
        name: 'moss',
        baseColorFactor: [0.2, 0.6, 0.3, 1],
        baseColorTexture: null,
        texCoord: 0,
        doubleSided: true,
        alphaMode: 'MASK',
        alphaCutoff: 0.3,
      },
    ]);
    expect(doc.textures).toEqual([
      { name: null, source: 0, wrapS: 33071, wrapT: 10497, magFilter: 9728 },
    ]);
    const img = doc.images[0]!;
    expect(img.name).toBe('checker');
    expect(img.mimeType).toBe('image/png');
    expect(img.uri).toBeNull();
    expect([...img.bytes!]).toEqual([...FAKE_PNG]);
  });

  it('bounds the whole scene in world space', () => {
    // Cube: ±0.75 around (0, 0.75, 0); plane: ±4 in x and z at y 0.
    expect(doc.bounds.min[0]).toBeCloseTo(-4, 5);
    expect(doc.bounds.max[0]).toBeCloseTo(4, 5);
    expect(doc.bounds.min[1]).toBeCloseTo(0, 5);
    expect(doc.bounds.max[1]).toBeCloseTo(1.5, 5);
    expect(doc.bounds.center[1]).toBeCloseTo(0.75, 5);
    expect(doc.bounds.radius).toBeCloseTo(Math.hypot(8, 1.5, 8) / 2, 5);
  });
});

describe('parseGltf (.gltf JSON)', () => {
  it('decodes data: URI buffers and images, and lists external URIs', () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pos.buffer)));
    const json: GltfJson = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${b64}` }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }, { source: 1 }],
      images: [{ uri: 'textures/wood.jpg' }, { uri: 'data:image/png;base64,AAEC' }],
      nodes: [{ mesh: 0 }],
      extensionsUsed: ['KHR_materials_emissive_strength'],
    };
    const doc = parseGltf({ json });
    expect([...doc.meshes[0]!.primitives[0]!.position]).toEqual([...pos]);
    expect(doc.scene).toEqual([0]);
    expect(doc.externalUris).toEqual(['textures/wood.jpg']);
    expect(doc.images[0]).toEqual({
      name: null,
      bytes: null,
      mimeType: 'image/jpeg',
      uri: 'textures/wood.jpg',
    });
    expect([...doc.images[1]!.bytes!]).toEqual([0, 1, 2]);
    expect(doc.images[1]!.mimeType).toBe('image/png');
    expect(doc.warnings).toEqual(['extension ignored: KHR_materials_emissive_strength']);
    // The same JSON as UTF-8 bytes parses too.
    const text = new TextEncoder().encode(JSON.stringify(json));
    const buf = text.buffer.slice(text.byteOffset, text.byteOffset + text.byteLength);
    expect(parseGltf(buf).externalUris).toEqual(['textures/wood.jpg']);
  });

  it('reads interleaved, normalised integer attributes and resolves a parent chain', () => {
    // One vertex record = position (3 × f32) + colour (4 × u8 normalised) = 16 bytes, stride 16.
    const bin = new ArrayBuffer(16 * 3);
    const dv = new DataView(bin);
    for (let i = 0; i < 3; i++) {
      dv.setFloat32(i * 16, i, true);
      dv.setFloat32(i * 16 + 4, i * 2, true);
      dv.setFloat32(i * 16 + 8, i * 3, true);
      dv.setUint8(i * 16 + 12, 255);
      dv.setUint8(i * 16 + 13, 0);
      dv.setUint8(i * 16 + 14, 51);
      dv.setUint8(i * 16 + 15, 255);
    }
    const json: GltfJson = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 48, uri: 'scene.bin' }],
      bufferViews: [{ buffer: 0, byteLength: 48, byteStride: 16 }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        {
          bufferView: 0,
          byteOffset: 12,
          componentType: 5121,
          normalized: true,
          count: 3,
          type: 'VEC4',
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
      nodes: [
        { name: 'root', translation: [1, 0, 0], children: [1] },
        { name: 'mid', scale: [2, 2, 2], children: [2] },
        { name: 'leaf', translation: [0, 1, 0], mesh: 0 },
      ],
    };
    const doc = parseGltf({ json, buffers: [bin] });
    const p = doc.meshes[0]!.primitives[0]!;
    expect([...p.position]).toEqual([0, 0, 0, 1, 2, 3, 2, 4, 6]);
    expect(p.color0[0]).toBe(1);
    expect(p.color0[1]).toBe(0);
    expect(p.color0[2]).toBeCloseTo(0.2, 6);
    expect(p.color0[3]).toBe(1);
    expect(doc.externalUris).toEqual(['scene.bin']);
    expect(doc.scene).toEqual([0]);
    expect(doc.sceneNodes).toEqual([0, 1, 2]);
    expect(doc.nodes[2]!.parent).toBe(1);
    expect(doc.nodes[1]!.parent).toBe(0);
    // leaf world = T(1,0,0) · S(2) · T(0,1,0): translation (1, 2, 0), scale 2.
    expect([...doc.nodes[2]!.world]).toEqual([2, 0, 0, 1, 0, 2, 0, 2, 0, 0, 2, 0]);
    // Scene bounds: the leaf's points (0..2, 0..4, 0..6) scaled by 2 and offset.
    expect(doc.bounds.min).toEqual([1, 2, 0]);
    expect(doc.bounds.max).toEqual([5, 10, 12]);
  });

  it('decodes data URIs', () => {
    expect([...decodeDataUri('data:application/octet-stream;base64,AAEC').bytes]).toEqual([
      0, 1, 2,
    ]);
    expect(decodeDataUri('data:image/png;base64,AAEC').mimeType).toBe('image/png');
    expect([...decodeDataUri('data:,%41B').bytes]).toEqual([0x41, 0x42]);
  });
});

describe('parseGltf errors', () => {
  const minimal = (extra: Partial<GltfJson>): GltfJson => ({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    ...extra,
  });
  const bin = new ArrayBuffer(36);

  it('names what it does not support, as GltfError', () => {
    expect(() => parseGltf(new Uint8Array([1, 2, 3, 255]).buffer)).toThrow(
      /not a GLB \(bad magic\) and not UTF-8 JSON/,
    );
    expect(() => parseGltf({ json: { asset: { version: '1.0' } } })).toThrow(/asset.version "1.0"/);
    expect(() =>
      parseGltf({
        json: minimal({ extensionsRequired: ['KHR_draco_mesh_compression'] }),
        buffers: [bin],
      }),
    ).toThrow(/required extensions not supported: KHR_draco_mesh_compression/);
    expect(() => parseGltf({ json: minimal({}) })).toThrow(
      /buffer 0 has no uri and no GLB BIN chunk/,
    );
    expect(() =>
      parseGltf({ json: minimal({ buffers: [{ byteLength: 36, uri: 'a.bin' }] }) }),
    ).toThrow(/buffer 0 needs external resource "a.bin"/);
    expect(() =>
      parseGltf({
        json: minimal({ meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 1 }] }] }),
        buffers: [bin],
      }),
    ).toThrow(/mesh 0 primitive 0: mode 1 not supported/);
    expect(() =>
      parseGltf({
        json: minimal({
          accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', sparse: {} }],
        }),
        buffers: [bin],
      }),
    ).toThrow(/accessor 0 is sparse/);
    expect(() =>
      parseGltf({
        json: minimal({
          accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }],
        }),
        buffers: [bin],
      }),
    ).toThrow(/runs past its bufferView/);
    expect(() =>
      parseGltf({
        json: minimal({ meshes: [{ primitives: [{ attributes: { NORMAL: 0 } }] }] }),
        buffers: [bin],
      }),
    ).toThrow(/no POSITION attribute/);
    expect(() => parseGltf({ json: minimal({ nodes: [{ mesh: 3 }] }), buffers: [bin] })).toThrow(
      /node 0 names mesh 3/,
    );
    expect(() =>
      parseGltf({
        json: minimal({ nodes: [{ mesh: 0, children: [1] }, { children: [0] }] }),
        buffers: [bin],
      }),
    ).toThrow(/has two parents|cycle/);
    let err: unknown;
    try {
      parseGltf({ json: minimal({}) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GltfError);
    expect((err as Error).name).toBe('GltfError');
    expect((err as Error).message.startsWith('gltf: ')).toBe(true);
  });
});
