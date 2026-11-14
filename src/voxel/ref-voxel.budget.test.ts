/**
 * Reference scene S4, the voxel world (E-041 A4, design/2.0/bar.md §3): a block world through
 * the `voxel` module (greedy meshing with AO, per-chunk culling), the camera flying a circle
 * (harness/ref-voxel.html), counted at 8×2×8 and 16×2×16 chunks of 16³ and held to
 * `ref-voxel.budget.json`. The bar wants the same calls at both sizes; today a frame draws
 * every visible chunk, so the larger world costs more: both are pinned. `TC_REF=write`
 * rewrites the JSON.
 */
import { describe, expect, it } from 'vitest';
import { countedRenderer, prepared, refBook, runScene } from '../render/ref-budget.test-util';
import { createRefScene } from '../render/ref-scenes.test-util';

const book = refBook('src/voxel/ref-voxel.budget.json');

describe('reference scene S4: the voxel world', () => {
  for (const size of [8, 16]) {
    it(`${size}×2×${size} chunks: at or under its row`, async () => {
      const { fake, meter, renderer } = countedRenderer();
      const scene = createRefScene('voxel', renderer, { size, mark: meter.view });
      await prepared(scene);
      const { report, stats } = runScene(scene, meter, renderer);
      const row = book.hold(`ref-voxel-${size}`, report);
      book.stats(`ref-voxel-${size}`, stats);
      expect(stats.drawCalls).toBeGreaterThan(0);
      // Not 0: the renderer's sorted-instance buffer doubles once when the flight first sees
      // more chunks than before (amortised, renderer.ts `sortedData`), so the row pins it.
      expect(row.typedArrays + row.arrayBuffers).toBeLessThan(0.1);
      expect(fake.errors).toEqual([]);
      scene.dispose();
    }, 60_000);
  }
});
