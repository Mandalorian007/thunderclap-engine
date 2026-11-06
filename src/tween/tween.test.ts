import { describe, expect, it, vi } from 'vitest';
import { ease } from './ease';
import { createTweens, type Tweens } from './timeline';
import type { Tween } from './tween';

function run(tw: Tweens, seconds: number, step = 1 / 60): void {
  let left = seconds;
  while (left > 1e-9) {
    const dt = Math.min(step, left);
    tw.update(dt);
    left -= dt;
  }
}

describe('Tweens.to', () => {
  it('moves number fields with the ease and snaps to the end', () => {
    const tw = createTweens();
    const o = { x: 0, y: 10 };
    const t = tw.to(o, { x: 100, y: 0 }, 1, { ease: ease.quadIn });
    expect(tw.active).toBe(1);
    tw.update(0.5);
    expect(t.progress).toBeCloseTo(0.5);
    expect(t.elapsed).toBeCloseTo(0.5);
    expect(t.duration).toBe(1);
    expect(o.x).toBeCloseTo(25);
    expect(o.y).toBeCloseTo(7.5);
    tw.update(0.6);
    expect(o.x).toBe(100);
    expect(o.y).toBe(0);
    expect(t.complete).toBe(true);
    expect(t.progress).toBe(1);
    expect(tw.active).toBe(0);
  });

  it('reads start values when the tween starts, after its delay', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const onStart = vi.fn();
    tw.to(o, { x: 10 }, 1, { delay: 0.5, onStart });
    tw.update(0.25);
    o.x = 5; // changed during the delay
    expect(onStart).not.toHaveBeenCalled();
    tw.update(0.25);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(o.x).toBe(5);
    tw.update(0.5);
    expect(o.x).toBeCloseTo(7.5);
  });

  it('follows nested paths and typed-array indices', () => {
    const tw = createTweens();
    const o = { position: new Float32Array([0, 0, 0]), style: { opacity: 1 }, list: [1, 2] };
    tw.to(o, { 'position.0': 1, 'position.2': -2, 'style.opacity': 0, 'list.1': 4 }, 1);
    tw.update(0.5);
    expect(o.position[0]).toBeCloseTo(0.5);
    expect(o.position[1]).toBe(0);
    expect(o.position[2]).toBeCloseTo(-1);
    expect(o.style.opacity).toBeCloseTo(0.5);
    expect(o.list[1]).toBeCloseTo(3);
    tw.update(0.5);
    expect(o.position[0]).toBe(1);
    expect(o.list[1]).toBe(4);
  });

  it('rejects paths that are missing or not numbers', () => {
    const tw = createTweens();
    expect(() => tw.to({ a: {} }, { 'a.b': 1 }, 1)).toThrow(/not a number/);
    expect(() => tw.to({ a: 'x' }, { a: 1 }, 1)).toThrow(/not a number/);
    expect(() => tw.to({}, { 'a.b': 1 }, 1)).toThrow(/does not exist/);
  });

  it('a zero-second tween completes on the first update', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const t = tw.to(o, { x: 1 }, 0);
    tw.update(0.1);
    expect(o.x).toBe(1);
    expect(t.complete).toBe(true);
    expect(tw.active).toBe(0);
  });
});

describe('end values are exact for every ease', () => {
  it.each(
    Object.entries(ease).filter(([, f]) => typeof f === 'function' && f.length === 1) as [
      string,
      (t: number) => number,
    ][],
  )('%s lands exactly on the target', (_name, f) => {
    const tw = createTweens();
    const o = { x: 0 };
    tw.to(o, { x: 1 }, 1, { ease: f });
    run(tw, 1.01);
    expect(o.x).toBe(1);
    expect(tw.active).toBe(0);
  });

  it('cubicBezier and steps land exactly too', () => {
    const tw = createTweens();
    const o = { a: 0, b: 0 };
    tw.to(o, { a: 1 }, 1, { ease: ease.cubicBezier(0.68, -0.6, 0.32, 1.6) });
    tw.to(o, { b: 1 }, 1, { ease: ease.steps(5) });
    run(tw, 1.01);
    expect(o.a).toBe(1);
    expect(o.b).toBe(1);
  });
});

describe('loops and yoyo', () => {
  it('loops N extra times and calls onComplete once at the end', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const onComplete = vi.fn();
    const t = tw.to(o, { x: 1 }, 1, { loops: 2, onComplete });
    run(tw, 1.5);
    expect(o.x).toBeCloseTo(0.5);
    expect(t.complete).toBe(false);
    run(tw, 1.4);
    expect(t.complete).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    run(tw, 0.2);
    expect(t.complete).toBe(true);
    expect(o.x).toBe(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('yoyo reverses every other iteration', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const t = tw.to(o, { x: 1 }, 1, { loops: 1, yoyo: true });
    tw.update(0.5);
    expect(o.x).toBeCloseTo(0.5);
    tw.update(0.75); // 0.25 into the return trip
    expect(o.x).toBeCloseTo(0.75);
    tw.update(0.75);
    expect(o.x).toBe(0);
    expect(t.complete).toBe(true);
  });

  it('loops forever and a long step crosses several boundaries', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const ends: number[] = [];
    const t = tw.to(o, { x: 1 }, 0.25, { loops: -1, onUpdate: () => ends.push(o.x) });
    tw.update(1.1); // 4 boundaries + 0.1
    expect(t.complete).toBe(false);
    expect(t.elapsed).toBeCloseTo(0.1);
    expect(o.x).toBeCloseTo(0.4);
    run(tw, 10);
    expect(t.complete).toBe(false);
    expect(tw.active).toBe(1);
  });

  it('a zero-length tween with loops still completes', () => {
    const tw = createTweens();
    const t = tw.delay(0, { loops: -1 });
    tw.update(0.1);
    expect(t.complete).toBe(true);
  });
});

describe('value and delay', () => {
  it('value reports each step and ends exactly on `to`', () => {
    const tw = createTweens();
    const seen: number[] = [];
    const t = tw.value(10, 20, 1, (v) => seen.push(v), { ease: ease.linear });
    tw.update(0.25);
    tw.update(0.25);
    tw.update(0.5);
    expect(seen).toEqual([12.5, 15, 20]);
    expect(t.complete).toBe(true);
  });

  it('delay is a timer with then', () => {
    const tw = createTweens();
    const fn = vi.fn();
    tw.delay(1).then(fn);
    run(tw, 0.9);
    expect(fn).not.toHaveBeenCalled();
    run(tw, 0.2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('delay option holds the start', () => {
    const tw = createTweens();
    const o = { x: 0 };
    tw.to(o, { x: 1 }, 1, { delay: 1 });
    tw.update(1.5);
    expect(o.x).toBeCloseTo(0.5);
  });
});

describe('sequence', () => {
  it('runs children in order with leftover dt carried across', () => {
    const tw = createTweens();
    const a = { x: 0 };
    const b = { x: 0 };
    const seq = tw.sequence(tw.to(a, { x: 1 }, 1), tw.delay(0.5), tw.to(b, { x: 1 }, 1));
    expect(tw.active).toBe(1); // children left the manager
    expect(seq.duration).toBe(2.5);
    tw.update(0.7);
    expect(a.x).toBeCloseTo(0.7);
    expect(b.x).toBe(0);
    tw.update(0.6); // a ends at 1.0; 0.3 into the delay
    expect(a.x).toBe(1);
    expect(b.x).toBe(0);
    expect(seq.elapsed).toBeCloseTo(1.3);
    tw.update(0.5); // delay ends at 1.5; b 0.3 in
    expect(b.x).toBeCloseTo(0.3);
    expect(seq.progress).toBeCloseTo(1.8 / 2.5);
    tw.update(5);
    expect(b.x).toBe(1);
    expect(seq.complete).toBe(true);
    expect(seq.progress).toBe(1);
    expect(tw.active).toBe(0);
  });

  it('one big step runs the whole sequence', () => {
    const tw = createTweens();
    const a = { x: 0 };
    const b = { x: 0 };
    const seq = tw.sequence(tw.to(a, { x: 1 }, 0.2), tw.to(b, { x: 1 }, 0.2));
    tw.update(1);
    expect(a.x).toBe(1);
    expect(b.x).toBe(1);
    expect(seq.complete).toBe(true);
  });

  it('waits on a paused child and loops as a whole', () => {
    const tw = createTweens();
    const a = { x: 0 };
    const b = { x: 0 };
    const ta = tw.to(a, { x: 1 }, 1);
    const seq = tw.sequence(ta, tw.to(b, { x: 1 }, 1), { loops: 1 });
    tw.update(0.5);
    ta.pause();
    tw.update(1);
    expect(a.x).toBeCloseTo(0.5);
    expect(b.x).toBe(0);
    ta.resume();
    tw.update(1); // a ends (0.5), b 0.5 in
    expect(a.x).toBe(1);
    expect(b.x).toBeCloseTo(0.5);
    tw.update(0.75); // b ends; second iteration replays a from its first start value, 0.25 in
    expect(seq.complete).toBe(false);
    expect(a.x).toBeCloseTo(0.25);
    expect(b.x).toBe(1);
    tw.update(1.75);
    expect(seq.complete).toBe(true);
  });

  it('a yoyo sequence plays its children backwards on the way back', () => {
    const tw = createTweens();
    const a = { x: 0 };
    const b = { x: 0 };
    tw.sequence(tw.to(a, { x: 1 }, 1), tw.to(b, { x: 1 }, 1), { loops: 1, yoyo: true });
    tw.update(2.5); // back: b runs first, reversed, 0.5 in
    expect(a.x).toBe(1);
    expect(b.x).toBeCloseTo(0.5);
    tw.update(1); // b done (back at 0), a 0.5 in, reversed
    expect(b.x).toBe(0);
    expect(a.x).toBeCloseTo(0.5);
  });

  it('parallel ends with its longest child and carries the smallest leftover', () => {
    const tw = createTweens();
    const a = { x: 0 };
    const b = { x: 0 };
    const c = { x: 0 };
    const par = tw.parallel(tw.to(a, { x: 1 }, 1), tw.to(b, { x: 1 }, 2));
    const seq = tw.sequence(par, tw.to(c, { x: 1 }, 1));
    expect(par.duration).toBe(2);
    expect(seq.duration).toBe(3);
    tw.update(1.5);
    expect(a.x).toBe(1);
    expect(b.x).toBeCloseTo(0.75);
    expect(c.x).toBe(0);
    expect(par.progress).toBeCloseTo(0.75);
    tw.update(1);
    expect(b.x).toBe(1);
    expect(c.x).toBeCloseTo(0.5);
    expect(par.complete).toBe(true);
    tw.update(1);
    expect(seq.complete).toBe(true);
    expect(tw.active).toBe(0);
  });

  it('refuses a tween that already belongs to a group', () => {
    const tw = createTweens();
    const t = tw.delay(1);
    tw.sequence(t);
    expect(() => tw.parallel(t)).toThrow(/only one group/);
  });
});

describe('pause, kill, restart', () => {
  it('pause holds, resume continues', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const t = tw.to(o, { x: 1 }, 1);
    tw.update(0.25);
    t.pause();
    expect(t.paused).toBe(true);
    tw.update(1);
    expect(o.x).toBeCloseTo(0.25);
    expect(tw.active).toBe(1);
    t.resume();
    tw.update(0.25);
    expect(o.x).toBeCloseTo(0.5);
  });

  it('timeScale slows, speeds and holds', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const t = tw.to(o, { x: 1 }, 1, { timeScale: 0.5 });
    tw.update(1);
    expect(o.x).toBeCloseTo(0.5);
    t.timeScale = 0;
    tw.update(1);
    expect(o.x).toBeCloseTo(0.5);
    t.timeScale = 4;
    tw.update(0.125);
    expect(o.x).toBe(1);
  });

  it('kill drops the tween without onComplete', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const onComplete = vi.fn();
    const t = tw.to(o, { x: 1 }, 1, { onComplete });
    tw.update(0.5);
    t.kill();
    expect(t.killed).toBe(true);
    expect(tw.active).toBe(0);
    tw.update(1);
    expect(o.x).toBeCloseTo(0.5);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('a tween killed from a callback during update is safe, and so is one added', () => {
    const tw = createTweens();
    const a = { x: 0 };
    const b = { x: 0 };
    const c = { x: 0 };
    let tb: Tween | null = null;
    let added = false;
    tw.to(a, { x: 1 }, 1, {
      onUpdate: () => {
        tb?.kill();
        if (!added) {
          added = true;
          tw.to(c, { x: 1 }, 1);
        }
      },
    });
    tb = tw.to(b, { x: 1 }, 1);
    tw.update(0.5);
    expect(a.x).toBeCloseTo(0.5);
    expect(b.x).toBe(0); // killed before it advanced
    expect(c.x).toBe(0); // added tweens start on the next update
    expect(tw.active).toBe(2);
    tw.update(0.5);
    expect(c.x).toBeCloseTo(0.5);
  });

  it('kill(target) kills the tweens on that object, inside groups too', () => {
    const tw = createTweens();
    const a = { x: 0 };
    const b = { x: 0 };
    tw.to(a, { x: 1 }, 1);
    tw.to(b, { x: 1 }, 1);
    const seq = tw.sequence(tw.to(a, { x: 2 }, 1), tw.to(b, { x: 2 }, 1));
    tw.kill(a);
    expect(tw.active).toBe(2);
    tw.update(0.5);
    expect(a.x).toBe(0);
    expect(b.x).toBeGreaterThan(0); // both tweens on b still run; the sequence skipped a's
    expect(seq.complete).toBe(false);
    expect(seq.progress).toBeCloseTo(0.75); // a's second was skipped whole
  });

  it('killAll empties the manager', () => {
    const tw = createTweens();
    tw.to({ x: 0 }, { x: 1 }, 1);
    tw.delay(2);
    tw.sequence(tw.delay(1), tw.delay(1));
    expect(tw.active).toBe(3);
    tw.killAll();
    expect(tw.active).toBe(0);
  });

  it('restart replays a finished root tween, delay included', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const t = tw.to(o, { x: 1 }, 1, { delay: 0.5, onStart, onComplete });
    run(tw, 2);
    expect(t.complete).toBe(true);
    expect(tw.active).toBe(0);
    o.x = 0;
    t.restart();
    expect(tw.active).toBe(1);
    expect(t.complete).toBe(false);
    expect(t.progress).toBe(0);
    tw.update(0.5);
    expect(o.x).toBe(0);
    tw.update(0.5);
    expect(o.x).toBeCloseTo(0.5);
    run(tw, 1);
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it('restart on a killed tween brings it back; on a live one rewinds it', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const t = tw.to(o, { x: 1 }, 1);
    tw.update(0.5);
    t.restart();
    expect(t.elapsed).toBe(0);
    expect(tw.active).toBe(1);
    t.kill();
    tw.update(0);
    expect(tw.active).toBe(0);
    t.restart();
    expect(tw.active).toBe(1);
    expect(t.killed).toBe(false);
  });

  it('update refuses re-entry', () => {
    const tw = createTweens();
    tw.delay(1, { onUpdate: () => tw.update(0.1) });
    expect(() => tw.update(0.1)).toThrow(/inside update/);
  });
});

describe('then and promise', () => {
  it('then chains and fires at once when already complete', () => {
    const tw = createTweens();
    const order: string[] = [];
    const t = tw
      .delay(1)
      .then(() => order.push('a'))
      .then(() => order.push('b'));
    run(tw, 1);
    expect(order).toEqual(['a', 'b']);
    t.then(() => order.push('c'));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('promise resolves on completion', async () => {
    const tw = createTweens();
    const p = tw.delay(0.1).promise();
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    tw.update(0.2);
    await p;
    expect(resolved).toBe(true);
  });

  it('await works on the tween itself', async () => {
    const tw = createTweens();
    const t = tw.delay(0.1);
    const done = (async () => {
      await t;
      return 'ok';
    })();
    tw.update(0.2);
    expect(await done).toBe('ok');
  });
});

describe('spring', () => {
  it('ends on settle, overshoots a little and ignores seconds', () => {
    const tw = createTweens();
    const o = { x: 0 };
    const t = tw.to(o, { x: 100 }, 99, { ease: ease.spring() });
    expect(t.duration).toBe(Number.POSITIVE_INFINITY);
    let peak = 0;
    let seconds = 0;
    while (!t.complete && seconds < 5) {
      tw.update(1 / 60);
      seconds += 1 / 60;
      peak = Math.max(peak, o.x);
    }
    expect(t.complete).toBe(true);
    expect(seconds).toBeLessThan(1.5);
    expect(o.x).toBe(100);
    expect(peak).toBeGreaterThan(100);
    expect(t.progress).toBe(1);
    expect(tw.active).toBe(0);
  });

  it('a spring inside a sequence hands over when it settles', () => {
    const tw = createTweens();
    const a = { x: 0 };
    const b = { x: 0 };
    const seq = tw.sequence(
      tw.to(a, { x: 1 }, 0, { ease: ease.spring(300, 40) }),
      tw.to(b, { x: 1 }, 0.5),
    );
    run(tw, 3);
    expect(a.x).toBe(1);
    expect(b.x).toBe(1);
    expect(seq.complete).toBe(true);
  });
});

describe('allocation', () => {
  it('update allocates no arrays or objects in steady state', () => {
    const tw = createTweens();
    const o = { x: 0, p: new Float32Array(3) };
    tw.to(o, { x: 1, 'p.1': 2 }, 100, { loops: -1, yoyo: true, ease: ease.elasticInOut });
    tw.value(0, 1, 100, () => {}, { loops: -1 });
    tw.sequence(tw.delay(0.5), tw.to(o, { x: 3 }, 0.5), { loops: -1 });
    tw.parallel(tw.delay(0.5), tw.to(o, { x: 3 }, 0.5), { loops: -1 });
    tw.to(o, { x: 1 }, 0, { ease: ease.spring(1, 0) }); // never settles: an undamped spring
    const arr = Array.prototype;
    const spies = [
      vi.spyOn(arr, 'push'),
      vi.spyOn(arr, 'map'),
      vi.spyOn(arr, 'slice'),
      vi.spyOn(arr, 'concat'),
    ];
    for (let i = 0; i < 120; i++) tw.update(1 / 60);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
