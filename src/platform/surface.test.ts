// @vitest-environment happy-dom
/** Surface.setFrame: the canvas letterboxes inside a part of the container. */
import { afterEach, describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { PHONE_SCALE } from './device-mode';
import { mountSurface } from './surface';

function root(w: number, h: number): HTMLElement {
  const el = document.createElement('main');
  Object.defineProperty(el, 'clientWidth', { get: () => w });
  Object.defineProperty(el, 'clientHeight', { get: () => h });
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Surface.setFrame', () => {
  it('fits the canvas inside the frame and keeps fitRect on the whole container', () => {
    const s = mountSurface(root(390, 844));
    expect(s.rect.y).toBe(312);
    s.setFrame({ x: 0, y: 56, width: 390, height: 360 });
    expect(s.rect.x).toBe(0);
    expect(s.rect.width).toBe(390);
    expect(s.rect.y).toBe(56 + 70);
    expect(s.canvas.style.top).toBe(`${s.rect.y}px`);
    expect(s.fitRect.y).toBe(312);
    s.setFrame(null);
    expect(s.rect.y).toBe(312);
    s.destroy();
  });

  it('notifies resize listeners only when the rect changes', () => {
    const s = mountSurface(root(390, 844));
    let calls = 0;
    s.onResize(() => calls++);
    s.setFrame({ x: 0, y: 56, width: 390, height: 360 });
    s.setFrame({ x: 0, y: 56, width: 390, height: 360 });
    expect(calls).toBe(2);
    s.destroy();
  });
});

describe('Surface fit: cover', () => {
  it('leaves the default letterbox alone and shows the whole design', () => {
    const s = mountSurface(root(844, 340));
    expect(s.rect.x).toBeGreaterThan(0);
    expect(s.visibleRect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    s.destroy();
  });

  it('covers the container, crops to the band and maps points through the covered canvas', () => {
    const s = mountSurface(root(844, 340), { fit: { minVisibleHeight: 720 } });
    expect(s.rect.x).toBe(0);
    expect(s.rect.width).toBe(844);
    expect(s.rect.y).toBeLessThan(0);
    expect(s.canvas.style.top).toBe(`${s.rect.y}px`);
    const v = s.visibleRect!;
    expect(v.width).toBe(1920);
    expect(v.height).toBeGreaterThanOrEqual(720);
    expect(v.height).toBeLessThan(1080);
    // The container's top-left corner is the visible rect's top-left (happy-dom: root at 0,0).
    const p = s.clientToLogical(0, 0);
    expect(p.x).toBeCloseTo(v.x, 5);
    expect(p.y).toBeCloseTo(v.y, 5);
    const c = s.logicalToClient(v.x, v.y + v.height);
    expect(c.y).toBeCloseTo(340, 5);
    expect(s.containsLogical({ x: 960, y: 540 })).toBe(true);
    expect(s.containsLogical({ x: 960, y: 2 })).toBe(false);
    // fitRect stays the whole container's letterbox.
    expect(s.fitRect.x).toBeGreaterThan(0);
    s.destroy();
  });

  it('covers a frame without clamping it to the container, and clips what shows', () => {
    const s = mountSurface(root(844, 340), { fit: 'cover' });
    s.setFrame({ x: 100, y: 0, width: 844, height: 340 });
    expect(s.rect.x).toBe(100);
    expect(s.rect.width).toBe(844);
    // Only 744 of the 844 px are inside the container.
    expect(s.visibleRect!.width).toBeCloseTo((744 / 844) * 1920, 5);
    s.destroy();
  });

  it('setFit switches at runtime and belowScale keeps large screens letterboxed', () => {
    const s = mountSurface(root(844, 340));
    let calls = 0;
    s.onResize(() => calls++);
    s.setFit!('cover');
    expect(s.rect.x).toBe(0);
    expect(calls).toBe(2);
    s.setFit!('contain');
    expect(s.rect.x).toBeGreaterThan(0);
    const big = mountSurface(root(1600, 600), { fit: { belowScale: PHONE_SCALE } });
    expect(big.rect).toEqual(big.fitRect);
    const phone = mountSurface(root(844, 340), { fit: { belowScale: PHONE_SCALE } });
    expect(phone.rect.x).toBe(0);
    s.destroy();
    big.destroy();
    phone.destroy();
  });

  it('Camera.fitFreeRect frames a world rect into the visible container', () => {
    const s = mountSurface(root(844, 340), { fit: 'cover' });
    const cam = Camera.ortho2d(1920, 1080);
    cam.fitFreeRect(
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 844, height: 340 },
      s,
    );
    // The whole world rect fits inside what shows: its corners map inside the visible rect.
    const v = s.visibleRect!;
    const tl = cam.worldToScreen(0, 0, 0);
    const br = cam.worldToScreen(1920, 1080, 0);
    expect(tl.y).toBeGreaterThanOrEqual(v.y - 1e-6);
    expect(br.y).toBeLessThanOrEqual(v.y + v.height + 1e-6);
    expect(tl.x).toBeGreaterThanOrEqual(v.x - 1e-6);
    expect(br.x).toBeLessThanOrEqual(v.x + v.width + 1e-6);
    s.destroy();
  });
});
