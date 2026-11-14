/**
 * Reference scene S1, the 2D board (E-041 A4, design/2.0/bar.md §3): a 48×27 tile layer, 4,000
 * drifting sprites and a flipbook walker (harness/ref-board.html), counted on the fake device
 * and held to `ref-board.budget.json`. The bar: draws at or under today, no allocation in a
 * frame, the bytes a frame uploads. `TC_REF=write` rewrites the JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cwd, env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { countedRenderer, refBook, runScene } from './ref-budget.test-util';
import { createRefScene } from './ref-scenes.test-util';

const book = refBook('src/render/ref-board.budget.json', {
  readFileSync,
  writeFileSync,
  root: cwd(),
  write: env.TC_REF === 'write',
});

describe('reference scene S1: the 2D board', () => {
  it('4,000 sprites over a tile layer: at or under its row, no allocation in a frame', () => {
    const { fake, meter, renderer } = countedRenderer();
    const scene = createRefScene('board', renderer);
    const { report, stats } = runScene(scene, meter, renderer);
    const row = book.hold('ref-board', report);
    book.stats('ref-board', stats);
    expect(row.typedArrays + row.arrayBuffers).toBe(0);
    expect(new Set(report.commandsPerFrame).size, 'the same calls every frame').toBe(1);
    expect(fake.errors).toEqual([]);
  });
});
