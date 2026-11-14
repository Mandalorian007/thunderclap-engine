// @vitest-environment happy-dom
/**
 * Reference scene S6, the idle HUD (E-041 A4, design/2.0/bar.md §3): today's HUD widgets (a
 * reticle, two meters, a slot strip, a heading) over a still lit scene, every frame setting each
 * widget to the value it already shows (harness/ref-hud.html). The GPU work is held to
 * `ref-hud.budget.json`, and so are the DOM writes (mutation records) and layout reads a frame
 * makes: the bar is 0 of each. `TC_REF=write` rewrites the JSON.
 */
import { describe, expect, it } from 'vitest';
import { countedRenderer, refBook, runScene } from '../render/ref-budget.test-util';
import { countDom, createRefScene } from '../render/ref-scenes.test-util';

const book = refBook('src/ui/ref-hud.budget.json');

describe('reference scene S6: the idle HUD', () => {
  it('idle frames: GPU work at or under its row, DOM writes and reads pinned', () => {
    document.body.innerHTML = '';
    const parent = document.createElement('div');
    document.body.append(parent);
    const { fake, meter, renderer } = countedRenderer();
    const scene = createRefScene('hud', renderer, { parent, mark: meter.view });
    // Settle: the first frames may lay out; count idle frames only.
    for (let i = 0; i < 10; i++) scene.step(i);
    const dom = countDom(document.body);
    dom.start();
    for (let i = 10; i < 50; i++) scene.step(i);
    const counts = dom.stop();
    book.note('ref-hud: DOM writes a frame', counts.writes / 40);
    book.note('ref-hud: DOM reads a frame', counts.reads / 40);
    const { report, stats } = runScene(scene, meter, renderer);
    const row = book.hold('ref-hud', report);
    book.stats('ref-hud', stats);
    expect(row.typedArrays + row.arrayBuffers).toBe(0);
    expect(fake.errors).toEqual([]);
    scene.dispose();
  });
});
