// @vitest-environment happy-dom
/**
 * A recording replays exactly at any speed, gamepad look included (ws/input-9). A linked look's
 * stick reads the input's pads, so a playback's recorded pads turn it while the live pad is
 * centred; and a playback given the tick clock advances it by the recorded spacing per fed tick,
 * so a held long-press fires on the same recorded tick at speed 1, 2 and 4.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTickClock } from './clock';
import { createGestures } from './gestures';
import { Input } from './input';
import { createLook } from './look';
import {
  createInputPlayback,
  createInputRecorder,
  type InputRecording,
  parseRecording,
  serializeRecording,
} from './record';
import type { GamepadLike } from './types';

const STEP_MS = 20;

const pad = (rx: number, ry: number): GamepadLike => ({
  connected: true,
  buttons: [],
  axes: [0, 0, rx, ry],
});

describe('Look reads recorded pads (ws/input-9)', () => {
  /** A stick sweep: the right stick turns through a circle and back to centre. */
  const sweep = (k: number): GamepadLike =>
    k < 3 || k >= 23
      ? pad(0, 0)
      : pad(0.8 * Math.cos((k - 3) * 0.3), 0.8 * Math.sin((k - 3) * 0.3));

  function rig(pads: (k: number) => GamepadLike) {
    const clock = createTickClock();
    const look = createLook({ clock, padDeadzone: 0, padSensitivity: 2 });
    let k = 0;
    const input = new Input({}, { look, getGamepads: () => [pads(k)] });
    const out: string[] = [];
    return {
      input,
      clock,
      look,
      update() {
        input.update();
        k++;
        out.push(`${look.look.dx.toFixed(9)},${look.look.dy.toFixed(9)}`);
      },
      out,
    };
  }

  it('a stick sweep replays the same yaw and pitch per tick while the live pad is centred', () => {
    const live = rig(sweep);
    const rec = createInputRecorder(live.input);
    for (let i = 0; i < 30; i++) {
      live.clock.advance(STEP_MS);
      live.update();
    }
    const recording = parseRecording(serializeRecording(rec.stop()));
    expect(live.out.some((s) => s !== live.out[0])).toBe(true);
    expect(recording.tickMs).toBe(STEP_MS);

    const again = rig(() => pad(0, 0));
    const play = createInputPlayback(again.input, recording);
    while (!play.done) {
      again.clock.advance(STEP_MS);
      play.step();
      again.update();
    }
    expect(again.out).toEqual(live.out);
  });

  it('without a playback the linked look reads the live pads, as before', () => {
    const live = rig(() => pad(0.5, 0));
    live.clock.advance(STEP_MS);
    live.update();
    live.clock.advance(STEP_MS);
    live.update();
    expect(live.look.look.dx).toBeCloseTo(0.5 * 2 * (STEP_MS / 1000), 9);
  });

  it('a look source given in its options is read as is, not replaced', () => {
    const look = createLook({ padDeadzone: 0, getGamepads: () => [pad(0, 0)] });
    const input = new Input({}, { look, getGamepads: () => [pad(1, 0)] });
    input.update();
    input.update();
    expect(look.look.dx).toBe(0);
  });
});

describe('playback speed advances a tick clock (ws/input-9)', () => {
  let el: HTMLElement;
  let wall = 0;

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

  const ptr = (type: string): PointerEvent => {
    const e = new PointerEvent(type, {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      bubbles: true,
    });
    Object.defineProperty(e, 'timeStamp', { value: wall - 3 });
    return e;
  };

  function rig() {
    const clock = createTickClock(5000);
    const gestures = createGestures({ clock });
    const input = new Input({}, { getGamepads: () => [], gestures });
    input.attach({ pointerTarget: el });
    return { clock, gestures, input };
  }

  /** Live: down on tick 2, held 40 ticks, up. Returns the recording and the long-press tick. */
  function record(): { recording: InputRecording; at: number } {
    const { clock, gestures, input } = rig();
    let k = 0;
    let at = -1;
    gestures.onGesture((kind) => {
      if (kind === 'longPress' && at < 0) at = k;
    });
    const rec = createInputRecorder(input);
    // As in a browser: events arrive between frames, then the frame's fixed step advances the
    // clock and updates the input.
    for (; k < 46; k++) {
      wall += STEP_MS;
      if (k === 2) el.dispatchEvent(ptr('pointerdown'));
      if (k === 42) el.dispatchEvent(ptr('pointerup'));
      clock.advance(STEP_MS);
      input.update();
    }
    const recording = rec.stop();
    input.detach();
    return { recording, at };
  }

  function replayAt(recording: InputRecording, speed: number): number {
    wall = 90_000;
    const { clock, gestures, input } = rig();
    const play = createInputPlayback(input, structuredClone(recording), { speed, clock });
    expect(play.clock).toBe(clock);
    expect(play.tickMs).toBe(STEP_MS);
    let at = -1;
    // The tick being updated is the last one fed.
    gestures.onGesture((kind) => {
      if (kind === 'longPress' && at < 0) at = play.tick - 1;
    });
    const start = clock.now();
    let steps = 0;
    while (play.step()) {
      steps++;
      // Wall time between steps is whatever the replay runs at; the clock is the playback's.
      wall += 7;
      input.update();
    }
    // Every fed tick moved the clock one recorded spacing.
    expect(clock.now() - start).toBe(play.length * STEP_MS);
    expect(steps).toBe(Math.ceil(play.length / speed));
    input.detach();
    return at;
  }

  it('a long-press replayed at speed 1, 2 and 4 fires on the same recorded tick', () => {
    const { recording, at } = record();
    expect(at).toBeGreaterThan(2);
    expect(recording.tickMs).toBe(STEP_MS);
    for (const speed of [1, 2, 4]) expect(replayAt(recording, speed)).toBe(at);
  });

  it('speed 4 advances the clock 4 spacings per step', () => {
    const clock = createTickClock();
    const input = new Input({}, { getGamepads: () => [] });
    const play = createInputPlayback(
      input,
      { version: 3, ticks: [{ t: 0, n: 10 }], tickMs: 25 },
      { speed: 4, clock },
    );
    play.step();
    expect(clock.now()).toBe(100);
    play.step();
    play.step();
    expect(clock.now()).toBe(250);
    expect(play.step()).toBe(false);
    expect(clock.now()).toBe(250);
  });

  it('old recordings use the input tickMs, and tickMs can be overridden', () => {
    const clock = createTickClock();
    const v1: InputRecording = { version: 1, ticks: [{ t: 0, n: 3 }] };
    const input = new Input({}, { getGamepads: () => [], tickMs: 10 });
    const play = createInputPlayback(input, parseRecording(v1), { clock });
    while (play.step()) input.update();
    expect(clock.now()).toBe(30);
    play.detach();
    const other = createTickClock();
    const fast = createInputPlayback(input, v1, { clock: other, tickMs: 5 });
    while (fast.step()) input.update();
    expect(other.now()).toBe(15);
  });

  it('without a clock nothing advances; a recorder on the wall clock writes Input.tickMs', () => {
    const input = new Input({}, { getGamepads: () => [], tickMs: 12 });
    const rec = createInputRecorder(input);
    wall += 100;
    input.update();
    expect(rec.stop().tickMs).toBe(12);
    const play = createInputPlayback(input, { version: 3, ticks: [{ t: 0, n: 2 }] });
    expect(play.clock).toBeNull();
    expect(play.tickMs).toBe(12);
  });

  it('parseRecording rejects a bad tickMs', () => {
    expect(() => parseRecording({ version: 3, ticks: [], tickMs: -1 })).toThrow(/tickMs/);
    expect(() => parseRecording({ version: 3, ticks: [], tickMs: '16' })).toThrow(/tickMs/);
  });
});
