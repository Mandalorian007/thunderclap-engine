import { describe, expect, it } from 'vitest';
import { Input } from './input';
import { Look, type LookOptions } from './look';
import type { GamepadLike } from './types';

function pad(axes: number[]): GamepadLike {
  return { axes, buttons: [] };
}

/** A Look on a fake clock; `tick(ms)` advances and updates. */
function setup(opts: LookOptions = {}) {
  let t = 1000;
  let pads: (GamepadLike | null)[] = [];
  const look = new Look({ now: () => t, getGamepads: () => pads, ...opts });
  return {
    look,
    setPads(p: (GamepadLike | null)[]) {
      pads = p;
    },
    tick(ms = 16) {
      t += ms;
      look.update();
    },
  };
}

describe('Look: mouse', () => {
  it('scales locked mouse movement by sensitivity; right turns right, up looks up', () => {
    const { look, tick } = setup({ sensitivity: 0.01 });
    look.mouseMove(10, -4);
    look.mouseMove(5, 0);
    tick();
    expect(look.look.dx).toBeCloseTo(0.15);
    expect(look.look.dy).toBeCloseTo(0.04);
    tick();
    expect(look.look).toEqual({ dx: 0, dy: 0 });
  });

  it('invertY flips vertical look', () => {
    const { look, tick } = setup({ sensitivity: 0.01, invertY: true });
    look.mouseMove(0, -4);
    tick();
    expect(look.look.dy).toBeCloseTo(-0.04);
  });
});

describe('Look: touch zones', () => {
  it('a touch in the move zone is a stick: deadzone, clamp to radius, forward is +y', () => {
    const { look, tick } = setup({ touch: { radius: 50, deadzone: 0.2 } });
    look.touchDown(1, 100, 300, true);
    look.touchMove(1, 105, 300); // 0.1 of the radius: inside the deadzone
    tick();
    expect(look.move).toEqual({ x: 0, y: 0 });
    expect(look.stick.active).toBe(true);
    look.touchMove(1, 100, 200); // 100 px up: clamped to 50
    tick();
    expect(look.move.x).toBeCloseTo(0);
    expect(look.move.y).toBeCloseTo(1);
    expect(look.stick).toMatchObject({ originX: 100, originY: 300, x: 100, y: 250 });
    look.touchMove(1, 100 + 30, 300); // 0.6 right → (0.6 - 0.2) / 0.8 = 0.5
    tick();
    expect(look.move.x).toBeCloseTo(0.5);
    // The stick holds while the finger rests.
    tick();
    expect(look.move.x).toBeCloseTo(0.5);
    look.touchUp(1);
    tick();
    expect(look.move).toEqual({ x: 0, y: 0 });
    expect(look.stick.active).toBe(false);
    // A stick never looks.
    expect(look.look).toEqual({ dx: 0, dy: 0 });
  });

  it('a touch outside the zone drags look; both work at once', () => {
    const { look, tick } = setup({ sensitivity: 0.01 });
    look.touchDown(1, 100, 300, true);
    look.touchDown(2, 600, 300, false);
    look.touchMove(2, 620, 290);
    look.touchMove(1, 100, 200);
    tick();
    expect(look.look.dx).toBeCloseTo(0.2);
    expect(look.look.dy).toBeCloseTo(0.1);
    expect(look.move.y).toBeCloseTo(1);
    tick();
    expect(look.look.dx).toBe(0);
    look.touchMove(2, 610, 290);
    tick();
    expect(look.look.dx).toBeCloseTo(-0.1);
  });

  it('a second touch in the move zone looks; touch sensitivity overrides', () => {
    const { look, tick } = setup({ sensitivity: 0.01, touch: { sensitivity: 0.02 } });
    look.touchDown(1, 100, 300, true);
    look.touchDown(2, 120, 300, true);
    look.touchMove(2, 130, 300);
    tick();
    expect(look.look.dx).toBeCloseTo(0.2);
    expect(look.move).toEqual({ x: 0, y: 0 });
  });
});

describe('Look: pad and keys', () => {
  it('left stick moves, right stick looks at padSensitivity · dt', () => {
    const { look, tick, setPads } = setup({ padSensitivity: 2, padDeadzone: 0 });
    tick();
    setPads([null, pad([0.5, -1, 1, -1])]);
    tick(100);
    expect(look.move.x).toBeCloseTo(0.5 / Math.hypot(0.5, 1));
    expect(look.move.y).toBeCloseTo(1 / Math.hypot(0.5, 1));
    // Diagonal right stick past full deflection: clamped to length 1, 2 rad/s × 0.1 s.
    expect(Math.hypot(look.look.dx, look.look.dy)).toBeCloseTo(0.2);
    expect(look.look.dx).toBeGreaterThan(0);
    expect(look.look.dy).toBeGreaterThan(0);
  });

  it('the pad deadzone zeroes small deflection; the first tick has no dt', () => {
    const { look, tick, setPads } = setup({ padDeadzone: 0.2 });
    setPads([pad([0.1, 0.1, 1, 0])]);
    tick();
    expect(look.move).toEqual({ x: 0, y: 0 });
    expect(look.look.dx).toBe(0);
    tick(50);
    expect(look.look.dx).toBeCloseTo(3 * 0.05);
  });

  it('reads move keys through the linked input and normalises diagonals', () => {
    const look = new Look({
      keys: { forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'] },
      getGamepads: () => [],
    });
    const input = new Input({}, { look, getGamepads: () => [] });
    input.keyDown('KeyW');
    input.update();
    expect(look.move).toEqual({ x: 0, y: 1 });
    input.keyDown('KeyD');
    input.update();
    expect(look.move.x).toBeCloseTo(Math.SQRT1_2);
    expect(look.move.y).toBeCloseTo(Math.SQRT1_2);
    input.keyUp('KeyW');
    input.keyUp('KeyD');
    input.keyDown('KeyS');
    input.update();
    expect(look.move).toEqual({ x: 0, y: -1 });
    input.setLook(null);
    expect(look.keyHeld).toBeNull();
    expect(input.getLook()).toBeNull();
  });
});

describe('Look: blocked', () => {
  it('reports zeros while blocked and drops the touches in progress', () => {
    let blocked = false;
    const look = new Look({ sensitivity: 0.01, getGamepads: () => [pad([1, 0, 1, 0])] });
    const input = new Input({}, { look, blocked: () => blocked });
    look.touchDown(1, 0, 0, true);
    look.touchDown(2, 500, 0, false);
    look.touchMove(2, 510, 0);
    blocked = true;
    input.update();
    expect(look.look).toEqual({ dx: 0, dy: 0 });
    expect(look.move).toEqual({ x: 0, y: 0 });
    look.mouseMove(50, 0);
    look.touchDown(3, 0, 0, true);
    blocked = false;
    // The old fingers no longer count; the pad still does.
    look.touchMove(1, 0, -100);
    look.touchMove(3, 0, -100);
    input.update();
    expect(look.stick.active).toBe(false);
    expect(look.move.x).toBeCloseTo(1);
    expect(look.move.y).toBeCloseTo(0);
  });
});
