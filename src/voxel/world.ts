/**
 * `createVoxelWorld`: a streamed voxel world drawn on the retained render core (D1 §2.8). The
 * game puts sections in (from a server, a generator or `createVoxelGrid`); the world meshes the
 * ready ones nearest the interest point first in the mesher Workers, uploads each result
 * straight into core arenas as one slot per stream of three static, GPU-culled draw sets
 * (opaque and cutout, foliage and crosses, liquid), and hides what connectivity (cave) culling
 * says the camera cannot see into.
 *
 * A frame of a held world costs the same GPU calls at any radius (each set executes one cached
 * bundle after one cull dispatch) and allocates nothing. Streaming is budgeted: results wait in
 * a queue and at most `uploadsPerFrame` reach the GPU per frame, nearest first, all in one
 * batch, so a set's bundle is recorded again at most once a frame and never for a frame with
 * nothing new.
 */
import type { Arena, ArenaAlloc } from '../render/core/arena';
import type { RenderCore } from '../render/core/core';
import type { DrawSet } from '../render/core/draw-set';
import { createInstanceLayout, createVertexLayout } from '../render/core/layout';
import { FACE_CLASS } from './blocks';
import {
  RAW_SECTION_CODEC,
  type SectionCodec,
  sectionKey,
  sectionKeyX,
  sectionKeyY,
  sectionKeyZ,
  type VoxelFormat,
} from './format';
import { inThreadMesherPort, type MesherPort, SectionMeshPool } from './pool';
import type { VoxelHit } from './ray';
import type { SectionMeshResult } from './section-protocol';
import { raycastCells, sectionRayProbe } from './section-ray';
import { createSectionStore, type SectionStore } from './store';
import { type SectionBox, SectionVisibility } from './visibility';
import { VOXEL_DEFAULT_FRAGMENT, type VoxelStream, voxelVertexWgsl } from './world-shaders';

/** A stream's look: a fragment entry over `VoxelVarying`, and the bind groups it reads. */
export interface VoxelMaterial {
  /**
   * WGSL with `@fragment fn fs(in: VoxelVarying) -> @location(0) vec4f` and its helpers. It
   * follows the world's vertex stage, so `decode_voxel_vertex`, `VoxelVarying` and `view` are
   * in scope.
   */
  fragment: string;
  /** The material's own bind groups at 1, 2, …. */
  bindGroups?: readonly { layout: GPUBindGroupLayout; group: GPUBindGroup }[];
  /** Default: none for opaque and foliage, alpha blending for liquid. */
  blend?: GPUBlendState;
}

/** Options for `createVoxelWorld`. */
export interface VoxelWorldOptions {
  format: VoxelFormat;
  /** How section bytes become cells (Workers decode with their own). Default `RAW_SECTION_CODEC`. */
  codec?: SectionCodec;
  /** A store the world draws from; default one made from the options below. */
  store?: SectionStore;
  /** The cell of empty space. Default 0. */
  air?: number;
  /** The world's section rows (see `SectionStoreOptions`). */
  minSectionY?: number;
  maxSectionY?: number;
  outside?: number;
  /**
   * The mesher threads: `MesherPort`s (`workerMesherPort(new Worker(...))`), or none for one
   * in-thread mesher (meshing then costs frame time).
   */
  workers?: MesherPort[];
  /** A port to replace a dead Worker (see `SectionMeshPoolOptions.respawn`). */
  respawn?: (index: number) => MesherPort;
  /** Jobs in flight per Worker. Default 2. */
  perWorker?: number;
  /** Merge faces greedily. Default true. */
  greedy?: boolean;
  /** The game's looks per stream; a missing one is the engine's plain default. */
  materials?: Partial<Record<VoxelStream, VoxelMaterial>>;
  /** Horizontal radius held around the interest point, in sections. Default 8. */
  radius?: number;
  /** Rows searched above and below the interest point. Default `radius` (at most the world's rows). */
  verticalRadius?: number;
  /** Most section results uploaded per frame. Default 32. */
  uploadsPerFrame?: number;
  /** Slots per set. Default enough for every section in the radius. */
  capacity?: number;
  /** Connectivity (cave) culling. Default true. */
  caveCulling?: boolean;
  /** Bytes per vertex arena block. Default 64 MiB. */
  vertexBlockBytes?: number;
  /** Clock, ms. Default `performance.now`. */
  clock?: () => number;
  label?: string;
}

/** What `VoxelWorld.stats` reports. */
export interface VoxelWorldStats {
  /** Sections held by the store, and sections with geometry on the GPU. */
  sections: number;
  drawn: number;
  /** Of `drawn`, how many cave culling hides. */
  hidden: number;
  /** Mesh results waiting to upload. */
  pending: number;
  /** Results uploaded this frame, and in all. */
  uploads: number;
  uploadsTotal: number;
  /** Quads on the GPU per stream. */
  opaqueQuads: number;
  foliageQuads: number;
  liquidQuads: number;
  /** Vertex bytes in use. */
  vertexBytes: number;
  /** This frame's `update` on the page, ms, and the most any frame's took. */
  updateMs: number;
  maxUpdateMs: number;
  /** Jobs queued and in flight in the pool. */
  queued: number;
  inFlight: number;
}

/** A streamed voxel world (see the file comment). Keys are `sectionKey(sx, sy, sz)`. */
export interface VoxelWorld {
  readonly format: VoxelFormat;
  readonly store: SectionStore;
  readonly pool: SectionMeshPool;
  readonly visibility: SectionVisibility;
  /** The three draw sets, for a game that wants to reorder or inspect them. */
  readonly sets: Readonly<Record<VoxelStream, DrawSet>>;
  readonly stats: VoxelWorldStats;
  /** Add or replace a section from its encoded bytes. */
  putSection(sx: number, sy: number, sz: number, bytes: Uint8Array): void;
  /** Forget a section and its geometry. */
  dropSection(sx: number, sy: number, sz: number): void;
  /** Set cells of one section (`SectionStore.edit`); the changed sections mesh again. */
  edit(key: number, changes: ArrayLike<number>): number[];
  /** The point (world blocks) meshing and the visibility area centre on: usually the camera. */
  setInterest(x: number, y: number, z: number): void;
  /**
   * Once a frame before `core.prepare`, with the eye (world blocks): queue ready sections,
   * feed the Workers, upload up to `uploadsPerFrame` results nearest first and apply cave
   * culling. Allocates nothing while the world is held.
   */
  update(eyeX: number, eyeY: number, eyeZ: number): void;
  /** The first solid cell along a ray (`raycastCells` over the store). */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: VoxelHit,
  ): number;
  /** Nothing waiting as of the last `update`: no dirty ready sections, jobs or uploads. */
  readonly settled: boolean;
  /** Free the GPU memory and stop the Workers. */
  dispose(): void;
}

const STREAMS: readonly VoxelStream[] = ['opaque', 'foliage', 'liquid'];
const VERTEX_BYTES = 8;
/** Quads start on a 4-vertex boundary so `vertex_index & 3` is the corner. */
const QUAD_ALIGN = 4 * VERTEX_BYTES;
const ORIGIN_BYTES = 16;
const HIDDEN_RADIUS = -3e38;

const PACKED = createVertexLayout({
  stride: VERTEX_BYTES,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const ORIGIN = createInstanceLayout({
  stride: ORIGIN_BYTES,
  attributes: [{ name: 'origin', format: 'float32x4', offset: 0 }],
});
const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

interface Section {
  key: number;
  sx: number;
  sy: number;
  sz: number;
  /** Slot id per stream, or −1. */
  slots: Int32Array;
  allocs: (ArenaAlloc | null)[];
  quads: Int32Array;
  origin: ArenaAlloc | null;
  /** Sphere of the geometry, world blocks. */
  bounds: Float64Array;
  hidden: boolean;
}

/**
 * Make a world on a render core. The sets join the core's `opaque`, `cutout` and `transparent`
 * passes; draw the core as usual (`prepare`, then `draw` per view) after `update`.
 */
export function createVoxelWorld(core: RenderCore, opts: VoxelWorldOptions): VoxelWorld {
  const format = opts.format;
  const S = format.size;
  const label = opts.label ?? 'voxel';
  const clock = opts.clock ?? (() => performance.now());
  const codec = opts.codec ?? RAW_SECTION_CODEC;
  const store =
    opts.store ??
    createSectionStore({
      format,
      codec,
      air: opts.air,
      minSectionY: opts.minSectionY,
      maxSectionY: opts.maxSectionY,
      outside: opts.outside,
    });
  const radius = opts.radius ?? 8;
  const minY = opts.minSectionY ?? Number.NEGATIVE_INFINITY;
  const maxY = opts.maxSectionY ?? Number.POSITIVE_INFINITY;
  const bounded = Number.isFinite(minY) && Number.isFinite(maxY);
  const vRadius = opts.verticalRadius ?? (bounded ? Math.min(radius, maxY - minY + 1) : radius);
  const rows = bounded ? Math.min(maxY - minY + 1, 2 * vRadius + 1) : 2 * vRadius + 1;
  const side = 2 * radius + 1;
  const capacity = opts.capacity ?? Math.max(256, side * side * rows + 64);
  const uploadsPerFrame = Math.max(1, opts.uploadsPerFrame ?? 32);

  const vertices: Arena = core.createArena({
    kind: 'vertex',
    blockBytes: opts.vertexBlockBytes,
    label: `${label} vertices`,
  });
  const instances: Arena = core.createArena({
    kind: 'instance',
    blockBytes: Math.max(1 << 16, capacity * ORIGIN_BYTES * 2),
    label: `${label} origins`,
  });
  const vertex = voxelVertexWgsl(format);
  const makeSet = (stream: VoxelStream): DrawSet => {
    const m = opts.materials?.[stream];
    return core.createDrawSet({
      label: `${label} ${stream}`,
      shader: {
        code: `${vertex}\n${m?.fragment ?? VOXEL_DEFAULT_FRAGMENT[stream]}`,
        blend: m?.blend ?? (stream === 'liquid' ? ALPHA_BLEND : undefined),
        cullMode: stream === 'opaque' ? 'back' : 'none',
      },
      vertexLayout: PACKED,
      instanceLayout: ORIGIN,
      vertices,
      instances,
      capacity,
      kind: 'static',
      cull: 'gpu',
      pass: stream === 'opaque' ? 'opaque' : stream === 'foliage' ? 'cutout' : 'transparent',
      bindGroups: m?.bindGroups,
    });
  };
  const sets: Record<VoxelStream, DrawSet> = {
    opaque: makeSet('opaque'),
    foliage: makeSet('foliage'),
    liquid: makeSet('liquid'),
  };

  const { idShift, idMask } = format;
  const faceClass = format.blocks.faceClass;
  const solidAt = (x: number, y: number, z: number): boolean => {
    const cell = store.cellAt(x, y, z);
    if (cell === undefined) return false;
    return faceClass[(cell >>> idShift) & idMask] === FACE_CLASS.opaque;
  };
  const visibility = new SectionVisibility({
    sectionSize: S,
    solidAt,
    clock,
    wrapXZ: 1 << Math.ceil(Math.log2(side + 4)),
    wrapY: 1 << Math.ceil(Math.log2(2 * vRadius + 1 + 4)),
  });
  visibility.enabled = opts.caveCulling !== false;

  const sections = new Map<number, Section>();
  const pending = new Map<number, SectionMeshResult>();
  const order: number[] = [];
  const ready: number[] = [];
  const interest = { x: 0, y: 0, z: 0, sx: Number.NaN, sy: Number.NaN, sz: Number.NaN };
  const area: SectionBox = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  let seenVisibility = -1;
  const stats: VoxelWorldStats = {
    sections: 0,
    drawn: 0,
    hidden: 0,
    pending: 0,
    uploads: 0,
    uploadsTotal: 0,
    opaqueQuads: 0,
    foliageQuads: 0,
    liquidQuads: 0,
    vertexBytes: 0,
    updateMs: 0,
    maxUpdateMs: 0,
    queued: 0,
    inFlight: 0,
  };

  const distance2 = (key: number): number => {
    const dx = sectionKeyX(key) - interest.sx;
    const dy = sectionKeyY(key) - interest.sy;
    const dz = sectionKeyZ(key) - interest.sz;
    return dx * dx + dy * dy + dz * dz;
  };
  const byDistance = (a: number, b: number): number => distance2(a) - distance2(b);

  const ports =
    opts.workers && opts.workers.length > 0 ? opts.workers : [inThreadMesherPort(codec)];
  const pool = new SectionMeshPool({
    format,
    ports,
    build: (key) => (store.ready(key) ? store.jobFor(key) : null),
    onMesh: (key, result) => {
      if (store.has(key)) pending.set(key, result);
    },
    greedy: opts.greedy,
    perWorker: opts.perWorker,
    respawn: opts.respawn,
  });
  const inFlightGoal = pool.size * (opts.perWorker ?? 2) * 2;

  function freeSlots(sec: Section): void {
    for (let i = 0; i < 3; i++) {
      const id = sec.slots[i]!;
      if (id >= 0) sets[STREAMS[i]!].remove(id);
      sec.slots[i] = -1;
      const a = sec.allocs[i];
      if (a) vertices.free(a);
      sec.allocs[i] = null;
      sec.quads[i] = 0;
    }
  }

  function setQuads(): void {
    let o = 0;
    let f = 0;
    let l = 0;
    let drawn = 0;
    let hidden = 0;
    for (const sec of sections.values()) {
      o += sec.quads[0]!;
      f += sec.quads[1]!;
      l += sec.quads[2]!;
      if (sec.slots[0]! >= 0 || sec.slots[1]! >= 0 || sec.slots[2]! >= 0) {
        drawn++;
        if (sec.hidden) hidden++;
      }
    }
    stats.opaqueQuads = o;
    stats.foliageQuads = f;
    stats.liquidQuads = l;
    stats.drawn = drawn;
    stats.hidden = hidden;
  }

  function placeBounds(sec: Section, i: number): void {
    const id = sec.slots[i]!;
    if (id < 0) return;
    const b = sec.bounds;
    sets[STREAMS[i]!].setBounds(id, b[0]!, b[1]!, b[2]!, sec.hidden ? HIDDEN_RADIUS : b[3]!);
  }

  function upload(key: number, r: SectionMeshResult): void {
    let sec = sections.get(key);
    const m = r.mesh;
    if (!sec) {
      sec = {
        key,
        sx: r.sx,
        sy: r.sy,
        sz: r.sz,
        slots: new Int32Array([-1, -1, -1]),
        allocs: [null, null, null],
        quads: new Int32Array(3),
        origin: null,
        bounds: new Float64Array(4),
        hidden: !visibility.reached(r.sx, r.sy, r.sz),
      };
      sections.set(key, sec);
    }
    visibility.set(r.sx, r.sy, r.sz, m.connectivity, m.openCells, m.dark);
    const ox = r.sx * S;
    const oy = r.sy * S;
    const oz = r.sz * S;
    const bb = m.bounds;
    const hx = (bb[3]! - bb[0]!) / 2;
    const hy = (bb[4]! - bb[1]!) / 2;
    const hz = (bb[5]! - bb[2]!) / 2;
    sec.bounds[0] = ox + bb[0]! + hx;
    sec.bounds[1] = oy + bb[1]! + hy;
    sec.bounds[2] = oz + bb[2]! + hz;
    sec.bounds[3] = Math.sqrt(hx * hx + hy * hy + hz * hz) + 0.01;
    const quads = [m.opaqueQuads, m.foliageQuads, m.liquidQuads];
    const data = [m.opaque, m.foliage, m.liquid];
    if (quads[0]! + quads[1]! + quads[2]! > 0 && !sec.origin) {
      sec.origin = instances.alloc(ORIGIN_BYTES, ORIGIN_BYTES);
      instances.write(sec.origin, new Float32Array([ox, oy, oz, 1]));
    }
    for (let i = 0; i < 3; i++) {
      const set = sets[STREAMS[i]!];
      const n = quads[i]!;
      const old = sec.allocs[i];
      if (n === 0) {
        if (sec.slots[i]! >= 0) set.remove(sec.slots[i]!);
        if (old) vertices.free(old);
        sec.slots[i] = -1;
        sec.allocs[i] = null;
        sec.quads[i] = 0;
        continue;
      }
      const a = vertices.alloc(n * 4 * VERTEX_BYTES, QUAD_ALIGN);
      vertices.write(a, data[i]!);
      const slot = {
        vertices: a,
        indexCount: n * 6,
        instances: sec.origin!,
        instanceCount: 1,
        bounds: [
          sec.bounds[0]!,
          sec.bounds[1]!,
          sec.bounds[2]!,
          sec.hidden ? HIDDEN_RADIUS : sec.bounds[3]!,
        ],
      };
      if (sec.slots[i]! >= 0) set.update(sec.slots[i]!, slot);
      else sec.slots[i] = set.add(slot);
      if (old) vertices.free(old);
      sec.allocs[i] = a;
      sec.quads[i] = n;
    }
    if (quads[0]! + quads[1]! + quads[2]! === 0 && sec.origin) {
      instances.free(sec.origin);
      sec.origin = null;
    }
  }

  function moveArea(): void {
    area.minX = interest.sx - radius;
    area.maxX = interest.sx + radius;
    area.minZ = interest.sz - radius;
    area.maxZ = interest.sz + radius;
    // Not clamped to the world's rows: the sky above (unknown, so open) is where eyes fly.
    area.minY = interest.sy - vRadius;
    area.maxY = interest.sy + vRadius;
    visibility.setArea(area);
  }

  const probe = sectionRayProbe(store);
  let disposed = false;
  let held = 0;
  /** Whether the store may hold more dirty ready sections than the last take moved. */
  let readyLeft = true;
  let lastNow = 0;

  const world: VoxelWorld = {
    format,
    store,
    pool,
    visibility,
    sets,
    stats,
    putSection(sx, sy, sz, bytes) {
      if (!store.has(sectionKey(sx, sy, sz))) held++;
      store.putSection(sx, sy, sz, bytes);
      readyLeft = true;
    },
    dropSection(sx, sy, sz) {
      const key = sectionKey(sx, sy, sz);
      if (store.has(key)) held--;
      store.dropSection(key);
      pool.cancel(key);
      pending.delete(key);
      const sec = sections.get(key);
      if (sec) {
        freeSlots(sec);
        if (sec.origin) instances.free(sec.origin);
        sections.delete(key);
      }
      visibility.clear(sx, sy, sz);
    },
    edit(key, changes) {
      readyLeft = true;
      return store.edit(key, changes);
    },
    setInterest(x, y, z) {
      interest.x = x;
      interest.y = y;
      interest.z = z;
      store.setInterest(x, y, z);
      const sx = Math.floor(x / S);
      const sy = Math.floor(y / S);
      const sz = Math.floor(z / S);
      if (sx !== interest.sx || sy !== interest.sy || sz !== interest.sz) {
        interest.sx = sx;
        interest.sy = sy;
        interest.sz = sz;
        moveArea();
        pool.reprioritize(distance2);
      }
    },
    update(ex, ey, ez) {
      // The clock is read only when there is work: a held frame reads none (and allocates none).
      const busy = readyLeft || !pool.idle || pending.size > 0 || visibility.throttled;
      const t0 = busy ? clock() : lastNow;
      lastNow = t0;
      // Feed the pool only as fast as it drains, so nearest-first follows a moving camera.
      const room = inFlightGoal - pool.stats.queued;
      if (readyLeft && room > 0) {
        const n = store.takeReady(ready, room);
        for (let i = 0; i < n; i++) pool.enqueue(ready[i]!, distance2(ready[i]!));
        readyLeft = n === room;
      }
      pool.pump();
      stats.uploads = 0;
      if (pending.size > 0) {
        order.length = 0;
        for (const key of pending.keys()) order.push(key);
        if (order.length > uploadsPerFrame) order.sort(byDistance);
        const n = Math.min(uploadsPerFrame, order.length);
        for (let i = 0; i < n; i++) {
          const key = order[i]!;
          const r = pending.get(key)!;
          pending.delete(key);
          if (store.has(key)) upload(key, r);
        }
        stats.uploads = n;
        stats.uploadsTotal += n;
        setQuads();
      }
      if (Number.isNaN(interest.sx)) world.setInterest(ex, ey, ez);
      visibility.update(ex, ey, ez, Math.floor(t0));
      if (visibility.version !== seenVisibility) {
        seenVisibility = visibility.version;
        let hidden = 0;
        for (const sec of sections.values()) {
          const h = !visibility.reached(sec.sx, sec.sy, sec.sz);
          if (h) hidden++;
          if (h === sec.hidden) continue;
          sec.hidden = h;
          for (let i = 0; i < 3; i++) placeBounds(sec, i);
        }
        stats.hidden = hidden;
      }
      stats.sections = held;
      stats.pending = pending.size;
      stats.queued = pool.stats.queued;
      stats.inFlight = pool.stats.inFlight;
      stats.vertexBytes = vertices.usedBytes;
      if (busy) {
        const ms = clock() - t0;
        stats.updateMs = ms;
        if (ms > stats.maxUpdateMs) stats.maxUpdateMs = ms;
      } else if (stats.updateMs !== 0) stats.updateMs = 0;
    },
    raycast(ox, oy, oz, dx, dy, dz, maxDistance, out) {
      return raycastCells(probe, ox, oy, oz, dx, dy, dz, maxDistance, out);
    },
    get settled() {
      return !readyLeft && pool.idle && pending.size === 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pool.terminate();
      for (const s of STREAMS) core.removeDrawSet(sets[s]);
      vertices.destroy();
      instances.destroy();
      sections.clear();
      pending.clear();
    },
  };
  return world;
}
