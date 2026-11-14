/**
 * Reference scene S4, the voxel world (E-041 A4, design/2.0/bar.md §3): a block world through
 * the `voxel` module (`createVoxelWorld`: greedy section meshing with baked light, GPU-culled
 * core sets drawn in the renderer's frame), the camera flying a circle (harness/ref-voxel.html),
 * counted at 8×2×8 and 16×2×16 chunks of 16³ and held to `ref-voxel.budget.json`. The bar wants
 * the same calls at both sizes, and since ws/core-passes they are: one cull dispatch and the
 * core's bundles, whatever the chunk count. `TC_REF=write` rewrites the JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cwd, env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { countedRenderer, prepared, refBook, runScene } from '../render/ref-budget.test-util';
import { createRefScene } from '../render/ref-scenes.test-util';

const book = refBook('src/voxel/ref-voxel.budget.json', {
  readFileSync,
  writeFileSync,
  root: cwd(),
  write: env.TC_REF === 'write',
});

describe('reference scene S4: the voxel world', () => {
  for (const size of [8, 16]) {
    it(`${size}×2×${size} chunks: at or under its row`, async () => {
      const { fake, meter, renderer } = countedRenderer();
      const scene = createRefScene('voxel', renderer, { size, mark: meter.view });
      await prepared(scene);
      const { report, stats } = runScene(scene, meter, renderer);
      const row = book.hold(`ref-voxel-${size}`, report);
      book.stats(`ref-voxel-${size}`, stats);
      // The world draws through the core (its counts are the core's, not `renderer.stats`).
      expect(renderer.core?.hasWork).toBe(true);
      expect(row.typedArrays + row.arrayBuffers).toBe(0);
      expect(fake.errors).toEqual([]);
      scene.dispose();
    }, 60_000);
  }
});
