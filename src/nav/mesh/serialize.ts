/**
 * Navmesh bytes: bake at build time, ship the buffer, `importNavMesh` at load. Little-endian,
 * self-describing header; off-mesh links travel with the mesh (their `userData` does not).
 */
import { addOffMeshLink } from './links';
import { NavMesh } from './navmesh';

const MAGIC = 0x4e41564d; // 'NAVM'
const FORMAT = 1;
const HEADER_U32 = 7;
const LINK_F32 = 10;

/** Serialises the mesh (polygons, adjacency, links) into a fresh buffer. */
export function exportNavMesh(mesh: NavMesh): ArrayBuffer {
  const nvp = mesh.maxVertsPerPoly;
  const links = mesh.links.filter((l) => l !== null);
  const bytes =
    HEADER_U32 * 4 +
    2 * 4 +
    6 * 4 +
    mesh.vertCount * 3 * 4 +
    mesh.polyCount * nvp * 4 * 2 +
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
  if (format !== FORMAT) throw new Error(`importNavMesh: unsupported format ${format}`);
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
  const mesh = new NavMesh(verts, vertCount, polys, polyCount, nvp, cs, ch, adjacency);
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
