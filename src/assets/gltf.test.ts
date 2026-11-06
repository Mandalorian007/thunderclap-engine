import { describe, expect, it } from 'vitest';
import {
  composeTrs,
  decodeDataUri,
  GltfError,
  type GltfJson,
  parseGltf,
  transformUv,
} from './gltf';
import {
  interleaveSkinned,
  SKINNED_JOINTS_OFFSET,
  SKINNED_VERTEX_STRIDE,
  SKINNED_WEIGHTS_OFFSET,
  skeletonFromSkin,
} from './gltf-skin';

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

  /** `JOINTS_0`: 4 unsigned integers per vertex as bytes (5121) or shorts (5123). */
  joints(data: number[], componentType: 5121 | 5123): number {
    const u = componentType === 5121 ? new Uint8Array(data) : new Uint16Array(data);
    const bv = this.view(new Uint8Array(u.buffer));
    return this.accessor({ bufferView: bv, componentType, count: data.length / 4, type: 'VEC4' });
  }

  /** `WEIGHTS_0` as normalised unsigned bytes. */
  weights8(data: number[]): number {
    const u = new Uint8Array(data.map((w) => Math.round(w * 255)));
    const bv = this.view(new Uint8Array(u.buffer));
    return this.accessor({
      bufferView: bv,
      componentType: 5121,
      normalized: true,
      count: data.length / 4,
      type: 'VEC4',
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

/** Rotation of 90° about +Z as a quaternion. */
const ROT_Z90 = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

/** Cubic-spline scale channel: two keys, each (in-tangent, value, out-tangent). */
const SPLINE_SCALE = [0, 0, 0, 1, 1, 1, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5, 2, 2, 2, 0, 0, 0];

/**
 * A two-bone skin: `root` (joint 0, at the origin) → `tip` (joint 1, one unit up), and a `strip`
 * node carrying a skinned quad whose top vertices follow the tip. The second primitive is the
 * same quad without normals or indices (unwelded by the parser). The `wave` animation moves the
 * tip (LINEAR translation), snaps it (STEP rotation) and breathes it (CUBICSPLINE scale).
 */
function skinnedGlb(): { glb: ArrayBuffer; w: GlbWriter } {
  const w = new GlbWriter();
  // Quad in the XY plane: bottom edge at y 0, top edge at y 1, facing +Z.
  const pos = [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0];
  const nrm = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const idx = [0, 1, 2, 0, 2, 3];
  const jnt = [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0];
  const wgt = [1, 0, 0, 0, 1, 0, 0, 0, 0.25, 0.75, 0, 0, 1, 0, 0, 0];
  const welded = {
    attributes: {
      POSITION: w.floats(pos, 'VEC3'),
      NORMAL: w.floats(nrm, 'VEC3'),
      JOINTS_0: w.joints(jnt, 5123),
      WEIGHTS_0: w.floats(wgt, 'VEC4', false),
    },
    indices: w.indices16(idx),
  };
  const bare = {
    attributes: {
      POSITION: w.floats(pos, 'VEC3'),
      JOINTS_0: w.joints(jnt, 5121),
      WEIGHTS_0: w.weights8(wgt),
    },
    indices: w.indices16(idx),
  };
  w.json.meshes = [{ name: 'strip', primitives: [welded, bare] }];
  // Column-major inverse bind: joint 0 identity, joint 1 translates by (0, -1, 0).
  const ibm = [
    ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1],
  ];
  w.json.skins = [
    { name: 'arm', joints: [0, 1], inverseBindMatrices: w.floats(ibm, 'MAT4', false), skeleton: 0 },
  ];
  w.json.nodes = [
    { name: 'root', children: [1], translation: [0, 0, 0] },
    { name: 'tip', translation: [0, 1, 0], rotation: ROT_Z90, scale: [1, 2, 1] },
    { name: 'strip', mesh: 0, skin: 0 },
  ];
  w.json.animations = [
    {
      name: 'wave',
      samplers: [
        {
          input: w.floats([0, 1], 'SCALAR', false),
          output: w.floats([0, 1, 0, 0, 2, 0], 'VEC3', false),
          interpolation: 'LINEAR',
        },
        {
          input: w.floats([0, 0.5, 1], 'SCALAR', false),
          output: w.floats([0, 0, 0, 1, ...ROT_Z90, 0, 0, 1, 0], 'VEC4', false),
          interpolation: 'STEP',
        },
        {
          input: w.floats([0, 1], 'SCALAR', false),
          output: w.floats(SPLINE_SCALE, 'VEC3', false),
          interpolation: 'CUBICSPLINE',
        },
      ],
      channels: [
        { sampler: 0, target: { node: 1, path: 'translation' } },
        { sampler: 1, target: { node: 1, path: 'rotation' } },
        { sampler: 2, target: { node: 1, path: 'scale' } },
      ],
    },
  ];
  w.json.scenes = [{ nodes: [0, 2] }];
  w.json.scene = 0;
  return { glb: w.finish(), w };
}

// ---------------------------------------------------------------- tests

describe('parseGltf (skins and animations)', () => {
  const { glb } = skinnedGlb();
  const doc = parseGltf(glb);

  it('reads the skin: joints, skeleton root and row-major inverse bind matrices', () => {
    expect(doc.skins).toHaveLength(1);
    const s = doc.skins[0]!;
    expect(s.name).toBe('arm');
    expect(s.joints).toEqual([0, 1]);
    expect(s.skeleton).toBe(0);
    expect(s.inverseBind).toHaveLength(24);
    expect([...s.inverseBind.slice(0, 12)]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    // Column-major translation (m[13] = -1) lands in row 1's last column.
    expect([...s.inverseBind.slice(12, 24)]).toEqual([1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0]);
    expect(doc.nodes[2]!.skin).toBe(0);
    expect(doc.nodes[0]!.skin).toBeNull();
    expect(doc.warnings).toEqual([]);
  });

  it('reads JOINTS_0 of any integer type as bytes when they fit, and WEIGHTS_0 as floats', () => {
    const welded = doc.meshes[0]!.primitives[0]!;
    expect(welded.joints).toBeInstanceOf(Uint8Array);
    expect([...welded.joints!]).toEqual([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0]);
    expect([...welded.weights!]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0.25, 0.75, 0, 0, 1, 0, 0, 0]);
    // The bare primitive is unwelded for flat normals; joints and weights follow the indices.
    const bare = doc.meshes[0]!.primitives[1]!;
    expect(bare.hadNormals).toBe(false);
    expect(bare.vertexCount).toBe(6);
    expect(bare.joints).toBeInstanceOf(Uint8Array);
    expect([...bare.joints!.slice(8, 12)]).toEqual([0, 1, 0, 0]); // vertex 2
    expect([...bare.joints!.slice(20, 24)]).toEqual([1, 0, 0, 0]); // vertex 3
    expect(bare.weights![8]).toBeCloseTo(0.25, 2);
    expect(bare.weights![9]).toBeCloseTo(0.75, 2);
    expect(bare.weights![20]).toBe(1);
  });

  it('reads the animation into the AnimationClip shape, values untouched', () => {
    expect(doc.animations).toHaveLength(1);
    const a = doc.animations[0]!;
    expect(a.name).toBe('wave');
    expect(a.duration).toBe(1);
    expect(a.channels).toHaveLength(3);
    const [t, r, s] = a.channels as [
      (typeof a.channels)[0],
      (typeof a.channels)[0],
      (typeof a.channels)[0],
    ];
    expect(t.node).toBe(1);
    expect(t.path).toBe('translation');
    expect(t.interpolation).toBe('LINEAR');
    expect([...t.times]).toEqual([0, 1]);
    expect([...t.values]).toEqual([0, 1, 0, 0, 2, 0]);
    expect(r.path).toBe('rotation');
    expect(r.interpolation).toBe('STEP');
    expect([...r.times]).toEqual([0, 0.5, 1]);
    expect([...r.values]).toEqual([0, 0, 0, 1, ...ROT_Z90.map(Math.fround), 0, 0, 1, 0]);
    expect(s.path).toBe('scale');
    expect(s.interpolation).toBe('CUBICSPLINE');
    expect(s.values).toHaveLength(2 * 3 * 3);
    expect([...s.values]).toEqual(SPLINE_SCALE);
    expect(s.times).toBeInstanceOf(Float32Array);
  });

  it('builds a Skeleton over every node: parents, rest TRS, inverse bind and joint nodes', () => {
    const sk = skeletonFromSkin(doc, 0);
    expect(sk.parents).toBeInstanceOf(Int16Array);
    expect([...sk.parents]).toEqual([-1, 0, -1]);
    expect(sk.rest).toHaveLength(30);
    expect([...sk.rest.slice(0, 10)]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect([...sk.rest.slice(10, 20)]).toEqual([0, 1, 0, ...ROT_Z90.map(Math.fround), 1, 2, 1]);
    expect(sk.inverseBind).toBe(doc.skins[0]!.inverseBind);
    expect(sk.joints).toBeInstanceOf(Uint16Array);
    expect([...sk.joints]).toEqual([0, 1]);
    expect(() => skeletonFromSkin(doc, 1)).toThrow(/skin 1 does not exist/);
  });

  it('interleaves the skinned layout: 12 floats, 4 joint bytes, 4 unorm8 weights per vertex', () => {
    const p = doc.meshes[0]!.primitives[0]!;
    const packed = interleaveSkinned(p);
    expect(packed.layout).toBe('skinned');
    expect(SKINNED_VERTEX_STRIDE).toBe(56);
    expect(packed.vertices.byteLength).toBe(4 * 56);
    const f32 = new Float32Array(packed.vertices);
    const u8 = new Uint8Array(packed.vertices);
    // Vertex 2: position (0.5, 1, 0), normal +Z, uv 0, colour 1.
    expect([...f32.slice(2 * 14, 2 * 14 + 12)]).toEqual([0.5, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1]);
    const j = 2 * 56 + SKINNED_JOINTS_OFFSET;
    expect([...u8.slice(j, j + 4)]).toEqual([0, 1, 0, 0]);
    const wAt = 2 * 56 + SKINNED_WEIGHTS_OFFSET;
    expect([...u8.slice(wAt, wAt + 4)]).toEqual([64, 191, 0, 0]);
    // Every vertex's weights sum to exactly 255.
    for (let i = 0; i < 4; i++) {
      const o = i * 56 + SKINNED_WEIGHTS_OFFSET;
      expect(u8[o]! + u8[o + 1]! + u8[o + 2]! + u8[o + 3]!).toBe(255);
    }
    const unskinned = parseGltf(sampleGlb().glb).meshes[0]!.primitives[0]!;
    expect(() => interleaveSkinned(unskinned)).toThrow(/not skinned/);
  });

  it('keeps JOINTS_0 as shorts above 255 and refuses to pack them', () => {
    const w = new GlbWriter();
    const prim = {
      attributes: {
        POSITION: w.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3'),
        NORMAL: w.floats([0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3'),
        JOINTS_0: w.joints([0, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 5123),
        WEIGHTS_0: w.floats([0.5, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 'VEC4', false),
      },
    };
    w.json.meshes = [{ primitives: [prim] }];
    w.json.nodes = Array.from({ length: 301 }, (_, i) => (i === 0 ? { mesh: 0, skin: 0 } : {}));
    w.json.skins = [{ joints: Array.from({ length: 301 }, (_, i) => i) }];
    const d = parseGltf(w.finish());
    const p = d.meshes[0]!.primitives[0]!;
    expect(p.joints).toBeInstanceOf(Uint16Array);
    expect(p.joints![1]).toBe(300);
    expect(() => interleaveSkinned(p)).toThrow(/above 255/);
    // No inverseBindMatrices: identity per joint.
    expect([...d.skins[0]!.inverseBind.slice(12, 24)]).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
    ]);
    expect(d.skins[0]!.skeleton).toBeNull();
  });

  it('names bad skins, channels and half-skinned primitives', () => {
    const base = (): GltfJson => JSON.parse(JSON.stringify(skinnedGlb().w.json)) as GltfJson;
    const bin = (): ArrayBuffer => {
      const glb = skinnedGlb().glb;
      const dv = new DataView(glb);
      const jsonLength = dv.getUint32(12, true);
      const binAt = 20 + jsonLength;
      return glb.slice(binAt + 8, binAt + 8 + dv.getUint32(binAt, true));
    };
    const parse = (mutate: (j: GltfJson) => void) => {
      const json = base();
      mutate(json);
      return () => parseGltf({ json, buffers: [bin()] });
    };
    expect(parse((j) => (j.skins![0]!.joints = [0, 7]))).toThrow(/skin 0 names joint node 7/);
    expect(parse((j) => (j.skins![0]!.joints = [0]))).toThrow(
      /skin 0: 2 inverse bind matrices for 1 joints/,
    );
    expect(parse((j) => (j.nodes![2]!.skin = 3))).toThrow(/node 2 names skin 3/);
    expect(parse((j) => (j.animations![0]!.channels[0]!.target.path = 'spin'))).toThrow(
      /animation 0 channel 0: path "spin" unknown/,
    );
    expect(parse((j) => (j.animations![0]!.channels[0]!.target.node = 9))).toThrow(
      /channel 0 targets node 9/,
    );
    expect(parse((j) => (j.animations![0]!.samplers[2]!.interpolation = 'LINEAR'))).toThrow(
      /channel 2: 6 output values for 2 keyframes/,
    );
    expect(parse((j) => (j.animations![0]!.samplers[0]!.interpolation = 'CUBICSPLINE'))).toThrow(
      /channel 0: 2 output values for 2 keyframes \(×3 for CUBICSPLINE\)/,
    );
    expect(parse((j) => (j.animations![0]!.samplers[1]!.output = 1))).toThrow(
      /channel 1: rotation output is VEC3, expected 4 components/,
    );
    expect(parse((j) => delete j.meshes![0]!.primitives[0]!.attributes.WEIGHTS_0)).toThrow(
      /JOINTS_0 without WEIGHTS_0/,
    );
    // A channel without a target node is skipped with a warning, not an error.
    const json = base();
    delete json.animations![0]!.channels[1]!.target.node;
    const d = parseGltf({ json, buffers: [bin()] });
    expect(d.animations[0]!.channels).toHaveLength(2);
    expect(d.warnings).toEqual(['animation 0 channel 1 ignored: no target node']);
  });
});

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
    const defaults = {
      metallicFactor: 1,
      roughnessFactor: 1,
      metallicRoughness: null,
      normal: null,
      normalScale: 1,
      occlusion: null,
      occlusionStrength: 1,
      emissive: null,
      emissiveFactor: [0, 0, 0],
    };
    expect(doc.materials).toEqual([
      {
        ...defaults,
        name: 'checkered',
        baseColorFactor: [1, 0.5, 0.25, 1],
        baseColor: { index: 0, texCoord: 0, transform: null },
        baseColorTexture: 0,
        texCoord: 0,
        doubleSided: false,
        alphaMode: 'OPAQUE',
        alphaCutoff: 0.5,
      },
      {
        ...defaults,
        name: 'moss',
        baseColorFactor: [0.2, 0.6, 0.3, 1],
        baseColor: null,
        baseColorTexture: null,
        texCoord: 0,
        doubleSided: true,
        alphaMode: 'MASK',
        alphaCutoff: 0.3,
      },
    ]);
    expect(doc.textures).toEqual([
      {
        name: null,
        source: 0,
        wrapS: 33071,
        wrapT: 10497,
        magFilter: 9728,
        sampler: {
          magFilter: 'nearest',
          minFilter: 'linear',
          mipmapFilter: 'linear',
          wrapS: 'clamp-to-edge',
          wrapT: 'repeat',
        },
      },
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
      extensionsUsed: ['KHR_materials_emissive_strength', 'KHR_lights_punctual'],
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
    expect(doc.warnings).toEqual(['extension ignored: KHR_lights_punctual']);
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
          accessors: [
            {
              bufferView: 0,
              componentType: 5126,
              count: 3,
              type: 'VEC3',
              sparse: {
                count: 1,
                indices: { bufferView: 0, componentType: 5123 },
                values: { bufferView: 0 },
              },
            },
          ],
        }),
        buffers: [bin],
      }),
    ).toThrow(/accessor 0 is sparse \(supported for morph target attributes only\)/);
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

// ---------------------------------------------------------------- morph targets

/**
 * A unit quad (4 vertices, 2 triangles) with three morph targets:
 * 0: dense POSITION and NORMAL deltas;
 * 1: sparse POSITION over zeros (vertices 1 and 3 move), plus a TANGENT the parser ignores;
 * 2: dense POSITION overlaid by a sparse override at vertex 2, no NORMAL.
 * `mesh.weights` is `[0.25, 0, 1]` unless `weights` says otherwise (null: none).
 */
function morphGlb(opts: { weights?: number[] | null; normals?: boolean } = {}): GlbWriter {
  const w = new GlbWriter();
  const pos = w.floats([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 'VEC3');
  const nrm = w.floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3');
  const idx = w.indices16([0, 1, 2, 0, 2, 3]);
  // Target 0: dense.
  const t0p = w.floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3', false);
  const t0n = w.floats([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0], 'VEC3', false);
  // Target 1: sparse over zeros: vertex 1 → (0, 0, 2), vertex 3 → (0, 0, 3).
  const sIdx = w.view(new Uint8Array(new Uint16Array([1, 3]).buffer));
  const sVal = w.view(new Uint8Array(new Float32Array([0, 0, 2, 0, 0, 3]).buffer));
  const t1p = w.accessor({
    componentType: 5126,
    count: 4,
    type: 'VEC3',
    sparse: {
      count: 2,
      indices: { bufferView: sIdx, componentType: 5123 },
      values: { bufferView: sVal },
    },
  });
  const tan = w.floats(new Array(16).fill(0), 'VEC4', false);
  // Target 2: dense (0.5 in x) with a sparse override at vertex 2 → (9, 9, 9).
  const t2Dense = w.view(
    new Uint8Array(new Float32Array([0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0]).buffer),
  );
  const s2Idx = w.view(new Uint8Array([2, 0, 0, 0]));
  const s2Val = w.view(new Uint8Array(new Float32Array([9, 9, 9]).buffer));
  const t2p = w.accessor({
    bufferView: t2Dense,
    componentType: 5126,
    count: 4,
    type: 'VEC3',
    sparse: {
      count: 1,
      indices: { bufferView: s2Idx, componentType: 5121 },
      values: { bufferView: s2Val },
    },
  });
  const attributes: Record<string, number> = { POSITION: pos };
  if (opts.normals !== false) attributes.NORMAL = nrm;
  w.json.meshes!.push({
    name: 'quad',
    primitives: [
      {
        attributes,
        indices: idx,
        targets: [
          { POSITION: t0p, NORMAL: t0n },
          { POSITION: t1p, TANGENT: tan },
          { POSITION: t2p },
        ],
      },
    ],
    ...(opts.weights === null ? {} : { weights: opts.weights ?? [0.25, 0, 1] }),
  });
  w.json.nodes!.push({ mesh: 0 });
  w.json.scenes!.push({ nodes: [0] });
  return w;
}

describe('parseGltf (morph targets)', () => {
  it('reads dense and sparse target deltas, default weights and ignored attributes', () => {
    const doc = parseGltf(morphGlb().finish());
    const mesh = doc.meshes[0]!;
    const p = mesh.primitives[0]!;
    expect(p.targets).toHaveLength(3);
    expect([...mesh.weights!]).toEqual([0.25, 0, 1]);
    expect(p.ignoredTargetAttributes).toEqual(['TANGENT']);
    expect([...p.targets[0]!.position!]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect([...p.targets[0]!.normal!]).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
    // Sparse over zeros: only the named vertices move.
    expect([...p.targets[1]!.position!]).toEqual([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 3]);
    expect(p.targets[1]!.normal).toBeNull();
    // Sparse over a dense base: the override replaces one vertex, the rest keep the base.
    expect([...p.targets[2]!.position!]).toEqual([0.5, 0, 0, 0.5, 0, 0, 9, 9, 9, 0.5, 0, 0]);
    expect(p.targets[2]!.normal).toBeNull();
    // The base attributes are untouched, and a primitive without targets has none.
    expect(p.position[5]).toBe(0);
    const plain = parseGltf(sampleGlb().glb).meshes[0]!;
    expect(plain.primitives[0]!.targets).toEqual([]);
    expect(plain.primitives[0]!.ignoredTargetAttributes).toEqual([]);
    expect(plain.weights).toBeNull();
  });

  it('weights are null when the file gives none; targets follow the unwelding', () => {
    expect(parseGltf(morphGlb({ weights: null }).finish()).meshes[0]!.weights).toBeNull();
    const p = parseGltf(morphGlb({ normals: false }).finish()).meshes[0]!.primitives[0]!;
    expect(p.hadNormals).toBe(false);
    expect(p.vertexCount).toBe(6);
    // Index order 0 1 2 0 2 3: the sparse target's vertex 1 lands at slot 1, vertex 3 at slot 5.
    expect([...p.targets[1]!.position!]).toEqual([
      0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
    ]);
    expect(p.targets[0]!.normal).toHaveLength(18);
  });

  it('names bad targets, weights and sparse data as GltfError', () => {
    const bad = (mutate: (w: GlbWriter) => void, re: RegExp) => {
      const w = morphGlb();
      mutate(w);
      expect(() => parseGltf(w.finish())).toThrow(re);
      let err: unknown;
      try {
        parseGltf(w.finish());
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(GltfError);
    };
    bad((w) => {
      w.json.meshes![0]!.weights = [1];
    }, /mesh 0: 1 default weights for 3 morph targets/);
    bad((w) => {
      const prim = w.json.meshes![0]!.primitives[0]!;
      w.json.meshes![0]!.primitives.push({ ...prim, targets: [] });
      delete w.json.meshes![0]!.weights;
    }, /mesh 0: primitive 1 has 0 morph targets, primitive 0 has 3/);
    bad((w) => {
      w.json.accessors![3]!.count = 3;
    }, /mesh 0 primitive 0 target 0 POSITION: 3 values for 4 vertices/);
    bad((w) => {
      w.json.accessors![3]!.type = 'VEC2';
    }, /target 0 POSITION: VEC2, expected VEC3/);
    bad((w) => {
      w.json.accessors![5]!.sparse!.count = 5;
    }, /target 1 POSITION: sparse count 5 for 4 elements/);
    bad((w) => {
      w.json.accessors![5]!.sparse!.count = 3;
    }, /target 1 POSITION: sparse data runs past its bufferView/);
    bad((w) => {
      w.json.accessors![5]!.sparse!.indices.componentType = 5126 as unknown as 5123;
    }, /sparse index componentType 5126 must be unsigned/);
    bad((w) => {
      // Sparse on a base attribute stays unsupported.
      w.json.accessors![0]!.sparse = w.json.accessors![5]!.sparse;
    }, /primitive 0: accessor 0 is sparse \(supported for morph target attributes only\)/);
  });
});

// ---------------------------------------------------------------- materials, every slot

/** A quad with every material slot, two samplers, TANGENT and TEXCOORD_1. */
function pbrGlb(opts: { normals?: boolean } = {}): GlbWriter {
  const w = new GlbWriter();
  const pos = w.floats([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 'VEC3');
  const nrm = w.floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3', false);
  const uv0 = w.floats([0, 1, 1, 1, 1, 0, 0, 0], 'VEC2', false);
  const uv1 = w.floats([0, 0, 2, 0, 2, 2, 0, 2], 'VEC2', false);
  const tan = w.floats([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1], 'VEC4', false);
  const idx = w.indices16([0, 1, 2, 0, 2, 3]);
  const png = w.view(FAKE_PNG);
  w.json.images = [{ bufferView: png, mimeType: 'image/png' }];
  w.json.samplers = [
    { magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33648 },
    { magFilter: 9729, minFilter: 9729 },
  ];
  w.json.textures = [{ source: 0, sampler: 0 }, { source: 0, sampler: 1 }, { source: 0 }];
  w.json.extensionsUsed = ['KHR_texture_transform', 'KHR_materials_emissive_strength'];
  w.json.extensionsRequired = ['KHR_texture_transform'];
  w.json.materials = [
    {
      name: 'full',
      pbrMetallicRoughness: {
        baseColorFactor: [0.5, 0.25, 1, 0.75],
        baseColorTexture: {
          index: 0,
          extensions: {
            KHR_texture_transform: { offset: [0.5, 0.25], rotation: 1.5, scale: [2, 3] },
          },
        },
        metallicFactor: 0.25,
        roughnessFactor: 0.75,
        metallicRoughnessTexture: { index: 1, texCoord: 1 },
      },
      normalTexture: { index: 2, scale: 0.5 },
      occlusionTexture: { index: 2, strength: 0.6 },
      emissiveTexture: {
        index: 1,
        texCoord: 0,
        extensions: { KHR_texture_transform: { scale: [4, 4], texCoord: 1 } },
      },
      emissiveFactor: [1, 0.5, 0],
      extensions: { KHR_materials_emissive_strength: { emissiveStrength: 3 } },
      alphaMode: 'BLEND',
      doubleSided: true,
    },
    { name: 'bare' },
  ];
  w.json.meshes = [
    {
      primitives: [
        {
          attributes: {
            POSITION: pos,
            ...(opts.normals === false ? {} : { NORMAL: nrm }),
            TEXCOORD_0: uv0,
            TEXCOORD_1: uv1,
            TANGENT: tan,
          },
          indices: idx,
          material: 0,
        },
      ],
    },
  ];
  w.json.nodes = [{ mesh: 0 }];
  w.json.scenes = [{ nodes: [0] }];
  w.json.scene = 0;
  return w;
}

describe('parseGltf (materials)', () => {
  it('reads every slot, factor, texCoord and extension of a material', () => {
    const doc = parseGltf(pbrGlb().finish());
    const m = doc.materials[0]!;
    expect(m.name).toBe('full');
    expect(m.baseColorFactor).toEqual([0.5, 0.25, 1, 0.75]);
    expect(m.baseColor).toEqual({
      index: 0,
      texCoord: 0,
      transform: { offset: [0.5, 0.25], rotation: 1.5, scale: [2, 3] },
    });
    expect(m.metallicFactor).toBe(0.25);
    expect(m.roughnessFactor).toBe(0.75);
    expect(m.metallicRoughness).toEqual({ index: 1, texCoord: 1, transform: null });
    expect(m.normal).toEqual({ index: 2, texCoord: 0, transform: null });
    expect(m.normalScale).toBe(0.5);
    expect(m.occlusion).toEqual({ index: 2, texCoord: 0, transform: null });
    expect(m.occlusionStrength).toBe(0.6);
    // The transform's own texCoord wins; missing offset/rotation default.
    expect(m.emissive).toEqual({
      index: 1,
      texCoord: 1,
      transform: { offset: [0, 0], rotation: 0, scale: [4, 4] },
    });
    // emissiveFactor × KHR_materials_emissive_strength.
    expect(m.emissiveFactor).toEqual([3, 1.5, 0]);
    expect(m.alphaMode).toBe('BLEND');
    expect(m.doubleSided).toBe(true);
    // Deprecated mirrors.
    expect(m.baseColorTexture).toBe(0);
    expect(m.texCoord).toBe(0);
    // Both extensions are handled: no warning, and `extensionsRequired` is accepted.
    expect(doc.warnings).toEqual([]);
  });

  it('fills the spec defaults for a bare material', () => {
    const m = parseGltf(pbrGlb().finish()).materials[1]!;
    expect(m).toEqual({
      name: 'bare',
      baseColorFactor: [1, 1, 1, 1],
      baseColor: null,
      metallicFactor: 1,
      roughnessFactor: 1,
      metallicRoughness: null,
      normal: null,
      normalScale: 1,
      occlusion: null,
      occlusionStrength: 1,
      emissive: null,
      emissiveFactor: [0, 0, 0],
      doubleSided: false,
      alphaMode: 'OPAQUE',
      alphaCutoff: 0.5,
      baseColorTexture: null,
      texCoord: 0,
    });
  });

  it('maps samplers to GPU terms, with defaults', () => {
    const t = parseGltf(pbrGlb().finish()).textures;
    expect(t[0]!.sampler).toEqual({
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      wrapS: 'clamp-to-edge',
      wrapT: 'mirror-repeat',
    });
    // 9729 LINEAR minFilter: no mipmap mode.
    expect(t[1]!.sampler).toEqual({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: null,
      wrapS: 'repeat',
      wrapT: 'repeat',
    });
    // No sampler: linear, trilinear, repeat.
    expect(t[2]!.sampler).toEqual({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      wrapS: 'repeat',
      wrapT: 'repeat',
    });
  });

  it('transformUv applies T · R · S', () => {
    const t = {
      offset: [0.5, 0.25] as [number, number],
      rotation: Math.PI / 2,
      scale: [2, 3] as [number, number],
    };
    const [u, v] = transformUv(t, 1, 1);
    // scale → (2, 3); rotate 90° ccw → (-3, 2); offset → (-2.5, 2.25).
    expect(u).toBeCloseTo(-2.5, 6);
    expect(v).toBeCloseTo(2.25, 6);
    const out: [number, number] = [0, 0];
    expect(transformUv({ offset: [0, 0], rotation: 0, scale: [1, 1] }, 0.3, 0.7, out)).toBe(out);
    expect(out).toEqual([0.3, 0.7]);
  });

  it('reads TANGENT and TEXCOORD_1, and unwelds them with flat normals', () => {
    const p = parseGltf(pbrGlb().finish()).meshes[0]!.primitives[0]!;
    expect([...p.tangent!]).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1]);
    expect([...p.uv1!]).toEqual([0, 0, 2, 0, 2, 2, 0, 2]);
    const flat = parseGltf(pbrGlb({ normals: false }).finish()).meshes[0]!.primitives[0]!;
    expect(flat.vertexCount).toBe(6);
    // Index order 0 1 2 0 2 3: vertex 2's tangent (w = -1) lands at slots 2 and 4.
    expect([...flat.tangent!.subarray(8, 12)]).toEqual([1, 0, 0, -1]);
    expect([...flat.tangent!.subarray(16, 20)]).toEqual([1, 0, 0, -1]);
    expect([...flat.uv1!.subarray(10, 12)]).toEqual([0, 2]);
    const plain = parseGltf(sampleGlb().glb).meshes[0]!.primitives[0]!;
    expect(plain.tangent).toBeNull();
    expect(plain.uv1).toBeNull();
  });

  it('names a bad TANGENT and a missing texture as GltfError', () => {
    const w = pbrGlb();
    w.json.meshes![0]!.primitives[0]!.attributes.TANGENT =
      w.json.meshes![0]!.primitives[0]!.attributes.NORMAL;
    expect(() => parseGltf(w.finish())).toThrow(/TANGENT: VEC3, expected VEC4/);
    const w2 = pbrGlb();
    w2.json.materials![0]!.normalTexture = { index: 7 };
    expect(() => parseGltf(w2.finish())).toThrow(
      /material 0 normalTexture: texture 7 does not exist/,
    );
    // A required extension the parser does not read still throws.
    const w3 = pbrGlb();
    w3.json.extensionsRequired = ['KHR_texture_transform', 'KHR_draco_mesh_compression'];
    expect(() => parseGltf(w3.finish())).toThrow(
      /required extensions not supported: KHR_draco_mesh_compression/,
    );
  });
});
