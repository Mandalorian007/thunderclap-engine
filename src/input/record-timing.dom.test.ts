// @vitest-environment happy-dom
/**
 * Recorded pointer timing (ws/input-7): a version 3 recording stamps every `ptr` entry with its
 * time, so a replayed tap, long-press, double-tap and drag classify as they did live, whatever
 * the replay's tick spacing. Version 2 recordings fall back to the replay's tick spacing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gestures } from './gestures';
import { Input } from './input';
import {
  createInputPlayback,
  createInputRecorder,
  type InputPointerEntry,
  type InputRecording,
  parseRecording,
} from './record';

/**
 * 20 ms ticks put the 450 ms long-press between ticks 22 (440 ms) and 23 (460 ms), so a live
 * event's real age (a few ms under load) cannot move it to another tick.
 */
const TICK_MS = 20;

function ptr(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    bubbles: true,
  });
}

type Step = (el: HTMLElement) => void;
const idle: Step = () => {};
const idles = (n: number): Step[] => Array.from({ length: n }, () => idle);
const down =
  (x = 100, y = 100): Step =>
  (el) =>
    el.dispatchEvent(ptr('pointerdown', x, y));
const move =
  (x: number, y = 100): Step =>
  (el) =>
    el.dispatchEvent(ptr('pointermove', x, y));
const up =
  (x = 100, y = 100): Step =>
  (el) =>
    el.dispatchEvent(ptr('pointerup', x, y));

const SCENARIOS: Record<string, { steps: Step[]; kinds: string[] }> = {
  tap: { steps: [down(), ...idles(2), up(), ...idles(2)], kinds: ['tap'] },
  longPress: { steps: [down(), ...idles(29), up(), idle], kinds: ['longPress'] },
  doubleTap: {
    steps: [down(), idle, up(), ...idles(3), down(102), idle, up(102), idle],
    kinds: ['tap', 'tap', 'doubleTap'],
  },
  drag: {
    steps: [down(), ...[106, 112, 120, 130, 145, 160].map((x) => move(x)), up(160), idle],
    kinds: Array.from({ length: 6 }, () => ['pan', 'drag']).flat(),
  },
};

describe('recorded pointer timing (ws/input-7)', () => {
  let el: HTMLElement;
  let t = 0;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
    t = 1000;
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  /** An input with linked gestures on the clock `t`; `ticks[i]` is what tick `i` recognised. */
  function rig() {
    const gestures = new Gestures({ now: () => t });
    const input = new Input({}, { getGamepads: () => [], gestures });
    input.attach({ pointerTarget: el });
    const ticks: string[][] = [];
    let cur: string[] = [];
    gestures.onGesture((kind, phase, g) => cur.push(`${kind}:${phase}@${g.x},${g.y}`));
    const update = () => {
      input.update();
      ticks.push(cur);
      cur = [];
    };
    return { input, ticks, update };
  }

  function recordLive(steps: Step[]): { recording: InputRecording; ticks: string[][] } {
    const live = rig();
    const rec = createInputRecorder(live.input);
    for (const step of steps) {
      t += TICK_MS;
      step(el);
      live.update();
    }
    const recording = rec.stop();
    live.input.detach();
    return { recording, ticks: live.ticks };
  }

  /** Replay into a fresh input, the clock moving `tickMs` per tick (0: frozen). */
  function replay(recording: InputRecording, tickMs: number): string[][] {
    t = 50_000;
    const again = rig();
    const play = createInputPlayback(again.input, parseRecording(JSON.stringify(recording)));
    for (;;) {
      t += tickMs;
      if (!play.step()) break;
      again.update();
    }
    again.input.detach();
    return again.ticks;
  }

  for (const [name, { steps, kinds }] of Object.entries(SCENARIOS)) {
    it(`a recorded ${name} replays to identical gesture events`, () => {
      const { recording, ticks } = recordLive(steps);
      expect(recording.version).toBe(3);
      const flat = ticks.flat();
      expect(flat.map((g) => g.split(':')[0])).toEqual(kinds);
      // Same tick spacing: the same gestures on the same ticks.
      expect(replay(recording, TICK_MS)).toEqual(ticks);
      // A frozen replay clock: the recorded times still classify every gesture as live.
      expect(replay(recording, 0).flat()).toEqual(flat);
      // Double the spacing: still the same classification.
      expect(replay(recording, TICK_MS * 2).flat()).toEqual(flat);
    });
  }

  it('ptr entries carry their time since the recorder started', () => {
    const { recording } = recordLive(SCENARIOS.tap!.steps);
    const lane = recording.ticks.flatMap((e) => ('ptr' in e && e.ptr ? e.ptr : []));
    expect(lane.map((e) => e[0])).toEqual([0, 2]);
    // Down on tick 0 (20 ms in), up on tick 3 (80 ms in), less the events' real age.
    for (const [e, at] of [
      [lane[0]!, 20],
      [lane[1]!, 80],
    ] as const) {
      expect(e[7]).toBeLessThanOrEqual(at);
      expect(e[7]).toBeGreaterThan(at - 10);
    }
  });

  it('a version 2 recording without times replays on the tick spacing', () => {
    const { recording } = recordLive(SCENARIOS.longPress!.steps);
    const v2: InputRecording = {
      version: 2,
      ticks: recording.ticks.map((e) =>
        'ptr' in e && e.ptr
          ? { ...e, ptr: e.ptr.map((p) => p.slice(0, 7) as InputPointerEntry) }
          : e,
      ),
    };
    expect(() => parseRecording(JSON.stringify(v2))).not.toThrow();
    // 30 ticks held: a long-press at 20 ms a tick (600 ms), a tap at 8 (240 ms).
    expect(
      replay(v2, TICK_MS)
        .flat()
        .map((g) => g.split(':')[0]),
    ).toEqual(['longPress']);
    expect(
      replay(v2, 8)
        .flat()
        .map((g) => g.split(':')[0]),
    ).toEqual(['tap']);
    // The timed recording does not care.
    expect(
      replay(recording, 8)
        .flat()
        .map((g) => g.split(':')[0]),
    ).toEqual(['longPress']);
  });

  it('parseRecording wants a finite time on every version 3 entry and none in version 2', () => {
    const e7 = [0, 1, 'touch', 1, 2, 0, 1];
    expect(() => parseRecording({ version: 3, ticks: [{ t: 0, ptr: [e7] }] })).toThrow(/ptr/);
    expect(() => parseRecording({ version: 3, ticks: [{ t: 0, ptr: [[...e7, 'x']] }] })).toThrow(
      /ptr/,
    );
    expect(() => parseRecording({ version: 2, ticks: [{ t: 0, ptr: [[...e7, 5]] }] })).toThrow(
      /ptr/,
    );
    expect(parseRecording({ version: 3, ticks: [{ t: 0, ptr: [[...e7, 5]] }] }).version).toBe(3);
  });

  it('after a seek, timed entries replay relative to the first one fed', () => {
    const { recording, ticks } = recordLive([...idles(3), ...SCENARIOS.longPress!.steps]);
    t = 50_000;
    const again = rig();
    const play = createInputPlayback(again.input, recording);
    play.seek(2);
    for (;;) {
      if (!play.step()) break;
      again.update();
    }
    again.input.detach();
    expect(again.ticks.flat()).toEqual(ticks.flat());
  });
});
