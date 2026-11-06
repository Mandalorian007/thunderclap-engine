/**
 * A TypeScript port of the meshoptimizer decoders `EXT_meshopt_compression` needs (bitstream
 * version 0 for vertices, versions 0 and 1 for indices): the vertex codec (`ATTRIBUTES`), the
 * triangle index codec (`TRIANGLES`), the index sequence codec (`INDICES`) and the three
 * filters (`OCTAHEDRAL`, `QUATERNION`, `EXPONENTIAL`) applied after the vertex codec. Sync, on
 * `Uint8Array`s; the only allocation is the caller's target (one per buffer view). Malformed
 * input throws `MeshoptError`. The reference is meshoptimizer's `vertexcodec.cpp`,
 * `indexcodec.cpp` and `vertexfilter.cpp` (MIT, Arseny Kapoulkine); this port follows their
 * scalar paths byte for byte.
 */

/** `EXT_meshopt_compression` `mode`. */
export type MeshoptMode = 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
/** `EXT_meshopt_compression` `filter` (`'NONE'` when absent). */
export type MeshoptFilter = 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';

/** A meshopt stream that does not decode (bad header, truncated, trailing bytes, bad stride). */
export class MeshoptError extends Error {
  override readonly name = 'MeshoptError';
}

const VERTEX_HEADER = 0xa0;
const INDEX_HEADER = 0xe0;
const SEQUENCE_HEADER = 0xd0;
const BYTE_GROUP = 16;
const BLOCK_BYTES = 8192;
const BLOCK_MAX = 256;
const TAIL_MAX = 32;

/** One byte lane of a vertex block; shared, so decoding allocates nothing. */
const lane = new Uint8Array(BLOCK_MAX);

/**
 * Decode one `EXT_meshopt_compression` buffer view into `target` (`count × stride` bytes, the
 * view's `byteLength`), then apply `filter` in place. Throws `MeshoptError` on a bad stream.
 */
export function decodeMeshopt(
  target: Uint8Array,
  count: number,
  stride: number,
  source: Uint8Array,
  mode: MeshoptMode,
  filter: MeshoptFilter = 'NONE',
): void {
  if (target.byteLength < count * stride) {
    throw new MeshoptError(`target holds ${target.byteLength} bytes, needs ${count * stride}`);
  }
  if (mode === 'ATTRIBUTES') {
    decodeVertices(target, count, stride, source);
    if (filter !== 'NONE') applyFilter(target, count, stride, filter);
    return;
  }
  if (filter !== 'NONE') throw new MeshoptError(`filter ${filter} applies to ATTRIBUTES only`);
  if (stride !== 2 && stride !== 4) {
    throw new MeshoptError(`index stride must be 2 or 4, got ${stride}`);
  }
  if (mode === 'TRIANGLES') decodeTriangles(target, count, stride, source);
  else if (mode === 'INDICES') decodeSequence(target, count, stride, source);
  else throw new MeshoptError(`unknown mode ${String(mode)}`);
}

// ---------------------------------------------------------------- vertex codec

function decodeVertices(target: Uint8Array, count: number, stride: number, src: Uint8Array): void {
  if (stride <= 0 || stride > 256 || stride % 4 !== 0) {
    throw new MeshoptError(`vertex stride must be a multiple of 4 up to 256, got ${stride}`);
  }
  const end = src.byteLength;
  if (end < 1 + stride) throw new MeshoptError('vertex stream truncated');
  const header = src[0]!;
  if ((header & 0xf0) !== VERTEX_HEADER) throw new MeshoptError('not a meshopt vertex stream');
  if ((header & 0x0f) > 0) throw new MeshoptError(`vertex codec version ${header & 0x0f}`);
  const blockSize = Math.min((BLOCK_BYTES / stride) & ~(BYTE_GROUP - 1), BLOCK_MAX);
  // The first "previous vertex" is the stream's last `stride` bytes.
  const tailFirst = end - stride;
  let at = 1;
  for (let offset = 0; offset < count; offset += blockSize) {
    const n = Math.min(blockSize, count - offset);
    const aligned = (n + BYTE_GROUP - 1) & ~(BYTE_GROUP - 1);
    for (let k = 0; k < stride; k++) {
      at = decodeBytes(src, at, end, aligned);
      let p = offset === 0 ? src[tailFirst + k]! : target[(offset - 1) * stride + k]!;
      let o = offset * stride + k;
      for (let i = 0; i < n; i++) {
        const z = lane[i]!;
        p = ((-(z & 1) ^ (z >>> 1)) + p) & 0xff;
        target[o] = p;
        o += stride;
      }
    }
  }
  if (end - at !== Math.max(TAIL_MAX, stride))
    throw new MeshoptError('vertex stream size mismatch');
}

/** Decode `size` (a multiple of 16) bytes of one lane into `lane`; returns the new read offset. */
function decodeBytes(src: Uint8Array, start: number, end: number, size: number): number {
  const groups = size / BYTE_GROUP;
  const headerSize = (groups + 3) >> 2;
  if (end - start < headerSize) throw new MeshoptError('vertex stream truncated');
  let at = start + headerSize;
  for (let g = 0; g < groups; g++) {
    const mode = (src[start + (g >> 2)]! >> ((g & 3) * 2)) & 3;
    const out = g * BYTE_GROUP;
    if (mode === 0) {
      lane.fill(0, out, out + BYTE_GROUP);
    } else if (mode === 3) {
      if (end - at < BYTE_GROUP) throw new MeshoptError('vertex stream truncated');
      for (let i = 0; i < BYTE_GROUP; i++) lane[out + i] = src[at + i]!;
      at += BYTE_GROUP;
    } else {
      const bits = mode === 1 ? 2 : 4;
      const packed = bits * 2; // bytes of packed values for 16 entries
      const escCode = (1 << bits) - 1;
      let lit = at + packed;
      if (lit > end) throw new MeshoptError('vertex stream truncated');
      let i = out;
      for (let b = 0; b < packed; b++) {
        let byte = src[at + b]!;
        for (let s = 0; s < 8 / bits; s++) {
          const enc = (byte >> (8 - bits)) & escCode;
          byte = (byte << bits) & 0xff;
          if (enc === escCode) {
            if (lit >= end) throw new MeshoptError('vertex stream truncated');
            lane[i++] = src[lit++]!;
          } else {
            lane[i++] = enc;
          }
        }
      }
      at = lit;
    }
  }
  return at;
}

// ---------------------------------------------------------------- index codecs

/** The edge fifo (16 × 2) and vertex fifo (16) of the triangle codec; shared, reset per call. */
const edgeFifo = new Uint32Array(32);
const vertexFifo = new Uint32Array(16);

function decodeTriangles(target: Uint8Array, count: number, size: number, src: Uint8Array): void {
  if (count % 3 !== 0) throw new MeshoptError(`index count ${count} is not a multiple of 3`);
  const end = src.byteLength;
  if (end < 1 + count / 3 + 16) throw new MeshoptError('index stream truncated');
  const header = src[0]!;
  if ((header & 0xf0) !== INDEX_HEADER) throw new MeshoptError('not a meshopt index stream');
  const version = header & 0x0f;
  if (version > 1) throw new MeshoptError(`index codec version ${version}`);
  const out = new DataView(target.buffer, target.byteOffset, target.byteLength);
  const write = (i: number, v: number) => {
    if (size === 2) out.setUint16(i * 2, v & 0xffff, true);
    else out.setUint32(i * 4, v >>> 0, true);
  };
  edgeFifo.fill(0xffffffff);
  vertexFifo.fill(0xffffffff);
  let eo = 0;
  let vo = 0;
  let next = 0;
  let last = 0;
  const fecmax = version >= 1 ? 13 : 15;
  let code = 1;
  const safeEnd = end - 16;
  const table = safeEnd;
  const cursor = { at: 1 + count / 3, end: safeEnd };
  const pushEdge = (a: number, b: number) => {
    edgeFifo[eo * 2] = a;
    edgeFifo[eo * 2 + 1] = b;
    eo = (eo + 1) & 15;
  };
  const pushVertex = (v: number, cond = true) => {
    vertexFifo[vo] = v;
    if (cond) vo = (vo + 1) & 15;
  };
  for (let i = 0; i < count; i += 3) {
    if (cursor.at > safeEnd) throw new MeshoptError('index stream truncated');
    const codetri = src[code++]!;
    if (codetri < 0xf0) {
      const fe = codetri >> 4;
      const e = (eo - 1 - fe) & 15;
      const a = edgeFifo[e * 2]!;
      const b = edgeFifo[e * 2 + 1]!;
      const fec = codetri & 15;
      let c: number;
      if (fec < fecmax) {
        c = fec === 0 ? next : vertexFifo[(vo - 1 - fec) & 15]!;
        if (fec === 0) next++;
        pushVertex(c, fec === 0);
      } else {
        // 13 and 14 are last - 1 and last + 1 (version 1); 15 is a free index.
        c = fec !== 15 ? (last + (fec - (fec ^ 3))) >>> 0 : readIndex(src, cursor, last);
        last = c;
        pushVertex(c);
      }
      write(i, a);
      write(i + 1, b);
      write(i + 2, c);
      pushEdge(c, b);
      pushEdge(a, c);
    } else if (codetri < 0xfe) {
      const aux = src[table + (codetri & 15)]!;
      const feb = aux >> 4;
      const fec = aux & 15;
      const a = next++;
      const b = feb === 0 ? next : vertexFifo[(vo - feb) & 15]!;
      if (feb === 0) next++;
      const c = fec === 0 ? next : vertexFifo[(vo - fec) & 15]!;
      if (fec === 0) next++;
      write(i, a);
      write(i + 1, b);
      write(i + 2, c);
      pushVertex(a);
      pushVertex(b, feb === 0);
      pushVertex(c, fec === 0);
      pushEdge(b, a);
      pushEdge(c, b);
      pushEdge(a, c);
    } else {
      if (cursor.at >= safeEnd) throw new MeshoptError('index stream truncated');
      const aux = src[cursor.at++]!;
      const fea = codetri === 0xfe ? 0 : 15;
      const feb = aux >> 4;
      const fec = aux & 15;
      if (aux === 0) next = 0; // reset (version 1)
      let a = fea === 0 ? next++ : 0;
      let b = feb === 0 ? next++ : vertexFifo[(vo - feb) & 15]!;
      let c = fec === 0 ? next++ : vertexFifo[(vo - fec) & 15]!;
      if (fea === 15) last = a = readIndex(src, cursor, last);
      if (feb === 15) last = b = readIndex(src, cursor, last);
      if (fec === 15) last = c = readIndex(src, cursor, last);
      write(i, a);
      write(i + 1, b);
      write(i + 2, c);
      pushVertex(a);
      pushVertex(b, feb === 0 || feb === 15);
      pushVertex(c, fec === 0 || fec === 15);
      pushEdge(b, a);
      pushEdge(c, b);
      pushEdge(a, c);
    }
  }
  if (cursor.at !== safeEnd) throw new MeshoptError('index stream size mismatch');
}

function decodeSequence(target: Uint8Array, count: number, size: number, src: Uint8Array): void {
  const end = src.byteLength;
  if (end < 1 + count + 4) throw new MeshoptError('index sequence truncated');
  const header = src[0]!;
  if ((header & 0xf0) !== SEQUENCE_HEADER) throw new MeshoptError('not a meshopt index sequence');
  const version = header & 0x0f;
  if (version > 1) throw new MeshoptError(`index sequence version ${version}`);
  const out = new DataView(target.buffer, target.byteOffset, target.byteLength);
  const safeEnd = end - 4;
  const cursor = { at: 1, end: safeEnd };
  let last0 = 0;
  let last1 = 0;
  for (let i = 0; i < count; i++) {
    if (cursor.at >= safeEnd) throw new MeshoptError('index sequence truncated');
    let v = readVByte(src, cursor);
    const current = v & 1;
    v >>>= 1;
    const d = (v >>> 1) ^ -(v & 1);
    const index = ((current ? last1 : last0) + d) >>> 0;
    if (current) last1 = index;
    else last0 = index;
    if (size === 2) out.setUint16(i * 2, index & 0xffff, true);
    else out.setUint32(i * 4, index, true);
  }
  if (cursor.at !== safeEnd) throw new MeshoptError('index sequence size mismatch');
}

function readVByte(src: Uint8Array, cursor: { at: number; end: number }): number {
  if (cursor.at >= src.byteLength) throw new MeshoptError('index stream truncated');
  const lead = src[cursor.at++]!;
  if (lead < 128) return lead;
  let result = lead & 127;
  let shift = 7;
  for (let i = 0; i < 4; i++) {
    if (cursor.at >= src.byteLength) throw new MeshoptError('index stream truncated');
    const group = src[cursor.at++]!;
    result = (result | ((group & 127) << shift)) >>> 0;
    shift += 7;
    if (group < 128) break;
  }
  return result >>> 0;
}

function readIndex(src: Uint8Array, cursor: { at: number; end: number }, last: number): number {
  const v = readVByte(src, cursor);
  const d = (v >>> 1) ^ -(v & 1);
  return (last + d) >>> 0;
}

// ---------------------------------------------------------------- filters

function applyFilter(data: Uint8Array, count: number, stride: number, filter: MeshoptFilter): void {
  const dv = new DataView(data.buffer, data.byteOffset, count * stride);
  if (filter === 'OCTAHEDRAL') {
    if (stride === 4) filterOct(dv, count, 1);
    else if (stride === 8) filterOct(dv, count, 2);
    else throw new MeshoptError(`OCTAHEDRAL needs stride 4 or 8, got ${stride}`);
  } else if (filter === 'QUATERNION') {
    if (stride !== 8) throw new MeshoptError(`QUATERNION needs stride 8, got ${stride}`);
    filterQuat(dv, count);
  } else if (filter === 'EXPONENTIAL') {
    if (stride % 4 !== 0) throw new MeshoptError(`EXPONENTIAL needs a stride of 4n, got ${stride}`);
    filterExp(dv, (count * stride) / 4);
  } else {
    throw new MeshoptError(`unknown filter ${String(filter)}`);
  }
}

const f = Math.fround;

/** Round half away from zero and truncate, as `int(x + (x >= 0 ? 0.5f : -0.5f))`. */
function roundAway(x: number): number {
  return Math.trunc(f(x + (x >= 0 ? 0.5 : -0.5)));
}

function filterOct(dv: DataView, count: number, bytes: 1 | 2): void {
  const max = bytes === 1 ? 127 : 32767;
  const get = (o: number) => (bytes === 1 ? dv.getInt8(o) : dv.getInt16(o, true));
  const set = (o: number, v: number) => {
    if (bytes === 1) dv.setInt8(o, v);
    else dv.setInt16(o, v, true);
  };
  for (let i = 0; i < count; i++) {
    const o = i * 4 * bytes;
    let x = get(o);
    let y = get(o + bytes);
    const z = f(get(o + 2 * bytes) - Math.abs(x) - Math.abs(y));
    const t = z >= 0 ? 0 : z;
    x = f(x + (x >= 0 ? t : -t));
    y = f(y + (y >= 0 ? t : -t));
    const l = f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
    const s = f(max / l);
    set(o, roundAway(f(x * s)));
    set(o + bytes, roundAway(f(y * s)));
    set(o + 2 * bytes, roundAway(f(z * s)));
  }
}

function filterQuat(dv: DataView, count: number): void {
  const scale = f(1 / Math.SQRT2);
  for (let i = 0; i < count; i++) {
    const o = i * 8;
    const d3 = dv.getInt16(o + 6, true);
    const sf = d3 | 3;
    const ss = f(scale / sf);
    const x = f(dv.getInt16(o, true) * ss);
    const y = f(dv.getInt16(o + 2, true) * ss);
    const z = f(dv.getInt16(o + 4, true) * ss);
    const ww = f(f(f(1 - f(x * x)) - f(y * y)) - f(z * z));
    const w = f(Math.sqrt(ww >= 0 ? ww : 0));
    const qc = d3 & 3;
    dv.setInt16(o + ((qc + 1) & 3) * 2, roundAway(f(x * 32767)), true);
    dv.setInt16(o + ((qc + 2) & 3) * 2, roundAway(f(y * 32767)), true);
    dv.setInt16(o + ((qc + 3) & 3) * 2, roundAway(f(z * 32767)), true);
    dv.setInt16(o + qc * 2, roundAway(f(w * 32767)), true);
  }
}

/** Scratch for the exponent's bit pattern; shared. */
const expBits = new Uint32Array(1);
const expFloat = new Float32Array(expBits.buffer);

function filterExp(dv: DataView, values: number): void {
  for (let i = 0; i < values; i++) {
    const v = dv.getUint32(i * 4, true);
    const m = (v << 8) >> 8;
    const e = v >> 24;
    expBits[0] = ((e + 127) << 23) >>> 0;
    expFloat[0] = expFloat[0]! * m;
    dv.setUint32(i * 4, expBits[0]!, true);
  }
}
