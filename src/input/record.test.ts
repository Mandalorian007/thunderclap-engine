/**
 * Input recording and replay: a scripted session recorded on one `Input` and replayed on a
 * second gives the same action states on every tick; the recording is compact JSON that
 * round-trips; `parseRecording` rejects what it cannot replay.
 */
import { describe, expect, it } from 'vitest';
import { Input } from './input';
import {
  createInputPlayback,
  createInputRecorder,
  type InputRecording,
  InputRecordingError,
  parseRecording,
  recordingLength,
  serializeRecording,
} from './record';
import type { GamepadLike } from './types';

type Action = 'left' | 'right' | 'fire' | 'alt' | 'zoom' | 'throttle' | 'jump' | 'jump2';

const BINDINGS = {
  left: [{ key: 'KeyA' }, { padAxis: 0, dir: -1 }],
  right: [{ key: 'KeyD' }, { padAxis: 0, dir: 1 }],
  fire: [{ mouse: 0 }, { padButton: 0 }],
  alt: [{ mouse: 2 }],
  zoom: [{ wheel: -1 }],
  throttle: [{ padAxis: 1, dir: 1, threshold: 0.1 }],
  jump: [{ key: 'Space' }],
  jump2: [{ padButton: 1, pad: 1 }],
} as const;

const ACTIONS = Object.keys(BINDINGS) as Action[];

interface TickState {
  actions: Record<string, { pressed: boolean; held: boolean; released: boolean; value: number }>;
  pointer: { x: number; y: number; dx: number; dy: number; inside: boolean; down: boolean };
  wheel: [number, number];
  lastDevice: string;
}

function snapshot(input: Input<Action>): TickState {
  const actions: TickState['actions'] = {};
  for (const a of ACTIONS) {
    const s = input.state(a);
    actions[a] = { pressed: s.pressed, held: s.held, released: s.released, value: s.value };
  }
  const p = input.pointer;
  return {
    actions,
    pointer: { x: p.x, y: p.y, dx: p.dx, dy: p.dy, inside: p.inside, down: p.down },
    wheel: [p.wheelX, p.wheelY],
    lastDevice: input.lastDevice,
  };
}

function pad(buttons: number[], axes: number[], pressedAt = 0.5): GamepadLike {
  return {
    connected: true,
    buttons: buttons.map((v) => ({ pressed: v >= pressedAt, value: v })),
    axes,
  };
}

/** A transform that maps a 100×100 client box onto 1000×1000 and rejects points outside. */
function transform(cx: number, cy: number): { x: number; y: number } | null {
  if (cx < 0 || cy < 0 || cx > 100 || cy > 100) return null;
  return { x: cx * 10, y: cy * 10 };
}

/**
 * The scripted session: 30 ticks mixing every feed kind, repeat taps, a blur, pads coming and
 * going.
 */
type Step = (input: Input<Action>, pads: (GamepadLike | null)[]) => void;

const STEPS: Step[] = [
  (i) => i.pointerAt(10, 10),
  (i) => i.keyDown('KeyA'),
  () => {},
  (i) => {
    i.keyUp('KeyA');
    i.keyDown('KeyD');
  },
  (i) => {
    // Two taps before a tick: the second queues.
    i.keyDown('Space');
    i.keyUp('Space');
    i.keyDown('Space');
    i.keyUp('Space');
  },
  () => {},
  () => {},
  (i) => {
    i.pointerAt(20, 30);
    i.buttonDown(0);
  },
  (i) => i.pointerAt(25, 35, 'touch'),
  (i) => i.buttonUp(0),
  (i) => {
    i.wheel(0, -120);
    i.wheel(0, -40);
  },
  (i) => i.wheel(3, 50),
  (_i, pads) => {
    pads.push(pad([0, 0], [0.9, 0]));
  },
  () => {},
  (_i, pads) => {
    pads[0] = pad([1, 0], [-0.7, 0.3]);
  },
  () => {},
  (_i, pads) => {
    // Not `pressed`, so the analog 0.6 survives (a pressed button records as 1).
    pads[0] = pad([0.6, 0], [0, 0.05], 0.7);
    pads[1] = pad([0, 1], [0, 0]);
  },
  (_i, pads) => {
    pads[1] = { connected: false, buttons: [], axes: [] };
  },
  (_i, pads) => {
    pads.length = 0;
  },
  (i) => i.buttonDown(2),
  (i) => i.pointerAt(200, 200),
  (i) => i.keyDown('KeyA'),
  (i) => i.releaseAll(),
  () => {},
  (i) => i.keyDown('KeyA'),
  () => {},
  () => {},
  () => {},
  (i) => i.keyUp('KeyD'),
  () => {},
];

function makeInput(pads: (GamepadLike | null)[]): Input<Action> {
  const input = new Input<Action>(BINDINGS, { getGamepads: () => pads });
  input.setPointerTransform(transform);
  return input;
}

function record(): { recording: InputRecording; states: TickState[] } {
  const pads: (GamepadLike | null)[] = [];
  const input = makeInput(pads);
  const rec = createInputRecorder(input);
  expect(input.recorder).toBe(rec);
  const states: TickState[] = [];
  for (const step of STEPS) {
    step(input, pads);
    input.update();
    states.push(snapshot(input));
  }
  expect(rec.ticks).toBe(STEPS.length);
  const recording = rec.stop();
  expect(input.recorder).toBeNull();
  // After stop nothing more is recorded.
  input.keyDown('KeyZ');
  input.update();
  expect(recordingLength(recording)).toBe(STEPS.length);
  return { recording, states };
}

function replay(recording: InputRecording, speed = 1): TickState[] {
  // The real pads of the replaying machine are never read.
  const livePads: GamepadLike[] = [pad([1, 1], [1, 1])];
  const input = makeInput(livePads);
  const pb = createInputPlayback(input, recording, { speed });
  expect(input.playback).toBe(pb);
  const states: TickState[] = [];
  while (pb.step()) {
    input.update();
    states.push(snapshot(input));
  }
  expect(pb.done).toBe(true);
  pb.detach();
  expect(input.playback).toBeNull();
  return states;
}

describe('input recording and replay', () => {
  it('replays keys, pointer, wheel, pads and releaseAll with identical states per tick', () => {
    const { recording, states } = record();
    const replayed = replay(recording);
    expect(replayed.length).toBe(states.length);
    for (let t = 0; t < states.length; t++) expect(replayed[t], `tick ${t}`).toEqual(states[t]);
    // The session really exercised things.
    expect(states.some((s) => s.actions.jump!.pressed)).toBe(true);
    expect(states.filter((s) => s.actions.jump!.pressed).length).toBe(2);
    expect(states.some((s) => s.actions.zoom!.pressed)).toBe(true);
    expect(states.some((s) => s.actions.throttle!.value === 0.3)).toBe(true);
    expect(states.some((s) => s.actions.fire!.value === 0.6)).toBe(true);
    expect(states.some((s) => s.actions.jump2!.held)).toBe(true);
    expect(states.some((s) => s.actions.alt!.held)).toBe(true);
    expect(states.some((s) => s.pointer.inside === false)).toBe(true);
    expect(states.some((s) => s.lastDevice === 'touch')).toBe(true);
    expect(states.some((s) => s.lastDevice === 'gamepad')).toBe(true);
  });

  it('records deltas only: runs for idle ticks, pads only when they change', () => {
    const { recording } = record();
    expect(recording.version).toBe(2);
    expect(recording.ticks.length).toBeLessThan(STEPS.length);
    // Ticks 4..6: events, then two idle ticks as one run.
    const run = recording.ticks.find((t) => 'n' in t && t.t === 5);
    expect(run).toEqual({ t: 5, n: 2 });
    const withPads = recording.ticks.filter((t) => 'g' in t);
    // Pads appear (12), change (14), change and a second pad (16), one disconnects (17), gone (18).
    expect(withPads.map((t) => t.t)).toEqual([12, 14, 16, 17, 18]);
    expect(withPads[0]).toEqual({ t: 12, g: [{ buttons: [0, 0], axes: [0.9, 0] }] });
    expect(withPads[1]).toEqual({ t: 14, g: [{ buttons: [1, 0], axes: [-0.7, 0.3] }] });
    expect(withPads[3]).toEqual({
      t: 17,
      g: [{ buttons: [0.6, 0], axes: [0, 0.05] }, null],
    });
    expect(withPads[4]).toEqual({ t: 18, g: [] });
    expect(recording.ticks[0]).toEqual({ t: 0, p: [10, 10] });
    expect(recording.ticks.find((t) => t.t === 4)).toEqual({
      t: 4,
      k: [
        ['Space', 1],
        ['Space', 0],
        ['Space', 1],
        ['Space', 0],
      ],
    });
    expect(recording.ticks.find((t) => t.t === 8)).toEqual({ t: 8, p: [25, 35, 'touch'] });
    expect(recording.ticks.find((t) => t.t === 10)).toEqual({ t: 10, w: [0, -160] });
    expect(recording.ticks.find((t) => t.t === 22)).toEqual({ t: 22, r: 1 });
  });

  it('round-trips through JSON and replays the parsed copy identically', () => {
    const { recording, states } = record();
    const json = serializeRecording(recording);
    const parsed = parseRecording(json);
    expect(parsed).toEqual(recording);
    expect(serializeRecording(parsed)).toBe(json);
    expect(replay(parsed)).toEqual(states);
    expect(parseRecording(JSON.parse(json))).toEqual(recording);
  });

  it('parseRecording rejects a bad version and malformed ticks', () => {
    expect(() => parseRecording('{"version":3,"ticks":[]}')).toThrow(/version/);
    expect(() => parseRecording('{"ticks":[]}')).toThrow(/version/);
    expect(() => parseRecording('nope')).toThrow(/JSON/);
    expect(() => parseRecording('[]')).toThrow(/object/);
    expect(() => parseRecording({ version: 1 })).toThrow(/ticks/);
    expect(() => parseRecording({ version: 1, ticks: [{ t: 1 }] })).toThrow(/expected t 0/);
    expect(() => parseRecording({ version: 1, ticks: [{ t: 0, n: 2 }, { t: 1 }] })).toThrow(
      /expected t 2/,
    );
    expect(() => parseRecording({ version: 1, ticks: [{ t: 0, k: [['KeyA', 2]] }] })).toThrow(
      /bad k/,
    );
    expect(() => parseRecording({ version: 1, ticks: [{ t: 0, p: [1] }] })).toThrow(/bad p/);
    expect(() => parseRecording({ version: 1, ticks: [{ t: 0, g: [{ buttons: 1 }] }] })).toThrow(
      /bad g/,
    );
    expect(parseRecording({ version: 1, ticks: [] })).toEqual({ version: 1, ticks: [] });
  });

  it('speed fast-forwards: the input lands in the same state as a tick-by-tick replay', () => {
    const { recording, states } = record();
    const fast = replay(recording, 4);
    // Every 4th tick of the slow replay, plus the final partial step.
    const expected = states.filter((_, t) => (t + 1) % 4 === 0 || t === states.length - 1);
    expect(fast).toEqual(expected);
  });

  it('seek releases everything and resumes from that tick with its pads', () => {
    const { recording, states } = record();
    const input = makeInput([]);
    const pb = createInputPlayback(input, recording);
    expect(pb.length).toBe(STEPS.length);
    // Play up to and including tick 14 (pad held), then jump back to 0.
    for (let t = 0; t <= 14; t++) {
      pb.step();
      input.update();
    }
    expect(input.lastDevice).toBe('gamepad');
    expect(input.held('left')).toBe(true);
    expect(input.held('right')).toBe(true);
    pb.seek(0);
    expect(pb.tick).toBe(0);
    expect(pb.done).toBe(false);
    input.update();
    expect(input.held('right')).toBe(false);
    // From the start again, states match the original once the stale edges settle.
    const again: TickState[] = [];
    while (pb.step()) {
      input.update();
      again.push(snapshot(input));
    }
    expect(again.slice(2)).toEqual(states.slice(2));
    // Seek into the middle: the pads in force there are restored, nothing earlier is fed.
    pb.seek(15);
    expect(pb.tick).toBe(15);
    input.update();
    expect(input.value('throttle')).toBe(0.3);
    expect(input.held('fire')).toBe(true);
    expect(input.held('right')).toBe(false);
  });

  it('allocates no tick entries while nothing happens', () => {
    const input = makeInput([null, null, null, null]);
    const rec = createInputRecorder(input);
    for (let i = 0; i < 100; i++) input.update();
    expect(rec.recording.ticks).toEqual([{ t: 0, n: 100 }]);
    expect(rec.ticks).toBe(100);
  });

  it('keeps which of pointer and keyboard was used last within a tick', () => {
    const src = makeInput([]);
    const rec = createInputRecorder(src);
    src.pointerAt(10, 10);
    src.keyDown('KeyA');
    src.update();
    src.keyDown('KeyD');
    src.pointerAt(20, 20);
    src.update();
    src.pointerAt(30, 30, 'touch');
    src.keyDown('Space');
    src.pointerAt(40, 40, 'touch');
    src.update();
    const recording = rec.stop();
    expect(recording.ticks).toEqual([
      { t: 0, p: [10, 10], k: [['KeyA', 1]], d: 1 },
      { t: 1, k: [['KeyD', 1]], p: [20, 20] },
      { t: 2, p: [40, 40, 'touch'], k: [['Space', 1]] },
    ]);
    const dst = makeInput([]);
    const pb = createInputPlayback(dst, recording);
    const devices: string[] = [];
    while (pb.step()) {
      dst.update();
      devices.push(dst.lastDevice);
    }
    expect(devices).toEqual(['keyboard', 'mouse', 'touch']);
    expect(() => parseRecording({ version: 1, ticks: [{ t: 0, d: 2 }] })).toThrow(
      InputRecordingError,
    );
  });

  it('a recorder with pads off captures no gamepads', () => {
    const pads = [pad([1], [0])];
    const input = makeInput(pads);
    const rec = createInputRecorder(input, { pads: false });
    input.update();
    expect(rec.stop().ticks).toEqual([{ t: 0, n: 1 }]);
  });
});

describe('recording triggers, chords and rumble (ws/input-3)', () => {
  const TRIG = {
    charge: [{ key: 'KeyC', trigger: 'hold' as const, holdMs: 300 }],
    combo: [{ chord: [{ key: 'ShiftLeft' }, { key: 'KeyK' }] }],
    dash: [{ key: 'KeyD', trigger: 'doubleTap' as const }],
  };
  type T = keyof typeof TRIG;

  function snap(input: Input<T>) {
    const out: Record<string, unknown> = {};
    for (const a of Object.keys(TRIG) as T[]) {
      const s = input.state(a);
      out[a] = [s.pressed, s.held, s.released, s.holdProgress];
    }
    return out;
  }

  it('a hold, a chord and a double tap replay identically tick for tick', () => {
    const input = new Input(TRIG, { getGamepads: () => [], tickMs: 100 });
    const rec = createInputRecorder(input);
    const states: unknown[] = [];
    const steps: ((i: Input<T>) => void)[] = [
      (i) => i.keyDown('KeyC'),
      () => {},
      (i) => i.keyDown('KeyK'),
      (i) => i.keyDown('ShiftLeft'),
      () => {},
      (i) => {
        i.keyUp('KeyC');
        i.keyUp('KeyK');
      },
      (i) => i.keyDown('KeyD'),
      (i) => i.keyUp('KeyD'),
      (i) => i.keyDown('KeyD'),
      () => {},
      (i) => i.releaseAll(),
    ];
    for (const step of steps) {
      step(input);
      input.update();
      states.push(snap(input));
    }
    const recording = rec.stop();
    expect(states.some((s) => (s as Record<string, boolean[]>).charge![1])).toBe(true);
    expect(states.filter((s) => (s as Record<string, boolean[]>).combo![0]).length).toBe(1);
    expect(states.filter((s) => (s as Record<string, boolean[]>).dash![0]).length).toBe(1);

    const other = new Input(TRIG, { getGamepads: () => [], tickMs: 100 });
    const pb = createInputPlayback(other, parseRecording(serializeRecording(recording)));
    const replayed: unknown[] = [];
    while (pb.step()) {
      other.update();
      replayed.push(snap(other));
    }
    expect(replayed).toEqual(states);
  });

  it('records rumbles per tick; playback does not re-issue them; parse validates them', () => {
    const effects: unknown[] = [];
    const rumblePad: GamepadLike = {
      connected: true,
      buttons: [],
      axes: [],
      vibrationActuator: {
        playEffect(_type, params) {
          effects.push(params);
        },
      },
    };
    const input = new Input(BINDINGS, { getGamepads: () => [rumblePad] });
    const rec = createInputRecorder(input, { pads: false });
    input.update();
    input.update();
    expect(input.rumble({ strong: 0.5, weak: 0.25, ms: 80 })).toBe(true);
    expect(input.rumble({ ms: 50, pad: 0 })).toBe(true);
    input.update();
    input.update();
    const recording = rec.stop();
    expect(recording.ticks).toEqual([
      { t: 0, n: 2 },
      {
        t: 2,
        rumble: [
          [0.5, 0.25, 80],
          [1, 1, 50, 0],
        ],
      },
      { t: 3, n: 1 },
    ]);
    expect(effects).toHaveLength(2);

    const other = new Input(BINDINGS, { getGamepads: () => [rumblePad] });
    const pb = createInputPlayback(other, parseRecording(serializeRecording(recording)));
    while (pb.step()) other.update();
    expect(effects).toHaveLength(2);
    expect(() => parseRecording({ version: 1, ticks: [{ t: 0, rumble: [[1, 1]] }] })).toThrow(
      /bad rumble/,
    );
    expect(() => parseRecording({ version: 1, ticks: [{ t: 0, rumble: [[1, 'x', 5]] }] })).toThrow(
      /bad rumble/,
    );
  });
});
