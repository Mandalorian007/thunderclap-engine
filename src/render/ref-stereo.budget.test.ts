/**
 * Reference scene S5, stereo (E-041 A4, design/2.0/bar.md §3): S2's figures (32) drawn through
 * two eyes 0.064 apart, each half the screen, `renderer.render` per eye as the XR path does
 * today (harness/ref-stereo.html), and the same scene through one camera for comparison; held
 * to `ref-stereo.budget.json`. The bar: one cull and prepare for both eyes, the pair at most
 * 1.15× one view. Today each eye costs in full: the ratio is pinned as a note.
 * `TC_REF=write` rewrites the JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cwd, env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { countedRenderer, refBook, runScene } from './ref-budget.test-util';
import { createRefScene } from './ref-scenes.test-util';

const book = refBook('src/render/ref-stereo.budget.json', {
  readFileSync,
  writeFileSync,
  root: cwd(),
  write: env.TC_REF === 'write',
});

describe('reference scene S5: stereo', () => {
  it('two eyes and one view: at or under their rows, the ratio pinned', () => {
    const counts: Record<number, number> = {};
    for (const views of [2, 1] as const) {
      const { fake, meter, renderer } = countedRenderer();
      const scene = createRefScene('stereo', renderer, { views, mark: meter.view });
      const { report, stats } = runScene(scene, meter, renderer);
      const name = views === 2 ? 'ref-stereo' : 'ref-stereo-mono';
      const row = book.hold(name, report);
      book.stats(name, stats);
      counts[views] = row.commands;
      expect(row.typedArrays + row.arrayBuffers).toBe(0);
      expect(fake.errors).toEqual([]);
    }
    const ratio = counts[2]! / counts[1]!;
    book.note('ref-stereo: commands, two eyes over one view', ratio);
    // Today's shape: the second eye costs nearly a full view (the render core's G3 target is 1.15).
    expect(ratio).toBeGreaterThan(1.15);
  });
});
