/**
 * Sticks and buttons into moves (ws/xr-merge; ported from Forge Wilds' xr-scheme test, its game
 * actions left out): the walk past the dead zone, snap and smooth turns, flicks, button edges,
 * and the head-relative walk.
 */
import { describe, expect, it } from 'vitest';
import { headRelative, headYawOf, XR_BUTTON, type XrPad, XrSticks } from './sticks';

/** A pad with `buttons` pressed and its stick at (x, y): y negative is forward (xr-standard). */
function pad(x = 0, y = 0, buttons: number[] = []): XrPad {
  const b = [0, 1, 2, 3, 4, 5].map((i) => ({ pressed: buttons.includes(i) }));
  return { buttons: b, axes: [0, 0, x, y] };
}

const DT = 1 / 72;
const DEG = Math.PI / 180;

describe('XrSticks', () => {
  it("the move hand walks past the dead zone; a resting thumb's drift doesn't", () => {
    const s = new XrSticks();
    s.frame(pad(0.05, -0.1), pad(), DT);
    expect([...s.move]).toEqual([0, 0]);
    s.frame(pad(0, -1), pad(), DT);
    expect([...s.move]).toEqual([0, 1]);
    s.frame(pad(1, 0), pad(), DT);
    expect(s.move[0]).toBe(1);
    expect(s.move[1]).toBeCloseTo(0, 12);
    s.frame(pad(0, -0.575), pad(), DT);
    expect(s.move[1]).toBeGreaterThan(0.45);
    expect(s.move[1]).toBeLessThan(0.55);
    s.frame(null, pad(), DT);
    expect([...s.move]).toEqual([0, 0]);
  });

  it('snaps once a push (re-armed at rest); smooth turns by the second', () => {
    const s = new XrSticks();
    let turned = 0;
    let snaps = 0;
    for (let i = 0; i < 20; i++) {
      s.frame(pad(), pad(0.9, 0), DT);
      turned += s.turn;
      if (s.snapped) snaps++;
    }
    expect(turned).toBeCloseTo(30 * DEG, 9);
    expect(snaps).toBe(1);
    s.frame(pad(), pad(0.1, 0), DT);
    expect(s.turn).toBe(0);
    s.frame(pad(), pad(-0.9, 0), DT);
    expect(s.turn).toBeCloseTo(-30 * DEG, 9);
    s.frame(pad(), pad(), DT);
    s.frame(pad(), pad(0.5, 0), DT);
    expect(s.turn).toBe(0);
    s.turnMode = 'smooth';
    s.smoothDegS = 90;
    s.frame(pad(), pad(1, 0), 0.5);
    expect(s.turn).toBeCloseTo(45 * DEG, 9);
    expect(s.snapped).toBe(false);
    s.turnMode = 'snap';
    s.snapDeg = 45;
    s.frame(pad(), pad(), DT);
    s.frame(pad(), pad(1, 0), DT);
    expect(s.turn).toBeCloseTo(45 * DEG, 9);
  });

  it('flicks up once (next), down once (previous); the larger axis is the one meant', () => {
    const s = new XrSticks();
    let steps = 0;
    for (let i = 0; i < 10; i++) {
      s.frame(pad(), pad(0, -0.9), DT);
      steps += s.flick;
    }
    expect(steps).toBe(1);
    s.frame(pad(), pad(), DT);
    s.frame(pad(), pad(0, -0.9), DT);
    expect(s.flick).toBe(1);
    s.frame(pad(), pad(), DT);
    steps = 0;
    for (let i = 0; i < 10; i++) {
      s.frame(pad(), pad(0, 0.9), DT);
      steps += s.flick;
    }
    expect(steps).toBe(-1);
    s.frame(pad(), pad(), DT);
    s.frame(pad(), pad(0.9, 0.65), DT);
    expect(s.turn).toBeGreaterThan(0);
    expect(s.flick).toBe(0);
  });

  it('button edges per hand, and any', () => {
    const s = new XrSticks();
    s.frame(pad(0, 0, [XR_BUTTON.primary]), pad(), DT);
    expect(s.pressed('left', 'primary')).toBe(true);
    expect(s.held('left', 'primary')).toBe(true);
    expect(s.pressed('right', 'primary')).toBe(false);
    expect(s.any).toBe(true);
    s.frame(pad(0, 0, [XR_BUTTON.primary]), pad(), DT);
    expect(s.pressed('left', 'primary')).toBe(false);
    expect(s.held('left', 'primary')).toBe(true);
    s.frame(pad(), pad(0, 0, [XR_BUTTON.secondary]), DT);
    expect(s.released('left', 'primary')).toBe(true);
    expect(s.pressed('right', 'secondary')).toBe(true);
    s.frame(pad(), pad(), DT);
    expect(s.any).toBe(false);
    // A controller put down with a button held lets go.
    s.frame(pad(), pad(0, 0, [XR_BUTTON.grip]), DT);
    s.frame(pad(), null, DT);
    expect(s.released('right', 'grip')).toBe(true);
  });

  it('the move hand can be the right: the sticks swap', () => {
    const s = new XrSticks({ moveHand: 'right' });
    s.frame(pad(0.9, 0), pad(0, -1), DT);
    expect([...s.move]).toEqual([0, 1]);
    expect(s.turn).toBeCloseTo(30 * DEG, 9);
  });
});

describe('head-relative', () => {
  it('forward at yaw 0 is -z; turned right 90° it is +x', () => {
    const out: [number, number] = [0, 0];
    headRelative([0, 1], 0, out);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(-1, 12);
    headRelative([0, 1], Math.PI / 2, out);
    expect(out[0]).toBeCloseTo(1, 12);
    expect(out[1]).toBeCloseTo(0, 12);
    headRelative([1, 0], Math.PI / 2, out);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(1, 12);
  });

  it("headYawOf reads a pitched head's yaw; straight down keeps the last", () => {
    for (const yaw of [0, 0.7, -1.2, 2.5]) {
      // Yaw right is a rotation of -yaw about +y, then a pitch about the head's x.
      const qy = [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)];
      const p = 0.3;
      const qx = [Math.sin(p / 2), 0, 0, Math.cos(p / 2)];
      expect(headYawOf(mul(qy, qx))).toBeCloseTo(yaw, 6);
    }
    const down = [Math.sin(-Math.PI / 4), 0, 0, Math.cos(-Math.PI / 4)];
    expect(headYawOf(down, 0.4)).toBe(0.4);
  });
});

function mul(a: number[], b: number[]): number[] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
