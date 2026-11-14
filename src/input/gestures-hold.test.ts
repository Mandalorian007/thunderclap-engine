import { describe, expect, it } from 'vitest';
import { inStickZone, StillPress, stickSideHold, stillHold, WheelSteps } from './gestures-hold';

describe('StillPress (ported from Forge play/gestures)', () => {
  it('a still press lifted soon is a tap, held is a hold, moved is a drag', () => {
    const g = new StillPress(stillHold());
    g.begin(100, 100, 0);
    expect(g.end(200)).toBe('tap');

    g.begin(100, 100, 0);
    expect(g.tick(299)).toBe(false);
    expect(g.tick(300)).toBe(true);
    expect(g.kind).toBe('hold');
    expect(g.tick(400)).toBe(false); // only once
    expect(g.end(500)).toBe('hold');

    g.begin(100, 100, 0);
    expect(g.move(115, 100, 50)).toBe('pending');
    expect(g.kind).toBe('drag');
    expect(g.tick(1000)).toBe(false); // a drag never holds
    expect(g.end(1000)).toBe('drag');
  });

  it('wanders inside the tolerance and still taps; a hold that moves stays a hold', () => {
    const g = new StillPress({ tolerancePx: 10, ms: 300 });
    g.begin(0, 0, 0);
    g.move(6, 6, 50);
    expect(g.end(100)).toBe('tap');
    g.begin(0, 0, 0);
    g.tick(300);
    g.move(80, 0, 350);
    expect(g.kind).toBe('hold');
  });

  it('a stalled timer still holds on the late move or lift', () => {
    const g = new StillPress();
    g.begin(0, 0, 0);
    expect(g.move(1, 1, 900)).toBe('pending');
    expect(g.kind).toBe('hold');
    g.begin(0, 0, 0);
    expect(g.end(900)).toBe('hold');
  });

  it('the lift point counts as a move: a flick seen only on lift is a drag', () => {
    const g = new StillPress();
    g.begin(0, 0, 0);
    expect(g.end(60, 120, 0)).toBe('drag');
  });

  it('set changes the hold time from the next press', () => {
    const g = new StillPress();
    g.set({ ms: 500, tolerancePx: 5 });
    g.begin(0, 0, 0);
    expect(g.tick(400)).toBe(false);
    expect(g.tick(500)).toBe(true);
    g.begin(0, 0, 0);
    g.move(5, 0, 10);
    expect(g.kind).toBe('drag');
  });
});

describe('hold specs', () => {
  it('stillHold and stickSideHold fill their defaults', () => {
    expect(stillHold()).toEqual({ type: 'still', tolerancePx: 10, ms: 300 });
    expect(stillHold({ ms: 250, tolerancePx: 5 })).toEqual({
      type: 'still',
      tolerancePx: 5,
      ms: 250,
    });
    const when = () => true;
    expect(stickSideHold({ when })).toEqual({ type: 'stickSide', tolerancePx: 10, ms: 300, when });
  });
});

describe('inStickZone', () => {
  it('takes the stick side unless the stick is taken', () => {
    expect(inStickZone(100, 1000, 'left')).toBe(true);
    expect(inStickZone(600, 1000, 'left')).toBe(false);
    expect(inStickZone(900, 1000, 'right')).toBe(true);
    expect(inStickZone(100, 1000, 'right')).toBe(false);
    expect(inStickZone(100, 1000, 'left', true)).toBe(false);
    expect(inStickZone(450, 1000, 'left', false, 0.4)).toBe(false);
  });
});

describe('WheelSteps (ported from Forge play/gestures)', () => {
  it('a notch is one step; a trackpad stream steps per 50 px; a fling at most one per event', () => {
    const w = new WheelSteps();
    expect(w.add(3, 1, 0)).toBe(1); // a line-mode notch
    expect(w.add(-100, 0, 1000)).toBe(-1); // a pixel notch after a pause
    w.reset();
    let steps = 0;
    for (let t = 0; t < 100; t += 10) steps += w.add(10, 0, t); // 100 px of trackpad
    expect(steps).toBe(2);
    w.reset();
    expect(w.add(20, 0, 0)).toBe(0);
    expect(w.add(500, 0, 10)).toBe(1); // a fling: one step
    expect(w.add(0, 0, 20)).toBe(0);
    expect(w.add(1, 0, 30)).toBe(1); // only one step's worth was left behind
    expect(w.add(1, 0, 40)).toBe(0);
  });

  it('a pause starts counting afresh', () => {
    const w = new WheelSteps({ pixelsPerStep: 50, idleMs: 250 });
    expect(w.add(30, 0, 0)).toBe(0);
    expect(w.add(30, 0, 1000)).toBe(0);
    expect(w.add(30, 0, 1010)).toBe(1);
  });
});
