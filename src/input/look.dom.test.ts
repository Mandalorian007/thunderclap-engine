// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gestures } from './gestures';
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

  it('wheel notches zoom: up is closer, 100 px (or stepPx) a notch, reset each tick', () => {
    look.attach(canvas);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 }));
    look.update();
    expect(look.zoom).toBeCloseTo(1.5);
    look.update();
    expect(look.zoom).toBe(0);
    look.zoomStepPx = 50;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    look.update();
    expect(look.zoom).toBeCloseTo(-2);
    expect(look.look.dy).toBe(0);
  });

  it('wheel deltaMode lines (3 a notch) and pages (1 a notch); wheel: false ignores it', () => {
    look.attach(canvas);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, deltaMode: 1 }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 2, deltaMode: 2 }));
    look.update();
    expect(look.zoom).toBeCloseTo(-1);
    look.zoomWheel = false;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    look.update();
    expect(look.zoom).toBe(0);
  });

  it('a second finger beside a look drag pinches without stealing a live move stick', () => {
    look.attach(canvas);
    // Stick in the left half, look drag in the right half.
    canvas.dispatchEvent(touch('pointerdown', 1, 100, 200));
    canvas.dispatchEvent(touch('pointermove', 1, 100, 150));
    canvas.dispatchEvent(touch('pointerdown', 2, 500, 200));
    canvas.dispatchEvent(touch('pointermove', 2, 510, 200));
    look.update();
    expect(look.move.y).toBeCloseTo(50 / 56 / (1 - 0.12) - 0.12 / (1 - 0.12), 2);
    expect(look.look.dx).toBeCloseTo(0.1);
    expect(look.zoom).toBe(0);

    // A third finger (right half, drag already live) starts the pinch at distance 100.
    canvas.dispatchEvent(touch('pointerdown', 3, 610, 200));
    canvas.dispatchEvent(touch('pointermove', 3, 660, 200)); // apart: 150
    canvas.dispatchEvent(touch('pointermove', 2, 480, 200)); // apart: 180; no look while pinching
    canvas.dispatchEvent(touch('pointermove', 1, 100, 250)); // the stick still moves
    look.update();
    expect(look.zoom).toBeCloseTo(0.8);
    expect(look.look.dx).toBe(0);
    expect(look.stick.active).toBe(true);
    expect(look.move.y).toBeLessThan(0);

    // Release the pinch finger: the look drag resumes from where it is.
    canvas.dispatchEvent(touch('pointerup', 3, 660, 200));
    canvas.dispatchEvent(touch('pointermove', 2, 500, 200));
    look.update();
    expect(look.zoom).toBe(0);
    expect(look.look.dx).toBeCloseTo(0.2);

    // Pinch again, lift the original look finger: the pinch finger becomes the drag.
    canvas.dispatchEvent(touch('pointerdown', 4, 600, 200));
    canvas.dispatchEvent(touch('pointermove', 4, 650, 200)); // 100 -> 150
    canvas.dispatchEvent(touch('pointerup', 2, 500, 200));
    canvas.dispatchEvent(touch('pointermove', 4, 640, 200));
    look.update();
    expect(look.zoom).toBeCloseTo(0.5);
    expect(look.look.dx).toBeCloseTo(-0.1);
    canvas.dispatchEvent(touch('pointerup', 4, 640, 200));
    canvas.dispatchEvent(touch('pointerup', 1, 100, 250));
    look.update();
    expect(look.move).toEqual({ x: 0, y: 0 });
  });

  it('pinch: false leaves a second right-half finger ignored', () => {
    look.zoomPinch = false;
    look.attach(canvas);
    canvas.dispatchEvent(touch('pointerdown', 2, 500, 200));
    canvas.dispatchEvent(touch('pointerdown', 3, 600, 200));
    canvas.dispatchEvent(touch('pointermove', 3, 700, 200));
    look.update();
    expect(look.zoom).toBe(0);
    expect(look.look.dx).toBe(0);
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

describe('Look lockOnFirstClick (ws/ergo-3d)', () => {
  const click = () =>
    new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'mouse', bubbles: true });
  let canvas: HTMLElement;
  let look: Look;
  afterEach(() => {
    look.detach();
    canvas.remove();
    delete (document as { pointerLockElement?: unknown }).pointerLockElement;
    delete (document as { exitPointerLock?: unknown }).exitPointerLock;
  });

  it('a mouse pointerdown requests the lock while unlocked; touches and blocked never do', async () => {
    canvas = document.createElement('div');
    document.body.appendChild(canvas);
    look = new Look({ lockOnFirstClick: true, getGamepads: () => [] });
    const { req } = fakeLock(canvas, true);
    look.attach(canvas);
    canvas.dispatchEvent(touch('pointerdown', 1, 600, 200));
    expect(req).not.toHaveBeenCalled();
    canvas.dispatchEvent(click());
    expect(req).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(look.locked).toBe(true);
    // Held: another click asks for nothing.
    canvas.dispatchEvent(click());
    expect(req).toHaveBeenCalledTimes(1);
    // Released (Escape): the next click locks again.
    look.release();
    canvas.dispatchEvent(click());
    expect(req).toHaveBeenCalledTimes(2);
    look.blocked = () => true;
    look.release();
    canvas.dispatchEvent(click());
    expect(req).toHaveBeenCalledTimes(2);
  });

  it('is off by default', () => {
    canvas = document.createElement('div');
    document.body.appendChild(canvas);
    look = new Look({ getGamepads: () => [] });
    const { req } = fakeLock(canvas, true);
    look.attach(canvas);
    canvas.dispatchEvent(click());
    expect(req).not.toHaveBeenCalled();
  });
});

describe('Look orbit mode in the DOM (ws/input-3)', () => {
  let canvas: HTMLElement;

  beforeEach(() => {
    canvas = document.createElement('div');
    document.body.appendChild(canvas);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
  });

  afterEach(() => {
    canvas.remove();
    vi.restoreAllMocks();
    delete (document as { pointerLockElement?: unknown }).pointerLockElement;
    delete (document as { exitPointerLock?: unknown }).exitPointerLock;
  });

  const mouse = (type: string, x: number, y: number, button = 0) =>
    new PointerEvent(type, {
      pointerId: 7,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: x,
      clientY: y,
      button,
      bubbles: true,
    });

  it('never requests the lock, warns once about lockOnFirstClick, and drags via its own listeners', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const look = new Look({
      mode: 'orbit',
      sensitivity: 0.01,
      lockOnFirstClick: true,
      getGamepads: () => [],
    });
    const { req } = fakeLock(canvas, true);
    look.attach(canvas);
    canvas.dispatchEvent(mouse('pointerdown', 100, 100));
    canvas.dispatchEvent(mouse('pointermove', 120, 100));
    canvas.dispatchEvent(mouse('pointerdown', 100, 100));
    look.update();
    expect(req).not.toHaveBeenCalled();
    expect(look.locked).toBe(false);
    expect(look.look.dx).toBeCloseTo(0.2);
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(look.request()).resolves.toBe(false);
    expect(req).not.toHaveBeenCalled();
    canvas.dispatchEvent(mouse('pointerup', 120, 100));
    canvas.dispatchEvent(mouse('pointermove', 220, 100));
    look.update();
    expect(look.look.dx).toBe(0);
    look.detach();
  });

  it('linked to an Input with Gestures, an orbit drag turns the view and never pans', () => {
    const look = new Look({ mode: 'orbit', sensitivity: 0.01, getGamepads: () => [] });
    const gestures = new Gestures({ now: () => 0 });
    const input = new Input(
      { pan: [{ gesture: 'pan' }] },
      { look, gestures, getGamepads: () => [] },
    );
    input.attach({ pointerTarget: canvas });
    canvas.dispatchEvent(mouse('pointerdown', 100, 100));
    canvas.dispatchEvent(mouse('pointermove', 140, 100));
    input.update();
    expect(look.look.dx).toBeCloseTo(0.4);
    expect(gestures.pan).toBeNull();
    expect(input.held('pan')).toBe(false);
    canvas.dispatchEvent(mouse('pointerup', 140, 100));
    input.update();
    // In locked mode the same drag is a pan again.
    look.setMode('locked');
    canvas.dispatchEvent(mouse('pointerdown', 100, 100));
    canvas.dispatchEvent(mouse('pointermove', 140, 100));
    input.update();
    expect(look.look.dx).toBe(0);
    expect(gestures.pan).not.toBeNull();
    expect(input.held('pan')).toBe(true);
    input.detach();
  });
});

describe('Look.onTap times by timeStamp (ws/input-6)', () => {
  let canvas: HTMLElement;
  let wall: number;

  beforeEach(() => {
    canvas = document.createElement('div');
    document.body.appendChild(canvas);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
    wall = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
  });

  afterEach(() => {
    canvas.remove();
    vi.restoreAllMocks();
  });

  /** A mouse event that happened at `ms` on the `performance.now()` clock. */
  const mouse = (type: string, ms: number) => {
    const e = new PointerEvent(type, {
      pointerId: 1,
      clientX: 600,
      clientY: 100,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      bubbles: true,
    });
    Object.defineProperty(e, 'timeStamp', { value: ms });
    return e;
  };

  it('a quick press handled 900 ms late still taps; a real hold does not', () => {
    const look = new Look({ mode: 'orbit', getGamepads: () => [] });
    const taps: number[] = [];
    look.onTap((x) => taps.push(x));
    const input = new Input({}, { look, getGamepads: () => [] });
    input.attach({ pointerTarget: canvas });
    canvas.dispatchEvent(mouse('pointerdown', 0));
    // The thread stalls: the up happened at 120 but is handled at 900.
    wall = 900;
    canvas.dispatchEvent(mouse('pointerup', 120));
    expect(taps).toEqual([600]);
    wall = 2000;
    canvas.dispatchEvent(mouse('pointerdown', 1000));
    canvas.dispatchEvent(mouse('pointerup', 1500));
    expect(taps).toEqual([600]);
    input.detach();
    look.detach();
  });
});
