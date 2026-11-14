/**
 * The turn about the head (ws/xr-merge; ported from Forge Wilds' xr-pivot test): the drawn eye is
 * carried so a head away from the body's place stays put through a snap turn, and the turn is
 * about the body where the game's blocked test refuses the carry or it's too far.
 */
import { describe, expect, it } from 'vitest';
import { type BodyBox, cellBoxBlocked, HeadPivot, PIVOT_MAX, type SolidAt } from './pivot';

const BOX: BodyBox = { half: 0.3, height: 1.8, eye: 1.62 };
const ground: SolidAt = (_x, y) => y < 64;
const EYE = [0.5, 64 + 1.62, 0.5];
const DEG = Math.PI / 180;
const on = (solid: SolidAt) => (x: number, y: number, z: number) =>
  cellBoxBlocked(x, y, z, BOX, solid);

function headAt(p: HeadPivot, yaw: number, hx: number, hz: number): [number, number] {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  return [
    EYE[0]! + p.offset[0] + (hx * -fz - hz * fx),
    EYE[2]! + p.offset[1] + (hx * fx - hz * fz),
  ];
}

describe('HeadPivot', () => {
  it('a snap turn with the head away from the body keeps the head where it was', () => {
    const p = new HeadPivot();
    const hx = 0.3;
    const hz = -0.2;
    let yaw = 0.4;
    for (const turn of [30, 30, -30, 45, 30]) {
      const was = headAt(p, yaw, hx, hz);
      const after = yaw - turn * DEG;
      expect(p.turn(EYE, yaw, after, hx, hz, on(ground))).toBe(true);
      yaw = after;
      const now = headAt(p, yaw, hx, hz);
      expect(Math.hypot(now[0] - was[0], now[1] - was[1])).toBeLessThan(1e-9);
    }
    expect(p.turns).toBe(5);
    expect(p.fallbacks).toBe(0);
  });

  it("a head at the body's place: nothing carried", () => {
    const p = new HeadPivot();
    p.turn(EYE, 0, -30 * DEG, 0, 0, on(ground));
    expect(Math.abs(p.offset[0]) + Math.abs(p.offset[1])).toBe(0);
  });

  it('a carry the blocked test refuses turns about the body instead', () => {
    const wall: SolidAt = (x, y) => y < 64 || x >= 1;
    const p = new HeadPivot();
    const left = new HeadPivot();
    left.turn(EYE, 0, 90 * DEG, 0, -0.5, on(ground));
    const towardWall = left.offset[0] > 0 ? 90 * DEG : -90 * DEG;
    expect(p.turn(EYE, 0, towardWall, 0, -0.5, on(wall))).toBe(false);
    expect(p.offset).toEqual([0, 0]);
    expect(p.fallbacks).toBe(1);
    expect(p.turn(EYE, 0, -towardWall, 0, -0.5, on(wall))).toBe(true);
    expect(p.offset[0]).toBeLessThan(0);
  });

  it('a carry further than PIVOT_MAX turns about the body; no test at all is allowed', () => {
    const p = new HeadPivot();
    expect(p.turn(EYE, 0, Math.PI, 0.6, 0)).toBe(false);
    expect(p.fallbacks).toBe(1);
    expect(1.2).toBeGreaterThan(PIVOT_MAX);
    expect(p.turn(EYE, 0, 30 * DEG, 0.6, 0)).toBe(true);
  });

  it('a body walked into a wall with a carry: the carry is dropped', () => {
    const p = new HeadPivot();
    p.turn(EYE, 0, -30 * DEG, 0.4, 0, on(ground));
    expect(p.offset).not.toEqual([0, 0]);
    p.check(EYE, on(ground));
    expect(p.drops).toBe(0);
    p.check(
      EYE,
      on(() => true),
    );
    expect(p.drops).toBe(1);
    expect(p.offset).toEqual([0, 0]);
  });

  it("cellBoxBlocked: on the ground and flush with a wall isn't in a cell; a lintel at the head is", () => {
    expect(cellBoxBlocked(0.5, 64 + 1.62, 0.5, BOX, ground)).toBe(false);
    const wall: SolidAt = (x, y) => y < 64 || x >= 1;
    expect(cellBoxBlocked(0.7, 64 + 1.62, 0.5, BOX, wall)).toBe(false);
    expect(cellBoxBlocked(0.75, 64 + 1.62, 0.5, BOX, wall)).toBe(true);
    const lintel: SolidAt = (_x, y) => y < 64 || y === 65;
    expect(cellBoxBlocked(0.5, 64 + 1.62, 0.5, BOX, lintel)).toBe(true);
  });
});
