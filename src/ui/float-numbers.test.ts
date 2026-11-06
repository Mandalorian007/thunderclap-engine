// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { h } from './dom';
import { createFloatNumbers, FLOAT_CSS } from './float-numbers';
import { createOverlay, type Overlay } from './overlay';

const floatEls = (ov: Overlay) =>
  Array.from(ov.layers.hud.querySelectorAll<HTMLElement>('.tc-float'));

/** The translate of a float's transform. */
const at = (el: HTMLElement): [number, number] => {
  const m = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\)/.exec(el.style.transform)!;
  return [Number(m[1]), Number(m[2])];
};

describe('float numbers (ws/ui-4)', () => {
  let parent: HTMLElement;
  let ov: Overlay;
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
    ov.setFrame({ x: 0, y: 0, width: 960, height: 540 });
    ov.anchors(() => Camera.ortho2d(1920, 1080));
  });
  afterEach(() => ov.destroy());

  it('100 spawns keep 64 nodes, recycling the oldest; a number is gone after its duration', () => {
    const f = ov.floats;
    expect(ov.floats).toBe(f);
    expect(f.max).toBe(64);
    for (let i = 0; i < 100; i++) {
      f.spawn(960, 540, 0, String(i), { kind: i % 2 ? 'damage' : 'heal' });
    }
    expect(f.live).toBe(64);
    expect(f.pooled).toBe(64);
    expect(floatEls(ov).length).toBe(64);
    expect(document.getElementById('tc-ui-float')?.textContent).toBe(FLOAT_CSS);
    f.update(0.5);
    const shown = floatEls(ov).filter((e) => !e.hidden);
    expect(shown.length).toBe(64);
    expect(shown.some((e) => e.textContent === '0')).toBe(false); // the first 36 were recycled
    expect(shown.some((e) => e.textContent === '99')).toBe(true);
    expect(at(shown[0]!)[0]).toBeCloseTo(480, 3);
    expect(at(shown[0]!)[1]).toBeCloseTo(270 - 12, 3); // half the 1 s life: 24 design px up, halved
    f.update(0.6);
    expect(f.live).toBe(0);
    expect(f.pooled).toBe(64);
    expect(floatEls(ov).every((e) => e.hidden)).toBe(true);
  });

  it('custom options and kinds; rises by the design px scaled to the frame; clear retires all', () => {
    const f = createFloatNumbers(ov, { max: 4, duration: 2, rise: 100 });
    f.spawn(960, 540, 0, '7', { kind: 'crit' });
    f.update(0);
    const el = floatEls(ov)[0]!;
    expect(el.dataset.kind).toBe('crit');
    expect(at(el)[0]).toBeCloseTo(480, 3);
    expect(at(el)[1]).toBeCloseTo(270, 3);
    f.update(1); // halfway: 50 design px = 25 frame px up at this half-size frame
    expect(at(el)[1]).toBeCloseTo(245, 3);
    f.spawn(0, 0, 0, 'a');
    f.spawn(0, 0, 0, 'b');
    expect(f.live).toBe(3);
    f.clear();
    expect(f.live).toBe(0);
    f.dispose();
    expect(floatEls(ov).length).toBe(0);
  });
});
