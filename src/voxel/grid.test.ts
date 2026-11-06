import { describe, expect, it } from 'vitest';
import { createVoxelGrid, deserializeVoxelGrid } from './grid';

describe('createVoxelGrid', () => {
  it('stores blocks over a Uint8Array with air outside', () => {
    const g = createVoxelGrid({ sizeX: 20, sizeY: 10, sizeZ: 5, chunk: 16 });
    expect(g.data.length).toBe(20 * 10 * 5);
    expect(g.chunksX).toBe(2);
    expect(g.chunksY).toBe(1);
    expect(g.chunksZ).toBe(1);
    expect(g.chunkCount).toBe(2);
    expect(g.get(3, 4, 2)).toBe(0);
    expect(g.set(3, 4, 2, 7)).toBe(true);
    expect(g.get(3, 4, 2)).toBe(7);
    expect(g.data[g.index(3, 4, 2)]).toBe(7);
    expect(g.set(3, 4, 2, 7)).toBe(false);
    expect(g.get(-1, 0, 0)).toBe(0);
    expect(g.get(0, 0, 5, 9)).toBe(9);
    expect(g.set(-1, 0, 0, 1)).toBe(false);
    expect(g.inBounds(19, 9, 4)).toBe(true);
    expect(g.inBounds(20, 9, 4)).toBe(false);
  });

  it('bumps version and flags the chunk and its touched neighbours dirty', () => {
    const g = createVoxelGrid({ sizeX: 32, sizeY: 32, sizeZ: 32, chunk: 16 });
    for (let c = 0; c < g.chunkCount; c++) g.clearDirty(c);
    const v = g.version;
    g.set(5, 5, 5, 1);
    expect(g.version).toBe(v + 1);
    expect(g.forEachDirtyChunk(() => {})).toBe(1);
    expect(g.isDirty(0)).toBe(false);
    g.set(15, 5, 5, 1);
    const dirty: number[] = [];
    g.forEachDirtyChunk((c) => dirty.push(c));
    expect(dirty.sort()).toEqual([g.chunkIndex(0, 0, 0), g.chunkIndex(1, 0, 0)]);
    g.set(0, 16, 16, 1);
    const again: number[] = [];
    g.forEachDirtyChunk((c) => again.push(c));
    expect(again).toHaveLength(4);
    expect(g.chunkAt(17, 2, 2)).toBe(g.chunkIndex(1, 0, 0));
    const out = [0, 0, 0];
    g.chunkCoords(g.chunkIndex(1, 1, 0), out);
    expect(out).toEqual([1, 1, 0]);
  });

  it('setMany writes a flat list and reports the cells that changed', () => {
    const g = createVoxelGrid({ sizeX: 8, sizeY: 8, sizeZ: 8, chunk: 8 });
    expect(g.setMany([0, 0, 0, 1, 1, 0, 0, 2, 1, 0, 0, 2, 9, 0, 0, 3])).toBe(2);
    expect(g.get(1, 0, 0)).toBe(2);
    expect(g.version).toBe(2);
  });

  it('fill, chunkEmpty and markAllDirty', () => {
    const g = createVoxelGrid({ sizeX: 16, sizeY: 32, sizeZ: 16, chunk: 16 });
    g.fill((_x, y) => (y < 4 ? 1 : 0));
    expect(g.chunkEmpty(g.chunkIndex(0, 0, 0))).toBe(false);
    expect(g.chunkEmpty(g.chunkIndex(0, 1, 0))).toBe(true);
    for (let c = 0; c < g.chunkCount; c++) g.clearDirty(c);
    g.markAllDirty();
    expect(g.forEachDirtyChunk(() => {})).toBe(2);
    expect(g.forEachDirtyChunk(() => {})).toBe(0);
  });

  it('serializes to one buffer and back, byte-identical', () => {
    const g = createVoxelGrid({ sizeX: 7, sizeY: 5, sizeZ: 3, chunk: 4 });
    g.fill((x, y, z) => (x + y + z) % 3);
    const buf = g.serialize();
    expect(buf.byteLength).toBe(16 + 7 * 5 * 3);
    const h = deserializeVoxelGrid(buf);
    expect(h.sizeX).toBe(7);
    expect(h.sizeZ).toBe(3);
    expect(h.chunk).toBe(4);
    expect(h.chunkCount).toBe(g.chunkCount);
    expect(Array.from(h.data)).toEqual(Array.from(g.data));
    const k = createVoxelGrid({ sizeX: 7, sizeY: 5, sizeZ: 3, chunk: 4 });
    for (let c = 0; c < k.chunkCount; c++) k.clearDirty(c);
    k.deserialize(g.serialize());
    expect(Array.from(k.data)).toEqual(Array.from(g.data));
    expect(k.forEachDirtyChunk(() => {})).toBe(k.chunkCount);
    const wrong = createVoxelGrid({ sizeX: 8, sizeY: 5, sizeZ: 3, chunk: 4 });
    expect(() => wrong.deserialize(buf)).toThrow();
  });

  it('subscribers hear sets and resets until unsubscribed', () => {
    const g = createVoxelGrid({ sizeX: 4, sizeY: 4, sizeZ: 4, chunk: 4 });
    const sets: number[][] = [];
    let resets = 0;
    const off = g.subscribe({
      set: (x, y, z, b) => sets.push([x, y, z, b]),
      reset: () => resets++,
    });
    g.set(1, 2, 3, 4);
    g.set(1, 2, 3, 4);
    g.fill(() => 1);
    g.deserialize(g.serialize());
    expect(sets).toEqual([[1, 2, 3, 4]]);
    expect(resets).toBe(2);
    off();
    g.set(0, 0, 0, 2);
    expect(sets).toHaveLength(1);
  });
});
