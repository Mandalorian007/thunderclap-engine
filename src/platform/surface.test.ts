// @vitest-environment happy-dom
/** Surface.setFrame: the canvas letterboxes inside a part of the container. */
import { afterEach, describe, expect, it } from 'vitest';
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
