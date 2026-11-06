// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../render/camera';
import { h } from './dom';
import { createOverlay, type Overlay } from './overlay';
import { placeTooltip, TOOLTIP_CSS } from './tooltip';

const FRAME = { x: 0, y: 0, width: 1000, height: 600 };
const SIZE = { width: 100, height: 40 };

describe('placeTooltip', () => {
  it('auto goes above, centred, with the arrow at the anchor', () => {
    const p = placeTooltip({ x: 400, y: 300, width: 50, height: 20 }, SIZE, FRAME, 'auto', 8);
    expect(p.side).toBe('top');
    expect(p.x).toBe(425 - 50);
    expect(p.y).toBe(300 - 8 - 40);
    expect(p.arrow).toBe(50);
  });

  it('flips to the opposite side at an edge and clamps into the frame', () => {
    const top = placeTooltip({ x: 10, y: 10, width: 50, height: 20 }, SIZE, FRAME, 'top', 8);
    expect(top.side).toBe('bottom');
    expect(top.y).toBe(10 + 20 + 8);
    expect(top.x).toBe(0); // clamped to the left edge
    expect(top.arrow).toBe(35); // the anchor's centre, 35 px in
    const right = placeTooltip({ x: 950, y: 300, width: 50, height: 20 }, SIZE, FRAME, 'right');
    expect(right.side).toBe('left');
    const auto = placeTooltip({ x: 0, y: 0, width: 1000, height: 600 }, SIZE, FRAME, 'auto');
    expect(auto.side).toBe('top'); // nothing fits: the side with the most room, ties to the first
    const corner = placeTooltip({ x: 990, y: 590, width: 10, height: 10 }, SIZE, FRAME, 'auto');
    expect(corner.side).toBe('top');
    expect(corner.x).toBe(900);
    expect(corner.arrow).toBe(88); // kept inside the inset from the corner
  });
});

describe('tooltips', () => {
  let parent: HTMLElement;
  let ov: Overlay;
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
    vi.useFakeTimers();
  });
  afterEach(() => {
    ov.destroy();
    vi.useRealTimers();
  });

  it('shares one role=tooltip element on the toasts layer, shown after the delay, hidden on leave', () => {
    const a = h('button', null, 'a');
    const b = h('button', null, 'b');
    ov.layers.hud.append(a, b);
    const ta = ov.tooltip(a, 'Alpha', { delay: 300 });
    const tb = ov.tooltip(b, 'Beta', { delay: 300, arrow: false });
    const el = ov.tooltips.element;
    expect(el.parentElement).toBe(ov.layers.toasts);
    expect(el.getAttribute('role')).toBe('tooltip');
    expect(el.hidden).toBe(true);
    expect(document.getElementById('tc-ui-tooltip')?.textContent).toBe(TOOLTIP_CSS);

    a.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(200);
    expect(ta.visible).toBe(false);
    vi.advanceTimersByTime(100);
    expect(ta.visible).toBe(true);
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('Alpha');
    expect(a.getAttribute('aria-describedby')).toBe(el.id);
    expect(ov.tooltips.active).toBe(ta);
    expect(ta.placement).not.toBeNull();

    a.dispatchEvent(new Event('pointerleave'));
    expect(ta.visible).toBe(false);
    expect(el.hidden).toBe(true);
    expect(a.hasAttribute('aria-describedby')).toBe(false);
    expect(ta.placement).toBeNull();

    // Leaving before the delay cancels the show.
    a.dispatchEvent(new Event('pointerenter'));
    a.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(1000);
    expect(el.hidden).toBe(true);

    // Focus shows at once; a second target takes the shared element over; Escape hides.
    b.dispatchEvent(new Event('focus'));
    expect(tb.visible).toBe(true);
    expect(el.textContent).toBe('Beta');
    expect(el.hasAttribute('data-no-arrow')).toBe(true);
    a.dispatchEvent(new Event('focus'));
    expect(ta.visible).toBe(true);
    expect(tb.visible).toBe(false);
    expect(b.hasAttribute('aria-describedby')).toBe(false);
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ta.visible).toBe(false);

    ta.set('Alpha 2');
    ta.show();
    expect(el.textContent).toBe('Alpha 2');
    ta.dispose();
    expect(el.hidden).toBe(true);
    a.dispatchEvent(new Event('focus'));
    expect(el.hidden).toBe(true);
  });

  it('a world point rides the anchors and hides with them', () => {
    ov.setFrame({ x: 40, y: 0, width: 960, height: 540 });
    const cam = Camera.ortho2d(1920, 1080);
    ov.anchors(() => cam);
    const t = ov.tooltip([1600, 540, 0], 'Here', { placement: 'bottom' });
    const el = ov.tooltips.element;
    expect(t.visible).toBe(true);
    ov.updateAnchors();
    // The proxy sits on the toasts layer (frame units: over the frame): 1600/1920 * 960 = 800.
    // happy-dom lays out nothing, so the tooltip is 0×0 and lands at the anchor plus the gap.
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform)!;
    expect(Number(m[1])).toBeCloseTo(800, 3);
    expect(Number(m[2])).toBeCloseTo(278, 3);
    expect(t.placement).toBe('bottom');
    expect(ov.layers.toasts.querySelector('.tc-tooltip-anchor')).not.toBeNull();

    cam.lookAt([5000, 0, 10], [5000, 0, 0]); // the point leaves the view
    ov.updateAnchors();
    expect(el.hidden).toBe(true);
    expect(t.visible).toBe(false);
    cam.lookAt([960, 540, 10], [960, 540, 0]);
    ov.updateAnchors();
    expect(el.hidden).toBe(false);
    t.dispose();
    expect(ov.layers.toasts.querySelector('.tc-tooltip-anchor')).toBeNull();
    expect(ov.tooltips.active).toBeNull();
  });

  it('needs the anchors for a world point', () => {
    expect(() => ov.tooltip([0, 0, 0], 'x')).toThrow();
  });
});
