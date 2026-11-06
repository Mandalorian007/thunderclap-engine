/**
 * A meshopt encoder for the harness (harness/gltf3.ts `?meshopt`): `encodeVertexBuffer`
 * (`ATTRIBUTES`, v0) and `encodeIndexBuffer` (`TRIANGLES`, v0/v1), a copy of the reference port
 * in src/assets/meshopt.test.ts. The decoder ships in the engine; encoders stay with the pages
 * and tests that build files (the harness imports only `@thunderclap/engine/<subpath>`).
 */

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

export function encodeVertexBuffer(data: Uint8Array, count: number, stride: number): Uint8Array {
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

export function encodeIndexBuffer(indices: number[], version: 0 | 1 = 1): Uint8Array {
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
