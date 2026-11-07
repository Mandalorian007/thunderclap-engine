// @vitest-environment happy-dom
/**
 * A playback anchors recorded event times at the clock reading of its first `step()`
 * (ws/input-10), so the first event keeps its recorded age. Before, the first timed event was
 * fed at age 0, so a long-press whose down was handled late could fire one tick later on
 * replay. The clock here idles 500 ms between the playback's creation and its first step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTickClock } from './clock';
import { createGestures } from './gestures';
import { Input } from './input';
import { createInputPlayback, createInputRecorder, type InputRecording } from './record';

const STEP_MS = 20;
/** Handling lags, ms: 10 and 17 put the live long-press a tick before an age-0 replay's. */
const LAGS = [3, 10, 17];

describe('playback anchors event ages at its first step (ws/input-10)', () => {
  let el: HTMLElement;
  let wall = 0;
  let lag = 0;

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
    Object.defineProperty(e, 'timeStamp', { value: wall - lag });
    return e;
  };

  function rig() {
    const clock = createTickClock(5000);
    const gestures = createGestures({ clock });
    const input = new Input({}, { getGamepads: () => [], gestures });
    input.attach({ pointerTarget: el });
    return { clock, gestures, input };
  }

  /** Live, in `createGame` order: down on tick 5, held 40 ticks, up. */
  function record(): { recording: InputRecording; at: number } {
    const { clock, gestures, input } = rig();
    let k = 0;
    let at = -1;
    gestures.onGesture((kind) => {
      if (kind === 'longPress' && at < 0) at = k;
    });
    const rec = createInputRecorder(input);
    for (; k < 50; k++) {
      wall += STEP_MS;
      if (k === 5) el.dispatchEvent(ptr('pointerdown'));
      if (k === 45) el.dispatchEvent(ptr('pointerup'));
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
    let at = -1;
    gestures.onGesture((kind) => {
      if (kind === 'longPress' && at < 0) at = play.tick - 1;
    });
    // The replay starts late: 500 ms pass on the clock (and the wall) before the first step.
    clock.advance(500);
    wall += 500;
    while (play.step()) {
      wall += 7;
      input.update();
    }
    input.detach();
    return at;
  }

  for (const l of LAGS) {
    it(`a down handled ${l} ms late long-presses on the recorded tick at speed 1 and 4`, () => {
      lag = l;
      const { recording, at } = record();
      // Down on tick 5 (clock 5100), lag ms early: 450 ms later is reached on tick at.
      expect(at).toBe(Math.ceil((5100 - l + 450 - 5000) / STEP_MS) - 1);
      for (const speed of [1, 4]) expect(replayAt(recording, speed)).toBe(at);
    });
  }

  it('after a seek the anchor is the next step, less the sought tick', () => {
    lag = 10;
    const { recording, at } = record();
    wall = 90_000;
    const { clock, gestures, input } = rig();
    const play = createInputPlayback(input, structuredClone(recording), { clock });
    let fired = -1;
    gestures.onGesture((kind) => {
      if (kind === 'longPress' && fired < 0) fired = play.tick - 1;
    });
    play.step();
    input.update();
    play.seek(3);
    clock.advance(500);
    while (play.step()) input.update();
    input.detach();
    expect(fired).toBe(at);
  });
});
