/**
 * The chunk upload, exactly as the world scene does it, on the engine's fake GPU: the mesher
 * writes one chunk into a transfer buffer (what the Worker sends), the scene's fixed-capacity
 * mesh takes views over it, and the draw is one indexed call of `indexCount` indices. A layout
 * mismatch (vertex size, index offset, capacity) shows up here as a device error, not as a
 * blank screen.
 */
import { Renderer, Transform, VERTEX_LAYOUT_3D } from '@thunderclap-engine/engine/render';
import { createFakeDevice, fakeRendererGpu } from '@thunderclap-engine/engine/testing';
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
import { createTerrain, SEED } from './terrain';

describe('chunk upload', () => {
  it('the mesher output fits the scene mesh and draws in one indexed call', () => {
    expect(VERTEX_FLOATS * 4).toBe(VERTEX_LAYOUT_3D.stride);

    const fake = createFakeDevice();
    const renderer = new Renderer(fakeRendererGpu(fake));
    const material = renderer.createMaterial({ label: 'blocks', blend: 'opaque', wgsl: '' });
    const mesh = renderer.createMesh({
      label: 'chunk-1-2',
      layout: VERTEX_LAYOUT_3D,
      capacity: { vertices: MAX_VERTICES, indices: MAX_INDICES },
    });

    const buffer = new ArrayBuffer(CHUNK_BUFFER_BYTES);
    const { vertexCount, indexCount, bounds } = meshChunk(createTerrain(SEED), 1, 2, buffer);
    expect(indexCount).toBeGreaterThan(0);
    mesh.update({
      vertices: new Float32Array(buffer, 0, vertexCount * VERTEX_FLOATS),
      indices: new Uint16Array(buffer, INDEX_OFFSET, indexCount),
      vertexCount,
      indexCount,
      bounds,
    });
    expect(mesh.indexCount).toBe(indexCount);

    const frame = renderer.beginFrame(0, 1 / 60);
    frame.mesh(mesh, material, new Transform({ x: CHUNK, y: 0, z: 2 * CHUNK }));
    renderer.endFrame();

    expect(fake.errors).toEqual([]);
    const draws = fake.passes
      .flatMap((p) => p.commands)
      .filter((c) => c.op === 'drawIndexed' && c.indices === indexCount);
    expect(draws).toHaveLength(1);
  });
});
