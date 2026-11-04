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

describe('Gestures: pinch and two-pointer pan', () => {
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

  it('two pointers moving together pan by their centre past the threshold', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 100, 100);
    g.pointerDown(2, 200, 100);
    tick();
    g.pointerMove(1, 105, 100);
    g.pointerMove(2, 205, 100);
    tick();
    expect(g.pan).toBeNull();
    // Each pointer moves on its own event: the centre crosses the threshold after the first.
    g.pointerMove(1, 130, 100);
    g.pointerMove(2, 230, 100);
    tick();
    expect(g.pan).toMatchObject({ phase: 'start', pointers: 2, dx: 17.5, x: 167.5 });
    expect(g.drag).toBeNull();
    tick();
    expect(g.pan).toMatchObject({ phase: 'move', dx: 12.5, x: 180 });
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
    expect(input.getGestures()).toBe(g);
    input.setGestures(null);
    expect(input.getGestures()).toBeNull();
  });
});
