import { describe, expect, it } from 'vitest';
import { Input } from './input';
import { Look, type LookOptions, PAD_ZOOM_PER_S } from './look';
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

  it("zoom.pad 'rightStickY' turns the right stick's vertical into zoom and out of look.dy", () => {
    const { look, tick, setPads } = setup({ padDeadzone: 0, zoom: { pad: 'rightStickY' } });
    tick();
    setPads([pad([0, 0, 0, -1])]); // stick up
    tick(100);
    expect(look.zoom).toBeCloseTo(PAD_ZOOM_PER_S * 0.1);
    expect(look.look.dy).toBe(0);
    setPads([pad([0, 0, 0.5, 0.5])]);
    tick(100);
    expect(look.zoom).toBeCloseTo(-0.5 * PAD_ZOOM_PER_S * 0.1);
    expect(look.look.dx).toBeCloseTo(0.5 * 3 * 0.1);
  });

  it("zoom.pad 'shoulders' reads buttons 4 and 5 as -1 and +1 per tick; 'none' reads nothing", () => {
    const { look, tick, setPads } = setup({ zoom: { pad: 'shoulders' } });
    const buttons = [0, 0, 0, 0, 0, 0].map(() => ({ pressed: false, value: 0 }));
    setPads([{ axes: [0, 0, 0, -1], buttons }]);
    tick();
    expect(look.zoom).toBe(0);
    // The stick still looks in this mode.
    tick(100);
    expect(look.look.dy).toBeCloseTo(0.3);
    buttons[5]!.pressed = true;
    tick();
    expect(look.zoom).toBe(1);
    buttons[4]!.pressed = true;
    tick();
    expect(look.zoom).toBe(0);
    buttons[5]!.pressed = false;
    tick();
    expect(look.zoom).toBe(-1);
    look.zoomPad = 'none';
    tick();
    expect(look.zoom).toBe(0);
  });

  it('wheel() feeds notches; sources sum and reset each tick', () => {
    const { look, tick } = setup();
    look.wheel(2);
    look.wheel(-0.5);
    tick();
    expect(look.zoom).toBe(1.5);
    tick();
    expect(look.zoom).toBe(0);
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
    expect(input.look).toBeNull();
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
    look.wheel(3);
    blocked = true;
    input.update();
    expect(look.look).toEqual({ dx: 0, dy: 0 });
    expect(look.zoom).toBe(0);
    expect(look.move).toEqual({ x: 0, y: 0 });
    look.mouseMove(50, 0);
    look.wheel(3);
    look.touchDown(3, 0, 0, true);
    blocked = false;
    // The old fingers no longer count; the pad still does.
    look.touchMove(1, 0, -100);
    look.touchMove(3, 0, -100);
    input.update();
    expect(look.stick.active).toBe(false);
    expect(look.move.x).toBeCloseTo(1);
    expect(look.zoom).toBe(0);
    expect(look.move.y).toBeCloseTo(0);
  });
});

describe('Look: orbit mode (ws/input-3)', () => {
  it('a drag turns the view at the mouse sensitivity; nothing without a drag', () => {
    const { look, tick } = setup({ mode: 'orbit', sensitivity: 0.01 });
    expect(look.mode).toBe('orbit');
    look.orbitMove(50, 50);
    tick();
    expect(look.look).toEqual({ dx: 0, dy: 0 });
    look.orbitDown(100, 100);
    look.orbitMove(110, 96);
    look.orbitMove(115, 96);
    tick();
    expect(look.orbiting).toBe(true);
    expect(look.look.dx).toBeCloseTo(0.15);
    expect(look.look.dy).toBeCloseTo(0.04);
    look.orbitUp();
    look.orbitMove(200, 200);
    tick();
    expect(look.orbiting).toBe(false);
    expect(look.look).toEqual({ dx: 0, dy: 0 });
  });

  it('honours sensitivity and invertY like the locked mouse', () => {
    const { look, tick } = setup({ mode: 'orbit', sensitivity: 0.02, invertY: true });
    look.orbitDown(0, 0);
    look.orbitMove(10, -4);
    tick();
    expect(look.look.dx).toBeCloseTo(0.2);
    expect(look.look.dy).toBeCloseTo(-0.08);
  });

  it('orbit feeds are ignored in locked mode; setMode mid-drag ends the drag', () => {
    const { look, tick } = setup({ sensitivity: 0.01 });
    look.orbitDown(0, 0);
    look.orbitMove(10, 0);
    tick();
    expect(look.orbiting).toBe(false);
    expect(look.look.dx).toBe(0);
    look.setMode('orbit');
    look.orbitDown(0, 0);
    look.orbitMove(10, 0);
    look.setMode('locked');
    look.orbitMove(20, 0);
    tick();
    expect(look.orbiting).toBe(false);
    // The movement before the switch still counts; the one after does not.
    expect(look.look.dx).toBeCloseTo(0.1);
    look.setMode('orbit');
    expect(look.mode).toBe('orbit');
  });

  it('blocked zeroes an orbit drag and ignores its movement', () => {
    let blocked = false;
    const { look, tick } = setup({ mode: 'orbit', sensitivity: 0.01, blocked: () => blocked });
    look.orbitDown(0, 0);
    look.orbitMove(10, 0);
    blocked = true;
    look.orbitMove(20, 0);
    tick();
    expect(look.look).toEqual({ dx: 0, dy: 0 });
    blocked = false;
    look.orbitMove(30, 0);
    tick();
    expect(look.look.dx).toBeCloseTo(0.1);
    expect(look.claimsPointer('mouse')).toBe(true);
    expect(look.claimsPointer('pen')).toBe(true);
    expect(look.claimsPointer('touch')).toBe(false);
  });

  it('wheel zoom and touch look still work in orbit mode', () => {
    const { look, tick } = setup({ mode: 'orbit', touch: { sensitivity: 0.01 } });
    look.wheel(2);
    look.touchDown(1, 600, 200, false);
    look.touchMove(1, 630, 200);
    tick();
    expect(look.zoom).toBe(2);
    expect(look.look.dx).toBeCloseTo(0.3);
  });
});

describe('Input drives the orbit drag (ws/input-3)', () => {
  it('a mouse press, moves and release on the linked input turn the view', () => {
    const look = new Look({ mode: 'orbit', sensitivity: 0.01, getGamepads: () => [] });
    const input = new Input({}, { look, getGamepads: () => [] });
    input.pointerAt(100, 100, 'mouse');
    input.pointerAt(120, 100, 'mouse');
    input.update();
    expect(look.look.dx).toBe(0);
    input.buttonDown(0);
    input.pointerAt(130, 90, 'mouse');
    input.update();
    expect(look.look.dx).toBeCloseTo(0.1);
    expect(look.look.dy).toBeCloseTo(0.1);
    input.buttonUp(0);
    input.pointerAt(200, 90, 'mouse');
    input.update();
    expect(look.look.dx).toBe(0);
    // A touch contact never orbits (the touch look zone handles it).
    input.pointerAt(100, 100, 'touch');
    input.buttonDown(0);
    input.pointerAt(150, 100, 'touch');
    input.update();
    expect(look.orbiting).toBe(false);
    expect(look.look.dx).toBe(0);
  });
});
