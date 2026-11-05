// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from './input';
import { Look } from './look';

function touch(type: string, id: number, x: number, y: number) {
  return new PointerEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    isPrimary: id === 1,
    bubbles: true,
  });
}

/** Fakes `document.pointerLockElement` and the lock calls. */
function fakeLock(el: HTMLElement, grant: boolean) {
  let holder: Element | null = null;
  Object.defineProperty(document, 'pointerLockElement', {
    configurable: true,
    get: () => holder,
  });
  const exit = vi.fn(() => {
    holder = null;
    document.dispatchEvent(new Event('pointerlockchange'));
  });
  Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: exit });
  const req = vi.fn(() => {
    queueMicrotask(() => {
      if (grant) holder = el;
      document.dispatchEvent(new Event(grant ? 'pointerlockchange' : 'pointerlockerror'));
    });
  });
  Object.defineProperty(el, 'requestPointerLock', { configurable: true, value: req });
  return { exit, req };
}

describe('Look DOM attachment', () => {
  let canvas: HTMLElement;
  let look: Look;

  beforeEach(() => {
    canvas = document.createElement('div');
    document.body.appendChild(canvas);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
    look = new Look({ sensitivity: 0.01, getGamepads: () => [] });
  });

  afterEach(() => {
    look.detach();
    canvas.remove();
    vi.restoreAllMocks();
    delete (document as { pointerLockElement?: unknown }).pointerLockElement;
    delete (document as { exitPointerLock?: unknown }).exitPointerLock;
  });

  it('splits touches by zone: left half moves, right half looks', () => {
    const input = new Input({}, { look, getGamepads: () => [] });
    input.attach({ pointerTarget: canvas });
    canvas.dispatchEvent(touch('pointerdown', 1, 100, 200));
    canvas.dispatchEvent(touch('pointermove', 1, 100, 100));
    canvas.dispatchEvent(touch('pointerdown', 2, 600, 200));
    canvas.dispatchEvent(touch('pointermove', 2, 630, 200));
    input.update();
    expect(look.move.y).toBeCloseTo(1);
    expect(look.look.dx).toBeCloseTo(0.3);
    canvas.dispatchEvent(touch('pointerup', 1, 100, 100));
    canvas.dispatchEvent(touch('pointercancel', 2, 630, 200));
    input.update();
    expect(look.move).toEqual({ x: 0, y: 0 });
    input.detach();
  });

  it("moveZone 'right' flips the halves; mouse pointers never touch-look", () => {
    look.moveZone = 'right';
    look.attach(canvas);
    canvas.dispatchEvent(touch('pointerdown', 1, 600, 200));
    canvas.dispatchEvent(touch('pointermove', 1, 700, 200));
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 5, pointerType: 'mouse', clientX: 100 }),
    );
    canvas.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 5, pointerType: 'mouse', clientX: 300 }),
    );
    look.update();
    expect(look.move.x).toBeCloseTo(1);
    expect(look.look.dx).toBe(0);
  });

  it('reads mouse movement only while the element holds the lock', async () => {
    const { req, exit } = fakeLock(canvas, true);
    look.attach(canvas);
    const changes: boolean[] = [];
    look.onLockChange((v) => changes.push(v));
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 20 }));
    look.update();
    expect(look.look.dx).toBe(0);

    await expect(look.request()).resolves.toBe(true);
    expect(req).toHaveBeenCalledTimes(1);
    expect(look.locked).toBe(true);
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 20, movementY: 10 }));
    look.update();
    expect(look.look.dx).toBeCloseTo(0.2);
    expect(look.look.dy).toBeCloseTo(-0.1);

    look.release();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(look.locked).toBe(false);
    // Not held: release does nothing.
    look.release();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([true, false]);
  });

  it('a refused lock resolves false; detached or unsupported resolves false', async () => {
    await expect(look.request()).resolves.toBe(false);
    look.attach(canvas);
    await expect(look.request()).resolves.toBe(false);
    fakeLock(canvas, false);
    await expect(look.request()).resolves.toBe(false);
    expect(look.locked).toBe(false);
  });

  it('blocked releases the lock and refuses a request', async () => {
    let blocked = false;
    const input = new Input({}, { look, blocked: () => blocked, getGamepads: () => [] });
    const { exit } = fakeLock(canvas, true);
    input.attach({ pointerTarget: canvas });
    await look.request();
    expect(look.locked).toBe(true);
    blocked = true;
    input.update();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(look.locked).toBe(false);
    await expect(look.request()).resolves.toBe(false);
    input.detach();
  });

  it('detach releases the lock and stops listening', async () => {
    const { exit } = fakeLock(canvas, true);
    look.attach(canvas);
    await look.request();
    look.detach();
    expect(exit).toHaveBeenCalled();
    expect(look.locked).toBe(false);
    canvas.dispatchEvent(touch('pointerdown', 2, 600, 200));
    canvas.dispatchEvent(touch('pointermove', 2, 650, 200));
    look.update();
    expect(look.look.dx).toBe(0);
  });
});
