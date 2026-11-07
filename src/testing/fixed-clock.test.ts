import { describe, expect, it } from 'vitest';
import {
  type Bindings,
  createGestures,
  createInputPlayback,
  createInputRecorder,
  Input,
  type TickClock,
} from '../input';
import { createFixedClock, type FixedClock } from './fixed-clock';

describe('createFixedClock', () => {
  it('is a TickClock that reads exactly N steps after N steps', () => {
    const clock: TickClock = createFixedClock();
    const fixed = clock as FixedClock;
    fixed.step(3);
    fixed.step();
    expect(fixed.ticks).toBe(4);
    expect(clock.now()).toBe(4 * (1000 / 60));
    fixed.step(600);
    expect(clock.now()).toBe(604 * (1000 / 60));
  });

  it('adds loose advances and the start, and ignores bad values', () => {
    const clock = createFixedClock(10, 100);
    clock.advance(5);
    clock.advance(-5);
    clock.advance(Number.NaN);
    clock.step(-1);
    clock.step(1.5);
    clock.step(2);
    expect(clock.now()).toBe(125);
    expect(clock.ticks).toBe(2);
    expect(clock.stepMs).toBe(10);
  });

  it('counts a step-sized advance as a step (the game loop advances by step × 1000; ws/core-8)', () => {
    const clock = createFixedClock(1000 / 60);
    for (let i = 0; i < 30; i++) clock.advance(1000 / 60);
    clock.advance(4);
    expect(clock.ticks).toBe(30);
    expect(clock.now()).toBe(30 * (1000 / 60) + 4);
  });

  it('rejects a step that is not a positive finite number', () => {
    expect(() => createFixedClock(0)).toThrow(RangeError);
    expect(() => createFixedClock(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

type Action = 'right' | 'info';
const bindings: Bindings<Action> = {
  right: [{ key: 'ArrowRight' }],
  info: [{ gesture: 'longPress' }],
};

/** A tiny game: `x` moves 2 per tick while `right` is held; a long-press opens `info`. */
function makeGame(clock: FixedClock) {
  const gestures = createGestures({ clock });
  const input = new Input<Action>(bindings, { getGamepads: () => [], gestures });
  const state = { x: 0, info: -1, tick: 0 };
  /** One fixed step, in the order `createGame`'s loop runs it. */
  const tick = () => {
    clock.step();
    input.update();
    state.tick++;
    if (input.held('right')) state.x += 2;
    if (input.pressed('info') && state.info < 0) state.info = state.tick;
  };
  return { input, gestures, state, tick };
}

describe('a game stepped on the fixed clock', () => {
  it('moves a value on an action press after N steps', () => {
    const game = makeGame(createFixedClock());
    game.input.keyDown('ArrowRight');
    for (let i = 0; i < 10; i++) game.tick();
    game.input.keyUp('ArrowRight');
    game.tick();
    expect(game.state.x).toBe(20);
  });

  it('fires a long-press on game time, not wall time', () => {
    const clock = createFixedClock(10);
    const game = makeGame(clock);
    game.gestures.pointerDown(1, 50, 50, 'touch', clock.now());
    for (let i = 0; i < 60; i++) game.tick();
    // 450 ms long-press on 10 ms steps: the 45th tick reaches it.
    expect(game.state.info).toBe(45);
  });

  it('replays an input recording to the same state', () => {
    const live = makeGame(createFixedClock(10));
    const rec = createInputRecorder(live.input);
    const script: Record<number, () => void> = {
      0: () => live.input.keyDown('ArrowRight'),
      7: () => live.input.keyUp('ArrowRight'),
      12: () => live.input.keyDown('ArrowRight'),
      70: () => live.input.keyUp('ArrowRight'),
    };
    for (let i = 0; i < 80; i++) {
      script[i]?.();
      live.tick();
    }
    const recording = rec.stop();

    const again = makeGame(createFixedClock(10));
    const pb = createInputPlayback(again.input, recording);
    while (pb.step()) again.tick();
    expect(again.state).toEqual(live.state);
    expect(live.state.x).toBe(2 * (7 + 58));
  });
});
