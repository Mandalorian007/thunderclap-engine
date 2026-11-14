// ws/input-fit: the free mouse's still press, hold pointer ids, live timing, the stick zone's
// share and the gated wheel in `createIntents`; `Look`'s move-zone share and sprint rim. Driven
// through the feed methods with a fake input (no DOM); the DOM paths are in input-fit.dom.test.
import { describe, expect, it } from 'vitest';
import { MOUSE_STILL_DEFAULTS, mouseStill } from './gestures-hold';
import { createIntents, type IntentAim, type IntentInput } from './intents';
import { Look } from './look';
import type { RayCamera } from './rays';
import type { InputDevice, PointerState } from './types';

type A = 'use' | 'dig' | 'place';

function fakeInput() {
  const st = {
    pressed: new Set<A>(),
    held: new Set<A>(),
    released: new Set<A>(),
    lastDevice: 'mouse' as InputDevice,
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
  return { st, input };
}

const camera = {
  screen: { width: 800, height: 600 },
  screenToWorld(sx: number, sy: number, depth: number, out: { x: number; y: number; z: number }) {
    out.x = sx;
    out.y = sy;
    out.z = depth;
    return out;
  },
} as unknown as RayCamera;

const at = (a: IntentAim) => (a === null ? null : a.screen ? [...a.screen] : null);

function setup(opts: { centred?: boolean; stickZoneShare?: number } = {}) {
  const f = fakeInput();
  let t = 0;
  let centred = opts.centred ?? false;
  const log: unknown[] = [];
  const intents = createIntents(
    {
      use: { kind: 'tap', actions: ['use'] },
      dig: { kind: 'hold', actions: ['dig'], mouse: mouseStill({ button: 2 }) },
      place: { kind: 'tap', actions: ['place'], mouse: mouseStill({ button: 2 }) },
      speed: { kind: 'wheel', modifiers: { alt: true }, steps: false },
      zoom: { kind: 'wheel', modifiers: { ctrl: true }, whileRay: true },
    },
    {
      use: (a) => log.push(['use', at(a)]),
      dig: {
        start: (a, from, id) => log.push(['start', at(a), from, id]),
        aim: (a, id) => log.push(['aim', at(a), id]),
        end: (id) => log.push(['end', id]),
      },
      place: (a) => log.push(['place', at(a)]),
      speed: (d) => log.push(['speed', d]),
      zoom: (d) => log.push(['zoom', d]),
    },
    {
      input: f.input,
      camera,
      now: () => t,
      centred: () => centred,
      stickZone: 'left',
      stickZoneShare: opts.stickZoneShare,
    },
  );
  const tick = (ms = 16) => {
    t += ms;
    intents.update();
    f.st.pressed.clear();
    f.st.released.clear();
  };
  return {
    ...f,
    intents,
    log,
    tick,
    now: () => t,
    setCentred: (c: boolean) => {
      centred = c;
    },
  };
}

describe('mouseStill', () => {
  it('defaults to the left button, 5 px and 250 ms', () => {
    expect(mouseStill()).toEqual({ type: 'mouse', ...MOUSE_STILL_DEFAULTS });
    expect(mouseStill({ button: 2, ms: 400 })).toEqual({
      type: 'mouse',
      button: 2,
      tolerancePx: 5,
      ms: 400,
    });
  });
});

describe('createIntents: the free mouse (ws/input-fit)', () => {
  it('a quick still click on its button taps its tap intent where it was; the action press is its own', () => {
    const s = setup();
    s.intents.mouseDown(2, 300, 200, s.now(), 1);
    s.st.pressed.add('place'); // the binding the same click drives
    s.tick();
    s.intents.mouseUp(301, 200, s.now() + 50);
    s.tick(50);
    expect(s.log).toEqual([['place', [301, 200]]]);
  });

  it('held still it holds from its press time, with the pointer id, follows the mouse and ends on release', () => {
    const s = setup();
    s.intents.mouseDown(2, 300, 200, 0, 7);
    s.tick(100);
    expect(s.log).toEqual([]);
    s.tick(200); // 300 ms still
    expect(s.log).toEqual([['start', [300, 200], 0, 7]]);
    expect(s.intents.holding).toBe('dig');
    s.intents.mouseMove(340, 200, s.now());
    s.tick();
    s.intents.mouseUp(340, 200, s.now());
    s.tick();
    expect(s.log.slice(1)).toEqual([
      ['aim', [340, 200], 7],
      ['end', 7],
    ]);
    expect(s.intents.holding).toBe(null);
  });

  it('moved past the tolerance first it is a drag: no tap, no hold', () => {
    const s = setup();
    s.intents.mouseDown(2, 300, 200, s.now(), 1);
    s.intents.mouseMove(320, 200, s.now() + 10);
    s.tick(400);
    s.intents.mouseUp(320, 200, s.now());
    s.tick();
    expect(s.log).toEqual([]);
  });

  it('a button no intent names, and a locked (centred) mouse, leave the actions alone', () => {
    const s = setup();
    s.intents.mouseDown(0, 300, 200, s.now(), 1);
    s.st.pressed.add('use');
    s.tick();
    s.intents.mouseUp(300, 200, s.now());
    s.tick();
    expect(s.log.map((e) => (e as unknown[])[0])).toEqual(['use']);

    const c = setup({ centred: true });
    c.intents.mouseDown(2, 300, 200, c.now(), 1);
    c.st.pressed.add('dig');
    c.st.held.add('dig');
    c.tick();
    expect(c.log).toEqual([['start', null, 16, null]]);
    c.st.held.delete('dig');
    c.tick();
    expect(c.log[1]).toEqual(['end', null]);
  });

  it('action holds pass a null pointer; touch holds pass the finger id', () => {
    const s = setup();
    s.st.lastDevice = 'touch';
    s.intents.touchDown(4, 500, 100, 0);
    s.tick(400);
    s.intents.touchUp(4, 500, 100, s.now());
    s.tick();
    expect(s.log).toEqual([
      ['start', [500, 100], 0, 4],
      ['end', 4],
    ]);
  });

  it('setTiming changes the hold time and tolerance from the next press, without a rebuild', () => {
    const s = setup();
    s.intents.setTiming({ mouse: { ms: 600, tolerancePx: 30 } });
    s.intents.mouseDown(2, 300, 200, 0, 1);
    s.intents.mouseMove(320, 200, 10); // inside the new tolerance
    s.tick(400);
    expect(s.log).toEqual([]);
    s.tick(300);
    expect(s.log).toEqual([['start', [320, 200], 0, 1]]);
    s.intents.mouseUp(320, 200, s.now());
    s.tick();

    s.log.length = 0;
    s.st.lastDevice = 'touch';
    s.intents.setTiming({ touch: { ms: 100 } });
    s.intents.touchDown(2, 500, 100, s.now());
    s.tick(150);
    expect(s.log[0]).toEqual(['start', [500, 100], s.now() - 150, 2]);
  });

  it("the stick zone's share is an option and a live setting", () => {
    // Without `inStick` from the caller the zone comes from the dispatcher's bounds.
    const s = setup({ stickZoneShare: 0.4 });
    const bounds = { left: 0, top: 0, width: 1000, height: 500 };
    const fakeDispatcher = {
      bounds: () => bounds,
      add: () => () => {},
      target: { addEventListener() {}, removeEventListener() {} },
    };
    s.intents.attach(fakeDispatcher as never);
    s.st.lastDevice = 'touch';
    s.intents.touchDown(1, 450, 100, s.now()); // past 40%: not the stick, so it may tap
    s.tick();
    s.intents.touchUp(1, 450, 100, s.now());
    s.tick();
    // Both tap intents take touches (`touch` defaults on), `place` included.
    expect(s.log).toEqual([
      ['use', [450, 100]],
      ['place', [450, 100]],
    ]);
    s.intents.setTiming({ stickZoneShare: 0.5 });
    s.intents.touchDown(2, 450, 100, s.now()); // inside the half: the stick's
    s.tick();
    s.intents.touchUp(2, 450, 100, s.now());
    s.tick();
    expect(s.log).toHaveLength(2);
    s.intents.detach();
  });
});

describe('createIntents: the gated wheel (ws/input-fit)', () => {
  it('a wheel intent takes only the wheel its modifiers name, in pixels when steps is false', () => {
    const s = setup();
    s.intents.wheel(30, 0, {});
    s.intents.wheel(30, 0, { alt: true });
    s.intents.wheel(2, 1, { alt: true }); // lines: 16 px each
    s.tick();
    s.tick();
    expect(s.log).toEqual([['speed', 62]]);
  });

  it('notches step, one per event however big (a fling never spins round)', () => {
    const s = setup();
    s.intents.wheel(100, 0, { ctrl: true }, 0);
    s.intents.wheel(100, 0, { ctrl: true }, 400);
    s.intents.wheel(-3, 1, { ctrl: true }, 800);
    s.tick();
    expect(s.log).toEqual([['zoom', 1]]);
  });

  it('a laser (an XR ray leading) silences a gate unless whileRay', () => {
    const f = fakeInput();
    const got: string[] = [];
    const intents = createIntents(
      {
        speed: { kind: 'wheel', steps: false },
        zoom: { kind: 'wheel', steps: false, whileRay: true },
      },
      { speed: () => got.push('speed'), zoom: () => got.push('zoom') },
      {
        input: f.input,
        camera,
        now: () => 0,
        pointers: {
          primary: { device: 'xr', ray: { origin: [0, 0, 0], dir: [0, 0, -1] } },
        } as never,
      },
    );
    intents.wheel(10);
    intents.update();
    expect(got).toEqual(['zoom']);
  });

  it('`when` gates too', () => {
    const f = fakeInput();
    let open = false;
    const got: number[] = [];
    const intents = createIntents(
      { speed: { kind: 'wheel', steps: false, when: () => open } },
      { speed: (d) => got.push(d) },
      { input: f.input, camera, now: () => 0 },
    );
    intents.wheel(10);
    open = true;
    intents.wheel(5);
    intents.update();
    expect(got).toEqual([5]);
  });

  it('nothing while blocked', () => {
    const s = setup();
    s.st.blocked = true;
    s.intents.wheel(30, 0, { alt: true });
    s.st.blocked = false;
    s.tick();
    expect(s.log).toEqual([]);
  });

  it('a cycle may take a gated wheel too, and a bad mouse button throws', () => {
    const f = fakeInput();
    const got: number[] = [];
    const intents = createIntents(
      { slot: { kind: 'cycle', wheel: { modifiers: { shift: true } } } },
      { slot: (d) => got.push(d) },
      { input: f.input, camera, now: () => 0 },
    );
    intents.wheel(120, 0, { shift: true });
    intents.wheel(120, 0, {});
    intents.update();
    expect(got).toEqual([1]);
    expect(() =>
      createIntents(
        { x: { kind: 'tap', mouse: mouseStill({ button: 9 }) } },
        { x: () => {} },
        { input: f.input, camera },
      ),
    ).toThrow();
  });
});

describe('Look (ws/input-fit)', () => {
  const look = (opts: ConstructorParameters<typeof Look>[0] = {}) =>
    new Look({ getGamepads: () => [], ...opts });

  it('moveZoneShare defaults to the half and may change', () => {
    expect(look().moveZoneShare).toBe(0.5);
    expect(look({ touch: { moveZoneShare: 0.4 } }).moveZoneShare).toBe(0.4);
  });

  it('no rim: the stick never sprints', () => {
    const l = look();
    l.touchDown(1, 100, 300, true);
    l.touchMove(1, 100, 100);
    expect(l.sprint).toBe(false);
    expect(l.stick.sprint).toBe(false);
  });

  it('pushed forward past the rim it sprints, keeps on above `keep`, and stops out of the cone or on lift', () => {
    const l = look({ touch: { radius: 50, deadzone: 0.2, sprintRim: true } });
    l.touchDown(1, 100, 300, true);
    l.touchMove(1, 100, 250); // at the radius: not yet
    expect(l.sprint).toBe(false);
    l.touchMove(1, 100, 230); // 70 px: 1.4 radii, straight up
    expect(l.sprint).toBe(true);
    l.touchMove(1, 100, 260); // 40 px: deflection (0.8 - 0.2) / 0.8 = 0.75 ≥ 0.7, keeps on
    expect(l.sprint).toBe(true);
    l.touchMove(1, 100, 265); // 35 px: 0.625 < 0.7, off
    expect(l.sprint).toBe(false);
    l.touchMove(1, 170, 230); // far, but 45° off forward
    expect(l.sprint).toBe(false);
    l.touchMove(1, 100, 220);
    expect(l.sprint).toBe(true);
    l.touchUp(1);
    expect(l.sprint).toBe(false);
  });

  it('a rim of its own: `at`, `coneDeg`, `keep`', () => {
    const l = look({ touch: { radius: 50, sprintRim: { at: 1, coneDeg: 60, keep: 0.9 } } });
    expect(l.sprintRim).toEqual({ at: 1, coneDeg: 60, keep: 0.9 });
    l.touchDown(1, 100, 300, true);
    l.touchMove(1, 140, 260); // 56.6 px, 45° off: inside the 60° cone
    expect(l.sprint).toBe(true);
    l.cancelAll();
    expect(l.sprint).toBe(false);
  });
});
