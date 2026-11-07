// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../render/camera';
import { Gestures } from './gestures';
import { Input } from './input';
import { Look } from './look';
import { createPointerDispatcher, eventTime, type PointerConsumer } from './pointer-dispatch';
import { createPointerRouter } from './pointer-router';
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
const touch = (type: string, id: number, x: number, y: number) =>
  ptr(type, x, y, { pointerId: id, pointerType: 'touch', isPrimary: id === 1 });

const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave'];

describe('createPointerDispatcher', () => {
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 800, 400));
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  it('attaches one listener per pointer event type, removed on destroy', () => {
    const add = vi.spyOn(el, 'addEventListener');
    const remove = vi.spyOn(el, 'removeEventListener');
    const d = createPointerDispatcher(el);
    const types = add.mock.calls.map((c) => c[0]).filter((t) => t.startsWith('pointer'));
    expect(types.sort()).toEqual([...POINTER_EVENTS].sort());
    d.destroy();
    expect(remove.mock.calls.map((c) => c[0]).filter((t) => t.startsWith('pointer')).length).toBe(
      POINTER_EVENTS.length,
    );
  });

  it('fills a record once per event and fans it out in priority order', () => {
    const d = createPointerDispatcher(el);
    const order: string[] = [];
    const record = (name: string): PointerConsumer => ({
      pointerDown: (p) => order.push(`${name}:${p.id}:${p.device}:${p.x},${p.y}:${p.button}`),
    });
    d.add(record('b'), 20);
    d.add(record('a'), 10);
    d.add(record('c'), 20);
    el.dispatchEvent(ptr('pointerdown', 110, 70, { pointerType: 'pen', button: -1 }));
    expect(order).toEqual(['a:1:pen:100,50:0', 'b:1:pen:100,50:0', 'c:1:pen:100,50:0']);
  });

  it('keeps client coordinates and reports inside with a transform', () => {
    const transform = vi.fn((x: number, y: number) => (x < 400 ? { x: x * 2, y } : null));
    const d = createPointerDispatcher(el, { transform });
    const seen: [number, number, boolean][] = [];
    d.add({ pointerMove: (p) => seen.push([p.x, p.y, p.inside]) });
    el.dispatchEvent(ptr('pointermove', 100, 50));
    el.dispatchEvent(ptr('pointermove', 500, 50));
    expect(seen).toEqual([
      [100, 50, true],
      [500, 50, false],
    ]);
    d.setTransform(null);
    el.dispatchEvent(ptr('pointermove', 500, 50));
    expect(seen[2]).toEqual([490, 30, true]);
  });

  it('a claim hides the pointer from other consumers until release or lift', () => {
    const d = createPointerDispatcher(el);
    const a: string[] = [];
    const b: string[] = [];
    const owner: PointerConsumer = {
      pointerDown: (p) => {
        a.push('down');
        d.claim(p.id, owner);
      },
      pointerMove: () => a.push('move'),
      pointerUp: () => a.push('up'),
    };
    const other: PointerConsumer = {
      pointerDown: () => b.push('down'),
      pointerMove: () => b.push('move'),
      pointerUp: () => b.push('up'),
    };
    d.add(owner, 0);
    d.add(other, 1);
    el.dispatchEvent(touch('pointerdown', 1, 10, 10));
    el.dispatchEvent(touch('pointermove', 1, 20, 10));
    expect(d.owner(1)).toBe(owner);
    d.release(1);
    el.dispatchEvent(touch('pointermove', 1, 30, 10));
    el.dispatchEvent(touch('pointerup', 1, 30, 10));
    expect(a).toEqual(['down', 'move', 'move', 'up']);
    expect(b).toEqual(['move', 'up']);
    // A second pointer is independent; its claim ends with its lift.
    el.dispatchEvent(touch('pointerdown', 2, 10, 10));
    expect(d.claimed(2)).toBe(true);
    el.dispatchEvent(touch('pointerup', 2, 10, 10));
    expect(d.claimed(2)).toBe(false);
    expect(b).toEqual(['move', 'up']);
  });

  it('seesClaimed consumers still receive claimed pointers; a second claim is refused', () => {
    const d = createPointerDispatcher(el);
    const o1 = {};
    const o2 = {};
    const seen: number[] = [];
    d.add({ pointerMove: (p) => seen.push(p.id) }, 0, true);
    expect(d.claim(1, o1)).toBe(true);
    expect(d.claim(1, o2)).toBe(false);
    expect(d.claim(1, o1)).toBe(true);
    el.dispatchEvent(ptr('pointermove', 1, 1));
    expect(seen).toEqual([1]);
  });

  it('blur and a hidden tab cancel every consumer and clear claims', () => {
    const d = createPointerDispatcher(el);
    const cancelAll = vi.fn();
    d.add({ cancelAll });
    d.claim(1, {});
    window.dispatchEvent(new Event('blur'));
    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(d.claimed(1)).toBe(false);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cancelAll).toHaveBeenCalledTimes(2);
    delete (document as { visibilityState?: unknown }).visibilityState;
  });
});

describe('Input with the dispatcher', () => {
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  it('attaches one listener set for input, gestures, look and router together', () => {
    const add = vi.spyOn(el, 'addEventListener');
    const gestures = new Gestures();
    const look = new Look({ getGamepads: () => [] });
    const router = createPointerRouter<string>({ camera: Camera.ortho2d(800, 400) });
    const input = new Input<'jump'>(
      { jump: [{ gesture: 'tap' }] },
      { getGamepads: () => [], gestures, look, pointers: router },
    );
    input.attach({ pointerTarget: el });
    const counts = new Map<string, number>();
    for (const [type] of add.mock.calls) counts.set(type, (counts.get(type) ?? 0) + 1);
    for (const t of POINTER_EVENTS) expect(counts.get(t), t).toBe(1);
    expect(input.dispatcher).not.toBeNull();
    input.detach();
    expect(input.dispatcher).toBeNull();
  });

  it('parses pointerType once per event', () => {
    const gestures = new Gestures();
    const look = new Look({ getGamepads: () => [] });
    const input = new Input<'jump'>({ jump: [] }, { getGamepads: () => [], gestures, look });
    input.attach({ pointerTarget: el });
    const e = ptr('pointerdown', 10, 10, { pointerType: 'pen' });
    const spy = vi.fn(() => 'pen');
    Object.defineProperty(e, 'pointerType', { get: spy });
    el.dispatchEvent(e);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(input.pointer.type).toBe('pen');
    input.detach();
  });

  it('standalone Gestures and Look still attach themselves', () => {
    const add = vi.spyOn(el, 'addEventListener');
    const gestures = new Gestures({ now: () => 0 });
    gestures.attach({ pointerTarget: el });
    const look = new Look({ mode: 'orbit', sensitivity: 0.01, getGamepads: () => [] });
    look.attach(el);
    // Two private dispatchers: two listener sets.
    expect(add.mock.calls.filter((c) => c[0] === 'pointerdown').length).toBe(2);
    el.dispatchEvent(touch('pointerdown', 1, 10, 10));
    el.dispatchEvent(touch('pointerup', 1, 10, 10));
    gestures.update();
    expect(gestures.tap?.x).toBe(10);
    el.dispatchEvent(ptr('pointerdown', 100, 100, { pointerId: 7 }));
    el.dispatchEvent(ptr('pointermove', 150, 100, { pointerId: 7 }));
    look.update();
    expect(look.look.dx).toBeCloseTo(0.5);
    gestures.detach();
    look.detach();
  });

  it('an orbit drag claims its pointer: the router emits no hit during the drag, hits again after', () => {
    const gestures = new Gestures({ now: () => 0 });
    const look = new Look({ mode: 'orbit', getGamepads: () => [] });
    const router = createPointerRouter<string>({
      camera: Camera.ortho2d(800, 400),
      testers: [aabbTester([{ min: [0, 0, 0], max: [800, 400, 0], target: 'q' }])],
    });
    const input = new Input<'jump'>(
      { jump: [] },
      { getGamepads: () => [], gestures, look, pointers: router },
    );
    input.setPointerTransform((x, y) => ({ x, y }));
    input.attach({ pointerTarget: el });
    const hits: string[] = [];
    router.on('hit', () => hits.push('hit'));
    router.on('hitEnd', () => hits.push('end'));
    el.dispatchEvent(ptr('pointermove', 50, 50));
    input.update();
    expect(hits).toEqual(['hit']);
    el.dispatchEvent(ptr('pointerdown', 50, 50));
    el.dispatchEvent(ptr('pointermove', 80, 50));
    input.update();
    expect(input.dispatcher!.claimed(1)).toBe(true);
    expect(look.orbiting).toBe(true);
    expect(hits).toEqual(['hit', 'end']);
    expect(router.pointers.length).toBe(0);
    el.dispatchEvent(ptr('pointermove', 120, 50));
    input.update();
    expect(hits).toEqual(['hit', 'end']);
    el.dispatchEvent(ptr('pointerup', 120, 50));
    el.dispatchEvent(ptr('pointermove', 130, 50));
    input.update();
    expect(input.dispatcher!.claimed(1)).toBe(false);
    expect(hits).toEqual(['hit', 'end', 'hit']);
    input.detach();
  });

  it('hoverWhileClaimed keeps the hover through the drag', () => {
    const look = new Look({ mode: 'orbit', getGamepads: () => [] });
    const router = createPointerRouter<string>({
      camera: Camera.ortho2d(800, 400),
      testers: [aabbTester([{ min: [0, 0, 0], max: [800, 400, 0], target: 'q' }])],
    });
    const input = new Input<'jump'>(
      { jump: [] },
      { getGamepads: () => [], look, pointers: router },
    );
    input.setPointerTransform((x, y) => ({ x, y }));
    input.attach({ pointerTarget: el, hoverWhileClaimed: true });
    el.dispatchEvent(ptr('pointerdown', 50, 50));
    el.dispatchEvent(ptr('pointermove', 80, 50));
    input.update();
    expect(router.hit?.target).toBe('q');
    input.detach();
  });

  it('onUpdated runs after triggers, in registration order, and can be removed', () => {
    const input = new Input<'jump'>({ jump: [{ key: 'Space' }] }, { getGamepads: () => [] });
    const seen: string[] = [];
    const off = input.onUpdated(() => seen.push(`a:${input.pressed('jump')}`));
    input.onUpdated(() => seen.push(`b:${input.pressed('jump')}`));
    input.keyDown('Space');
    input.update();
    expect(seen).toEqual(['a:true', 'b:true']);
    off();
    input.update();
    expect(seen).toEqual(['a:true', 'b:true', 'b:false']);
  });

  it('router moved fires once per tick per pointer; released when a button lifts', () => {
    const router = createPointerRouter<string>({
      camera: Camera.ortho2d(800, 400),
      testers: [aabbTester([{ min: [0, 0, 0], max: [800, 400, 0], target: 'q' }])],
    });
    const input = new Input<'jump'>({ jump: [] }, { getGamepads: () => [], pointers: router });
    input.setPointerTransform((x, y) => ({ x, y }));
    input.attach({ pointerTarget: el });
    const moved: (string | null)[] = [];
    const released: number[] = [];
    router.on('moved', (e) => moved.push(e.hit?.target ?? null));
    router.on('released', (e) => released.push(e.pointer.key));
    el.dispatchEvent(ptr('pointermove', 10, 10));
    el.dispatchEvent(ptr('pointermove', 20, 10));
    el.dispatchEvent(ptr('pointermove', 30, 10));
    input.update();
    expect(moved).toEqual(['q']);
    input.update();
    expect(moved).toEqual(['q']);
    el.dispatchEvent(ptr('pointerdown', 30, 10));
    input.update();
    expect(released).toEqual([]);
    el.dispatchEvent(ptr('pointerup', 30, 10));
    input.update();
    expect(released).toEqual([1]);
    input.detach();
  });

  it('an ActionSource feeds values and fresh presses into actions; axis subtracts', () => {
    const input = new Input<'left' | 'right' | 'jump'>(
      { left: [], right: [], jump: [{ key: 'Space' }] },
      { getGamepads: () => [] },
    );
    let right = 0;
    let jumpFresh = false;
    let jump = 0;
    const off = input.addActionSource({
      value: (a) => (a === 'right' ? right : a === 'jump' ? jump : 0),
      fresh: (a) => a === 'jump' && jumpFresh,
    });
    right = 0.5;
    input.update();
    expect(input.value('right')).toBe(0.5);
    expect(input.axis('left', 'right')).toBe(0.5);
    expect(input.pressed('right')).toBe(true);
    jump = 1;
    input.update();
    expect(input.pressed('jump')).toBe(true);
    jumpFresh = true;
    input.update();
    expect(input.pressed('jump')).toBe(true);
    jumpFresh = false;
    input.update();
    expect(input.pressed('jump')).toBe(false);
    expect(input.held('jump')).toBe(true);
    off();
    input.update();
    expect(input.held('jump')).toBe(false);
  });
});

describe('eventTime (ws/input-6)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('moves a timeStamp onto a clock by its age; unusable stamps read as now', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    expect(eventTime(880, () => 1000)).toBe(880);
    expect(eventTime(880, () => 50)).toBe(-70);
    expect(eventTime(1200, () => 50)).toBe(50);
    expect(eventTime(Number.NaN, () => 50)).toBe(50);
    expect(eventTime(-1, () => 50)).toBe(50);
  });
});
