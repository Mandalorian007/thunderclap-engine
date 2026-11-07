// @vitest-environment happy-dom
/**
 * Replay at any tick spacing (ws/input-8). On a shared `createTickClock()` the game advances by
 * its fixed step, a recording replays the same gestures and the same look output on the same
 * tick indices whether the replay's ticks are half, as far, or twice as far apart in wall time
 * as the live ones, including a long-press fired by `update()` while the pointer is held. On the
 * default wall clock the held long-press moves to another tick (the input-7 limit this closes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTickClock, type InputClock } from './clock';
import { createGestures } from './gestures';
import { Input } from './input';
import { createLook } from './look';
import { createInputPlayback, createInputRecorder, type InputRecording } from './record';
import type { GamepadLike } from './types';

/** The game's fixed step, ms, and the live wall-time spacing between ticks. */
const STEP_MS = 20;
/** Replay spacings, wall ms between ticks: half, the same, double. */
const SPACINGS = [STEP_MS / 2, STEP_MS, STEP_MS * 2];
/** Every live event is handled this many wall ms after it happened. */
const LAG_MS = 3;

let wall = 0;

function ptr(type: string, x: number, y: number, device = 'touch'): PointerEvent {
  const e = new PointerEvent(type, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    pointerType: device,
    isPrimary: true,
    button: 0,
    bubbles: true,
  });
  Object.defineProperty(e, 'timeStamp', { value: wall - LAG_MS });
  return e;
}

type Step = (el: HTMLElement) => void;
const idle: Step = () => {};
const idles = (n: number): Step[] => Array.from({ length: n }, () => idle);
const down =
  (x = 100, y = 100, device?: string): Step =>
  (el) =>
    el.dispatchEvent(ptr('pointerdown', x, y, device));
const move =
  (x: number, y = 100, device?: string): Step =>
  (el) =>
    el.dispatchEvent(ptr('pointermove', x, y, device));
const up =
  (x = 100, y = 100, device?: string): Step =>
  (el) =>
    el.dispatchEvent(ptr('pointerup', x, y, device));

/** All four gestures. The long-press is still held for 10 ticks after it fires. */
const GESTURES: Record<string, { steps: Step[]; kinds: string[] }> = {
  tap: { steps: [down(), ...idles(2), up(), ...idles(2)], kinds: ['tap'] },
  longPress: { steps: [down(), ...idles(32), up(), idle], kinds: ['longPress'] },
  doubleTap: {
    steps: [down(), idle, up(), ...idles(3), down(102), idle, up(102), idle],
    kinds: ['tap', 'tap', 'doubleTap'],
  },
  drag: {
    steps: [down(), ...[106, 112, 120, 130, 145, 160].map((x) => move(x)), up(160), idle],
    kinds: Array.from({ length: 6 }, () => ['pan', 'drag']).flat(),
  },
};

describe('gestures and look replay identically at any tick spacing (ws/input-8)', () => {
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
    wall = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  /** A tick: wall time moves `spacing`, a tick clock (when there is one) the fixed step. */
  type Rig = { input: Input<string>; ticks: string[][]; update: () => void; clock: InputClock };

  function gestureRig(tick: boolean): Rig & { advance: (spacing: number) => void } {
    const clock = tick ? createTickClock(5000) : undefined;
    const gestures = createGestures(clock ? { clock } : {});
    const input = new Input({}, { getGamepads: () => [], gestures });
    input.attach({ pointerTarget: el });
    const ticks: string[][] = [];
    let cur: string[] = [];
    gestures.onGesture((kind, phase, g) => cur.push(`${kind}:${phase}@${g.x},${g.y}`));
    return {
      input,
      ticks,
      clock: gestures.clock,
      advance: (spacing) => {
        wall += spacing;
        clock?.advance(STEP_MS);
      },
      update: () => {
        input.update();
        ticks.push(cur);
        cur = [];
      },
    };
  }

  function run(
    make: () => Rig & { advance: (spacing: number) => void },
    steps: Step[],
  ): { recording: InputRecording; ticks: string[][] } {
    const live = make();
    const rec = createInputRecorder(live.input);
    for (const step of steps) {
      live.advance(STEP_MS);
      step(el);
      live.update();
    }
    const recording = rec.stop();
    live.input.detach();
    return { recording, ticks: live.ticks };
  }

  function replay(
    make: () => Rig & { advance: (spacing: number) => void },
    recording: InputRecording,
    spacing: number,
  ): string[][] {
    wall = 90_000;
    const again = make();
    const play = createInputPlayback(again.input, structuredClone(recording));
    for (;;) {
      again.advance(spacing);
      if (!play.step()) break;
      again.update();
    }
    again.input.detach();
    return again.ticks;
  }

  for (const [name, { steps, kinds }] of Object.entries(GESTURES)) {
    it(`${name}: the same gestures on the same ticks at half, the same and double spacing`, () => {
      const make = () => gestureRig(true);
      const { recording, ticks } = run(make, steps);
      expect(ticks.flat().map((g) => g.split(':')[0])).toEqual(kinds);
      for (const spacing of SPACINGS) expect(replay(make, recording, spacing)).toEqual(ticks);
    });
  }

  it('the held long-press lands on the tick the step passes longPressMs', () => {
    const { ticks } = run(() => gestureRig(true), GESTURES.longPress!.steps);
    // Down on tick 0, stamped LAG_MS early: 450 ms later is tick 23 (460 ms of steps).
    expect(ticks.findIndex((t) => t.length > 0)).toBe(Math.ceil((450 - LAG_MS) / STEP_MS));
  });

  it('on the wall clock the held long-press moves with the replay spacing', () => {
    const make = () => gestureRig(false);
    const { recording, ticks } = run(make, GESTURES.longPress!.steps);
    const firedAt = (t: string[][]) => t.findIndex((g) => g.length > 0);
    const at = firedAt(ticks);
    expect(firedAt(replay(make, recording, STEP_MS))).toBe(at);
    expect(firedAt(replay(make, recording, STEP_MS / 2))).toBeGreaterThan(at);
    expect(firedAt(replay(make, recording, STEP_MS * 2))).toBeLessThan(at);
  });

  /**
   * A linked look in orbit mode on the tick clock, no gestures (so the recorder and playback
   * take the look's clock). The pad's right stick is pushed on ticks 4 to 11 (by tick index,
   * the same live and replayed); a mouse press of 10 ticks taps, one of 30 does not.
   */
  function lookRig(tick: boolean): Rig & { advance: (spacing: number) => void } {
    const clock = tick ? createTickClock() : undefined;
    let k = 0;
    const pushed: GamepadLike = { connected: true, buttons: [], axes: [0, 0, 0.6, -0.4] };
    const look = createLook({
      ...(clock ? { clock } : {}),
      mode: 'orbit',
      sensitivity: 0.01,
      padDeadzone: 0,
      getGamepads: () => (k >= 4 && k < 12 ? [pushed] : []),
    });
    const input = new Input({}, { look, getGamepads: () => [] });
    input.attach({ pointerTarget: el });
    const ticks: string[][] = [];
    let cur: string[] = [];
    look.onTap((x, y) => cur.push(`tap@${x},${y}`));
    return {
      input,
      ticks,
      clock: look.clock,
      advance: (spacing) => {
        wall += spacing;
        clock?.advance(STEP_MS);
      },
      update: () => {
        input.update();
        k++;
        cur.push(`look ${look.look.dx.toFixed(6)},${look.look.dy.toFixed(6)}`);
        ticks.push(cur);
        cur = [];
      },
    };
  }

  const LOOK_STEPS: Step[] = [
    down(300, 100, 'mouse'),
    move(306, 102, 'mouse'),
    ...idles(8),
    up(306, 102, 'mouse'),
    ...idles(3),
    down(400, 200, 'mouse'),
    move(420, 210, 'mouse'),
    ...idles(28),
    up(420, 210, 'mouse'),
    idle,
  ];

  it('look: identical output on every tick at half, the same and double spacing', () => {
    const make = () => lookRig(true);
    const { recording, ticks } = run(make, LOOK_STEPS);
    const flat = ticks.flat();
    expect(flat.filter((s) => s.startsWith('tap'))).toEqual(['tap@306,102']);
    // The pad turns the view by padSensitivity * step on its ticks.
    expect(ticks[5]!.at(-1)).toBe(
      `look ${(3 * 0.6 * 0.02).toFixed(6)},${(3 * 0.4 * 0.02).toFixed(6)}`,
    );
    for (const spacing of SPACINGS) expect(replay(make, recording, spacing)).toEqual(ticks);
  });

  it('look on the wall clock: the pad turn follows the replay spacing', () => {
    const make = () => lookRig(false);
    const { recording, ticks } = run(make, LOOK_STEPS);
    expect(replay(make, recording, STEP_MS)).toEqual(ticks);
    expect(replay(make, recording, STEP_MS * 2)).not.toEqual(ticks);
  });
});
