// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gestures } from './gestures';
import { Input } from './input';
import { createTouchZones } from './touch-zones';

function touch(type: string, id: number, x: number, y: number) {
  return new PointerEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    isPrimary: id === 1,
    button: 0,
    bubbles: true,
  });
}

type Action = 'moveLeft' | 'moveRight' | 'moveUp' | 'moveDown' | 'jump' | 'dash' | 'pinch';

describe('createTouchZones', () => {
  let el: HTMLElement;
  let input: Input<Action>;
  let gestures: Gestures;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
    gestures = new Gestures({ now: () => 0 });
    input = new Input<Action>(
      {
        moveLeft: [],
        moveRight: [],
        moveUp: [],
        moveDown: [],
        jump: [{ key: 'Space' }],
        dash: [],
        pinch: [{ gesture: 'pinch' }],
      },
      { getGamepads: () => [], gestures },
    );
    input.attach({ pointerTarget: el });
  });

  afterEach(() => {
    input.detach();
    el.remove();
    vi.restoreAllMocks();
  });

  const build = () =>
    createTouchZones(input, {
      zones: {
        move: {
          kind: 'stick',
          rect: (w, h) => ({ x: 0, y: h / 2, w: w / 2, h: h / 2 }),
          radius: 50,
          deadZone: 0.1,
        },
        act: {
          kind: 'buttons',
          rect: (w, h) => ({ x: w / 2, y: h / 2, w: w / 2, h: h / 2 }),
          buttons: {
            jump: (w, h) => ({ x: w - 100, y: h - 100, w: 100, h: 100 }),
            dash: (w, h) => ({ x: w - 200, y: h - 100, w: 100, h: 100 }),
          },
        },
        nav: { kind: 'swipe', rect: (w) => ({ x: 0, y: 0, w, h: 100 }), threshold: 20 },
      },
      bindings: {
        moveLeft: { zone: 'move', axis: 'x', dir: -1 },
        moveRight: { zone: 'move', axis: 'x', dir: 1 },
        moveUp: { zone: 'move', axis: 'y', dir: -1 },
        moveDown: [
          { zone: 'move', axis: 'y', dir: 1 },
          { zone: 'nav', swipe: 'down' },
        ],
        jump: { zone: 'act', button: 'jump' },
        dash: { zone: 'nav', swipe: 'right' },
      },
    });

  it('two pointers in two zones read independently and never pinch', () => {
    const zones = build();
    el.dispatchEvent(touch('pointerdown', 1, 100, 300));
    el.dispatchEvent(touch('pointerdown', 2, 750, 350));
    el.dispatchEvent(touch('pointermove', 1, 150, 300));
    el.dispatchEvent(touch('pointermove', 2, 760, 350));
    input.update();
    expect(zones.zones.move.active).toBe(true);
    expect(zones.zones.move.x).toBeCloseTo(1);
    expect(zones.zones.move.y).toBeCloseTo(0);
    expect(zones.zones.act.held('jump')).toBe(true);
    expect(zones.zones.act.pressed('jump')).toBe(true);
    expect(input.axis('moveLeft', 'moveRight')).toBeCloseTo(1);
    expect(input.pressed('jump')).toBe(true);
    expect(input.held('pinch')).toBe(false);
    expect(input.dispatcher!.claimed(1)).toBe(true);
    expect(input.dispatcher!.claimed(2)).toBe(true);
    input.update();
    expect(zones.zones.act.pressed('jump')).toBe(false);
    expect(input.held('jump')).toBe(true);
    el.dispatchEvent(touch('pointerup', 2, 760, 350));
    el.dispatchEvent(touch('pointermove', 1, 100, 260));
    input.update();
    expect(zones.zones.act.held('jump')).toBe(false);
    expect(input.released('jump')).toBe(true);
    // 40 px up of a 50 px radius: 0.8, rescaled past the 0.1 dead zone.
    expect(input.axis('moveUp', 'moveDown')).toBeCloseTo(-(0.8 - 0.1) / 0.9);
    el.dispatchEvent(touch('pointerup', 1, 100, 260));
    input.update();
    expect(zones.zones.move.active).toBe(false);
    expect(zones.zones.move.vector).toEqual([0, 0]);
    expect(input.held('pinch')).toBe(false);
    zones.destroy();
  });

  it('a pointer starting outside every zone is not claimed and reaches gestures', () => {
    const zones = build();
    const pans: number[] = [];
    gestures.onGesture((kind, _phase, g) => {
      if (kind === 'pan') pans.push(g.x);
    });
    el.dispatchEvent(touch('pointerdown', 1, 500, 150));
    expect(input.dispatcher!.claimed(1)).toBe(false);
    el.dispatchEvent(touch('pointermove', 1, 540, 150));
    input.update();
    expect(zones.zones.move.active).toBe(false);
    expect(zones.zones.act.active).toBe(false);
    expect(pans.length).toBeGreaterThan(0);
    // A second pointer in the move zone is claimed while the first stays with the gestures.
    el.dispatchEvent(touch('pointerdown', 2, 100, 300));
    expect(input.dispatcher!.claimed(2)).toBe(true);
    expect(zones.zones.move.active).toBe(true);
    zones.destroy();
  });

  it('a zone takes one pointer; the dead zone and the stick radius clamp', () => {
    const zones = build();
    el.dispatchEvent(touch('pointerdown', 1, 100, 300));
    el.dispatchEvent(touch('pointerdown', 2, 200, 300));
    expect(input.dispatcher!.claimed(2)).toBe(false);
    el.dispatchEvent(touch('pointermove', 1, 103, 300));
    input.update();
    expect(zones.zones.move.x).toBe(0);
    el.dispatchEvent(touch('pointermove', 1, 300, 300));
    input.update();
    expect(zones.zones.move.x).toBe(1);
    expect(zones.zones.move.originX).toBe(100);
    zones.destroy();
  });

  it('a swipe reports once per gesture and feeds its actions', () => {
    const zones = build();
    el.dispatchEvent(touch('pointerdown', 1, 100, 50));
    el.dispatchEvent(touch('pointermove', 1, 110, 50));
    input.update();
    expect(zones.zones.nav.swipe).toBeNull();
    el.dispatchEvent(touch('pointermove', 1, 130, 52));
    input.update();
    expect(zones.zones.nav.swipe).toBe('right');
    expect(input.pressed('dash')).toBe(true);
    el.dispatchEvent(touch('pointermove', 1, 200, 52));
    input.update();
    expect(zones.zones.nav.swipe).toBeNull();
    expect(input.released('dash')).toBe(true);
    el.dispatchEvent(touch('pointerup', 1, 200, 52));
    el.dispatchEvent(touch('pointerdown', 1, 100, 50));
    el.dispatchEvent(touch('pointermove', 1, 100, 90));
    input.update();
    expect(zones.zones.nav.swipe).toBe('down');
    expect(input.pressed('moveDown')).toBe(true);
    zones.destroy();
  });

  it('a centre-anchored stick measures from the zone centre; disabled zones take nothing', () => {
    const zones = createTouchZones(input, {
      zones: {
        move: {
          kind: 'stick',
          rect: () => ({ x: 0, y: 200, w: 200, h: 200 }),
          anchor: 'center',
          radius: 100,
          deadZone: 0,
        },
      },
    });
    el.dispatchEvent(touch('pointerdown', 1, 150, 300));
    input.update();
    expect(zones.zones.move.originX).toBe(100);
    expect(zones.zones.move.x).toBeCloseTo(0.5);
    el.dispatchEvent(touch('pointerup', 1, 150, 300));
    zones.enabled = false;
    el.dispatchEvent(touch('pointerdown', 1, 150, 300));
    expect(zones.zones.move.active).toBe(false);
    expect(input.dispatcher!.claimed(1)).toBe(false);
    zones.destroy();
  });

  it('follows the input through detach and attach; destroy unlinks', () => {
    const zones = build();
    input.detach();
    expect(zones.zones.move.active).toBe(false);
    input.attach({ pointerTarget: el });
    el.dispatchEvent(touch('pointerdown', 1, 100, 300));
    expect(zones.zones.move.active).toBe(true);
    el.dispatchEvent(touch('pointerup', 1, 100, 300));
    zones.destroy();
    el.dispatchEvent(touch('pointerdown', 1, 100, 300));
    expect(zones.zones.move.active).toBe(false);
    expect(input.dispatcher!.claimed(1)).toBe(false);
  });

  it('types bindings against the input actions and the zone names (ws/api-core)', () => {
    const zones = { move: { kind: 'stick', rect: () => ({ x: 0, y: 0, w: 1, h: 1 }) } } as const;
    const ok = createTouchZones(input, {
      zones,
      bindings: { moveLeft: { zone: 'move', axis: 'x', dir: -1 } },
    });
    ok.destroy();
    const typo = () =>
      createTouchZones(input, {
        zones,
        // @ts-expect-error: 'mvoe' is not a zone
        bindings: { moveLeft: { zone: 'mvoe', axis: 'x', dir: -1 } },
      });
    const unknownAction = () =>
      createTouchZones(input, {
        zones,
        // @ts-expect-error: 'fly' is not one of the input's actions
        bindings: { fly: { zone: 'move', axis: 'y', dir: 1 } },
      });
    expect(typeof typo).toBe('function');
    expect(typeof unknownAction).toBe('function');
  });
});
