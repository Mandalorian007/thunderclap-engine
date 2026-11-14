// ws/ui-input-fit (Forge's D5b asks): the touch stick's leash and knob, Forge's stick numbers on
// the engine's options, a free mouse's drag to look, and the speed wheel. Defaults unchanged.
import { describe, expect, it } from 'vitest';
import { Input } from './input';
import { Look, type LookOptions } from './look';

function setup(opts: LookOptions = {}) {
  let t = 1000;
  const look = new Look({ now: () => t, getGamepads: () => [], ...opts });
  return {
    look,
    tick(ms = 16) {
      t += ms;
      look.update();
    },
  };
}

describe('the touch stick', () => {
  it('a leash pulls the origin after a thumb dragged past it; the knob stays within the radius', () => {
    const { look, tick } = setup({ touch: { radius: 50, leash: 1.6 } });
    look.touchDown(1, 100, 300, true);
    look.touchMove(1, 100, 260);
    expect(look.stick.knobY).toBe(-40);
    expect(look.stick.originY).toBe(300);
    // 120 px up: the origin follows to 80 px behind the thumb; the knob is at the radius.
    look.touchMove(1, 100, 180);
    expect(look.stick.originY).toBe(260);
    expect(look.stick.knobY).toBe(-50);
    expect(look.stick.y).toBe(210);
    tick();
    expect(look.move.y).toBeCloseTo(1);
    // Turning back is immediate: 40 px down from the moved origin.
    look.touchMove(1, 100, 300);
    tick();
    expect(look.move.y).toBeLessThan(0);
    look.touchUp(1);
    expect([look.stick.knobX, look.stick.knobY]).toEqual([0, 0]);
  });

  it('no leash by default: the origin stays where the thumb landed', () => {
    const { look } = setup({ touch: { radius: 50 } });
    expect(look.leash).toBe(0);
    look.touchDown(1, 100, 300, true);
    look.touchMove(1, 100, 100);
    expect(look.stick.originY).toBe(300);
    expect(look.stick.knobY).toBe(-50);
  });

  it('Forge’s stick on the options: dead 0.18 remapped (d-dead)/(r-dead), sprint at 1.3 inside a 1.6 leash', () => {
    const { look, tick } = setup({
      touch: { radius: 56, deadzone: 0.18, sprintRim: true, leash: 1.6, moveZoneShare: 0.4 },
    });
    const dead = 0.18 * 56;
    look.touchDown(1, 100, 300, true);
    look.touchMove(1, 100 + dead, 300);
    tick();
    expect(look.move.x).toBe(0);
    look.touchMove(1, 100 + 30, 300);
    tick();
    expect(look.move.x).toBeCloseTo((30 - dead) / (56 - dead), 9);
    // Pushed forward 1.3 radii: sprint; on to past the leash: still sprinting, origin following.
    look.touchMove(1, 100, 300 - 1.3 * 56);
    expect(look.sprint).toBe(true);
    look.touchMove(1, 100, 300 - 3 * 56);
    expect(look.sprint).toBe(true);
    expect(look.stick.originY).toBeCloseTo(300 - 1.4 * 56, 9);
  });
});

describe('a free mouse drags to look', () => {
  it('past the slop it turns from where the press began; within it, nothing', () => {
    const { look, tick } = setup({ sensitivity: 0.01, freeDrag: true });
    expect(look.freeDrag).toEqual({ slop: 5 });
    look.orbitDown(100, 100);
    look.orbitMove(103, 102);
    expect(look.orbiting).toBe(false);
    tick();
    expect(look.look.dx).toBe(0);
    look.orbitMove(110, 100);
    expect(look.orbiting).toBe(true);
    tick();
    expect(look.look.dx).toBeCloseTo(0.1);
    look.orbitUp();
    look.orbitMove(200, 100);
    tick();
    expect(look.look.dx).toBe(0);
  });

  it('not while the pointer is locked, and not without `freeDrag` (the default)', () => {
    const off = setup({ sensitivity: 0.01 });
    off.look.orbitDown(100, 100);
    off.look.orbitMove(200, 100);
    off.tick();
    expect(off.look.look.dx).toBe(0);
    const on = setup({ sensitivity: 0.01, freeDrag: { slop: 0 } });
    on.look.locked = true;
    on.look.orbitDown(100, 100);
    on.look.orbitMove(200, 100);
    on.tick();
    expect(on.look.look.dx).toBe(0);
  });

  it('a linked Input’s mouse feeds it (so a recording replays it)', () => {
    const look = new Look({ sensitivity: 0.01, freeDrag: { slop: 2 }, getGamepads: () => [] });
    const input = new Input({}, { look, getGamepads: () => [] });
    input.pointerAt(10, 10);
    input.buttonDown(0);
    input.pointerAt(30, 10);
    input.update();
    expect(look.look.dx).toBeCloseTo(0.2);
    input.buttonUp(0);
  });
});

describe('the speed wheel', () => {
  it('each notch multiplies the speed, clamped; off by default', () => {
    const { look } = setup({ speedWheel: { min: 2, max: 400 }, speed: 10 });
    look.speedStep(1);
    expect(look.speed).toBeCloseTo(11.8);
    look.speedStep(-1);
    expect(look.speed).toBeCloseTo(11.8 * 0.85);
    for (let i = 0; i < 100; i++) look.speedStep(1);
    expect(look.speed).toBe(400);
    for (let i = 0; i < 100; i++) look.speedStep(-1);
    expect(look.speed).toBe(2);
    const plain = setup();
    expect(plain.look.speedWheel).toBe(null);
    plain.look.speedStep(1);
    expect(plain.look.speed).toBe(1);
  });
});
