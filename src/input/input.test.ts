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

describe('Input triggers (ws/input-3)', () => {
  const TICK = 100;

  it("'hold' fires after holdMs of ticks, reports holdProgress and releases on lift", () => {
    const input = new Input(
      { charge: [{ key: 'KeyC', trigger: 'hold', holdMs: 400 }] },
      { getGamepads: () => [], tickMs: TICK },
    );
    input.keyDown('KeyC');
    input.update();
    expect(input.state('charge')).toMatchObject({
      held: false,
      pressed: false,
      holdProgress: 0.25,
    });
    input.update();
    input.update();
    expect(input.state('charge')).toMatchObject({ held: false, holdProgress: 0.75 });
    input.update();
    expect(input.state('charge')).toMatchObject({ pressed: true, held: true, holdProgress: 1 });
    input.update();
    expect(input.state('charge')).toMatchObject({ pressed: false, held: true, heldTicks: 2 });
    input.keyUp('KeyC');
    input.update();
    expect(input.state('charge')).toMatchObject({ released: true, held: false, holdProgress: 0 });
  });

  it('a hold let go early never fires; a re-press restarts the count', () => {
    const input = new Input(
      { charge: [{ key: 'KeyC', trigger: 'hold' }] },
      { getGamepads: () => [], tickMs: TICK },
    );
    input.keyDown('KeyC');
    input.update();
    input.update();
    input.keyUp('KeyC');
    input.update();
    expect(input.state('charge')).toMatchObject({ pressed: false, released: false, held: false });
    input.keyDown('KeyC');
    input.update();
    expect(input.state('charge').holdProgress).toBeCloseTo(0.25);
    input.keyUp('KeyC');
    input.keyDown('KeyC');
    input.update();
    expect(input.state('charge').holdProgress).toBeCloseTo(0.25);
  });

  it("'doubleTap' fires for one tick on a second press within doubleTapMs", () => {
    const input = new Input(
      { dash: [{ key: 'KeyD', trigger: 'doubleTap', doubleTapMs: 300 }] },
      { getGamepads: () => [], tickMs: TICK },
    );
    input.keyDown('KeyD');
    input.update();
    input.keyUp('KeyD');
    input.update();
    expect(input.pressed('dash')).toBe(false);
    input.keyDown('KeyD');
    input.update();
    expect(input.state('dash')).toMatchObject({ pressed: true, held: true });
    input.update();
    expect(input.state('dash')).toMatchObject({ pressed: false, held: false, released: true });
    input.keyUp('KeyD');
    // A third press right after does not chain into another double tap.
    input.keyDown('KeyD');
    input.update();
    expect(input.pressed('dash')).toBe(false);
    // Too slow.
    input.keyUp('KeyD');
    for (let i = 0; i < 4; i++) input.update();
    input.keyDown('KeyD');
    input.update();
    expect(input.pressed('dash')).toBe(false);
  });

  it('a chord is active while every member is down, pressed once, in any order', () => {
    const input = new Input(
      {
        combo: [{ chord: [{ key: 'ShiftLeft' }, { key: 'KeyK' }] }],
        k: [{ key: 'KeyK' }],
      },
      { getGamepads: () => [] },
    );
    input.keyDown('KeyK');
    input.update();
    expect(input.held('combo')).toBe(false);
    expect(input.held('k')).toBe(true);
    input.keyDown('ShiftLeft');
    input.update();
    expect(input.state('combo')).toMatchObject({ pressed: true, held: true });
    input.update();
    expect(input.state('combo')).toMatchObject({ pressed: false, held: true });
    input.keyUp('KeyK');
    input.update();
    expect(input.state('combo')).toMatchObject({ released: true, held: false });
    expect(input.released('k')).toBe(true);
  });

  it('blocked zeroes hold progress and does not fire afterwards for a key held through', () => {
    let blocked = false;
    const input = new Input(
      { charge: [{ key: 'KeyC', trigger: 'hold', holdMs: 200 }] },
      { getGamepads: () => [], tickMs: TICK, blocked: () => blocked },
    );
    input.keyDown('KeyC');
    input.update();
    blocked = true;
    input.update();
    expect(input.state('charge')).toMatchObject({ held: false, holdProgress: 0 });
    blocked = false;
    input.update();
    expect(input.state('charge')).toMatchObject({ held: true, pressed: false });
  });
});

describe('Input rebinding (ws/input-3)', () => {
  it('rebind replaces one action and keeps the others; bindings() reports the map', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    input.keyDown('ArrowLeft');
    input.update();
    input.rebind('confirm', [{ key: 'KeyJ' }]);
    expect(input.bindings().confirm).toEqual([{ key: 'KeyJ' }]);
    expect(input.bindings().left).toBe(bindings.left);
    input.update();
    expect(input.state('left')).toMatchObject({ held: true, heldTicks: 2 });
    input.keyDown('Enter');
    input.keyDown('KeyJ');
    input.update();
    expect(input.held('confirm')).toBe(true);
    input.keyUp('KeyJ');
    input.update();
    expect(input.released('confirm')).toBe(true);
    expect(() => input.rebind('nope' as 'confirm', [])).toThrow(/unknown action/);
  });

  it('rebinding a held input lands its release on the old action, not the new one', () => {
    const input = new Input(
      { a: [{ key: 'KeyX' }], b: [{ key: 'KeyY' }] },
      { getGamepads: () => [] },
    );
    input.keyDown('KeyX');
    input.update();
    expect(input.held('a')).toBe(true);
    input.rebind('b', [{ key: 'KeyX' }]);
    input.rebind('a', [{ key: 'KeyZ' }]);
    input.update();
    expect(input.state('a')).toMatchObject({ released: true, held: false });
    expect(input.state('b')).toMatchObject({ pressed: false, held: false });
    input.keyUp('KeyX');
    input.update();
    expect(input.state('b')).toMatchObject({ released: false, held: false });
    input.keyDown('KeyX');
    input.update();
    expect(input.state('b')).toMatchObject({ pressed: true, held: true });
  });

  it('listen resolves with the next key, swallowing it; Escape cancels; timeout cancels', async () => {
    const input = new Input(bindings, { getGamepads: () => [], tickMs: 100 });
    const p = input.listen('confirm');
    expect(input.listening).toBe('confirm');
    input.keyDown('KeyJ');
    input.update();
    await expect(p).resolves.toEqual({ key: 'KeyJ' });
    expect(input.listening).toBeNull();
    expect(input.anyPressed()).toBe(false);
    input.keyUp('KeyJ');

    const esc = input.listen('confirm');
    input.keyDown('Escape');
    await expect(esc).resolves.toBeNull();

    const late = input.listen('confirm', { timeoutMs: 250 });
    input.update();
    input.update();
    input.update();
    expect(input.listening).toBe('confirm');
    input.update();
    await expect(late).resolves.toBeNull();

    const mouse = input.listen('click');
    input.buttonDown(2);
    await expect(mouse).resolves.toEqual({ mouse: 2 });
    expect(input.held('click')).toBe(false);
  });

  it('listen takes a pad button that was up when it began, and a newer listen cancels the older', async () => {
    let pads: GamepadLike[] = [pad([0])];
    const input = new Input(bindings, { getGamepads: () => pads });
    input.update();
    const first = input.listen('confirm');
    const second = input.listen('left');
    await expect(first).resolves.toBeNull();
    input.update();
    expect(input.listening).toBe('left');
    pads = [pad([0, 3])];
    input.update();
    await expect(second).resolves.toEqual({ padButton: 3 });
    expect(input.lastDevice).toBe('gamepad');
  });
});

describe('Input rumble (ws/input-3)', () => {
  function rumblePad(): GamepadLike & { effects: unknown[] } {
    const effects: unknown[] = [];
    return {
      connected: true,
      buttons: [],
      axes: [],
      effects,
      vibrationActuator: {
        type: 'dual-rumble',
        playEffect(type, params) {
          effects.push([type, params]);
          return Promise.resolve('complete');
        },
      },
    };
  }

  it('plays a dual-rumble effect on the first pad that can, reporting support', () => {
    const plain = pad();
    const p = rumblePad();
    const input = new Input(bindings, { getGamepads: () => [plain, p] });
    expect(input.rumbleSupported()).toBe(false);
    input.update();
    expect(input.rumbleSupported()).toBe(true);
    expect(input.rumbleSupported(0)).toBe(false);
    expect(input.rumbleSupported(1)).toBe(true);
    const seen: unknown[] = [];
    input.on('rumble', (r) => seen.push(r));
    expect(input.rumble({ strong: 0.5, weak: 2, ms: 120 })).toBe(true);
    expect(p.effects).toEqual([
      ['dual-rumble', { duration: 120, startDelay: 0, strongMagnitude: 0.5, weakMagnitude: 1 }],
    ]);
    expect(input.rumble({ pad: 0 })).toBe(false);
    expect(input.rumble({ pad: 1 })).toBe(true);
    expect(p.effects[1]).toEqual([
      'dual-rumble',
      { duration: 100, startDelay: 0, strongMagnitude: 1, weakMagnitude: 1 },
    ]);
    expect(seen).toHaveLength(3);
  });

  it('is a no-op without pads or when the actuator throws', () => {
    const input = new Input(bindings, { getGamepads: () => [] });
    expect(input.rumble()).toBe(false);
    const broken: GamepadLike = {
      connected: true,
      buttons: [],
      axes: [],
      vibrationActuator: {
        playEffect() {
          throw new Error('nope');
        },
      },
    };
    const i2 = new Input(bindings, { getGamepads: () => [broken] });
    i2.update();
    expect(i2.rumble()).toBe(false);
  });
});
