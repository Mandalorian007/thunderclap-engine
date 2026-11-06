/**
 * The "+z riser draws as a triangle" item from the README's *Known limits*, pinned (ws/demo-voxel-2).
 *
 * On a one-block terrain step the +z riser face (the vertical face between a tread and the tread
 * one block higher) shows as a triangle from some viewpoints, the hidden half showing the green
 * of a +y face. This test meshes that step through the engine mesher and checks the riser quad the
 * way the engine's draw would need it: both triangles present, wound towards +z, covering the whole
 * unit square, every corner on the z = 8 plane, one layer. It PASSES: the mesher's output is right
 * (the same checks ran over all 46 411 quads of the demo's world, including that each merged quad
 * has a solid cell behind and an air cell in front of every cell it spans, and the Worker's reply
 * is byte-identical to `meshChunk` on the page). The cut is on the draw side: it moves with the
 * viewpoint, and it is unchanged by the index split (both diagonals), by flat AO, by the upload path
 * (`createVoxelChunks` or a `createMesh` from the same arrays), by the chunk draw order, by the near
 * and far planes, and with the shadow, the post stack, the water and the sky off. Suspects, in
 * order: the scene pass depth state in `src/render/renderer.ts` (the attachment at
 * `att.depthLoadOp`, around line 978, and the `less-equal` compare with `depth24plus` in
 * `src/render/material.ts` lines 52 and 170), the 3D vertex path of `src/render/wgsl.ts`
 * (`engine_vertex`, line 383) and `Camera.perspective` (`src/render/camera.ts` line 125). Skipped because it cannot fail where the fault is; listed as a wish for
 * ws/voxel-2, which may turn it on as a harness pixel probe.
 *
 * Vitest only includes `src/**`; to run it, copy it under `src/voxel/` with the `world` import
 * pointed at `../../demos/voxel/world` and `it.skip` made `it` (it passes, 1 test).
 */
import { createChunkMeshOut, createVoxelGrid, meshChunk } from '@thunderclap/engine/voxel';
import { describe, expect, it } from 'vitest';
import { blockLayer, outsideBlock } from './world';

const FLOATS = 12;

describe('voxel demo: the +z riser of a one-block step', () => {
  it.skip('is two outward triangles covering the unit square (passes: the mesher is right, the cut is on the draw side)', () => {
    const grid = createVoxelGrid({ sizeX: 16, sizeY: 16, sizeZ: 16, chunk: 16 });
    // Grass floor at y < 4; one grass ledge at y = 4 for z <= 7, so the riser is at z = 8, y 4..5.
    grid.fill((_x, y, z) => (y < 4 ? 3 : y === 4 && z <= 7 ? 3 : 0));
    const out = createChunkMeshOut();
    meshChunk(grid, 0, 0, 0, { layerOf: blockLayer, outside: outsideBlock }, out);
    const vertex = (i: number) => out.vertices.subarray(i * FLOATS, i * FLOATS + FLOATS);

    const risers: number[] = [];
    for (let q = 0; q < out.vertexCount / 4; q++) {
      const v = vertex(q * 4);
      if (v[5] === 1 && v[2] === 8 && v[1]! >= 4 && v[1]! <= 5) risers.push(q);
    }
    // The riser spans x 0..16 as one merged quad (or a few, with AO breaking the run).
    expect(risers.length).toBeGreaterThan(0);
    let covered = 0;
    for (const q of risers) {
      const idx = Array.from(out.indices.subarray(q * 6, q * 6 + 6));
      for (const i of idx) expect(i >= q * 4 && i < q * 4 + 4).toBe(true);
      const layer = vertex(q * 4)[11];
      for (let c = 0; c < 4; c++) {
        const v = vertex(q * 4 + c);
        expect(v[2]).toBe(8);
        expect([v[3], v[4], v[5]]).toEqual([0, 0, 1]);
        expect(v[11]).toBe(layer);
      }
      for (let t = 0; t < 2; t++) {
        const a = vertex(idx[t * 3]!);
        const b = vertex(idx[t * 3 + 1]!);
        const c = vertex(idx[t * 3 + 2]!);
        const ux = b[0]! - a[0]!;
        const uy = b[1]! - a[1]!;
        const wx = c[0]! - a[0]!;
        const wy = c[1]! - a[1]!;
        // Signed area towards +z: positive is outward, and the two halves make the whole quad.
        const area2 = ux * wy - uy * wx;
        expect(area2).toBeGreaterThan(0);
        covered += area2 / 2;
      }
    }
    expect(covered).toBe(16);
  });
});
