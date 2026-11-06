import { describe, expect, it } from 'vitest';
import { type Ease, ease, isSpring, stepSpring } from './ease';

const FUNCTIONS = (Object.keys(ease) as (keyof typeof ease)[]).filter(
  (k) => k !== 'steps' && k !== 'cubicBezier' && k !== 'spring',
) as Exclude<keyof typeof ease, 'steps' | 'cubicBezier' | 'spring'>[];

/** The eases that never go back (back and elastic overshoot, bounce bounces). */
const MONOTONIC = FUNCTIONS.filter((k) => !/^(back|elastic|bounce)/.test(k));

describe('ease table', () => {
  it('has the full family table', () => {
    for (const f of [
      'quad',
      'cubic',
      'quart',
      'quint',
      'sine',
      'expo',
      'circ',
      'back',
      'elastic',
      'bounce',
    ]) {
      for (const s of ['In', 'Out', 'InOut'])
        expect(typeof ease[`${f}${s}` as keyof typeof ease]).toBe('function');
    }
    expect(FUNCTIONS.length).toBe(32);
  });

  it.each(FUNCTIONS)('%s is 0 at 0 and 1 at 1', (name) => {
    const f = ease[name] as Ease;
    expect(f(0)).toBeCloseTo(0, 9);
    expect(f(1)).toBeCloseTo(1, 9);
  });

  it.each(FUNCTIONS)('%s is finite over 0..1', (name) => {
    const f = ease[name] as Ease;
    for (let i = 0; i <= 100; i++) expect(Number.isFinite(f(i / 100))).toBe(true);
  });

  it.each(MONOTONIC)('%s never decreases', (name) => {
    const f = ease[name] as Ease;
    let prev = f(0);
    for (let i = 1; i <= 200; i++) {
      const v = f(i / 200);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  it('midpoints', () => {
    expect(ease.linear(0.5)).toBe(0.5);
    expect(ease.smoothstep(0.5)).toBe(0.5);
    expect(ease.quadIn(0.5)).toBe(0.25);
    expect(ease.quadOut(0.5)).toBe(0.75);
    expect(ease.quadInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.cubicIn(0.5)).toBe(0.125);
    expect(ease.cubicInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.quartInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.quintInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.sineInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.expoInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.circInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.backInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.elasticInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.bounceInOut(0.5)).toBeCloseTo(0.5);
    expect(ease.bounceOut(0.5)).toBeCloseTo(0.765625);
    expect(ease.sineIn(0.5)).toBeCloseTo(1 - Math.SQRT1_2);
    expect(ease.expoIn(0.5)).toBeCloseTo(1 / 32);
  });

  it('In and Out are mirror images, InOut is their join', () => {
    for (const f of [
      'quad',
      'cubic',
      'quart',
      'quint',
      'sine',
      'expo',
      'circ',
      'back',
      'elastic',
      'bounce',
    ]) {
      const fin = ease[`${f}In` as keyof typeof ease] as Ease;
      const fout = ease[`${f}Out` as keyof typeof ease] as Ease;
      const finout = ease[`${f}InOut` as keyof typeof ease] as Ease;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        expect(fout(t)).toBeCloseTo(1 - fin(1 - t), 6);
        if (t <= 0.5 && f !== 'back' && f !== 'elastic')
          expect(finout(t)).toBeCloseTo(fin(2 * t) / 2, 6);
      }
    }
  });

  it('back and elastic overshoot', () => {
    expect(ease.backIn(0.3)).toBeLessThan(0);
    expect(ease.backOut(0.7)).toBeGreaterThan(1);
    expect(ease.elasticOut(0.2)).toBeGreaterThan(1);
  });

  it('steps(n) holds n plateaus and ends at 1', () => {
    const s = ease.steps(4);
    expect(s(0)).toBe(0);
    expect(s(0.1)).toBe(0);
    expect(s(0.25)).toBe(0.25);
    expect(s(0.6)).toBe(0.5);
    expect(s(0.99)).toBe(0.75);
    expect(s(1)).toBe(1);
    expect(ease.steps(0)(0.5)).toBe(0);
    expect(ease.steps(0)(1)).toBe(1);
  });

  it('cubicBezier matches CSS presets', () => {
    const linear = ease.cubicBezier(0, 0, 1, 1);
    const easeCss = ease.cubicBezier(0.25, 0.1, 0.25, 1);
    const easeInOutCss = ease.cubicBezier(0.42, 0, 0.58, 1);
    for (let i = 0; i <= 10; i++) expect(linear(i / 10)).toBeCloseTo(i / 10, 5);
    expect(easeCss(0)).toBe(0);
    expect(easeCss(1)).toBe(1);
    expect(easeCss(0.5)).toBeCloseTo(0.8024, 3);
    expect(easeInOutCss(0.5)).toBeCloseTo(0.5, 5);
    expect(easeInOutCss(0.25)).toBeCloseTo(0.1291, 3);
    // Overshooting control points: solvable, leaves 0..1 in between.
    const over = ease.cubicBezier(0.68, -0.6, 0.32, 1.6);
    expect(over(0.1)).toBeLessThan(0);
    expect(over(0.9)).toBeGreaterThan(1);
    expect(over(1)).toBe(1);
  });

  it('spring describes a spring, and stepSpring settles at 1', () => {
    const s = ease.spring();
    expect(isSpring(s)).toBe(true);
    expect(isSpring(ease.linear)).toBe(false);
    expect(s.stiffness).toBe(170);
    expect(s.damping).toBe(22);
    const state = new Float64Array(2);
    let t = 0;
    let settled = false;
    let peak = 0;
    while (!settled && t < 5) {
      settled = stepSpring(state, s, 1 / 60);
      t += 1 / 60;
      peak = Math.max(peak, state[0]!);
    }
    expect(settled).toBe(true);
    expect(t).toBeLessThan(1.5);
    expect(state[0]).toBe(1);
    expect(state[1]).toBe(0);
    expect(peak).toBeGreaterThan(1); // slightly underdamped by default
    // Critically damped: no overshoot.
    const crit = ease.spring(100, 20);
    const c = new Float64Array(2);
    let max = 0;
    for (let i = 0; i < 600; i++) {
      stepSpring(c, crit, 1 / 60);
      max = Math.max(max, c[0]!);
    }
    expect(max).toBeLessThanOrEqual(1);
  });

  it('a stiff spring survives a long step', () => {
    const s = ease.spring(2000, 10);
    const state = new Float64Array(2);
    stepSpring(state, s, 0.5);
    expect(Number.isFinite(state[0])).toBe(true);
    expect(Math.abs(state[0]! - 1)).toBeLessThan(2);
  });
});
