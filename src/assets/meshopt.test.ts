import { describe, expect, it } from 'vitest';
import { type GltfJson, parseGltf } from './gltf';
import { decodeMeshopt, MeshoptError } from './meshopt';

// ---------------------------------------------------------------- reference encoder (tests only)
//
// A port of meshoptimizer's encoders (`meshopt_encodeVertexBuffer` v0, `meshopt_encodeIndexBuffer`
// v0/v1, `meshopt_encodeIndexSequence`, `meshopt_encodeFilterOct/Quat/Exp`) written for these
// tests: the decoder ships in the engine, the encoder stays here. Byte groups pick the smallest
// of the 0/2/4/8-bit encodings, as the reference does.

function zigzag8(v: number): number {
  return (v & 0x80 ? ~(v << 1) : v << 1) & 0xff;
}

function encodeBytes(out: number[], lane: Uint8Array): void {
  const groups = lane.length / 16;
  const headerAt = out.length;
  for (let i = 0; i < (groups + 3) >> 2; i++) out.push(0);
  for (let g = 0; g < groups; g++) {
    const vals = lane.subarray(g * 16, g * 16 + 16);
    let mode: number;
    if (vals.every((v) => v === 0)) mode = 0;
    else {
      const s2 = 4 + vals.filter((v) => v >= 3).length;
      const s4 = 8 + vals.filter((v) => v >= 15).length;
      mode = s2 <= s4 && s2 <= 16 ? 1 : s4 <= 16 ? 2 : 3;
    }
    out[headerAt + (g >> 2)]! |= mode << ((g & 3) * 2);
    if (mode === 3) out.push(...vals);
    else if (mode !== 0) {
      const bits = mode === 1 ? 2 : 4;
      const esc = (1 << bits) - 1;
      const lits: number[] = [];
      for (let b = 0; b < bits * 2; b++) {
        let byte = 0;
        for (let s = 0; s < 8 / bits; s++) {
          const v = vals[b * (8 / bits) + s]!;
          const enc = v >= esc ? esc : v;
          if (enc === esc) lits.push(v);
          byte = (byte << bits) | enc;
        }
        out.push(byte);
      }
      out.push(...lits);
    }
  }
}

function encodeVertexBuffer(data: Uint8Array, count: number, stride: number): Uint8Array {
  const out: number[] = [0xa0];
  const blockSize = Math.min((8192 / stride) & ~15, 256);
  let last = data.slice(0, stride);
  for (let offset = 0; offset < count; offset += blockSize) {
    const n = Math.min(blockSize, count - offset);
    const aligned = (n + 15) & ~15;
    for (let k = 0; k < stride; k++) {
      const lane = new Uint8Array(aligned);
      let p = last[k]!;
      for (let i = 0; i < n; i++) {
        const v = data[(offset + i) * stride + k]!;
        lane[i] = zigzag8((v - p) & 0xff);
        p = v;
      }
      encodeBytes(out, lane);
    }
    last = data.slice((offset + n - 1) * stride, (offset + n) * stride);
  }
  const tail = Math.max(32, stride);
  for (let i = 0; i < tail - stride; i++) out.push(0);
  out.push(...data.subarray(0, stride));
  return new Uint8Array(out);
}

function vbyte(out: number[], v: number): void {
  let x = v >>> 0;
  do {
    out.push((x & 127) | (x > 127 ? 128 : 0));
    x >>>= 7;
  } while (x);
}

function encodeIndex(out: number[], index: number, last: number): void {
  const d = (index - last) | 0;
  vbyte(out, ((d << 1) ^ (d >> 31)) >>> 0);
}

const CODEAUX = [
  0x00, 0x76, 0x87, 0x56, 0x67, 0x78, 0xa9, 0x86, 0x65, 0x89, 0x68, 0x98, 0x01, 0x69, 0, 0,
];
const ORDER = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
] as const;

function encodeIndexBuffer(indices: number[], version: 0 | 1 = 1): Uint8Array {
  const edge: [number, number][] = Array.from({ length: 16 }, () => [-1, -1]);
  const vfifo: number[] = Array.from({ length: 16 }, () => -1);
  let eo = 0;
  let vo = 0;
  let next = 0;
  const takeNext = (): number => {
    next++;
    return 0;
  };
  let last = 0;
  const fecmax = version >= 1 ? 13 : 15;
  const code: number[] = [];
  const data: number[] = [];
  const pushEdge = (a: number, b: number) => {
    edge[eo] = [a, b];
    eo = (eo + 1) & 15;
  };
  const pushVertex = (v: number) => {
    vfifo[vo] = v;
    vo = (vo + 1) & 15;
  };
  const getVertex = (v: number) => {
    for (let i = 0; i < 16; i++) if (vfifo[(vo - 1 - i) & 15] === v) return i;
    return -1;
  };
  const getEdge = (a: number, b: number, c: number) => {
    for (let i = 0; i < 16; i++) {
      const [e0, e1] = edge[(eo - 1 - i) & 15]!;
      if (e0 === a && e1 === b) return (i << 2) | 0;
      if (e0 === b && e1 === c) return (i << 2) | 1;
      if (e0 === c && e1 === a) return (i << 2) | 2;
    }
    return -1;
  };
  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    const fer = getEdge(t[0]!, t[1]!, t[2]!);
    if (fer >= 0 && fer >> 2 < 15) {
      const o = ORDER[fer & 3]!;
      const a = t[o[0]]!;
      const b = t[o[1]]!;
      const c = t[o[2]]!;
      const fe = fer >> 2;
      const fc = getVertex(c);
      let fec = fc >= 1 && fc < fecmax ? fc : c === next ? takeNext() : 15;
      if (fec === 15 && version >= 1) {
        if (c + 1 === last) {
          fec = 13;
          last = c;
        }
        if (c === last + 1) {
          fec = 14;
          last = c;
        }
      }
      code.push((fe << 4) | fec);
      if (fec === 15) {
        encodeIndex(data, c, last);
        last = c;
      }
      if (fec === 0 || fec >= fecmax) pushVertex(c);
      pushEdge(c, b);
      pushEdge(a, c);
    } else {
      const rotation = t[1] === next ? 1 : t[2] === next ? 2 : 0;
      const o = ORDER[rotation]!;
      const a = t[o[0]]!;
      const b = t[o[1]]!;
      const c = t[o[2]]!;
      let reset = false;
      if (a === 0 && b === 1 && c === 2 && next > 0 && version >= 1) {
        reset = true;
        next = 0;
        vfifo.fill(-1);
      }
      const fb = getVertex(b);
      const fc = getVertex(c);
      const fea = a === next ? takeNext() : 15;
      const feb = fb >= 0 && fb < 14 ? fb + 1 : b === next ? takeNext() : 15;
      const fec = fc >= 0 && fc < 14 ? fc + 1 : c === next ? takeNext() : 15;
      const aux = (feb << 4) | fec;
      const auxIndex = version >= 1 ? CODEAUX.indexOf(aux) : -1;
      if (fea === 0 && auxIndex >= 0 && !reset) code.push(0xf0 | auxIndex);
      else {
        code.push(0xfe + (fea === 15 ? 1 : 0));
        data.push(aux);
      }
      if (fea === 15) {
        encodeIndex(data, a, last);
        last = a;
      }
      if (feb === 15) {
        encodeIndex(data, b, last);
        last = b;
      }
      if (fec === 15) {
        encodeIndex(data, c, last);
        last = c;
      }
      if (fea === 0 || fea === 15) pushVertex(a);
      if (feb === 0 || feb === 15) pushVertex(b);
      if (fec === 0 || fec === 15) pushVertex(c);
      pushEdge(b, a);
      pushEdge(c, b);
      pushEdge(a, c);
    }
  }
  // Version 0 has no table lookups (auxIndex is -1 above), so its table bytes are unread.
  return new Uint8Array([0xe0 | version, ...code, ...data, ...CODEAUX]);
}

function encodeIndexSequence(indices: number[]): Uint8Array {
  const out: number[] = [0xd1];
  const last = [0, 0];
  let current = 0;
  for (const index of indices) {
    const cd = (index - last[current]!) | 0;
    current ^= Math.abs(cd) >= 30 ? 1 : 0;
    const d = (index - last[current]!) | 0;
    const v = ((d << 1) ^ (d >> 31)) >>> 0;
    vbyte(out, ((v << 1) | current) >>> 0);
    last[current] = index;
  }
  out.push(0, 0, 0, 0);
  return new Uint8Array(out);
}

function quantizeSnorm(v: number, bits: number): number {
  const scale = (1 << (bits - 1)) - 1;
  const c = Math.max(-1, Math.min(1, v));
  return Math.trunc(c * scale + (c >= 0 ? 0.5 : -0.5));
}

/** Octahedral-encode unit vectors (4 floats each, w kept) into int8 (bits 8) or int16 lanes. */
function encodeOct(vectors: number[], bits: 8 | 16): Uint8Array {
  const n = vectors.length / 4;
  const out = bits === 8 ? new Int8Array(n * 4) : new Int16Array(n * 4);
  for (let i = 0; i < n; i++) {
    let [x, y, z, w] = vectors.slice(i * 4, i * 4 + 4) as [number, number, number, number];
    const l = Math.abs(x) + Math.abs(y) + Math.abs(z);
    const s = l === 0 ? 0 : 1 / l;
    x *= s;
    y *= s;
    z *= s;
    const u = z >= 0 ? x : (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const v = z >= 0 ? y : (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    out[i * 4] = quantizeSnorm(u, bits);
    out[i * 4 + 1] = quantizeSnorm(v, bits);
    out[i * 4 + 2] = quantizeSnorm(1, bits);
    out[i * 4 + 3] = quantizeSnorm(w, bits);
  }
  return new Uint8Array(out.buffer);
}

function encodeQuat(quats: number[], bits = 16): Uint8Array {
  const n = quats.length / 4;
  const out = new Int16Array(n * 4);
  for (let i = 0; i < n; i++) {
    const q = quats.slice(i * 4, i * 4 + 4);
    let qc = 0;
    for (let k = 1; k < 4; k++) if (Math.abs(q[k]!) > Math.abs(q[qc]!)) qc = k;
    const sign = q[qc]! < 0 ? -1 : 1;
    out[i * 4] = quantizeSnorm(q[(qc + 1) & 3]! * Math.SQRT2 * sign, bits);
    out[i * 4 + 1] = quantizeSnorm(q[(qc + 2) & 3]! * Math.SQRT2 * sign, bits);
    out[i * 4 + 2] = quantizeSnorm(q[(qc + 3) & 3]! * Math.SQRT2 * sign, bits);
    out[i * 4 + 3] = (quantizeSnorm(1, bits) & ~3) | qc;
  }
  return new Uint8Array(out.buffer);
}

function encodeExp(values: number[], bits = 24): Uint8Array {
  const out = new Uint32Array(values.length);
  values.forEach((v, i) => {
    const e = v === 0 ? 0 : Math.floor(Math.log2(Math.abs(v))) + 1;
    const exp = e - (bits - 1);
    const m = Math.trunc(v * 2 ** -exp + (v >= 0 ? 0.5 : -0.5));
    out[i] = (((exp & 0xff) << 24) | (m & 0xffffff)) >>> 0;
  });
  return new Uint8Array(out.buffer);
}

function decode(
  bytes: Uint8Array,
  count: number,
  stride: number,
  mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES',
  filter: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL' = 'NONE',
): Uint8Array {
  const target = new Uint8Array(count * stride);
  decodeMeshopt(target, count, stride, bytes, mode, filter);
  return target;
}

/** A smooth grid of vertices (position + normal + uv as floats): realistic, compressible. */
function gridVertices(n: number): { floats: Float32Array; indices: number[]; count: number } {
  const f: number[] = [];
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const h = Math.sin(x * 0.3) * Math.cos(y * 0.2) * 0.25;
      f.push(x / n, h, y / n, 0, 1, 0, x / n, y / n);
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  }
  return { floats: new Float32Array(f), indices, count: (n + 1) * (n + 1) };
}

// ---------------------------------------------------------------- codecs

describe('meshopt vertex codec (ATTRIBUTES)', () => {
  it('round-trips an attribute stream across several blocks', () => {
    const { floats, count } = gridVertices(40); // 1681 vertices: 7 blocks of 256 at stride 32
    const raw = new Uint8Array(floats.buffer);
    const enc = encodeVertexBuffer(raw, count, 32);
    expect(enc.byteLength).toBeLessThan(raw.byteLength);
    expect(decode(enc, count, 32, 'ATTRIBUTES')).toEqual(raw);
  });

  it('round-trips random bytes (every group mode) at strides 4, 12 and 256', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed >> 16;
    };
    for (const stride of [4, 12, 256]) {
      const count = 300;
      const raw = new Uint8Array(count * stride);
      for (let i = 0; i < raw.length; i++) raw[i] = i % 7 === 0 ? rand() & 0xff : (i >> 4) & 3;
      expect(decode(encodeVertexBuffer(raw, count, stride), count, stride, 'ATTRIBUTES')).toEqual(
        raw,
      );
    }
  });

  it('rejects a bad header, a bad stride and trailing bytes', () => {
    const raw = new Uint8Array(64).map((_, i) => i);
    const enc = encodeVertexBuffer(raw, 4, 16);
    const bad = enc.slice();
    bad[0] = 0x10;
    expect(() => decode(bad, 4, 16, 'ATTRIBUTES')).toThrow(MeshoptError);
    expect(() => decode(enc, 8, 8, 'ATTRIBUTES')).toThrow(MeshoptError);
    expect(() => decode(enc, 16, 6, 'ATTRIBUTES')).toThrow(/stride/);
    const longer = new Uint8Array(enc.byteLength + 1);
    longer.set(enc.subarray(0, enc.byteLength - 16));
    longer.set(enc.subarray(enc.byteLength - 16), enc.byteLength - 15);
    expect(() => decode(longer, 4, 16, 'ATTRIBUTES')).toThrow(/size mismatch/);
  });
});

describe('meshopt index codecs', () => {
  it('round-trips a triangle list (TRIANGLES, versions 0 and 1, 16- and 32-bit)', () => {
    const { indices } = gridVertices(30);
    for (const version of [0, 1] as const) {
      const enc = encodeIndexBuffer(indices, version);
      expect(enc.byteLength).toBeLessThan(indices.length * 2);
      const out16 = decode(enc, indices.length, 2, 'TRIANGLES');
      expect(Array.from(new Uint16Array(out16.buffer))).toEqual(indices);
      const out32 = decode(enc, indices.length, 4, 'TRIANGLES');
      expect(Array.from(new Uint32Array(out32.buffer))).toEqual(indices);
    }
  });

  it('round-trips a triangle soup with free indices, a reset and large values', () => {
    const soup = [
      0, 1, 2, 2, 1, 3, 70000, 5, 9, 9, 5, 70001, 0, 1, 2, 3, 4, 5, 100, 99, 101, 7, 7, 7,
    ];
    const enc = encodeIndexBuffer(soup, 1);
    expect(Array.from(new Uint32Array(decode(enc, soup.length, 4, 'TRIANGLES').buffer))).toEqual(
      soup,
    );
  });

  it('round-trips an index sequence (INDICES), both lanes', () => {
    const seq = [0, 1, 2, 3, 1000, 1001, 4, 5, 1002, 6, 70000, 2, 0];
    const enc = encodeIndexSequence(seq);
    expect(Array.from(new Uint32Array(decode(enc, seq.length, 4, 'INDICES').buffer))).toEqual(seq);
    expect(Array.from(new Uint16Array(decode(enc, seq.length, 2, 'INDICES').buffer))).toEqual(
      seq.map((v) => v & 0xffff),
    );
  });

  it('rejects a wrong header, a count off by a triangle and a bad index stride', () => {
    const enc = encodeIndexBuffer([0, 1, 2, 2, 1, 3]);
    expect(() => decode(enc, 6, 2, 'INDICES')).toThrow(MeshoptError);
    expect(() => decode(enc, 3, 2, 'TRIANGLES')).toThrow(/size mismatch/);
    expect(() => decode(enc, 6, 1, 'TRIANGLES')).toThrow(/stride/);
    expect(() => decode(enc, 6, 2, 'TRIANGLES', 'OCTAHEDRAL')).toThrow(/ATTRIBUTES only/);
  });
});

// ---------------------------------------------------------------- filters

describe('meshopt filters', () => {
  /** Vertex-encode the filtered lanes, then decode with the filter. */
  const viaCodec = (
    lanes: Uint8Array,
    count: number,
    stride: number,
    filter: 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL',
  ) => decode(encodeVertexBuffer(lanes, count, stride), count, stride, 'ATTRIBUTES', filter);

  it('OCTAHEDRAL decodes known vectors (int8 and int16)', () => {
    // Axis-aligned inputs decode exactly: (127, 0, 0) is +X, (0, 0, 127) is +Z, w passes through.
    const known = new Int8Array([127, 0, 127, 64, 0, 0, 127, -127, -127, 0, 127, 0]);
    const out = new Int8Array(viaCodec(new Uint8Array(known.buffer), 3, 4, 'OCTAHEDRAL').buffer);
    expect(Array.from(out)).toEqual([127, 0, 0, 64, 0, 0, 127, -127, -127, 0, 0, 0]);
    // Arbitrary unit vectors survive a 16-bit round trip within a few 1e-4.
    const vecs: number[] = [];
    for (const [x, y, z] of [
      [0.6, 0.8, 0],
      [0.267, -0.535, 0.802],
      [-0.408, 0.408, -0.816],
      [0, 0, -1],
    ]) {
      const l = Math.hypot(x!, y!, z!);
      vecs.push(x! / l, y! / l, z! / l, 0);
    }
    const d16 = new Int16Array(viaCodec(encodeOct(vecs, 16), 4, 8, 'OCTAHEDRAL').buffer);
    for (let i = 0; i < 16; i++) {
      if (i % 4 === 3) continue;
      expect(Math.abs(d16[i]! / 32767 - vecs[i]!)).toBeLessThan(2e-4);
    }
  });

  it('QUATERNION decodes known vectors', () => {
    // Identity: the largest component is w (index 3), the other three are zero.
    const id = new Int16Array([0, 0, 0, (32767 & ~3) | 3]);
    const out = new Int16Array(viaCodec(new Uint8Array(id.buffer), 1, 8, 'QUATERNION').buffer);
    expect(Array.from(out)).toEqual([0, 0, 0, 32767]);
    const h = Math.SQRT1_2;
    const quats = [0, h, 0, h, 0.5, -0.5, 0.5, 0.5, -0.9, 0.1, 0.3, 0.3];
    const l3 = Math.hypot(-0.9, 0.1, 0.3, 0.3);
    for (let k = 8; k < 12; k++) quats[k] = quats[k]! / l3;
    const dq = new Int16Array(viaCodec(encodeQuat(quats), 3, 8, 'QUATERNION').buffer);
    for (let i = 0; i < 3; i++) {
      // Double cover: the decoded quaternion may be the negation.
      const s = Math.sign(dq[i * 4 + 3]! || 1) === Math.sign(quats[i * 4 + 3]!) ? 1 : -1;
      for (let k = 0; k < 4; k++) {
        expect(Math.abs((s * dq[i * 4 + k]!) / 32767 - quats[i * 4 + k]!)).toBeLessThan(2e-4);
      }
    }
  });

  it('EXPONENTIAL decodes known vectors', () => {
    const known = new Uint32Array([
      3, // 3 × 2^0
      ((0xff << 24) | 3) >>> 0, // 3 × 2^-1
      ((2 << 24) | (0xffffff & -5)) >>> 0, // -5 × 2^2
      0,
    ]);
    const out = new Float32Array(
      viaCodec(new Uint8Array(known.buffer), 1, 16, 'EXPONENTIAL').buffer,
    );
    expect(Array.from(out)).toEqual([3, 1.5, -20, 0]);
    const values = [0.1, -1234.5678, 1e-5, 42];
    const enc = viaCodec(encodeExp(values), 1, 16, 'EXPONENTIAL');
    const back = new Float32Array(enc.buffer);
    values.forEach((v, i) => {
      expect(Math.abs(back[i]! - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -22);
    });
  });

  it('rejects a filter on the wrong stride', () => {
    const raw = new Uint8Array(12);
    expect(() => viaCodec(raw, 1, 12, 'OCTAHEDRAL')).toThrow(/stride 4 or 8/);
    expect(() => viaCodec(raw, 3, 4, 'QUATERNION')).toThrow(/stride 8/);
  });
});

// ---------------------------------------------------------------- EXT_meshopt_compression in parseGltf

/**
 * The same grid twice: an uncompressed `.gltf` and one whose vertex and index views carry
 * `EXT_meshopt_compression` over a fallback buffer with no data (the extension is required).
 */
function twins(): {
  plain: GltfJson;
  plainBin: ArrayBuffer;
  packed: GltfJson;
  packedBin: ArrayBuffer;
} {
  const { floats, indices, count } = gridVertices(12);
  const raw = new Uint8Array(floats.buffer);
  const idx = new Uint8Array(new Uint32Array(indices).buffer);
  const accessors: GltfJson['accessors'] = [
    {
      bufferView: 0,
      byteOffset: 0,
      componentType: 5126,
      count,
      type: 'VEC3',
      min: [0, -0.25, 0],
      max: [1, 0.25, 1],
    },
    { bufferView: 0, byteOffset: 12, componentType: 5126, count, type: 'VEC3' },
    { bufferView: 0, byteOffset: 24, componentType: 5126, count, type: 'VEC2' },
    { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' },
  ];
  const meshes: GltfJson['meshes'] = [
    { primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] },
  ];
  const base = {
    asset: { version: '2.0' },
    accessors,
    meshes,
    nodes: [{ mesh: 0, translation: [1, 2, 3] as [number, number, number] }],
    scenes: [{ nodes: [0] }],
  };
  const plainBin = new Uint8Array(raw.byteLength + idx.byteLength);
  plainBin.set(raw);
  plainBin.set(idx, raw.byteLength);
  const plain: GltfJson = {
    ...base,
    buffers: [{ byteLength: plainBin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: raw.byteLength, byteStride: 32 },
      { buffer: 0, byteOffset: raw.byteLength, byteLength: idx.byteLength },
    ],
  };
  const vEnc = encodeVertexBuffer(raw, count, 32);
  const iEnc = encodeIndexBuffer(indices);
  const vLen = Math.ceil(vEnc.byteLength / 4) * 4;
  const packedBin = new Uint8Array(vLen + iEnc.byteLength);
  packedBin.set(vEnc);
  packedBin.set(iEnc, vLen);
  const packed: GltfJson = {
    ...base,
    extensionsUsed: ['EXT_meshopt_compression'],
    extensionsRequired: ['EXT_meshopt_compression'],
    buffers: [
      { byteLength: packedBin.byteLength },
      {
        byteLength: plainBin.byteLength,
        extensions: { EXT_meshopt_compression: { fallback: true } },
      },
    ],
    bufferViews: [
      {
        buffer: 1,
        byteOffset: 0,
        byteLength: raw.byteLength,
        byteStride: 32,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: 0,
            byteLength: vEnc.byteLength,
            byteStride: 32,
            count,
            mode: 'ATTRIBUTES',
          },
        },
      },
      {
        buffer: 1,
        byteOffset: raw.byteLength,
        byteLength: idx.byteLength,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: vLen,
            byteLength: iEnc.byteLength,
            byteStride: 4,
            count: indices.length,
            mode: 'TRIANGLES',
          },
        },
      },
    ],
  };
  return { plain, plainBin: plainBin.buffer, packed, packedBin: packedBin.buffer };
}

describe('parseGltf with EXT_meshopt_compression', () => {
  it('loads the same mesh as the uncompressed twin', () => {
    const t = twins();
    const a = parseGltf({ json: t.plain, buffers: [t.plainBin] });
    const b = parseGltf({ json: t.packed, buffers: [t.packedBin] });
    const pa = a.meshes[0]!.primitives[0]!;
    const pb = b.meshes[0]!.primitives[0]!;
    expect(pb.position).toEqual(pa.position);
    expect(pb.normal).toEqual(pa.normal);
    expect(pb.uv0).toEqual(pa.uv0);
    expect(pb.indices).toEqual(pa.indices);
    expect(b.warnings).toEqual([]);
    expect(b.nodes[0]!.world).toEqual(a.nodes[0]!.world);
  });

  it('decodes the stream even when the fallback buffer holds data', () => {
    const t = twins();
    // Zeroed fallback bytes: a reader that used them would see a flat, degenerate mesh.
    const zero = new ArrayBuffer(t.plainBin.byteLength);
    const a = parseGltf({ json: t.plain, buffers: [t.plainBin] });
    const b = parseGltf({ json: t.packed, buffers: [t.packedBin, zero] });
    expect(b.meshes[0]!.primitives[0]!.position).toEqual(a.meshes[0]!.primitives[0]!.position);
    expect(b.meshes[0]!.primitives[0]!.indices).toEqual(a.meshes[0]!.primitives[0]!.indices);
  });

  it('reads views as written when no view carries the extension', () => {
    const t = twins();
    const a = parseGltf({ json: t.plain, buffers: [t.plainBin] });
    expect(a.meshes[0]!.primitives[0]!.indices.length).toBe(12 * 12 * 6);
  });

  it('names the view when a compressed stream is corrupt', () => {
    const t = twins();
    const bin = new Uint8Array(t.packedBin.slice(0));
    bin[0] = 0;
    expect(() => parseGltf({ json: t.packed, buffers: [bin.buffer] })).toThrow(/bufferView 0/);
  });
});
