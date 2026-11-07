// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gestures } from './gestures';
import { Input } from './input';

function ptr(type: string, id: number, x: number, y: number, init: PointerEventInit = {}) {
  return new PointerEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    isPrimary: id === 1,
    button: 0,
    bubbles: true,
    ...init,
  });
}

describe('Gestures DOM attachment', () => {
  let canvas: HTMLElement;
  let t: number;
  let g: Gestures;

  beforeEach(() => {
    canvas = document.createElement('div');
    document.body.appendChild(canvas);
    t = 0;
    g = new Gestures({ now: () => t });
  });

  afterEach(() => {
    g.detach();
    canvas.remove();
    vi.restoreAllMocks();
  });

  it('reads touch taps and drags relative to the target when there is no transform', () => {
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 400, 300));
    g.attach({ pointerTarget: canvas });
    expect(canvas.style.touchAction).toBe('none');
    canvas.dispatchEvent(ptr('pointerdown', 1, 110, 60));
    canvas.dispatchEvent(ptr('pointerup', 1, 110, 60));
    g.update();
    expect(g.tap).toEqual({ x: 10, y: 10, inside: true, device: 'touch' });

    canvas.dispatchEvent(ptr('pointerdown', 1, 110, 60, { pointerType: 'pen' }));
    canvas.dispatchEvent(ptr('pointermove', 1, 150, 60, { pointerType: 'pen' }));
    g.update();
    expect(g.drag).toMatchObject({
      phase: 'start',
      x: 50,
      origin: { x: 10, y: 10 },
      device: 'pen',
    });
  });

  it('runs the transform on client coordinates; mouse uses the primary button only', () => {
    g.setPointerTransform((x, y) => ({ x: x * 2, y: y * 2 }));
    g.attach({ pointerTarget: canvas });
    canvas.dispatchEvent(ptr('pointerdown', 1, 5, 5, { pointerType: 'mouse', button: 2 }));
    canvas.dispatchEvent(ptr('pointerup', 1, 5, 5, { pointerType: 'mouse', button: 2 }));
    g.update();
    expect(g.tap).toBeNull();
    canvas.dispatchEvent(ptr('pointerdown', 1, 5, 5, { pointerType: 'mouse' }));
    canvas.dispatchEvent(ptr('pointerup', 1, 5, 5, { pointerType: 'mouse' }));
    g.update();
    expect(g.tap).toEqual({ x: 10, y: 10, inside: true, device: 'mouse' });
  });

  it('two touches pinch; pointercancel and window blur drop the press', () => {
    g.attach({ pointerTarget: canvas });
    canvas.dispatchEvent(ptr('pointerdown', 1, 0, 0));
    canvas.dispatchEvent(ptr('pointerdown', 2, 100, 0));
    canvas.dispatchEvent(ptr('pointermove', 2, 200, 0));
    g.update();
    expect(g.pinch?.phase).toBe('start');
    g.update();
    expect(g.pinch?.scale).toBeCloseTo(2);
    canvas.dispatchEvent(ptr('pointercancel', 2, 200, 0));
    g.update();
    expect(g.pinch?.phase).toBe('cancel');
    canvas.dispatchEvent(ptr('pointerup', 1, 0, 0));

    canvas.dispatchEvent(ptr('pointerdown', 1, 0, 0));
    window.dispatchEvent(new Event('blur'));
    canvas.dispatchEvent(ptr('pointerup', 1, 0, 0));
    g.update();
    expect(g.tap).toBeNull();
  });

  it('detach removes the listeners and restores touch-action', () => {
    canvas.style.touchAction = 'pan-y';
    g.attach({ pointerTarget: canvas });
    g.detach();
    expect(canvas.style.touchAction).toBe('pan-y');
    canvas.dispatchEvent(ptr('pointerdown', 1, 0, 0));
    canvas.dispatchEvent(ptr('pointerup', 1, 0, 0));
    g.update();
    expect(g.tap).toBeNull();
  });

  it('a linked Input attaches, transforms, updates and detaches its gestures', () => {
    canvas.style.touchAction = 'auto';
    const input = new Input(
      { select: [{ gesture: 'tap' }], click: [{ mouse: 0 }] },
      {
        getGamepads: () => [],
      },
    );
    input.setPointerTransform((x, y) => ({ x: x + 1, y: y + 1 }));
    input.setGestures(g);
    input.attach({ pointerTarget: canvas });
    canvas.dispatchEvent(ptr('pointerdown', 1, 20, 30));
    canvas.dispatchEvent(ptr('pointerup', 1, 20, 30));
    input.update();
    expect(input.pressed('select')).toBe(true);
    expect(input.pressed('click')).toBe(true);
    expect(g.tap).toMatchObject({ x: 21, y: 31 });
    input.detach();
    expect(canvas.style.touchAction).toBe('auto');
    canvas.dispatchEvent(ptr('pointerdown', 1, 20, 30));
    canvas.dispatchEvent(ptr('pointerup', 1, 20, 30));
    input.update();
    expect(g.tap).toBeNull();

    // Linking after attach attaches straight away.
    input.setGestures(null);
    input.attach({ pointerTarget: canvas });
    input.setGestures(g);
    canvas.dispatchEvent(ptr('pointerdown', 1, 0, 0));
    canvas.dispatchEvent(ptr('pointerup', 1, 0, 0));
    input.update();
    expect(input.pressed('select')).toBe(true);
    input.detach();
  });
});

describe('Gestures magnify: the loupe element', () => {
  it('shows while a finger holds below the pitch, and hides when it lifts', () => {
    const source = document.createElement('canvas');
    document.body.appendChild(source);
    let t = 0;
    const g = new Gestures({
      now: () => t,
      magnify: {
        pitch: () => 30,
        source,
        className: 'my-loupe',
        snap: (x, y) => ({ x, y, r: 10 }),
      },
    });
    g.pointerDown(1, 100, 100);
    t += 16;
    g.update();
    const el = g.loupeElement;
    expect(el?.classList.contains('tc-loupe')).toBe(true);
    expect(el?.classList.contains('my-loupe')).toBe(true);
    expect(el?.dataset.on).toBe('');
    expect(el?.style.width).toBe('128px');
    g.pointerUp(1, 100, 100);
    t += 16;
    g.update();
    expect(el?.dataset.on).toBeUndefined();
    g.destroy();
    expect(el?.isConnected).toBe(false);
    source.remove();
  });
});

/** `e` with its `timeStamp` set to `ms` (when it happened, on the `performance.now()` clock). */
function stamped<E extends Event>(e: E, ms: number): E {
  Object.defineProperty(e, 'timeStamp', { value: ms });
  return e;
}

describe('Gestures time events by timeStamp, not handling time (ws/input-6)', () => {
  let canvas: HTMLElement;
  let wall: number;

  beforeEach(() => {
    canvas = document.createElement('div');
    document.body.appendChild(canvas);
    wall = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
  });

  afterEach(() => {
    canvas.remove();
    vi.restoreAllMocks();
  });

  it('a down at 0 and an up stamped 120 but handled at 900 are a tap, not a long-press', () => {
    const g = new Gestures();
    g.attach({ pointerTarget: canvas });
    const seen: string[] = [];
    g.onGesture((kind) => seen.push(kind));
    canvas.dispatchEvent(stamped(ptr('pointerdown', 1, 10, 10), 0));
    g.update();
    // The thread stalls; the move and the up are handled 900 ms in, before the next tick.
    wall = 900;
    canvas.dispatchEvent(stamped(ptr('pointermove', 1, 11, 10), 60));
    canvas.dispatchEvent(stamped(ptr('pointerup', 1, 11, 10), 120));
    g.update();
    expect(g.tap).not.toBeNull();
    expect(g.longPress).toBeNull();
    expect(seen).toEqual(['tap']);
    g.detach();
  });

  it('a down and up both handled late, stamped 0 and 120, are a tap', () => {
    const g = new Gestures();
    g.attach({ pointerTarget: canvas });
    wall = 900;
    canvas.dispatchEvent(stamped(ptr('pointerdown', 1, 10, 10), 0));
    canvas.dispatchEvent(stamped(ptr('pointerup', 1, 10, 10), 120));
    g.update();
    expect(g.tap).not.toBeNull();
    expect(g.longPress).toBeNull();
    g.detach();
  });

  it('a real hold past the threshold is still a long-press, timed from the down stamp', () => {
    const g = new Gestures();
    g.attach({ pointerTarget: canvas });
    // The down is handled 200 ms late; the timer measures from its stamp, not from 200.
    wall = 200;
    canvas.dispatchEvent(stamped(ptr('pointerdown', 1, 10, 10), 0));
    g.update();
    expect(g.longPress).toBeNull();
    wall = 460;
    g.update();
    expect(g.longPress).toMatchObject({ x: 10, y: 10 });
    wall = 900;
    canvas.dispatchEvent(stamped(ptr('pointerup', 1, 10, 10), 600));
    g.update();
    expect(g.tap).toBeNull();
    expect(g.longPress).toBeNull();

    // Held past the threshold with no tick in between, up handled late: a long-press too.
    wall = 2000;
    canvas.dispatchEvent(stamped(ptr('pointerdown', 1, 10, 10), 1000));
    canvas.dispatchEvent(stamped(ptr('pointerup', 1, 10, 10), 1500));
    g.update();
    expect(g.tap).toBeNull();
    expect(g.longPress).not.toBeNull();
    g.detach();
  });

  it('double taps use the stamps: two late taps 450 ms apart are not a double tap', () => {
    const g = new Gestures();
    g.attach({ pointerTarget: canvas });
    wall = 900;
    canvas.dispatchEvent(stamped(ptr('pointerdown', 1, 10, 10), 0));
    canvas.dispatchEvent(stamped(ptr('pointerup', 1, 10, 10), 50));
    canvas.dispatchEvent(stamped(ptr('pointerdown', 1, 10, 10), 500));
    canvas.dispatchEvent(stamped(ptr('pointerup', 1, 10, 10), 550));
    g.update();
    expect(g.tap).not.toBeNull();
    g.update();
    expect(g.tap).not.toBeNull();
    expect(g.doubleTap).toBeNull();
    g.detach();
  });

  it('a fake clock sees the event age: stamps are moved onto it', () => {
    let t = 0;
    const g = new Gestures({ now: () => t });
    g.attach({ pointerTarget: canvas });
    // Wall and fake clocks differ; the press happened 900 ms before it was handled.
    wall = 5000;
    t = 900;
    canvas.dispatchEvent(stamped(ptr('pointerdown', 1, 10, 10), 4100));
    canvas.dispatchEvent(stamped(ptr('pointerup', 1, 10, 10), 4220));
    g.update();
    expect(g.tap).not.toBeNull();
    expect(g.longPress).toBeNull();
    g.detach();
  });
});
