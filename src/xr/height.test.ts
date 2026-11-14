/**
 * Seated or standing (ws/xr-merge; ported from Forge Wilds' xr-height test): "match the avatar"
 * measures the head at the first sane pose and takes it off every pose's height, so a seated
 * (1.0 m) or tall (1.8 m) player's eye is the character's, and moving from there stays real.
 */
import { describe, expect, it } from 'vitest';
import { HEAD_MAX, HEAD_MIN, HeightCalibration, WAIT_MS } from './height';

const EYE = 1.62;

describe('HeightCalibration', () => {
  it("seated (1.0 m) and tall (1.8 m): the drawn eye is the character's", () => {
    for (const head of [1.0, 1.8, 1.62, 0.6, 2.2]) {
      const h = new HeightCalibration(EYE, 'avatar');
      h.ask('start');
      expect(h.pending).toBe(true);
      h.frame(head, 0);
      expect(h.pending).toBe(false);
      expect(h.offset).toBe(head);
      expect(h.measured).toBe(head);
      expect(h.eyeOverFeet(head)).toBeCloseTo(EYE, 9);
    }
  });

  it('after calibrating, a crouch lowers the eye and standing raises it', () => {
    const h = new HeightCalibration(EYE, 'avatar');
    h.ask('start');
    h.frame(1.0, 0);
    expect(h.eyeOverFeet(0.7)).toBeCloseTo(EYE - 0.3, 9);
    expect(h.eyeOverFeet(1.5)).toBeCloseTo(EYE + 0.5, 9);
    h.frame(0.7, 16);
    expect(h.offset).toBe(1.0);
  });

  it("real height: the head's own height is the eye's; switching modes", () => {
    const h = new HeightCalibration(EYE, 'real');
    h.ask('start');
    expect(h.pending).toBe(false);
    h.frame(1.0, 0);
    expect(h.offset).toBe(EYE);
    expect(h.eyeOverFeet(1.0)).toBeCloseTo(1.0, 9);
    h.setMode('avatar');
    expect(h.pending).toBe(true);
    h.frame(1.1, 20);
    expect(h.offset).toBe(1.1);
    h.setMode('real');
    expect(h.offset).toBe(EYE);
    expect(h.pending).toBe(false);
  });

  it("a head that isn't worn is waited out", () => {
    const h = new HeightCalibration(EYE, 'avatar');
    h.ask('start');
    h.frame(HEAD_MIN - 0.1, 1000);
    h.frame(Number.NaN, 1500);
    h.frame(HEAD_MAX + 0.1, 2000);
    expect(h.pending).toBe(true);
    expect(h.offset).toBe(EYE);
    h.frame(1.3, 1000 + WAIT_MS - 1);
    expect(h.offset).toBe(1.3);
    expect(h.timeouts).toBe(0);

    const g = new HeightCalibration(EYE, 'avatar');
    g.ask('start');
    g.frame(0.1, 5000);
    g.frame(0.1, 5000 + WAIT_MS);
    expect(g.pending).toBe(false);
    expect(g.timeouts).toBe(1);
    expect(g.offset).toBe(EYE);
    expect(g.measured).toBe(null);
    g.frame(1.2, 8000);
    expect(g.offset).toBe(EYE);
  });

  it('recalibrating: measured again; one with no sane head keeps the last', () => {
    const h = new HeightCalibration(EYE, 'avatar');
    h.ask('start');
    h.frame(1.0, 0);
    h.ask('reset');
    expect(h.pending).toBe(true);
    expect(h.offset).toBe(1.0);
    h.frame(1.7, 100);
    expect(h.offset).toBe(1.7);
    h.ask('asked');
    h.frame(0.2, 200);
    h.frame(0.2, 200 + WAIT_MS);
    expect(h.offset).toBe(1.7);
    expect(h.report()).toEqual({
      mode: 'avatar',
      measured: 1.7,
      offset: 1.7,
      calibrations: 2,
      recalibrations: 2,
      timeouts: 1,
      pending: false,
      last: 'asked',
    });
  });
});
