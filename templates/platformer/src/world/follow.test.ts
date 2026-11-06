import { describe, expect, it } from 'vitest';
import { createFollow, type FollowOptions, snapFollow, updateFollow } from './follow';

const o: FollowOptions = {
  viewW: 1920,
  viewH: 1080,
  worldW: 8000,
  worldH: 2000,
  deadX: 120,
  deadY: 80,
  lookAhead: 300,
  lookAheadTime: 0.25,
  smoothY: 0,
};

describe('updateFollow', () => {
  it('stays put while the target is inside the dead zone', () => {
    const f = createFollow(2000, 1000);
    updateFollow(f, 2050, 1030, 0, 1 / 60, o);
    expect(f.x).toBe(2000);
    expect(f.y).toBe(1000);
  });

  it('follows once the target leaves the dead zone', () => {
    const f = createFollow(2000, 1000);
    updateFollow(f, 2400, 1000, 0, 1 / 60, o);
    expect(f.x).toBeCloseTo(2400 - o.deadX);
    updateFollow(f, 2400, 1300, 0, 1 / 60, o);
    expect(f.y).toBeCloseTo(1300 - o.deadY);
  });

  it('leads in the facing direction and settles at the look-ahead distance', () => {
    const f = createFollow(2000, 1000);
    for (let i = 0; i < 300; i++) updateFollow(f, 2000, 1000, 1, 1 / 60, o);
    expect(f.lead).toBeCloseTo(o.lookAhead, 1);
    expect(f.x).toBeCloseTo(2000 + o.lookAhead - o.deadX, 1);
    // Turn around: the lead eases the other way and the view follows.
    for (let i = 0; i < 300; i++) updateFollow(f, 2000, 1000, -1, 1 / 60, o);
    expect(f.lead).toBeCloseTo(-o.lookAhead, 1);
    expect(f.x).toBeCloseTo(2000 - o.lookAhead + o.deadX, 1);
  });

  it('look-ahead eases rather than snaps', () => {
    const f = createFollow(2000, 1000);
    updateFollow(f, 2000, 1000, 1, 1 / 60, o);
    expect(f.lead).toBeGreaterThan(0);
    expect(f.lead).toBeLessThan(o.lookAhead * 0.2);
  });

  it('clamps to the world so the view never leaves it', () => {
    const f = createFollow(2000, 1000);
    for (let i = 0; i < 60; i++) updateFollow(f, 100, 100, -1, 1 / 60, o);
    expect(f.x).toBe(o.viewW / 2);
    expect(f.y).toBe(o.viewH / 2);
    for (let i = 0; i < 60; i++) updateFollow(f, 7990, 1990, 1, 1 / 60, o);
    expect(f.x).toBe(o.worldW - o.viewW / 2);
    expect(f.y).toBe(o.worldH - o.viewH / 2);
  });

  it('centres a world smaller than the view', () => {
    const f = createFollow(0, 0);
    snapFollow(f, 300, 300, { ...o, worldW: 1000, worldH: 500 });
    expect(f.x).toBe(500);
    expect(f.y).toBe(250);
  });

  it('snap drops the lead', () => {
    const f = createFollow(2000, 1000);
    for (let i = 0; i < 60; i++) updateFollow(f, 2000, 1000, 1, 1 / 60, o);
    snapFollow(f, 3000, 1000, o);
    expect(f.lead).toBe(0);
    expect(f.x).toBe(3000);
  });
});
