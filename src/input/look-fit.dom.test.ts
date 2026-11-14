// @vitest-environment happy-dom
// ws/ui-input-fit: the speed wheel and a free mouse's drag through the DOM listener.
import { afterEach, describe, expect, it } from 'vitest';
import { Look } from './look';

let canvas: HTMLElement | null = null;
afterEach(() => {
  canvas?.remove();
  canvas = null;
});

function mouse(type: string, x: number, y: number, button = 0) {
  return new PointerEvent(type, {
    pointerId: 7,
    clientX: x,
    clientY: y,
    pointerType: 'mouse',
    isPrimary: true,
    button,
    bubbles: true,
  });
}

/** A wheel notch; happy-dom's WheelEvent leaves the modifier keys out, so they are set here. */
function wheel(deltaY: number, altKey = false) {
  const e = new WheelEvent('wheel', { deltaY });
  Object.defineProperty(e, 'altKey', { value: altKey });
  return e;
}

describe('Look in the page', () => {
  it('Alt + wheel sets the speed and does not zoom; the plain wheel zooms', () => {
    canvas = document.body.appendChild(document.createElement('div'));
    const look = new Look({ speedWheel: true, getGamepads: () => [] });
    look.attach(canvas);
    canvas.dispatchEvent(wheel(-100, true));
    expect(look.speed).toBeCloseTo(1.18);
    canvas.dispatchEvent(wheel(100, true));
    expect(look.speed).toBeCloseTo(1.18 * 0.85);
    look.update();
    expect(look.zoom).toBe(0);
    canvas.dispatchEvent(wheel(-100));
    look.update();
    expect(look.zoom).toBe(1);
    look.detach();
  });

  it('a free mouse’s drag turns the view; its click stays a click', () => {
    canvas = document.body.appendChild(document.createElement('div'));
    const look = new Look({ sensitivity: 0.01, freeDrag: true, getGamepads: () => [] });
    const taps: number[] = [];
    look.onTap((x) => taps.push(x));
    look.attach(canvas);
    canvas.dispatchEvent(mouse('pointerdown', 50, 50));
    canvas.dispatchEvent(mouse('pointerup', 51, 50));
    look.update();
    expect(look.look.dx).toBe(0);
    expect(taps.length).toBe(1);
    canvas.dispatchEvent(mouse('pointerdown', 50, 50));
    canvas.dispatchEvent(mouse('pointermove', 80, 50));
    look.update();
    expect(look.look.dx).toBeCloseTo(0.3);
    canvas.dispatchEvent(mouse('pointerup', 80, 50));
    look.detach();
  });
});
