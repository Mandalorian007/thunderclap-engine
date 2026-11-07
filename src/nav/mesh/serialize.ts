/**
 * Navmesh bytes: bake at build time, ship the buffer, `importNavMesh` at load. Little-endian,
 * self-describing header; areas and off-mesh links travel with the mesh (their `userData` does
 * not). Format 2 (ws/nav-4) adds the area bytes; format 1 buffers load with every area 0.
 */
import { addOffMeshLink } from './links';
import { NavMesh } from './navmesh';

const MAGIC = 0x4e41564d; // 'NAVM'
/** Format 2 appends the area byte per polygon (padded to 4 bytes); format 1 bytes still load with every area 0. */
const FORMAT = 2;
const HEADER_U32 = 7;
const LINK_F32 = 10;

function areaBytes(polyCount: number): number {
  return (polyCount + 3) & ~3;
}

/** Serialises the mesh (polygons, adjacency, areas, links) into a fresh buffer. */
export function exportNavMesh(mesh: NavMesh): ArrayBuffer {
  const nvp = mesh.maxVertsPerPoly;
  const links = mesh.links.filter((l) => l !== null);
  const bytes =
    HEADER_U32 * 4 +
    2 * 4 +
    6 * 4 +
    mesh.vertCount * 3 * 4 +
    mesh.polyCount * nvp * 4 * 2 +
    areaBytes(mesh.polyCount) +
    links.length * LINK_F32 * 4;
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  let o = 0;
  const u32 = (v: number) => {
    view.setUint32(o, v, true);
    o += 4;
  };
  const i32 = (v: number) => {
    view.setInt32(o, v, true);
    o += 4;
  };
  const f32 = (v: number) => {
    view.setFloat32(o, v, true);
    o += 4;
  };
  u32(MAGIC);
  u32(FORMAT);
  u32(nvp);
  u32(mesh.vertCount);
  u32(mesh.polyCount);
  u32(links.length);
  u32(mesh.nextLinkId);
  f32(mesh.cellSize);
  f32(mesh.cellHeight);
  f32(mesh.bounds.min.x);
  f32(mesh.bounds.min.y);
  f32(mesh.bounds.min.z);
  f32(mesh.bounds.max.x);
  f32(mesh.bounds.max.y);
  f32(mesh.bounds.max.z);
  for (let i = 0; i < mesh.vertCount * 3; i++) f32(mesh.verts[i]!);
  for (let i = 0; i < mesh.polyCount * nvp; i++) i32(mesh.polys[i]!);
  for (let i = 0; i < mesh.polyCount * nvp; i++) i32(mesh.adjacency[i]!);
  new Uint8Array(buffer, o, mesh.polyCount).set(mesh.area.subarray(0, mesh.polyCount));
  o += areaBytes(mesh.polyCount);
  for (const l of links) {
    f32(l.from.x);
    f32(l.from.y);
    f32(l.from.z);
    f32(l.to.x);
    f32(l.to.y);
    f32(l.to.z);
    f32(l.radius);
    f32(l.cost ?? Number.NaN);
    u32(l.bidirectional ? 1 : 0);
    u32(l.id);
  }
  return buffer;
}

/** Rebuilds a mesh from `exportNavMesh` bytes; throws on a buffer that is not one. */
export function importNavMesh(buffer: ArrayBuffer | ArrayBufferView): NavMesh {
  const view =
    buffer instanceof ArrayBuffer
      ? new DataView(buffer)
      : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let o = 0;
  const u32 = () => {
    const v = view.getUint32(o, true);
    o += 4;
    return v;
  };
  const f32 = () => {
    const v = view.getFloat32(o, true);
    o += 4;
    return v;
  };
  if (view.byteLength < HEADER_U32 * 4 || u32() !== MAGIC)
    throw new Error('importNavMesh: not a navmesh buffer');
  const format = u32();
  if (format !== 1 && format !== FORMAT)
    throw new Error(`importNavMesh: unsupported format ${format}`);
  const nvp = u32();
  const vertCount = u32();
  const polyCount = u32();
  const linkCount = u32();
  const nextLinkId = u32();
  const cs = f32();
  const ch = f32();
  o += 6 * 4; // bounds are recomputed from the vertices
  const verts = new Float32Array(Math.max(1, vertCount) * 3);
  for (let i = 0; i < vertCount * 3; i++) verts[i] = f32();
  const polys = new Int32Array(Math.max(1, polyCount) * nvp).fill(-1);
  for (let i = 0; i < polyCount * nvp; i++) {
    polys[i] = view.getInt32(o, true);
    o += 4;
  }
  const adjacency = new Int32Array(Math.max(1, polyCount) * nvp).fill(-1);
  for (let i = 0; i < polyCount * nvp; i++) {
    adjacency[i] = view.getInt32(o, true);
    o += 4;
  }
  const area = new Uint8Array(Math.max(1, polyCount));
  if (format >= 2) {
    area.set(new Uint8Array(view.buffer, view.byteOffset + o, polyCount));
    o += areaBytes(polyCount);
  }
  const mesh = new NavMesh(verts, vertCount, polys, polyCount, nvp, cs, ch, adjacency, area);
  for (let i = 0; i < linkCount; i++) {
    const from = { x: f32(), y: f32(), z: f32() };
    const to = { x: f32(), y: f32(), z: f32() };
    const radius = f32();
    const cost = f32();
    const bidirectional = u32() === 1;
    const id = u32();
    mesh.nextLinkId = id;
    addOffMeshLink(mesh, {
      from,
      to,
      radius,
      bidirectional,
      cost: Number.isNaN(cost) ? undefined : cost,
    });
  }
  mesh.nextLinkId = nextLinkId;
  mesh.version = 0;
  return mesh;
}

/**
 * Loads a navmesh shipped as bytes (a `pnpm bake:nav` or `pnpm bake` output, read with `fetch`
 * or a `bytes` bundle entry): `importNavMesh`, then checks what a corrupt or truncated file would
 * break later, so a bad asset fails at load with a reason instead of inside a query. Throws when
 * the buffer is not a navmesh, is shorter than its header says, or holds a vertex index, an
 * adjacency entry or a coordinate out of range.
 */
export function loadNavMesh(bytes: ArrayBuffer | ArrayBufferView): NavMesh {
  const length = bytes.byteLength;
  let mesh: NavMesh;
  try {
    mesh = importNavMesh(bytes);
  } catch (e) {
    throw new Error(`loadNavMesh: ${e instanceof Error ? e.message : String(e)}`);
  }
  const nvp = mesh.maxVertsPerPoly;
  const links = mesh.links.reduce((n, l) => (l ? n + 1 : n), 0);
  const expected =
    HEADER_U32 * 4 +
    8 * 4 +
    mesh.vertCount * 12 +
    mesh.polyCount * nvp * 8 +
    areaBytes(mesh.polyCount) +
    links * LINK_F32 * 4;
  // Format 1 has no area block.
  if (length !== expected && length !== expected - areaBytes(mesh.polyCount)) {
    throw new Error(`loadNavMesh: ${length} bytes, the header describes ${expected}`);
  }
  if (nvp < 3 || nvp > 6) throw new Error(`loadNavMesh: ${nvp} vertices per polygon`);
  for (let i = 0; i < mesh.vertCount * 3; i++) {
    if (!Number.isFinite(mesh.verts[i]!))
      throw new Error(`loadNavMesh: vertex ${(i / 3) | 0} is not finite`);
  }
  for (let p = 0; p < mesh.polyCount; p++) {
    const n = mesh.polyVertexCount(p);
    if (n < 3) throw new Error(`loadNavMesh: polygon ${p} has ${n} vertices`);
    for (let k = 0; k < nvp; k++) {
      const v = mesh.polys[p * nvp + k]!;
      const adj = mesh.adjacency[p * nvp + k]!;
      if (k < n && !(v >= 0 && v < mesh.vertCount)) {
        throw new Error(`loadNavMesh: polygon ${p} names vertex ${v}`);
      }
      if (adj < -1 || adj >= mesh.polyCount || (k >= n && adj !== -1)) {
        throw new Error(`loadNavMesh: polygon ${p} edge ${k} names neighbour ${adj}`);
      }
    }
  }
  return mesh;
}
