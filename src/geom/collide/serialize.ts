/**
 * A built collider as bytes, so a level's BVH is baked once and loaded, not rebuilt on every
 * start. Little-endian, versioned, typed arrays laid out whole; `userData` is not serialised
 * (pass it to `importCollider` to reattach, by source index). Re-exporting an imported collider
 * gives identical bytes.
 */
import { type SourceKind, type SourceRecord, StaticCollider } from './bvh';

const MAGIC = 0x54434f4c; // 'TCOL'
const VERSION = 1;
const HEADER_U32 = 8; // magic, version, leafSize, root, topCount, triCount, nodeCount, sourceCount
const SOURCE_U32 = 8; // kind, start, count, root, nodeStart, nodeEnd, layer, flags (bit 0 removed, bit 1 has local)

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** Serialises `c` to a self-contained buffer. */
export function exportCollider(c: StaticCollider): ArrayBuffer {
  const triCount = c.triSource.length;
  const nodeCount = c.nodeLeaf.length;
  let localFloats = 0;
  for (const s of c.sources) if (s.local) localFloats += s.local.length;
  const bytes =
    HEADER_U32 * 4 +
    c.sources.length * SOURCE_U32 * 4 +
    triCount * 9 * 4 +
    triCount * 4 +
    nodeCount * 3 * 4 * 2 +
    align4(nodeCount) +
    nodeCount * 4 * 2 +
    localFloats * 4;
  const buf = new ArrayBuffer(bytes);
  const u32 = new Uint32Array(buf, 0, HEADER_U32 + c.sources.length * SOURCE_U32);
  u32[0] = MAGIC;
  u32[1] = VERSION;
  u32[2] = c.leafSize;
  u32[3] = c.root;
  u32[4] = c.topCount;
  u32[5] = triCount;
  u32[6] = nodeCount;
  u32[7] = c.sources.length;
  let o = HEADER_U32;
  for (const s of c.sources) {
    u32[o++] = s.kind;
    u32[o++] = s.start;
    u32[o++] = s.count;
    u32[o++] = s.root;
    u32[o++] = s.nodeStart;
    u32[o++] = s.nodeEnd;
    u32[o++] = s.layer;
    u32[o++] = (s.removed ? 1 : 0) | (s.local ? 2 : 0);
  }
  let byte = o * 4;
  new Float32Array(buf, byte, triCount * 9).set(c.tris);
  byte += triCount * 9 * 4;
  new Uint32Array(buf, byte, triCount).set(c.triSource);
  byte += triCount * 4;
  new Float32Array(buf, byte, nodeCount * 3).set(c.nodeMin);
  byte += nodeCount * 3 * 4;
  new Float32Array(buf, byte, nodeCount * 3).set(c.nodeMax);
  byte += nodeCount * 3 * 4;
  new Uint8Array(buf, byte, nodeCount).set(c.nodeLeaf);
  byte += align4(nodeCount);
  new Int32Array(buf, byte, nodeCount).set(c.nodeA);
  byte += nodeCount * 4;
  new Int32Array(buf, byte, nodeCount).set(c.nodeB);
  byte += nodeCount * 4;
  for (const s of c.sources) {
    if (!s.local) continue;
    new Float32Array(buf, byte, s.local.length).set(s.local);
    byte += s.local.length * 4;
  }
  return buf;
}

/**
 * Rebuilds a collider from `exportCollider` bytes. The arrays are copied out of `buf`, so it may
 * be released. `userData[i]` is attached to source `i` when given.
 */
export function importCollider(buf: ArrayBuffer, userData?: unknown[]): StaticCollider {
  if (buf.byteLength < HEADER_U32 * 4) throw new Error('collide: buffer too short for a collider');
  const head = new Uint32Array(buf, 0, HEADER_U32);
  if (head[0] !== MAGIC) throw new Error('collide: not a collider buffer');
  if (head[1] !== VERSION) throw new Error(`collide: unsupported collider version ${head[1]}`);
  const leafSize = head[2]!;
  const root = head[3]!;
  const topCount = head[4]!;
  const triCount = head[5]!;
  const nodeCount = head[6]!;
  const sourceCount = head[7]!;
  const rec = new Uint32Array(buf, HEADER_U32 * 4, sourceCount * SOURCE_U32);
  let byte = HEADER_U32 * 4 + sourceCount * SOURCE_U32 * 4;
  const tris = new Float32Array(buf.slice(byte, byte + triCount * 9 * 4));
  byte += triCount * 9 * 4;
  const triSource = new Uint32Array(buf.slice(byte, byte + triCount * 4));
  byte += triCount * 4;
  const nodeMin = new Float32Array(buf.slice(byte, byte + nodeCount * 3 * 4));
  byte += nodeCount * 3 * 4;
  const nodeMax = new Float32Array(buf.slice(byte, byte + nodeCount * 3 * 4));
  byte += nodeCount * 3 * 4;
  const nodeLeaf = new Uint8Array(buf.slice(byte, byte + nodeCount));
  byte += align4(nodeCount);
  const nodeA = new Int32Array(buf.slice(byte, byte + nodeCount * 4));
  byte += nodeCount * 4;
  const nodeB = new Int32Array(buf.slice(byte, byte + nodeCount * 4));
  byte += nodeCount * 4;
  const sources: SourceRecord[] = [];
  for (let i = 0; i < sourceCount; i++) {
    const o = i * SOURCE_U32;
    const count = rec[o + 2]!;
    const flags = rec[o + 7]!;
    let local: Float32Array | null = null;
    if (flags & 2) {
      local = new Float32Array(buf.slice(byte, byte + count * 9 * 4));
      byte += count * 9 * 4;
    }
    sources.push({
      kind: rec[o]! as SourceKind,
      start: rec[o + 1]!,
      count,
      root: rec[o + 3]!,
      nodeStart: rec[o + 4]!,
      nodeEnd: rec[o + 5]!,
      layer: rec[o + 6]!,
      removed: (flags & 1) !== 0,
      local,
      userData: userData?.[i],
    });
  }
  return new StaticCollider({
    tris,
    triSource,
    nodeMin,
    nodeMax,
    nodeLeaf,
    nodeA,
    nodeB,
    root,
    topCount,
    sources,
    leafSize,
  });
}
