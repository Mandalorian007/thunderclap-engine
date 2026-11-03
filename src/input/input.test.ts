import { describe, expect, it } from 'vitest';
import { Input } from './input';
import type { GamepadLike } from './types';

const bindings = {
  confirm: [{ key: 'Enter' }, { key: 'Space' }, { padButton: 0 }],
  left: [{ key: 'ArrowLeft' }, { padAxis: 0, dir: -1 }],
  click: [{ mouse: 0 }],
  zoomIn: [{ wheel: -1 }],
} as const;

function pad(buttons: number[] = [], axes: number[] = [0, 0]): GamepadLike {
  return {
    connected: true,
    buttons: Array.from({ length: 16 }, (_, i) => ({
      pressed: buttons.includes(i),
      value: buttons.includes(i) ? 1 : 0,
    })),
    axes,
  };
}

describe('Input action map', () => {
  it('reports pressed → held → released edges', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.keyDown('Enter');
    input.update();
    expect(input.state('confirm')).toMatchObject({
      pressed: true,
      held: true,
      released: false,
      heldTicks: 1,
    });
    input.update();
    expect(input.state('confirm')).toMatchObject({ pressed: false, held: true, heldTicks: 2 });
    input.keyUp('Enter');
    input.update();
    expect(input.state('confirm')).toMatchObject({
      pressed: false,
      held: false,
      released: true,
      heldTicks: 0,
    });
    input.update();
    expect(input.released('confirm')).toBe(false);
  });

  it('does not lose a tap that starts and ends between ticks', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.keyDown('Space');
    input.keyUp('Space');
    input.update();
    expect(input.pressed('confirm')).toBe(true);
    input.update();
    expect(input.released('confirm')).toBe(true);
    expect(input.held('confirm')).toBe(false);
  });

  it('queues repeat taps that land in one tick', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    for (let i = 0; i < 3; i++) {
      input.keyDown('Enter');
      input.keyUp('Enter');
    }
    const seen: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      input.update();
      seen.push(input.pressed('confirm'));
    }
    expect(seen).toEqual([true, true, true, false, false]);
    expect(input.released('confirm')).toBe(false);
    input.update();
    expect(input.held('confirm')).toBe(false);
  });

  it('queues a repeat that arrives while the queue drains, and mouse taps', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.buttonDown(0);
    input.buttonUp(0);
    input.buttonDown(0);
    input.buttonUp(0);
    input.update();
    expect(input.pressed('click')).toBe(true);
    input.buttonDown(0);
    input.buttonUp(0);
    input.update();
    expect(input.pressed('click')).toBe(true);
    input.update();
    expect(input.pressed('click')).toBe(true);
    input.update();
    expect(input.pressed('click')).toBe(false);
  });

  it('caps the queue and drops it while blocked or on releaseAll', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    for (let i = 0; i < 20; i++) {
      input.keyDown('Enter');
      input.keyUp('Enter');
    }
    let presses = 0;
    for (let i = 0; i < 20; i++) {
      input.update();
      if (input.pressed('confirm')) presses++;
    }
    expect(presses).toBe(9); // first tap + 8 queued
    let blocked = false;
    input.blocked = () => blocked;
    input.keyDown('Enter');
    input.keyUp('Enter');
    input.keyDown('Enter');
    input.keyUp('Enter');
    blocked = true;
    input.update();
    blocked = false;
    input.update();
    expect(input.pressed('confirm')).toBe(false);
    input.keyDown('Enter');
    input.keyUp('Enter');
    input.keyDown('Enter');
    input.keyUp('Enter');
    input.releaseAll();
    input.update();
    input.update();
    expect(input.pressed('confirm')).toBe(false);
  });

  it('queueTaps: false merges taps in one tick', () => {
    const input = new Input(bindings, { getGamepads: () => [], queueTaps: false });
    input.keyDown('Enter');
    input.keyUp('Enter');
    input.keyDown('Enter');
    input.keyUp('Enter');
    input.update();
    expect(input.pressed('confirm')).toBe(true);
    input.update();
    expect(input.pressed('confirm')).toBe(false);
  });

  it('merges multiple bindings: second key held does not re-press', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.keyDown('Enter');
    input.update();
    input.keyDown('Space');
    input.keyUp('Enter');
    input.update();
    expect(input.pressed('confirm')).toBe(false);
    expect(input.held('confirm')).toBe(true);
  });

  it('a key tapped on two ticks in a row presses twice', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.keyDown('Enter');
    input.keyUp('Enter');
    input.update();
    expect(input.pressed('confirm')).toBe(true);
    input.keyDown('Enter');
    input.keyUp('Enter');
    input.update();
    expect(input.pressed('confirm')).toBe(true);
    input.update();
    expect(input.pressed('confirm')).toBe(false);
  });

  it('reads gamepad buttons and axes with thresholds', () => {
    let pads: (GamepadLike | null)[] = [null, pad([0], [-0.3, 0])];
    const input = new Input(bindings, { getGamepads: () => pads });
    input.update();
    expect(input.pressed('confirm')).toBe(true);
    expect(input.held('left')).toBe(false);
    expect(input.lastDevice).toBe('gamepad');
    pads = [null, pad([], [-0.8, 0])];
    input.update();
    expect(input.released('confirm')).toBe(true);
    expect(input.pressed('left')).toBe(true);
    expect(input.value('left')).toBeCloseTo(0.8);
  });

  it('respects a pad index on the binding', () => {
    const input = new Input(
      { a: [{ padButton: 0, pad: 0 }] },
      { getGamepads: () => [pad(), pad([0])] },
    );
    input.update();
    expect(input.held('a')).toBe(false);
  });

  it('maps mouse buttons and wheel', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.buttonDown(0);
    input.wheel(0, -120);
    input.update();
    expect(input.pressed('click')).toBe(true);
    expect(input.pressed('zoomIn')).toBe(true);
    expect(input.pointer.wheelY).toBe(-120);
    expect(input.pointer.down).toBe(true);
    input.buttonUp(0);
    input.update();
    expect(input.released('click')).toBe(true);
    expect(input.released('zoomIn')).toBe(true);
    expect(input.pointer.wheelY).toBe(0);
  });

  it('suppresses actions while blocked without firing presses on unblock', () => {
    let blocked = false;
    const input = new Input(bindings, { getGamepads: () => [], blocked: () => blocked });
    input.keyDown('Enter');
    input.update();
    expect(input.pressed('confirm')).toBe(true);
    blocked = true;
    input.update();
    expect(input.held('confirm')).toBe(false);
    expect(input.released('confirm')).toBe(false);
    // Key pressed during the block and still held after it.
    input.keyDown('ArrowLeft');
    input.update();
    expect(input.pressed('left')).toBe(false);
    blocked = false;
    input.update();
    expect(input.pressed('left')).toBe(false);
    expect(input.pressed('confirm')).toBe(false);
    expect(input.held('left')).toBe(true);
    input.keyUp('ArrowLeft');
    input.update();
    expect(input.released('left')).toBe(true);
  });

  it('applies the pointer transform and tracks deltas', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.setPointerTransform((cx, cy) => (cx < 0 ? null : { x: cx * 2, y: cy * 2 }));
    input.pointerAt(10, 20);
    input.update();
    expect(input.pointer).toMatchObject({ x: 20, y: 40, inside: true, dx: 20, dy: 40 });
    input.pointerAt(15, 20);
    input.update();
    expect(input.pointer).toMatchObject({ x: 30, dx: 10, dy: 0 });
    input.pointerAt(-1, 0);
    expect(input.pointer.inside).toBe(false);
    expect(input.pointer.x).toBe(30);
  });

  it('releaseAll clears stuck keys; setBindings resets states', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.keyDown('Enter');
    input.update();
    input.releaseAll();
    input.update();
    expect(input.released('confirm')).toBe(true);
    input.setBindings({ ...bindings, confirm: [{ key: 'KeyZ' }] });
    input.keyDown('KeyZ');
    input.update();
    expect(input.pressed('confirm')).toBe(true);
    expect(input.anyPressed()).toBe(true);
    expect(() => input.state('nope' as 'confirm')).toThrow();
  });
});
