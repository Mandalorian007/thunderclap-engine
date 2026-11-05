// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { Input } from './input';
import { createPointerRouter, type PointerRouter } from './pointer-router';
import { aabbTester } from './rays';

function ptr(type: string, x: number, y: number, init: PointerEventInit = {}) {
  return new PointerEvent(type, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    bubbles: true,
    ...init,
  });
}

describe('PointerRouter DOM attachment through Input', () => {
  let el: HTMLElement;
  let input: Input<'select'>;
  let router: PointerRouter<string>;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    router = createPointerRouter<string>({
      camera: Camera.ortho2d(800, 600),
      testers: [aabbTester([{ min: [0, 0, 0], max: [100, 100, 0], target: 'q' }])],
    });
    input = new Input(
      { select: [{ pointer: 'select' }] },
      { getGamepads: () => [], pointers: router },
    );
    input.setPointerTransform((x, y) => ({ x, y }));
    input.attach({ pointerTarget: el });
  });

  afterEach(() => {
    input.detach();
    el.remove();
  });

  it('mouse hover and click on the target route to hits and the select action', () => {
    const seen: string[] = [];
    router.on('select', (e) => seen.push(e.hit?.target ?? '-'));
    el.dispatchEvent(ptr('pointermove', 50, 50));
    input.update();
    expect(router.hit?.target).toBe('q');
    el.dispatchEvent(ptr('pointerdown', 50, 50));
    el.dispatchEvent(ptr('pointerup', 50, 50));
    input.update();
    expect(input.pressed('select')).toBe(true);
    expect(seen).toEqual(['q']);
    el.dispatchEvent(ptr('pointerleave', 50, 50));
    input.update();
    expect(router.pointers.length).toBe(0);
  });

  it('touch through the DOM: a pointer while down', () => {
    el.dispatchEvent(ptr('pointerdown', 20, 20, { pointerType: 'touch', pointerId: 7 }));
    input.update();
    expect(router.primary?.device).toBe('touch');
    expect(router.hit?.target).toBe('q');
    el.dispatchEvent(ptr('pointerup', 20, 20, { pointerType: 'touch', pointerId: 7 }));
    input.update();
    input.update();
    expect(router.pointers.length).toBe(0);
  });

  it('detach stops listening and drops pointers', () => {
    el.dispatchEvent(ptr('pointermove', 50, 50));
    input.update();
    input.detach();
    input.update();
    expect(router.pointers.length).toBe(0);
    el.dispatchEvent(ptr('pointermove', 50, 50));
    input.update();
    expect(router.pointers.length).toBe(0);
  });
});
