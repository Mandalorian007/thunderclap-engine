import { describe, expect, it } from 'vitest';
import { Input, shapeStick } from './input';
import type { Binding, GamepadLike } from './types';

function pad(axes: number[]): GamepadLike {
  return { connected: true, buttons: [], axes };
}

describe('action contexts (ws/input-5)', () => {
  const game = () =>
    new Input(
      {
        attack: [{ key: 'KeyJ' }] as Binding[],
        jump: [{ key: 'Space' }] as Binding[],
        confirm: [] as Binding[],
      },
      { getGamepads: () => [] },
    );

  it("a menu with pass 'none' silences attack, 'unbound' lets it through", () => {
    const input = game();
    const seen: (string | null)[] = [];
    input.onContextChange((c) => seen.push(c));
    const pop = input.pushContext('menu', {
      bindings: { confirm: [{ key: 'Enter' }] },
      pass: 'none',
    });
    expect(input.context).toBe('menu');
    input.keyDown('KeyJ');
    input.update();
    expect(input.pressed('attack')).toBe(false);
    input.keyUp('KeyJ');
    input.update();
    pop();
    expect(input.context).toBeNull();
    input.pushContext('menu', { bindings: { confirm: [{ key: 'Enter' }] } });
    input.keyDown('KeyJ');
    input.keyDown('Enter');
    input.update();
    expect(input.pressed('attack')).toBe(true);
    expect(input.pressed('confirm')).toBe(true);
    expect(seen).toEqual(['menu', null, 'menu']);
  });

  it("'all' overlays the context's bindings on the ones below", () => {
    const input = game();
    input.pushContext('vehicle', { bindings: { jump: [{ key: 'KeyH' }] }, pass: 'all' });
    expect(input.bindings().jump).toEqual([{ key: 'KeyH' }, { key: 'Space' }]);
    input.keyDown('Space');
    input.update();
    expect(input.pressed('jump')).toBe(true);
  });

  it('a key held through a push does not fire pressed in the new context', () => {
    const input = game();
    input.keyDown('Space');
    input.update();
    expect(input.pressed('jump')).toBe(true);
    // The menu binds Space to confirm and takes jump away.
    input.pushContext('menu', { bindings: { confirm: [{ key: 'Space' }] }, pass: 'none' });
    input.update();
    expect(input.pressed('confirm')).toBe(false);
    expect(input.held('confirm')).toBe(false);
    expect(input.released('jump')).toBe(true);
    input.keyUp('Space');
    input.update();
    input.keyDown('Space');
    input.update();
    expect(input.pressed('confirm')).toBe(true);
  });

  it('a change resets hold progress only for the actions whose bindings changed', () => {
    const input = new Input(
      {
        charge: [{ key: 'KeyC', trigger: 'hold', holdMs: 100 }] as Binding[],
        walk: [{ key: 'KeyW' }] as Binding[],
      },
      { getGamepads: () => [] },
    );
    input.keyDown('KeyC');
    input.keyDown('KeyW');
    for (let i = 0; i < 3; i++) input.update();
    expect(input.state('charge').holdProgress).toBeGreaterThan(0);
    input.pushContext('aim', {
      bindings: { charge: [{ key: 'KeyC', trigger: 'hold', holdMs: 100 }] },
    });
    input.update();
    expect(input.state('charge').holdProgress).toBe(0);
    expect(input.held('walk')).toBe(true);
    expect(input.pressed('walk')).toBe(false);
  });

  it('popping restores the old binding and glyph; rebind and bindings act on the top context', () => {
    const input = game();
    expect(input.glyphFor('jump', 'keyboard')?.label).toBe('Space');
    input.pushContext('swim', { bindings: { jump: [{ key: 'KeyE' }] } });
    expect(input.glyphFor('jump', 'keyboard')?.label).toBe('E');
    input.rebind('jump', [{ key: 'KeyR' }]);
    expect(input.bindings().jump).toEqual([{ key: 'KeyR' }]);
    expect(input.bindings(null).jump).toEqual([{ key: 'Space' }]);
    input.rebind('jump', [{ key: 'KeyB' }], null);
    expect(input.bindings().jump).toEqual([{ key: 'KeyR' }]);
    expect(input.popContext('swim')).toBe(true);
    expect(input.popContext('swim')).toBe(false);
    expect(input.glyphFor('jump', 'keyboard')?.label).toBe('B');
    input.keyDown('KeyB');
    input.update();
    expect(input.pressed('jump')).toBe(true);
  });

  it('pushing a name again moves it to the top; a remover removes only its own push', () => {
    const input = game();
    const a = input.pushContext('a');
    input.pushContext('b');
    input.pushContext('a', { pass: 'none' });
    expect(input.contexts).toEqual(['b', 'a']);
    a();
    expect(input.contexts).toEqual(['b', 'a']);
    // The deprecated reader is a copy of the same names.
    expect(input.contextStack()).toEqual(['b', 'a']);
    expect(input.contextStack()).not.toBe(input.contexts);
  });

  it('a context can add an action the base map lacks (ws/api-core)', () => {
    const input = new Input<string>({ jump: [{ key: 'Space' }] }, { getGamepads: () => [] });
    expect(input.bindings().back).toBeUndefined();
    const pop = input.pushContext('menu', { bindings: { back: [{ key: 'Escape' }] } });
    input.keyDown('Escape');
    input.update();
    expect(input.pressed('back')).toBe(true);
    expect(input.bindings().back).toEqual([{ key: 'Escape' }]);
    expect(input.bindings(null).back).toBeUndefined();
    input.keyUp('Escape');
    input.update();
    pop();
    // Popped, it stays a known action bound to nothing.
    input.keyDown('Escape');
    input.update();
    expect(input.pressed('back')).toBe(false);
    expect(input.bindings().back).toEqual([]);
    // A base rebuild keeps it while the context is on the stack.
    input.pushContext('menu', { bindings: { back: [{ key: 'Escape' }] } });
    input.setBindings({ jump: [{ key: 'KeyJ' }] });
    expect(input.bindings().back).toEqual([{ key: 'Escape' }]);
    expect(input.listening).toBeNull();
    expect(input.gestures).toBeNull();
    expect(input.pointers).toBeNull();
    expect(input.look).toBeNull();
  });
});

describe('input buffer (ws/input-5)', () => {
  const make = () =>
    new Input({ jump: [{ key: 'Space' }] as Binding[] }, { getGamepads: () => [] });
  const tap = (input: Input<'jump'>) => {
    input.keyDown('Space');
    input.update();
    input.keyUp('Space');
  };

  it('a press 3 ticks before buffered(a, 100) at 60 Hz is true, 7 ticks false', () => {
    const input = make();
    tap(input);
    expect(input.buffered('jump', 100)).toBe(true);
    for (let i = 0; i < 3; i++) input.update();
    expect(input.buffered('jump', 100)).toBe(true);
    for (let i = 0; i < 3; i++) input.update();
    // 6 ticks: ceil(100 / 16.7) = 6, still in.
    expect(input.buffered('jump', 100)).toBe(true);
    input.update();
    expect(input.buffered('jump', 100)).toBe(false);
  });

  it('a consumed press is not returned twice and clears pressed for the tick', () => {
    const input = make();
    tap(input);
    expect(input.pressed('jump')).toBe(true);
    expect(input.consume('jump')).toBe(true);
    expect(input.pressed('jump')).toBe(false);
    expect(input.buffered('jump', 100)).toBe(false);
    expect(input.consume('jump')).toBe(false);
    input.update();
    expect(input.buffered('jump', 100)).toBe(false);
    tap(input);
    expect(input.buffered('jump', 100)).toBe(true);
  });

  it('blocked presses do not buffer; a context change drops the buffered press', () => {
    let blocked = true;
    const input = new Input(
      { jump: [{ key: 'Space' }] as Binding[] },
      { getGamepads: () => [], blocked: () => blocked },
    );
    tap(input);
    expect(input.buffered('jump', 100)).toBe(false);
    blocked = false;
    input.update();
    tap(input);
    expect(input.buffered('jump', 100)).toBe(true);
    input.pushContext('menu', { pass: 'none' });
    expect(input.buffered('jump', 100)).toBe(false);
  });
});

describe('stick read (ws/input-5)', () => {
  const out: [number, number] = [0, 0];

  it('scaledRadial rescales past the deadzone and is continuous at its edge', () => {
    expect(shapeStick(0.1, 0, out)).toEqual([0, 0]);
    expect(shapeStick(1, 0, out)[0]).toBeCloseTo(1);
    expect(shapeStick(0.575, 0, out)[0]).toBeCloseTo(0.5);
    expect(shapeStick(0.15, 0, out)[0]).toBe(0);
    expect(shapeStick(0.15 + 1e-9, 0, out)[0]).toBeLessThan(1e-6);
    expect(shapeStick(0.15 + 1e-9, 0, out)[0]).toBeGreaterThan(0);
  });

  it('radial passes the value through past the deadzone; axial deadzones each axis', () => {
    expect(shapeStick(0.1, 0.1, out, { shape: 'radial' })).toEqual([0, 0]);
    const r = shapeStick(0.3, 0.4, out, { shape: 'radial' });
    expect(r[0]).toBeCloseTo(0.3);
    expect(r[1]).toBeCloseTo(0.4);
    // Radial would let this diagonal through; axial snaps it to the x axis.
    expect(shapeStick(0.9, 0.1, out, { shape: 'axial' })).toEqual([0.9, 0]);
    const [x, y] = shapeStick(1, 1, out, { shape: 'axial' });
    expect(Math.hypot(x, y)).toBeCloseTo(1);
  });

  it('curve and clamp', () => {
    expect(shapeStick(0.5, 0, out, { shape: 'radial', curve: 2 })[0]).toBeCloseTo(0.25);
    expect(shapeStick(-0.5, 0, out, { shape: 'axial', curve: 2, deadzone: 0 })[0]).toBeCloseTo(
      -0.25,
    );
    expect(shapeStick(0.575, 0, out, { curve: 2 })[0]).toBeCloseTo(0.25);
    expect(shapeStick(2, 0, out, { shape: 'radial', clamp: false })[0]).toBe(2);
    expect(shapeStick(2, 0, out, { shape: 'radial' })[0]).toBe(1);
  });

  it('diagonal keys read length 1; pad axes and stickAngle', () => {
    let axes = [0, 0];
    const input = new Input(
      {
        left: [{ key: 'KeyA' }, { padAxis: 0, dir: -1, threshold: 0 }] as Binding[],
        right: [{ key: 'KeyD' }, { padAxis: 0, dir: 1, threshold: 0 }] as Binding[],
        down: [{ key: 'KeyS' }, { padAxis: 1, dir: -1, threshold: 0 }] as Binding[],
        up: [{ key: 'KeyW' }, { padAxis: 1, dir: 1, threshold: 0 }] as Binding[],
      },
      { getGamepads: () => [pad(axes)] },
    );
    input.keyDown('KeyD');
    input.keyDown('KeyW');
    input.update();
    const o = input.stick('left', 'right', 'down', 'up', out);
    expect(o).toBe(out);
    expect(Math.hypot(o[0], o[1])).toBeCloseTo(1);
    expect(input.stickAngle(o)).toBeCloseTo(Math.PI / 4);
    input.keyUp('KeyD');
    input.keyUp('KeyW');
    axes = [0.05, 0];
    input.update();
    input.stick('left', 'right', 'down', 'up', out);
    expect(input.stickAngle(out)).toBeNull();
    axes = [-0.575, 0];
    input.update();
    input.stick('left', 'right', 'down', 'up', out);
    expect(out[0]).toBeCloseTo(-0.5);
    expect(input.stickAngle(out)).toBeCloseTo(Math.PI);
  });
});
