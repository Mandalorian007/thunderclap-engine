import { describe, expect, it } from 'vitest';
import {
  CHUNK,
  CHUNK_BUFFER_BYTES,
  INDEX_OFFSET,
  MAX_INDICES,
  MAX_VERTICES,
  meshChunk,
  VERTEX_FLOATS,
} from './mesher';
import { createTerrain, heightAt, LAYER_COUNT, type Terrain } from './terrain';

/** A terrain with hand-set heights (row-major by z), for exact face counts. */
function flat(size: number, height: number): Terrain {
  return { seed: 0, size, heights: new Uint8Array(size * size).fill(height) };
}

describe('meshChunk', () => {
  it('fits the worst case in the buffer and keeps indices uint16', () => {
    expect(MAX_VERTICES).toBeLessThanOrEqual(65536);
    expect(CHUNK_BUFFER_BYTES).toBeGreaterThanOrEqual(INDEX_OFFSET + MAX_INDICES * 2);
    expect(INDEX_OFFSET % 4).toBe(0);
  });

  it('meshes a flat chunk as 256 tops plus the four outer walls', () => {
    const t = flat(CHUNK, 3);
    const buffer = new ArrayBuffer(CHUNK_BUFFER_BYTES);
    const m = meshChunk(t, 0, 0, buffer);
    const quads = CHUNK * CHUNK + 4 * CHUNK;
    expect(m.vertexCount).toBe(quads * 4);
    expect(m.indexCount).toBe(quads * 6);
    // The bounds hold the slab: centre over the chunk, radius reaching its corners.
    expect(m.bounds.center).toEqual([CHUNK / 2, 1.5, CHUNK / 2]);
    expect(m.bounds.radius).toBeCloseTo(Math.hypot(CHUNK / 2, 1.5, CHUNK / 2));
  });

  it('writes every vertex inside the chunk with a unit normal and a valid layer', () => {
    const t = createTerrain(5, CHUNK * 2);
    const buffer = new ArrayBuffer(CHUNK_BUFFER_BYTES);
    const m = meshChunk(t, 1, 1, buffer);
    expect(m.vertexCount).toBeGreaterThan(CHUNK * CHUNK * 4);
    expect(m.vertexCount).toBeLessThanOrEqual(MAX_VERTICES);
    expect(m.indexCount).toBeLessThanOrEqual(MAX_INDICES);
    const verts = new Float32Array(buffer, 0, m.vertexCount * VERTEX_FLOATS);
    const idx = new Uint16Array(buffer, INDEX_OFFSET, m.indexCount);
    for (let v = 0; v < verts.length; v += VERTEX_FLOATS) {
      expect(verts[v]).toBeGreaterThanOrEqual(0);
      expect(verts[v]).toBeLessThanOrEqual(CHUNK);
      expect(verts[v + 2]).toBeGreaterThanOrEqual(0);
      expect(verts[v + 2]).toBeLessThanOrEqual(CHUNK);
      expect(Math.hypot(verts[v + 3]!, verts[v + 4]!, verts[v + 5]!)).toBeCloseTo(1);
      const layer = verts[v + 11]!;
      expect(Number.isInteger(layer)).toBe(true);
      expect(layer).toBeGreaterThanOrEqual(0);
      expect(layer).toBeLessThan(LAYER_COUNT);
    }
    for (const i of idx) expect(i).toBeLessThan(m.vertexCount);
  });

  it('emits a side only where a column stands above its neighbour', () => {
    const t = flat(CHUNK, 2);
    // One tall column in the middle: 4 extra walls of height 3 (its drop), plus its top.
    t.heights[5 * CHUNK + 7] = 5;
    const buffer = new ArrayBuffer(CHUNK_BUFFER_BYTES);
    const m = meshChunk(t, 0, 0, buffer);
    const quads = CHUNK * CHUNK + 4 * CHUNK + 4;
    expect(m.vertexCount).toBe(quads * 4);
    // The tall column's top sits at y = 5 and its walls span 2..5.
    const verts = new Float32Array(buffer, 0, m.vertexCount * VERTEX_FLOATS);
    let topAtFive = 0;
    let maxY = 0;
    for (let v = 0; v < verts.length; v += VERTEX_FLOATS) {
      maxY = Math.max(maxY, verts[v + 1]!);
      if (verts[v + 1] === 5 && verts[v + 4] === 1) topAtFive++;
    }
    expect(topAtFive).toBe(4);
    expect(maxY).toBe(heightAt(t, 7, 5));
    expect(m.bounds.center[1]).toBeCloseTo(2.5);
  });

  it('uses the chunk offset: chunk (1, 0) meshes columns 16..31', () => {
    const t = flat(CHUNK * 2, 1);
    t.heights[0 * CHUNK * 2 + 20] = 4;
    const a = meshChunk(t, 0, 0, new ArrayBuffer(CHUNK_BUFFER_BYTES));
    const b = meshChunk(t, 1, 0, new ArrayBuffer(CHUNK_BUFFER_BYTES));
    // Chunk 0 is flat; its east and south edges face other chunks at the same height, so only
    // the two outer walls (x = 0, z = 0) are emitted.
    expect(a.vertexCount).toBe((CHUNK * CHUNK + 2 * CHUNK) * 4);
    expect(b.vertexCount).toBeGreaterThan(a.vertexCount);
  });
});
