import { describe, expect, it } from 'vitest';
import { createVoxelGrid } from './grid';
import { installVoxelMesherWorker, type VoxelWorkerScopeLike } from './mesher-worker';
import {
  type ChunkMesh,
  createVoxelMesher,
  type VoxelMesherReply,
  type VoxelMesherRequest,
  type VoxelWorkerLike,
} from './worker-client';

/**
 * A fake Worker: the page side records requests; `run()` hands them to a real
 * `installVoxelMesherWorker` on a fake scope and delivers its replies back, so the test sees
 * the whole round trip with the order under its control.
 */
function fakeWorker() {
  const sent: VoxelMesherRequest[] = [];
  const transfers: Transferable[][] = [];
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const replies: VoxelMesherReply[] = [];
  const scope: VoxelWorkerScopeLike = {
    postMessage: (m) => replies.push(m),
    addEventListener: () => {},
  };
  const handle = installVoxelMesherWorker({}, scope);
  const worker: VoxelWorkerLike = {
    postMessage: (m, t) => {
      sent.push(m);
      transfers.push(t ?? []);
    },
    addEventListener: (_t, l) => listeners.push(l),
    removeEventListener: (_t, l) => listeners.splice(listeners.indexOf(l), 1),
  };
  /** Process every request sent so far on the worker side (no replies delivered yet). */
  const work = () => {
    while (sent.length > 0) handle(sent.shift()!);
  };
  /** Deliver the worker's replies to the page side. */
  const deliver = () => {
    while (replies.length > 0) {
      const r = replies.shift()!;
      for (const l of listeners) l({ data: r });
    }
  };
  return { worker, sent, transfers, listeners, replies, work, deliver };
}

function flat() {
  const g = createVoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 16, chunk: 16 });
  g.fill((_x, y) => (y < 2 ? 1 : 0));
  return g;
}

async function settled<T>(p: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([p, Promise.resolve('pending' as const)]);
}

describe('createVoxelMesher with a worker', () => {
  it('sends the grid once as a transferable, then mirrors sets', () => {
    const grid = flat();
    const f = fakeWorker();
    const m = createVoxelMesher(grid, { worker: f.worker });
    expect(m.offThread).toBe(true);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.type).toBe('grid');
    expect(f.transfers[0]).toHaveLength(1);
    grid.set(3, 5, 7, 2);
    expect(f.sent[1]).toEqual({ type: 'set', x: 3, y: 5, z: 7, block: 2 });
    grid.fill(() => 0);
    expect(f.sent[2]!.type).toBe('grid');
    m.dispose();
    grid.set(1, 1, 1, 1);
    expect(f.sent).toHaveLength(3);
    expect(f.listeners).toHaveLength(0);
  });

  it('remesh resolves with the worker reply in MeshReply shape', async () => {
    const grid = flat();
    const f = fakeWorker();
    const m = createVoxelMesher(grid, { worker: f.worker });
    const p = m.remesh(1);
    expect(m.pending).toBe(1);
    expect(f.sent.at(-1)).toEqual({ type: 'mesh', chunk: 1 });
    f.work();
    expect(f.replies).toHaveLength(1);
    const r = f.replies[0]!;
    expect(r.chunk).toBe(1);
    expect(r.vertexCount).toBe(20); // the slab's five open faces (the sixth meets chunk 0)
    expect(r.indexCount).toBe(30);
    expect(r.indexOffset).toBe(20 * 12 * 4);
    expect(r.buffer.byteLength).toBe(r.indexOffset + 30 * 4);
    expect(r.bounds.center).toEqual([8, 1, 8]);
    f.deliver();
    const mesh = await p;
    expect(mesh).toBe(r);
    expect(m.pending).toBe(0);
  });

  it('coalesces repeat requests for a chunk in flight into one follow-up', async () => {
    const grid = flat();
    const f = fakeWorker();
    const m = createVoxelMesher(grid, { worker: f.worker });
    const a = m.remesh(0);
    const b = m.remesh(0);
    const c = m.remesh(0);
    const other = m.remesh(1);
    expect(b).toBe(c);
    expect(a).not.toBe(b);
    expect(m.pending).toBe(3);
    expect(f.sent.filter((s) => s.type === 'mesh')).toEqual([
      { type: 'mesh', chunk: 0 },
      { type: 'mesh', chunk: 1 },
    ]);
    grid.set(0, 5, 0, 3); // lands after the first run, before the follow-up
    f.work();
    f.deliver();
    const first = await a;
    expect(first.chunk).toBe(0);
    expect((await other).chunk).toBe(1);
    expect(await settled(b)).toBe('pending');
    // The follow-up went out once the first reply came back, and sees the edit.
    expect(f.sent.filter((s) => s.type === 'mesh')).toEqual([{ type: 'mesh', chunk: 0 }]);
    f.work();
    f.deliver();
    const second = await b;
    expect(second.vertexCount).toBeGreaterThan(first.vertexCount);
    expect(m.pending).toBe(0);
  });

  it('ignores replies for chunks it did not ask for and foreign messages', async () => {
    const grid = flat();
    const f = fakeWorker();
    const m = createVoxelMesher(grid, { worker: f.worker });
    for (const l of f.listeners) {
      l({ data: null });
      l({ data: { type: 'other' } });
      l({ data: { type: 'mesh', chunk: 5 } });
    }
    expect(m.pending).toBe(0);
  });
});

describe('createVoxelMesher in-thread', () => {
  it('meshes on a microtask with the same reply shape', async () => {
    const grid = flat();
    const m = createVoxelMesher(grid);
    expect(m.offThread).toBe(false);
    const p = m.remesh(0);
    const same = m.remesh(0);
    expect(same).toBe(p);
    expect(m.pending).toBe(1);
    const r: ChunkMesh = await p;
    expect(r.chunk).toBe(0);
    expect(r.vertexCount).toBe(20);
    expect(r.indexCount).toBe(30);
    expect(r.indexOffset).toBe(20 * 12 * 4);
    expect(new Uint32Array(r.buffer, r.indexOffset, 6).length).toBe(6);
    expect(m.pending).toBe(0);
    m.sync(); // a no-op without a worker
    const empty = await m.remesh(1);
    expect(empty.vertexCount).toBe(20);
    grid.fill(() => 0);
    const none = await m.remesh(1);
    expect(none.vertexCount).toBe(0);
    expect(none.buffer.byteLength).toBe(0);
    expect(none.bounds.radius).toBe(0);
    m.dispose();
  });

  it('honours the mesher options', async () => {
    const grid = flat();
    const m = createVoxelMesher(grid, { ao: false, layerOf: (b, face) => b * 10 + face });
    const r = await m.remesh(0);
    const v = new Float32Array(r.buffer, 0, r.vertexCount * 12);
    const layers = new Set<number>();
    for (let i = 0; i < r.vertexCount; i++) layers.add(v[i * 12 + 11]!);
    expect([...layers].sort()).toEqual([11, 12, 13, 14, 15]); // no +x face: chunk 1 covers it
  });
});

describe('installVoxelMesherWorker', () => {
  it('listens on the scope, waits for a grid and applies sets before meshing', () => {
    const grid = flat();
    const replies: VoxelMesherReply[] = [];
    let listener: ((e: { data: unknown }) => void) | null = null;
    installVoxelMesherWorker(
      {},
      {
        postMessage: (m) => replies.push(m),
        addEventListener: (_t, l) => {
          listener = l;
        },
      },
    );
    const post = (data: unknown) => listener!({ data });
    post({ type: 'mesh', chunk: 0 }); // no grid yet: dropped
    post('junk');
    expect(replies).toHaveLength(0);
    post({ type: 'grid', buffer: grid.serialize() });
    post({ type: 'set', x: 0, y: 5, z: 0, block: 1 });
    post({ type: 'mesh', chunk: 0 });
    expect(replies).toHaveLength(1);
    expect(replies[0]!.type).toBe('mesh');
    expect(replies[0]!.vertexCount).toBe(20 + 6 * 4); // the slab's five faces plus a floating block
  });
});
