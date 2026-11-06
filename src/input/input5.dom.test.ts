// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gestures } from './gestures';
import { Input } from './input';
import { Look } from './look';
import {
  createInputPlayback,
  createInputRecorder,
  type InputRecording,
  parseRecording,
} from './record';
import { createTouchZones } from './touch-zones';

function ptr(type: string, id: number, x: number, y: number, pointerType = 'touch') {
  return new PointerEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType,
    isPrimary: id === 1,
    button: 0,
    bubbles: true,
  });
}

describe('Look.onTap (ws/input-5)', () => {
  let el: HTMLElement;
  let t = 0;
  let look: Look;
  let input: Input<never>;
  const taps: [number, number, string][] = [];

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400));
    t = 0;
    taps.length = 0;
    look = new Look({ mode: 'orbit', now: () => t, getGamepads: () => [] });
    look.onTap((x, y, d) => taps.push([x, y, d]));
    input = new Input({}, { look, getGamepads: () => [] });
    input.attach({ pointerTarget: el });
  });

  afterEach(() => {
    input.detach();
    look.detach();
    el.remove();
    vi.restoreAllMocks();
  });

  it('a click fires once, in the pointer transform units', () => {
    input.setPointerTransform((x, y) => ({ x: x / 2, y: y / 2 }));
    el.dispatchEvent(ptr('pointerdown', 1, 200, 100, 'mouse'));
    t = 100;
    el.dispatchEvent(ptr('pointermove', 1, 203, 100, 'mouse'));
    el.dispatchEvent(ptr('pointerup', 1, 203, 100, 'mouse'));
    expect(taps).toEqual([[101.5, 50, 'mouse']]);
  });

  it('a drag does not tap; a press held past maxMs does not; a second finger cancels', () => {
    // The right half: the left half is the move stick, which never taps.
    el.dispatchEvent(ptr('pointerdown', 1, 600, 100));
    el.dispatchEvent(ptr('pointermove', 1, 615, 100));
    el.dispatchEvent(ptr('pointerup', 1, 615, 100));
    el.dispatchEvent(ptr('pointerdown', 1, 600, 100));
    t = 500;
    el.dispatchEvent(ptr('pointerup', 1, 600, 100));
    el.dispatchEvent(ptr('pointerdown', 1, 600, 100));
    el.dispatchEvent(ptr('pointerdown', 2, 700, 100));
    el.dispatchEvent(ptr('pointerup', 2, 700, 100));
    el.dispatchEvent(ptr('pointerup', 1, 600, 100));
    el.dispatchEvent(ptr('pointerdown', 1, 100, 100));
    el.dispatchEvent(ptr('pointerup', 1, 100, 100));
    expect(taps).toEqual([]);
    el.dispatchEvent(ptr('pointerdown', 1, 600, 100));
    el.dispatchEvent(ptr('pointerup', 1, 600, 100));
    expect(taps).toEqual([[600, 100, 'touch']]);
  });
});

type Action = 'moveLeft' | 'moveRight' | 'moveUp' | 'moveDown' | 'jump' | 'attack';

describe('recording every pointer (ws/input-5)', () => {
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

  /** A two-thumb touch-zone game; `snap` is each tick's action states. */
  function game() {
    const gestures = new Gestures({ now: () => 0 });
    const input = new Input<Action>(
      { moveLeft: [], moveRight: [], moveUp: [], moveDown: [], jump: [], attack: [] },
      { getGamepads: () => [], gestures },
    );
    input.attach({ pointerTarget: el });
    const zones = createTouchZones(input, {
      zones: {
        move: {
          kind: 'stick',
          rect: (w, h) => ({ x: 0, y: 0, w: w / 2, h }),
          radius: 50,
          deadZone: 0,
        },
        act: {
          kind: 'buttons',
          rect: (w, h) => ({ x: w / 2, y: 0, w: w / 2, h }),
          buttons: { jump: (w) => ({ x: w / 2, y: 0, w: w / 2, h: 200 }) },
        },
      },
      bindings: {
        moveLeft: { zone: 'move', axis: 'x', dir: -1 },
        moveRight: { zone: 'move', axis: 'x', dir: 1 },
        moveUp: { zone: 'move', axis: 'y', dir: -1 },
        moveDown: { zone: 'move', axis: 'y', dir: 1 },
        jump: { zone: 'act', button: 'jump' },
      },
    });
    const snap = () =>
      JSON.stringify(
        (['moveLeft', 'moveRight', 'moveUp', 'moveDown', 'jump'] as const).map((a) => {
          const s = input.state(a);
          return [s.pressed, s.held, s.released, Math.round(s.value * 1000)];
        }),
      );
    return { input, zones, snap };
  }

  const script: ((el: HTMLElement) => void)[] = [
    (e) => e.dispatchEvent(ptr('pointerdown', 1, 100, 200)),
    (e) => e.dispatchEvent(ptr('pointermove', 1, 130, 200)),
    (e) => {
      e.dispatchEvent(ptr('pointermove', 1, 140, 180));
      e.dispatchEvent(ptr('pointermove', 1, 150, 170));
      e.dispatchEvent(ptr('pointerdown', 2, 700, 100));
    },
    () => {},
    (e) => e.dispatchEvent(ptr('pointerup', 2, 700, 100)),
    (e) => e.dispatchEvent(ptr('pointermove', 1, 60, 220)),
    () => window.dispatchEvent(new Event('blur')),
    () => {},
  ];

  it('a two-thumb session replays to identical per-tick action states', () => {
    const live = game();
    const rec = createInputRecorder(live.input);
    const want: string[] = [];
    for (const step of script) {
      step(el);
      live.input.update();
      want.push(live.snap());
    }
    const recording = rec.stop();
    expect(recording.version).toBe(2);
    const lanes = recording.ticks.flatMap((t) => ('ptr' in t && t.ptr ? t.ptr : []));
    // The two coalesced moves on tick 2 keep only the last.
    expect(lanes.filter((p) => p[0] === 1 && p[3] === 150)).toHaveLength(1);
    expect(lanes.filter((p) => p[0] === 1 && p[3] === 140)).toHaveLength(0);
    // The blur cancels thumb 1.
    expect(lanes.at(-1)).toEqual([3, 1, 'touch', 60, 220, 0, 1]);
    expect(want.some((s) => s.includes('[true,true,false,1000]'))).toBe(true);
    live.zones.destroy();
    live.input.detach();

    const again = game();
    const play = createInputPlayback(again.input, parseRecording(JSON.stringify(recording)));
    const got: string[] = [];
    while (play.step()) {
      again.input.update();
      got.push(again.snap());
    }
    expect(got).toEqual(want);
    again.zones.destroy();
    again.input.detach();
  });

  it('context and consume calls are recorded, not replayed', () => {
    const input = new Input({ jump: [{ key: 'Space' }] }, { getGamepads: () => [] });
    const rec = createInputRecorder(input);
    input.keyDown('Space');
    input.update();
    input.consume('jump');
    const pop = input.pushContext('menu');
    input.update();
    pop();
    input.update();
    const r = rec.stop();
    const events = r.ticks.filter((t) => 'cx' in t || 'cs' in t);
    expect(events.flatMap((t) => ('cs' in t ? t.cs : []))).toEqual(['jump']);
    expect(events.flatMap((t) => ('cx' in t ? t.cx : []))).toEqual([
      ['menu', 1],
      ['menu', 0],
    ]);
    const other = new Input({ jump: [{ key: 'Space' }] }, { getGamepads: () => [] });
    const play = createInputPlayback(other, r);
    while (play.step()) other.update();
    expect(other.context).toBeNull();
  });

  it('a version 1 recording still parses and plays; bad v2 lanes are rejected', () => {
    const v1: InputRecording = {
      version: 1,
      ticks: [
        { t: 0, k: [['Space', 1]] },
        { t: 1, k: [['Space', 0]] },
      ],
    };
    const input = new Input({ jump: [{ key: 'Space' }] }, { getGamepads: () => [] });
    const play = createInputPlayback(input, parseRecording(JSON.stringify(v1)));
    play.step();
    input.update();
    expect(input.pressed('jump')).toBe(true);
    play.step();
    input.update();
    expect(input.released('jump')).toBe(true);
    expect(play.done).toBe(true);
    expect(() => parseRecording({ version: 2, ticks: [{ t: 0, ptr: [[9, 1]] }] })).toThrow(/ptr/);
    expect(() => parseRecording({ version: 2, ticks: [{ t: 0, cx: [['a', 2]] }] })).toThrow(/cx/);
    expect(() => parseRecording({ version: 2, ticks: [{ t: 0, cs: [1] }] })).toThrow(/cs/);
    expect(
      parseRecording({ version: 2, ticks: [{ t: 0, ptr: [[0, 1, 'pen', 1, 2, 0, 1]] }] }).version,
    ).toBe(2);
  });
});
