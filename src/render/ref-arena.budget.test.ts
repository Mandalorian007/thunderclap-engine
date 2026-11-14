/**
 * Reference scene S3, the lit arena (E-041 A4, design/2.0/bar.md §3): 49 PBR spheres on two
 * standard materials, pillars and a floor, the sun's shadow, eight circling point lights and
 * two spots, bloom, vignette and the grade (harness/ref-arena.html), counted on the fake device
 * and held to `ref-arena.budget.json`. `TC_REF=write` rewrites the JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cwd, env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { countedRenderer, refBook, runScene } from './ref-budget.test-util';
import { createRefScene } from './ref-scenes.test-util';

const book = refBook('src/render/ref-arena.budget.json', {
  readFileSync,
  writeFileSync,
  root: cwd(),
  write: env.TC_REF === 'write',
});

describe('reference scene S3: the lit arena', () => {
  it('49 spheres, 10 lights, a shadow and post: at or under its row', () => {
    const { fake, meter, renderer } = countedRenderer();
    const scene = createRefScene('arena', renderer, { mark: meter.view });
    const { report, stats } = runScene(scene, meter, renderer);
    const row = book.hold('ref-arena', report);
    book.stats('ref-arena', stats);
    expect(stats.shadowDraws).toBeGreaterThan(0);
    expect(row.typedArrays + row.arrayBuffers).toBe(0);
    expect(fake.errors).toEqual([]);
    scene.dispose();
  });
});
