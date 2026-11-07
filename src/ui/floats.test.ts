// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { h } from './dom';
import { createFloats, critScale, FLOATS_CSS, floatOpacity } from './floats';
import { createOverlay, type Overlay } from './overlay';

const els = (ov: Overlay) => Array.from(ov.layers.hud.querySelectorAll<HTMLElement>('.tc-floats'));
/** Translate and scale of a label's transform. */
const at = (el: HTMLElement): [number, number, number] => {
  const m = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\) scale\(([-\d.e]+)\)/.exec(
    el.style.transform,
  )!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const flat = () => Camera.ortho2d(1920, 1080);
const near = (got: number[], want: number[]) => {
  for (let i = 0; i < want.length; i++) expect(got[i]).toBeCloseTo(want[i]!, 3);
};

describe('floats (ws/ui-5)', () => {
  let parent: HTMLElement;
  let ov: Overlay;
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
    ov.setFrame({ x: 0, y: 0, width: 960, height: 540 });
  });
  afterEach(() => ov.destroy());

  it('the pool reuses nodes: steady spawning never makes more than it needs', () => {
    const f = createFloats(ov, flat, { reducedMotion: false });
    expect(document.getElementById('tc-ui-floats')?.textContent).toBe(FLOATS_CSS);
    // Two a step at a 0.1 s step and a 1 s life: about 20 in flight.
    for (let i = 0; i < 100; i++) {
      f.spawn(String(i), [100 + i, 500, 0], { stack: false });
      f.spawn(String(-i), [900, 100 + i, 0], { stack: false });
      f.update(0.1);
    }
    expect(f.live).toBeLessThanOrEqual(20);
    expect(f.pooled).toBeLessThanOrEqual(22);
    const made = f.pooled;
    const nodes = els(ov);
    for (let i = 0; i < 100; i++) {
      f.spawn('x', [960, 540, 0], { stack: false });
      f.spawn('y', [960, 540, 0], { stack: false });
      f.update(0.1);
    }
    expect(f.pooled).toBe(made);
    expect(els(ov)).toEqual(nodes);
  });

  it('past max the oldest is recycled; a life ends hidden', () => {
    const f = createFloats(ov, flat, { max: 4, life: 1 });
    for (let i = 0; i < 6; i++) f.spawn(String(i), [960, 540, 0], { stack: false });
    expect(f.pooled).toBe(4);
    expect(f.live).toBe(4);
    f.update(0.5);
    const texts = els(ov)
      .filter((e) => !e.hidden)
      .map((e) => e.textContent)
      .sort();
    expect(texts).toEqual(['2', '3', '4', '5']);
    f.clear();
    f.spawn('short', [960, 540, 0], { stack: false });
    f.spawn('long', [960, 540, 0], { life: 3, stack: false });
    f.update(0.5);
    f.update(0.6); // past the 1 s life
    expect(f.live).toBe(1);
    expect(
      els(ov)
        .filter((e) => !e.hidden)
        .map((e) => e.textContent),
    ).toEqual(['long']);
    f.update(2);
    expect(f.live).toBe(0);
    expect(els(ov).every((e) => e.hidden)).toBe(true);
    f.dispose();
    expect(els(ov).length).toBe(0);
  });

  it('a spawn behind the camera is hidden, one in front shows', () => {
    const cam = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 100);
    Object.assign(cam.screen, { x: 0, y: 0, width: 1920, height: 1080 });
    cam.lookAt([0, 0, 10], [0, 0, 0]);
    const f = createFloats(ov, () => cam);
    f.spawn('front', [0, 0, 0]);
    f.spawn('behind', [0, 0, 20]);
    f.update(0.016);
    const [front, behind] = els(ov);
    expect(front!.textContent).toBe('front');
    expect(front!.hidden).toBe(false);
    expect(at(front!)[0]).toBeCloseTo(480, 1);
    expect(behind!.textContent).toBe('behind');
    expect(behind!.hidden).toBe(true);
    expect(f.live).toBe(2);
  });

  it('rises by design px scaled to the frame, fans out stacked spawns, pops a crit', () => {
    const f = createFloats(ov, flat, { rise: 100, stackStep: [30, 18], reducedMotion: false });
    f.spawn('a', [960, 540, 0]);
    f.spawn('b', [960, 540, 0]);
    f.spawn('c', [960, 540, 0]);
    f.spawn('far', [100, 100, 0]);
    f.update(0);
    const [a, b, c, far] = els(ov);
    // A half-size frame: design px are halved.
    near(at(a!), [480, 270, 1]);
    expect(at(b!)[0]).toBeCloseTo(480 + 15, 3);
    expect(at(b!)[1]).toBeCloseTo(270 - 9, 3);
    expect(at(c!)[0]).toBeCloseTo(480 - 15, 3);
    expect(at(c!)[1]).toBeCloseTo(270 - 18, 3);
    expect(at(far!)[0]).toBeCloseTo(50, 3);
    f.update(0.5);
    expect(at(a!)[1]).toBeCloseTo(270 - 25, 3);
    expect(a!.style.opacity).toBe('1');
    f.update(0.3); // t = 0.8: halfway through the fade
    expect(Number(a!.style.opacity)).toBeCloseTo(0.5, 1);

    f.clear();
    f.spawn('CRIT', [960, 540, 0], { crit: true, color: 'rgb(255, 255, 0)', size: 2 });
    const crit = els(ov).find((e) => e.textContent === 'CRIT')!;
    expect(crit.hasAttribute('data-crit')).toBe(true);
    expect(crit.style.color).toBe('rgb(255, 255, 0)');
    expect(crit.style.fontSize).toBe('calc(var(--tc-font-size-m) * 2)');
    f.update(0);
    expect(at(crit)[2]).toBeCloseTo(0.6, 3);
    f.update(0.08);
    expect(at(crit)[2]).toBeCloseTo(1.5, 3);
    f.update(0.5);
    expect(at(crit)[2]).toBeCloseTo(1.15, 3);
  });

  it('reduced motion: no rise, no pop', () => {
    const f = createFloats(ov, flat, { reducedMotion: true });
    f.spawn('9', [960, 540, 0], { crit: true });
    f.update(0.5);
    near(at(els(ov)[0]!), [480, 270, 1]);
  });

  it('opacity and pop curves', () => {
    expect(floatOpacity(0)).toBe(1);
    expect(floatOpacity(0.6)).toBe(1);
    expect(floatOpacity(1)).toBe(0);
    expect(critScale(0)).toBeCloseTo(0.6, 9);
    expect(critScale(1)).toBe(1.15);
  });

  it("ui.floats(camera) is the overlay's one Floats; destroy takes its nodes (ws/ui-6)", () => {
    const f = ov.floats(flat, { max: 8 });
    expect(ov.floats()).toBe(f);
    expect(f.max).toBe(8);
    f.spawn('7', [960, 540, 0]);
    f.update(0.1);
    expect(f.live).toBe(1);
    expect(els(ov).length).toBe(1);
    ov.destroy();
    expect(els(ov).length).toBe(0);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
  });
});
