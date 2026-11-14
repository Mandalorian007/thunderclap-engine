/**
 * Reference scene S2, characters (E-041 A4, design/2.0/bar.md §3): walking skinned figures, an
 * `AnimationMixer` each posed by `skinPose` into one `SkinPalette`, on a shadowed ground
 * (harness/ref-characters.html), counted at 64 and 256 figures and held to
 * `ref-characters.budget.json`. The bar: calls flat in the number of figures, one pose pass a
 * frame. `TC_REF=write` rewrites the JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cwd, env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { countedRenderer, refBook, runScene } from '../render/ref-budget.test-util';
import { createRefScene } from '../render/ref-scenes.test-util';

const book = refBook('src/anim/ref-characters.budget.json', {
  readFileSync,
  writeFileSync,
  root: cwd(),
  write: env.TC_REF === 'write',
});

describe('reference scene S2: characters', () => {
  for (const size of [64, 256]) {
    it(`${size} figures: at or under its row, no allocation in a frame`, () => {
      const { fake, meter, renderer } = countedRenderer();
      const scene = createRefScene('characters', renderer, { size, mark: meter.view });
      const { report, stats } = runScene(scene, meter, renderer);
      const row = book.hold(`ref-characters-${size}`, report);
      book.stats(`ref-characters-${size}`, stats);
      expect(row.typedArrays + row.arrayBuffers).toBe(0);
      expect(fake.errors).toEqual([]);
    });
  }

  it('the palette upload is one write a frame whatever the count', () => {
    const rows = book.got.parts;
    expect(rows['ref-characters-64']?.update?.writeBuffer).toBe(1);
    expect(rows['ref-characters-256']?.update?.writeBuffer).toBe(1);
  });
});
