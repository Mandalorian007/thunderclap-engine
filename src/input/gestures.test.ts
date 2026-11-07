import { describe, expect, it } from 'vitest';
import { type GestureOptions, Gestures } from './gestures';
import { Input } from './input';

/** Gestures on a fake clock. `tick(ms)` advances the clock and runs one update. */
function setup(opts: GestureOptions = {}) {
  let t = 1000;
  const g = new Gestures({ now: () => t, ...opts });
  return {
    g,
    advance(ms: number) {
      t += ms;
    },
    tick(ms = 16) {
      t += ms;
      g.update();
    },
  };
}

describe('Gestures: tap and pan boundary', () => {
  it('a down and up in place is one tap at the down point', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 100, 50);
    g.pointerUp(1, 100, 50);
    tick();
    expect(g.tap).toEqual({ x: 100, y: 50, inside: true, device: 'touch' });
    expect(g.pan).toBeNull();
    expect(g.drag).toBeNull();
    tick();
    expect(g.tap).toBeNull();
  });

  it('moving exactly the threshold (10 CSS px) is still a tap', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 100, 100);
    g.pointerMove(1, 106, 108); // distance 10
    g.pointerUp(1, 106, 108);
    tick();
    expect(g.tap).not.toBeNull();
    expect(g.pan).toBeNull();
  });

  it('moving past the threshold is a pan and a drag, never a tap', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 100, 100);
    g.pointerMove(1, 111, 100);
    tick();
    expect(g.pan).toMatchObject({ phase: 'start', x: 111, y: 100, dx: 11, dy: 0, pointers: 1 });
    expect(g.drag).toMatchObject({ phase: 'start', origin: { x: 100, y: 100 }, dx: 11 });
    // Coming back inside the threshold does not turn it back into a tap.
    g.pointerMove(1, 100, 100);
    g.pointerUp(1, 100, 100);
    tick();
    expect(g.pan).toMatchObject({ phase: 'move', dx: -11 });
    tick();
    expect(g.pan?.phase).toBe('end');
    expect(g.drag?.phase).toBe('end');
    expect(g.tap).toBeNull();
    tick();
    expect(g.pan).toBeNull();
  });

  it('the threshold is CSS px, not game px', () => {
    // Game space at 2x CSS: an 8 CSS px move is 16 game px but still a tap.
    const { g, tick } = setup();
    g.setPointerTransform((x, y) => ({ x: x * 2, y: y * 2 }));
    g.pointerDown(1, 50, 50);
    g.pointerUp(1, 58, 50);
    tick();
    expect(g.tap).toMatchObject({ x: 100, y: 100 });
    expect(g.pan).toBeNull();
  });

  it('honours a custom threshold', () => {
    const { g, tick } = setup({ panThreshold: 30 });
    g.pointerDown(1, 0, 0);
    g.pointerUp(1, 25, 0);
    tick();
    expect(g.tap).not.toBeNull();
  });
});

describe('Gestures: pan and drag', () => {
  it('reports every tick while running, merging moves and summing to the total travel', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 20, 0);
    tick();
    g.pointerMove(1, 30, 5);
    g.pointerMove(1, 40, 10);
    tick();
    expect(g.drag).toMatchObject({ phase: 'move', x: 40, y: 10, dx: 20, dy: 10 });
    tick();
    // Nothing moved: still reported, with no change.
    expect(g.drag).toMatchObject({ phase: 'move', x: 40, y: 10, dx: 0, dy: 0 });
    g.pointerUp(1, 40, 10);
    tick();
    expect(g.drag).toMatchObject({
      phase: 'end',
      x: 40,
      y: 10,
      origin: { x: 0, y: 0, inside: true },
    });
  });

  it('gives start, move and end their own ticks for a flick between two ticks', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 50, 0);
    g.pointerMove(1, 80, 0);
    g.pointerUp(1, 100, 0);
    const phases: (string | undefined)[] = [];
    let total = 0;
    for (let i = 0; i < 4; i++) {
      tick();
      phases.push(g.drag?.phase);
      total += g.drag?.dx ?? 0;
    }
    expect(phases).toEqual(['start', 'move', 'end', undefined]);
    expect(total).toBe(100);
  });

  it('keeps the origin in game space and drags off the game rect', () => {
    const { g, tick } = setup();
    // A 100x100 game rect at client (10,10), scale 1; outside it the transform returns null.
    g.setPointerTransform((x, y) =>
      x >= 10 && x <= 110 && y >= 10 && y <= 110 ? { x: x - 10, y: y - 10 } : null,
    );
    g.pointerDown(1, 60, 60);
    g.pointerMove(1, 90, 60);
    tick();
    expect(g.drag).toMatchObject({ phase: 'start', x: 80, origin: { x: 50, y: 50, inside: true } });
    g.pointerMove(1, 200, 60);
    tick();
    expect(g.drag).toMatchObject({ phase: 'move', inside: false, x: 80, dx: 0 });
    g.pointerUp(1, 200, 60);
    tick();
    expect(g.drag).toMatchObject({ phase: 'end', inside: false, origin: { x: 50 } });
  });

  it('a second pointer cancels the drag and starts a pinch', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 20, 0);
    tick();
    g.pointerDown(2, 120, 0);
    tick();
    expect(g.drag?.phase).toBe('cancel');
    expect(g.pinch).toMatchObject({ phase: 'start', scale: 1, x: 70, y: 0 });
  });
});

describe('Gestures: long-press', () => {
  it('fires at 450 ms by default, once, and no tap follows', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 10, 10);
    advance(440);
    g.update();
    expect(g.longPress).toBeNull();
    tick(10);
    expect(g.longPress).toEqual({ x: 10, y: 10, inside: true, device: 'touch' });
    tick();
    expect(g.longPress).toBeNull();
    g.pointerUp(1, 10, 10);
    tick();
    expect(g.tap).toBeNull();
    expect(g.longPress).toBeNull();
  });

  it('a release at 449 ms is a tap', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 10, 10);
    advance(449);
    g.pointerUp(1, 10, 10);
    tick(0);
    expect(g.tap).not.toBeNull();
    expect(g.longPress).toBeNull();
  });

  it('a release after the time with no tick in between is still a long-press', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 10, 10);
    advance(600);
    g.pointerUp(1, 10, 10);
    tick(0);
    expect(g.longPress).not.toBeNull();
    expect(g.tap).toBeNull();
  });

  it('moving past the threshold first cancels it; after it fires, moving does not drag', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 30, 0);
    advance(600);
    tick();
    expect(g.longPress).toBeNull();
    expect(g.drag).not.toBeNull();
    g.pointerUp(1);
    tick();
    tick();

    g.pointerDown(2, 0, 0);
    tick(500);
    expect(g.longPress).not.toBeNull();
    g.pointerMove(2, 60, 0);
    tick();
    expect(g.drag).toBeNull();
  });

  it('honours a custom time', () => {
    const { g, tick } = setup({ longPressMs: 800 });
    g.pointerDown(1, 0, 0);
    tick(500);
    expect(g.longPress).toBeNull();
    tick(300);
    expect(g.longPress).not.toBeNull();
  });
});

describe('Gestures: travel before the long-press timer', () => {
  it('a slow drag in 6 px steps across a 500 ms frame gap pans and never long-presses', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 6, 0);
    // A long frame: the next move arrives well past longPressMs.
    advance(500);
    g.pointerMove(1, 12, 0);
    tick();
    expect(g.longPress).toBeNull();
    expect(g.pan).toMatchObject({ phase: 'start', dx: 12 });
    expect(g.drag?.phase).toBe('start');
    g.pointerMove(1, 18, 0);
    tick();
    expect(g.drag).toMatchObject({ phase: 'move', dx: 6 });
    g.pointerUp(1, 18, 0);
    tick();
    expect(g.drag?.phase).toBe('end');
    expect(g.longPress).toBeNull();
    expect(g.tap).toBeNull();
  });

  it('a still finger for 500 ms long-presses', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 20, 20);
    tick(500);
    expect(g.longPress).toMatchObject({ x: 20, y: 20 });
    expect(g.pan).toBeNull();
  });

  it('4 px, 4 px, 4 px (12 cumulative) pans; travel is cumulative, not the last step', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 4, 0);
    g.pointerMove(1, 8, 0);
    tick();
    expect(g.pan).toBeNull();
    g.pointerMove(1, 12, 0);
    tick();
    expect(g.pan).toMatchObject({ phase: 'start', dx: 12 });
    expect(g.drag).toMatchObject({ phase: 'start', origin: { x: 0, y: 0 } });
  });

  it('a mouse follows the same rule', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 0, 0, 'mouse');
    g.pointerMove(1, 5, 0);
    advance(600);
    g.pointerMove(1, 11, 0);
    tick();
    expect(g.longPress).toBeNull();
    expect(g.drag).toMatchObject({ phase: 'start', device: 'mouse' });
  });

  it('a pointer within the threshold still long-presses when its late move arrives', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 0, 0);
    advance(500);
    g.pointerMove(1, 3, 0);
    tick();
    expect(g.longPress).not.toBeNull();
    expect(g.pan).toBeNull();
  });
});

describe('Gestures: onGesture', () => {
  type Seen = [string, string, number, number];
  function observe(g: Gestures) {
    const seen: Seen[] = [];
    const off = g.onGesture((kind, phase, p) => seen.push([kind, phase, p.x, p.y]));
    return { seen, off };
  }

  it('reports start, move and end for a pan at recognition time, not per tick', () => {
    const { g, tick } = setup();
    const { seen } = observe(g);
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 20, 0);
    g.pointerMove(1, 30, 0);
    expect(seen).toEqual([
      ['pan', 'start', 20, 0],
      ['drag', 'start', 20, 0],
      ['pan', 'move', 30, 0],
      ['drag', 'move', 30, 0],
    ]);
    tick();
    tick();
    // Idle ticks are not events.
    expect(seen).toHaveLength(4);
    g.pointerUp(1, 30, 0);
    expect(seen.slice(4)).toEqual([
      ['pan', 'end', 30, 0],
      ['drag', 'end', 30, 0],
    ]);
  });

  it('one call for a tap, and a doubleTap on the second of two', () => {
    const { g, tick, advance } = setup();
    const { seen } = observe(g);
    g.pointerDown(1, 5, 5);
    g.pointerUp(1, 5, 5);
    expect(seen).toEqual([['tap', 'end', 5, 5]]);
    tick();
    tick();
    expect(seen).toHaveLength(1);
    advance(100);
    g.pointerDown(2, 6, 5);
    g.pointerUp(2, 6, 5);
    expect(seen.slice(1)).toEqual([
      ['tap', 'end', 6, 5],
      ['doubleTap', 'end', 6, 5],
    ]);
  });

  it('long-press, pinch and a blocked cancel reach the listener', () => {
    let blocked = false;
    const { g, tick } = setup({ blocked: () => blocked });
    const { seen } = observe(g);
    g.pointerDown(1, 10, 10);
    tick(500);
    expect(seen).toEqual([['longPress', 'end', 10, 10]]);
    g.pointerUp(1);
    tick();

    g.pointerDown(1, 100, 100);
    g.pointerDown(2, 200, 100);
    g.pointerMove(2, 300, 100);
    expect(seen.slice(1)).toEqual([
      ['pinch', 'start', 150, 100],
      ['pinch', 'move', 200, 100],
    ]);
    g.pointerUp(2);
    g.pointerUp(1);
    expect(seen.at(-1)).toEqual(['pinch', 'end', 200, 100]);
    tick();
    tick();

    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 50, 0);
    tick();
    const n = seen.length;
    blocked = true;
    tick();
    expect(seen.slice(n)).toEqual([
      ['pan', 'cancel', 50, 0],
      ['drag', 'cancel', 50, 0],
    ]);
  });

  it('unsubscribe stops the calls; other listeners keep theirs', () => {
    const { g, advance } = setup();
    const a = observe(g);
    const b = observe(g);
    g.pointerDown(1, 1, 1);
    g.pointerUp(1, 1, 1);
    a.off();
    advance(400); // past doubleTapMs: plain taps only
    g.pointerDown(1, 2, 2);
    g.pointerUp(1, 2, 2);
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(2);
    a.off(); // a second call is harmless
    b.off();
    advance(400);
    g.pointerDown(1, 3, 3);
    g.pointerUp(1, 3, 3);
    expect(b.seen).toHaveLength(2);
  });
});

describe('Gestures: double tap', () => {
  it('two quick taps near each other: two taps and one double tap on the second', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 100, 100);
    g.pointerUp(1, 100, 100);
    tick();
    expect(g.tap).not.toBeNull();
    expect(g.doubleTap).toBeNull();
    advance(100);
    g.pointerDown(2, 110, 105);
    g.pointerUp(2, 110, 105);
    tick();
    expect(g.tap).toMatchObject({ x: 110, y: 105 });
    expect(g.doubleTap).toMatchObject({ x: 110, y: 105 });
    // A third tap starts over.
    g.pointerDown(3, 110, 105);
    g.pointerUp(3, 110, 105);
    tick();
    expect(g.tap).not.toBeNull();
    expect(g.doubleTap).toBeNull();
  });

  it('too slow or too far apart is two single taps', () => {
    const { g, tick, advance } = setup();
    g.pointerDown(1, 100, 100);
    g.pointerUp(1, 100, 100);
    tick();
    advance(320);
    g.pointerDown(1, 100, 100);
    g.pointerUp(1, 100, 100);
    tick();
    expect(g.doubleTap).toBeNull();

    advance(400);
    g.pointerDown(1, 100, 100);
    g.pointerUp(1, 100, 100);
    tick();
    g.pointerDown(1, 140, 100);
    g.pointerUp(1, 140, 100);
    tick();
    expect(g.doubleTap).toBeNull();
  });

  it('queues taps that arrive faster than ticks, one per tick', () => {
    const { g, tick } = setup();
    for (const x of [0, 100, 200]) {
      g.pointerDown(1, x, 0);
      g.pointerUp(1, x, 0);
    }
    const xs: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      tick();
      xs.push(g.tap?.x);
    }
    expect(xs).toEqual([0, 100, 200, undefined]);
  });
});

describe('Gestures: pinch and multi-pointer', () => {
  it('reports scale and per-tick delta, ending when a pointer lifts', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 100, 100);
    g.pointerDown(2, 200, 100);
    tick();
    expect(g.pinch).toMatchObject({ phase: 'start', scale: 1, delta: 1, x: 150 });
    expect(g.tap).toBeNull();
    g.pointerMove(2, 300, 100);
    tick();
    expect(g.pinch?.scale).toBeCloseTo(2);
    expect(g.pinch?.delta).toBeCloseTo(2);
    g.pointerMove(1, 0, 100);
    tick();
    expect(g.pinch?.scale).toBeCloseTo(3);
    expect(g.pinch?.delta).toBeCloseTo(1.5);
    g.pointerUp(2);
    tick();
    expect(g.pinch).toMatchObject({ phase: 'end' });
    expect(g.pinch?.scale).toBeCloseTo(3);
    // The remaining pointer does nothing until it lifts.
    g.pointerMove(1, 200, 300);
    g.pointerUp(1);
    tick();
    tick();
    expect(g.pinch).toBeNull();
    expect(g.tap).toBeNull();
    expect(g.drag).toBeNull();
    expect(g.pan).toBeNull();
  });

  it('two pointers moving together never pan or drag: pinch wins', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 100, 100);
    g.pointerDown(2, 200, 100);
    tick();
    expect(g.pinch?.phase).toBe('start');
    // The centre travels 60 CSS px, well past the pan threshold.
    g.pointerMove(1, 130, 100);
    g.pointerMove(2, 230, 100);
    tick();
    g.pointerMove(1, 160, 100);
    g.pointerMove(2, 260, 100);
    tick();
    expect(g.pan).toBeNull();
    expect(g.drag).toBeNull();
    expect(g.pinch).toMatchObject({ phase: 'move', x: 210 });
    g.pointerUp(2);
    g.pointerUp(1);
    tick();
    expect(g.pinch?.phase).toBe('end');
    expect(g.pan).toBeNull();
    tick();
    expect(g.pan).toBeNull();
    expect(g.drag).toBeNull();
  });

  it('a second pointer cancels a running pan and drag, and neither resumes while two are down', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 100, 100);
    g.pointerMove(1, 130, 100);
    tick();
    expect(g.pan).toMatchObject({ phase: 'start', pointers: 1, dx: 30 });
    expect(g.drag?.phase).toBe('start');
    g.pointerDown(2, 200, 100);
    tick();
    expect(g.pan).toMatchObject({ phase: 'cancel', dx: 0, dy: 0 });
    expect(g.drag).toMatchObject({ phase: 'cancel', origin: { x: 100, y: 100 } });
    expect(g.pinch?.phase).toBe('start');
    g.pointerMove(1, 170, 140);
    g.pointerMove(2, 240, 140);
    tick();
    expect(g.pan).toBeNull();
    expect(g.drag).toBeNull();
    // Lifting one pointer ends the pinch; the remaining pointer cannot start a new pan.
    g.pointerUp(2);
    tick();
    expect(g.pinch?.phase).toBe('end');
    g.pointerMove(1, 300, 300);
    tick();
    expect(g.pan).toBeNull();
    expect(g.drag).toBeNull();
    g.pointerUp(1);
    tick();
    expect(g.pan).toBeNull();
  });
});

describe('Gestures: blocked and cancel', () => {
  it('reports nothing while blocked, and the press held across it never fires', () => {
    let blocked = true;
    const { g, tick } = setup({ blocked: () => blocked });
    g.pointerDown(1, 0, 0);
    g.pointerUp(1, 0, 0);
    tick();
    expect(g.tap).toBeNull();
    g.pointerDown(1, 0, 0);
    tick(600);
    expect(g.longPress).toBeNull();
    blocked = false;
    tick();
    g.pointerUp(1, 0, 0);
    tick();
    expect(g.longPress).toBeNull();
    expect(g.tap).toBeNull();
  });

  it('a running drag gets one cancel when a block starts', () => {
    let blocked = false;
    const { g, tick } = setup({ blocked: () => blocked });
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 50, 0);
    tick();
    expect(g.drag?.phase).toBe('start');
    blocked = true;
    tick();
    expect(g.drag).toMatchObject({ phase: 'cancel', dx: 0 });
    expect(g.pan?.phase).toBe('cancel');
    tick();
    expect(g.drag).toBeNull();
    blocked = false;
    g.pointerMove(1, 100, 0);
    g.pointerUp(1, 100, 0);
    tick();
    tick();
    expect(g.drag).toBeNull();
  });

  it('pointerCancel and cancelAll drop the press', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 50, 0);
    tick();
    g.pointerCancel(1);
    tick();
    expect(g.drag?.phase).toBe('cancel');
    tick();
    expect(g.drag).toBeNull();

    g.pointerDown(1, 0, 0);
    g.cancelAll();
    g.pointerUp(1, 0, 0);
    tick();
    expect(g.tap).toBeNull();
  });
});

describe('Gestures as action bindings', () => {
  const bindings = {
    select: [{ gesture: 'tap' }],
    info: [{ gesture: 'longPress' }],
    zoom: [{ gesture: 'doubleTap' }],
    grab: [{ gesture: 'drag' }],
    scale: [{ gesture: 'pinch' }],
  } as const;

  function linked(blocked = () => false) {
    let t = 0;
    const g = new Gestures({ now: () => t });
    const input = new Input(bindings, { getGamepads: () => [], gestures: g, blocked });
    return {
      g,
      input,
      tick(ms = 16) {
        t += ms;
        input.update();
      },
    };
  }

  it('tap selects; long-press is info (held until lift) and never selects', () => {
    const { g, input, tick } = linked();
    g.pointerDown(1, 5, 5);
    g.pointerUp(1, 5, 5);
    tick();
    expect(input.pressed('select')).toBe(true);
    expect(input.pressed('info')).toBe(false);
    tick();
    expect(input.released('select')).toBe(true);

    g.pointerDown(1, 5, 5);
    tick(500);
    expect(input.pressed('info')).toBe(true);
    tick();
    expect(input.held('info')).toBe(true);
    expect(input.pressed('info')).toBe(false);
    g.pointerUp(1, 5, 5);
    tick();
    expect(input.released('info')).toBe(true);
    expect(input.pressed('select')).toBe(false);
  });

  it('taps on consecutive ticks press each time; a double tap presses zoom', () => {
    const { g, input, tick } = linked();
    g.pointerDown(1, 5, 5);
    g.pointerUp(1, 5, 5);
    g.pointerDown(1, 5, 5);
    g.pointerUp(1, 5, 5);
    tick();
    expect(input.pressed('select')).toBe(true);
    expect(input.pressed('zoom')).toBe(false);
    tick();
    expect(input.pressed('select')).toBe(true);
    expect(input.pressed('zoom')).toBe(true);
  });

  it('drag and pinch hold from start to end', () => {
    const { g, input, tick } = linked();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 40, 0);
    tick();
    expect(input.pressed('grab')).toBe(true);
    tick();
    expect(input.held('grab')).toBe(true);
    expect(input.pressed('grab')).toBe(false);
    g.pointerDown(2, 100, 0);
    tick();
    expect(input.released('grab')).toBe(true);
    expect(input.pressed('scale')).toBe(true);
    g.pointerUp(2);
    tick();
    expect(input.released('scale')).toBe(true);
  });

  it('shares blocked() and the pointer transform with the input', () => {
    let blocked = false;
    const { g, input, tick } = linked(() => blocked);
    input.setPointerTransform((x, y) => ({ x: x / 2, y: y / 2 }));
    blocked = true;
    g.pointerDown(1, 10, 10);
    g.pointerUp(1, 10, 10);
    tick();
    expect(g.tap).toBeNull();
    expect(input.held('select')).toBe(false);
    blocked = false;
    // Reassigning input.blocked later is seen too.
    input.blocked = () => true;
    g.pointerDown(1, 10, 10);
    g.pointerUp(1, 10, 10);
    tick();
    expect(g.tap).toBeNull();
    input.blocked = () => false;
    g.pointerDown(1, 10, 10);
    g.pointerUp(1, 10, 10);
    tick();
    expect(g.tap).toMatchObject({ x: 5, y: 5 });
    expect(input.pressed('select')).toBe(true);
  });

  it('without linked gestures a gesture binding reads inactive', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.update();
    expect(input.held('select')).toBe(false);
    const g = new Gestures();
    input.setGestures(g);
    expect(input.gestures).toBe(g);
    input.setGestures(null);
    expect(input.gestures).toBeNull();
  });
});

describe("Gestures: pan: 'prefer' and the pan candidate (ws/input-3)", () => {
  it('3 px, a 500 ms frame gap, then 12 px is a pan, never a long-press', () => {
    const { g, tick } = setup({ pan: 'prefer' });
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 3, 0);
    tick();
    expect(g.longPress).toBeNull();
    // A stalled frame: the next tick lands past longPressMs with the pointer still down.
    tick(500);
    expect(g.longPress).toBeNull();
    g.pointerMove(1, 12, 0);
    tick();
    expect(g.pan).toMatchObject({ phase: 'start', dx: 12 });
    expect(g.longPress).toBeNull();
  });

  it('the same sequence without prefer long-presses (the default is unchanged)', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 3, 0);
    tick();
    tick(500);
    expect(g.longPress).not.toBeNull();
    g.pointerMove(1, 12, 0);
    tick();
    expect(g.pan).toBeNull();
  });

  it('a candidate that lifts under the threshold is a tap in time, nothing when late', () => {
    const { g, tick, advance } = setup({ pan: 'prefer' });
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 4, 0);
    g.pointerUp(1, 4, 0);
    tick();
    expect(g.tap).not.toBeNull();
    g.pointerDown(2, 0, 0);
    g.pointerMove(2, 4, 0);
    advance(600);
    g.pointerUp(2, 4, 0);
    tick();
    expect(g.tap).toBeNull();
    expect(g.longPress).toBeNull();
  });

  it('onPanCandidate is called once per press when travel passes a quarter of the threshold', () => {
    const calls: [number, number][] = [];
    const { g, tick } = setup({ onPanCandidate: (p, travel) => calls.push([p, travel]) });
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 2, 0);
    expect(calls).toEqual([]);
    g.pointerMove(1, 3, 0);
    g.pointerMove(1, 20, 0);
    tick();
    expect(calls).toEqual([[1, 3]]);
    // Without prefer the candidate still long-presses if it stays put.
    g.pointerUp(1);
    tick();
    g.pointerDown(2, 0, 0);
    g.pointerMove(2, 4, 0);
    tick(500);
    expect(calls).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(g.longPress).not.toBeNull();
  });

  it('a claimed pointer is not a gesture at all', () => {
    const { g, tick } = setup();
    g.claim = (id, device) => device === 'mouse' && id === 9;
    g.pointerDown(9, 0, 0, 'mouse');
    g.pointerMove(9, 40, 0);
    g.pointerDown(1, 0, 0);
    g.pointerMove(1, 40, 0);
    tick();
    expect(g.pan).toMatchObject({ pointers: 1, dx: 40 });
    g.pointerUp(9);
    g.pointerUp(1);
    tick();
    expect(g.pan?.phase).toBe('end');
  });
});
