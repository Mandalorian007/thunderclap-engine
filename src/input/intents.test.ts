import { describe, expect, it } from 'vitest';
import { stickSideHold } from './gestures-hold';
import { createIntents, type IntentAim, type IntentInput } from './intents';
import type { RayCamera } from './rays';
import type { InputDevice, PointerState } from './types';

type A = 'use' | 'act' | 'jump' | 'next' | 'prev' | 's1' | 's2';

/** A fake input: the test sets this tick's edges, held set and pointer. */
function fakeInput() {
  const st = {
    pressed: new Set<A>(),
    held: new Set<A>(),
    released: new Set<A>(),
    lastDevice: 'keyboard' as InputDevice,
    blocked: false,
    pointer: {
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      inside: true,
      down: false,
      wheelX: 0,
      wheelY: 0,
      type: 'mouse',
    } as PointerState,
  };
  const input = {
    pressed: (a: A) => st.pressed.has(a),
    held: (a: A) => st.held.has(a),
    released: (a: A) => st.released.has(a),
    get pointer() {
      return st.pointer;
    },
    get lastDevice() {
      return st.lastDevice;
    },
    blocked: () => st.blocked,
    dispatcher: null,
    on: () => () => {},
  } as unknown as IntentInput<A>;
  /** One tick: press, hold, release. */
  const press = (a: A) => {
    st.pressed.add(a);
    st.held.add(a);
  };
  const release = (a: A) => {
    st.held.delete(a);
    st.released.add(a);
  };
  const clear = () => {
    st.pressed.clear();
    st.released.clear();
    st.pointer.wheelY = 0;
  };
  return { st, input, press, release, clear };
}

/** A camera whose ray through (sx, sy) starts at (sx + yaw, sy, 0) and points +z. */
function fakeCamera() {
  const cam = {
    yaw: 0,
    screen: { width: 800, height: 600 },
    screenToWorld(sx: number, sy: number, depth: number, out: { x: number; y: number; z: number }) {
      out.x = sx + cam.yaw;
      out.y = sy;
      out.z = depth;
      return out;
    },
  };
  return cam as typeof cam & RayCamera;
}

const snap = (a: IntentAim) =>
  a === null ? null : { o: [...a.origin], s: a.screen ? [...a.screen] : null };

function setup(centred = false) {
  const f = fakeInput();
  const cam = fakeCamera();
  let t = 0;
  const log: unknown[] = [];
  const intents = createIntents(
    {
      use: { kind: 'tap', actions: ['use'] },
      act: { kind: 'hold', actions: ['act'] },
      jump: { kind: 'press', actions: ['jump'] },
      land: { kind: 'release', actions: ['jump'] },
      slot: { kind: 'select', actions: ['s1', 's2'] },
      cycle: { kind: 'cycle', next: ['next'], prev: ['prev'], wheel: true },
      look: { kind: 'aim' },
    },
    {
      use: (aim) => log.push(['use', snap(aim)]),
      act: {
        start: (aim, at) => log.push(['start', snap(aim), at]),
        aim: (aim) => log.push(['aim', snap(aim)]),
        end: () => log.push(['end']),
      },
      jump: (aim) => log.push(['jump', snap(aim)]),
      land: () => log.push(['land']),
      slot: (n) => log.push(['slot', n]),
      cycle: (d) => log.push(['cycle', d]),
      look: () => {},
    },
    { input: f.input, camera: cam, now: () => t, centred: () => centred },
  );
  const tick = (ms = 16) => {
    t += ms;
    intents.update();
    f.clear();
  };
  return {
    ...f,
    cam,
    intents,
    log,
    tick,
    at: () => t,
    setT: (v: number) => {
      t = v;
    },
  };
}

describe('createIntents: actions', () => {
  it('press, release, tap, select and cycle fire on their edges, aimed at the free mouse', () => {
    const s = setup();
    s.st.pointer.x = 10;
    s.st.pointer.y = 20;
    s.press('jump');
    s.press('use');
    s.press('s2');
    s.press('next');
    s.tick();
    // In the order the intents are declared.
    expect(s.log).toEqual([
      ['use', { o: [10, 20, 0], s: [10, 20] }],
      ['jump', { o: [10, 20, 0], s: [10, 20] }],
      ['slot', 1],
      ['cycle', 1],
    ]);
    s.log.length = 0;
    s.release('jump');
    s.press('prev');
    s.tick();
    expect(s.log).toEqual([['land'], ['cycle', -1]]);
  });

  it('the wheel steps a cycle, one step per notch', () => {
    const s = setup();
    s.st.pointer.wheelY = 100;
    s.tick();
    s.tick(300);
    s.st.pointer.wheelY = -100;
    s.tick(300);
    expect(s.log).toEqual([
      ['cycle', 1],
      ['cycle', -1],
    ]);
  });

  it('a held action starts, re-aims as the view turns, and ends on release', () => {
    const s = setup();
    s.st.pointer.x = 5;
    s.press('act');
    s.tick();
    s.tick(); // no change: no aim call
    s.cam.yaw = 3; // the view turns: the ray is made again
    s.tick();
    s.release('act');
    s.tick();
    expect(s.log).toEqual([
      ['start', { o: [5, 0, 0], s: [5, 0] }, 16],
      ['aim', { o: [8, 0, 0], s: [5, 0] }],
      ['end'],
    ]);
    expect(s.intents.holding).toBe(null);
  });

  it('the locked mouse (centred) aims at null; a pad aims at null', () => {
    const s = setup(true);
    s.press('use');
    s.tick();
    expect(s.log).toEqual([['use', null]]);
    const p = setup();
    p.st.lastDevice = 'gamepad';
    p.press('use');
    p.tick();
    expect(p.log).toEqual([['use', null]]);
  });

  it('nothing fires while blocked... except the edges the input still reports', () => {
    const s = setup();
    s.st.blocked = true;
    s.intents.touchDown(1, 100, 100, s.at());
    s.tick(400);
    expect(s.log).toEqual([]);
  });
});

describe('createIntents: touches', () => {
  it('a still finger lifted soon taps where it was, once (the touch-made action press is ignored)', () => {
    const s = setup();
    s.st.lastDevice = 'touch';
    s.intents.touchDown(1, 40, 50, s.at());
    s.tick();
    s.intents.touchUp(1, 41, 50, s.at() + 100);
    s.press('use'); // a binding the touch also drives
    s.tick(100);
    expect(s.log).toEqual([['use', { o: [41, 50, 0], s: [41, 50] }]]);
  });

  it('a still finger held holds from its press time, follows the finger and the view, and ends on lift', () => {
    const s = setup();
    s.st.lastDevice = 'touch';
    s.setT(1000);
    s.intents.touchDown(1, 40, 50, 1000);
    s.tick(100);
    expect(s.log).toEqual([]);
    s.tick(250); // 350 ms still
    expect(s.log).toEqual([['start', { o: [40, 50, 0], s: [40, 50] }, 1000]]);
    expect(s.intents.holding).toBe('act');
    s.intents.touchMove(1, 60, 50, s.at());
    s.tick();
    s.cam.yaw = 2;
    s.tick();
    s.intents.touchUp(1, 60, 50, s.at());
    s.tick();
    expect(s.log.slice(1)).toEqual([
      ['aim', { o: [60, 50, 0], s: [60, 50] }],
      ['aim', { o: [62, 50, 0], s: [60, 50] }],
      ['end'],
    ]);
    expect(s.intents.holding).toBe(null);
  });

  it('a moved finger is a drag: no tap, no hold', () => {
    const s = setup();
    s.st.lastDevice = 'touch';
    s.intents.touchDown(1, 40, 50, s.at());
    s.intents.touchMove(1, 80, 50, s.at() + 10);
    s.tick(500);
    s.intents.touchUp(1, 80, 50, s.at());
    s.tick();
    expect(s.log).toEqual([]);
  });

  it('a flick seen only on its lift is a drag, not a tap', () => {
    const s = setup();
    s.st.lastDevice = 'touch';
    s.intents.touchDown(1, 40, 50, s.at());
    s.intents.touchUp(1, 140, 50, s.at() + 40);
    s.tick();
    expect(s.log).toEqual([]);
  });

  it('a cancelled finger neither taps nor finishes a hold silently', () => {
    const s = setup();
    s.st.lastDevice = 'touch';
    s.intents.touchDown(1, 40, 50, s.at());
    s.tick(400);
    s.intents.touchCancel(1);
    s.tick();
    expect(s.log.map((e) => (e as unknown[])[0])).toEqual(['start', 'end']);
  });

  it('a touch scheme with no finger down does not aim', () => {
    const s = setup();
    s.st.lastDevice = 'touch';
    s.tick();
    expect(s.intents.aiming).toBe(false);
    expect(s.intents.aim).toBe(null);
    s.intents.touchDown(1, 10, 10, s.at());
    s.tick();
    expect(s.intents.aiming).toBe(true);
    expect(s.intents.aim?.screen).toEqual([10, 10]);
  });
});

describe('createIntents: the stick side', () => {
  function stickSetup(canHold: boolean) {
    const f = fakeInput();
    f.st.lastDevice = 'touch';
    const cam = fakeCamera();
    let t = 0;
    const log: string[] = [];
    const intents = createIntents(
      {
        use: { kind: 'tap', actions: ['use'] },
        gather: {
          kind: 'hold',
          touch: false,
          stickSide: stickSideHold<IntentAim>({ when: () => canHold }),
        },
      },
      {
        use: () => log.push('use'),
        gather: { start: () => log.push('start'), end: () => log.push('end') },
      },
      { input: f.input, camera: cam, now: () => t },
    );
    const tick = (ms = 16) => {
      t += ms;
      intents.update();
    };
    return { intents, log, tick, at: () => t };
  }

  it('the stick thumb holds still where the game says it may, and never taps', () => {
    const s = stickSetup(true);
    s.intents.touchDown(1, 10, 10, s.at(), true);
    s.tick(400);
    s.intents.touchUp(1, 10, 10, s.at());
    s.tick();
    expect(s.log).toEqual(['start', 'end']);
    s.log.length = 0;
    s.intents.touchDown(2, 10, 10, s.at(), true);
    s.intents.touchUp(2, 10, 10, s.at() + 50);
    s.tick();
    expect(s.log).toEqual([]); // a stick tap is not a tap
  });

  it('where the game says no, the stick thumb only walks', () => {
    const s = stickSetup(false);
    s.intents.touchDown(1, 10, 10, s.at(), true);
    s.tick(400);
    s.intents.touchUp(1, 10, 10, s.at());
    s.tick();
    expect(s.log).toEqual([]);
  });
});
