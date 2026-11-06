import { describe, expect, it } from 'vitest';
import type { AnimationChannel, AnimationClip } from './clip';
import { AnimationAction, AnimationMixer } from './mixer';
import { POSE_NODE_FLOATS, type Skeleton } from './pose';
import { quatFromAxisAngle } from './quat';

const f32 = (a: number[]) => new Float32Array(a);
function skeleton(nodes = 2): Skeleton {
  const rest = new Float32Array(nodes * POSE_NODE_FLOATS);
  for (let i = 0; i < nodes; i++) {
    const o = i * POSE_NODE_FLOATS;
    rest[o + 6] = 1;
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  const parents = new Int16Array(nodes);
  for (let i = 0; i < nodes; i++) parents[i] = i - 1;
  return { parents, rest };
}
/** Node 0 translation x ramps 0 → `to` over `duration` seconds. */
function ramp(name: string, to: number, duration = 1, node = 0): AnimationClip {
  const ch: AnimationChannel = {
    node,
    path: 'translation',
    interpolation: 'LINEAR',
    times: f32([0, duration]),
    values: f32([0, 0, 0, to, 0, 0]),
  };
  return { name, duration, channels: [ch] };
}
/** Constant node 0 translation x. */
function constant(name: string, x: number): AnimationClip {
  return {
    name,
    duration: 1,
    channels: [
      {
        node: 0,
        path: 'translation',
        interpolation: 'STEP',
        times: f32([0]),
        values: f32([x, 0, 0]),
      },
    ],
  };
}
const x0 = (m: AnimationMixer) => m.pose[0]!;

describe('AnimationMixer play and update', () => {
  it('starts at the rest pose and writes the sampled clip', () => {
    const m = new AnimationMixer(skeleton());
    expect([...m.pose]).toEqual([...m.skeleton.rest]);
    const a = m.play(ramp('r', 10));
    expect(a.active).toBe(true);
    expect(m.playing).toBe(1);
    m.update(0.25);
    expect(x0(m)).toBeCloseTo(2.5);
    expect(a.time).toBeCloseTo(0.25);
    expect(a.effectiveWeight).toBe(1);
  });

  it('loops by default and wraps the time', () => {
    const m = new AnimationMixer(skeleton());
    const a = m.play(ramp('r', 10));
    m.update(1.25);
    expect(a.time).toBeCloseTo(0.25);
    expect(x0(m)).toBeCloseTo(2.5);
    expect(a.finished).toBe(false);
  });

  it('loop: false holds the last frame and sets finished', () => {
    const m = new AnimationMixer(skeleton());
    const a = m.play(ramp('r', 10), { loop: false });
    m.update(0.5);
    expect(a.finished).toBe(false);
    m.update(1);
    expect(a.finished).toBe(true);
    expect(a.time).toBe(1);
    expect(x0(m)).toBeCloseTo(10);
    m.update(1);
    expect(x0(m)).toBeCloseTo(10);
    expect(a.active).toBe(true);
  });

  it('speed scales time; negative speed plays backwards from the end', () => {
    const m = new AnimationMixer(skeleton());
    const a = m.play(ramp('r', 10), { speed: 2 });
    m.update(0.25);
    expect(x0(m)).toBeCloseTo(5);
    m.stop(a);
    const b = m.play(ramp('r', 10), { speed: -1, loop: false });
    expect(b.time).toBe(1);
    m.update(0.25);
    expect(x0(m)).toBeCloseTo(7.5);
    m.update(5);
    expect(b.time).toBe(0);
    expect(b.finished).toBe(true);
  });

  it('weight < 1 on layer 0 blends toward the rest pose', () => {
    const m = new AnimationMixer(skeleton());
    m.play(constant('c', 10), { weight: 0.25 });
    m.update(0);
    expect(x0(m)).toBeCloseTo(2.5);
  });

  it('two override actions are averaged by weight, never summed past 1', () => {
    const m = new AnimationMixer(skeleton());
    m.play(constant('a', 10), { weight: 1 });
    m.play(constant('b', 20), { weight: 1 });
    m.update(0);
    expect(x0(m)).toBeCloseTo(15);
    m.stopAll();
    m.play(constant('a', 10), { weight: 0.75 });
    m.play(constant('b', 20), { weight: 0.25 });
    m.update(0);
    expect(x0(m)).toBeCloseTo(12.5);
  });

  it('paused actions keep their pose without advancing', () => {
    const m = new AnimationMixer(skeleton());
    const a = m.play(ramp('r', 10));
    m.update(0.5);
    a.paused = true;
    m.update(0.5);
    expect(a.time).toBeCloseTo(0.5);
    expect(x0(m)).toBeCloseTo(5);
  });

  it('pool is bounded; stopped slots are reused', () => {
    const m = new AnimationMixer(skeleton(), { maxActions: 2 });
    const a = m.play(constant('a', 1));
    m.play(constant('b', 2));
    expect(() => m.play(constant('c', 3))).toThrow(/slots/);
    m.stop(a);
    expect(a.active).toBe(false);
    const c = m.play(constant('c', 3));
    expect(c).toBe(a);
    expect(m.actions.length).toBe(2);
  });

  it('stopAll resets the pose to rest', () => {
    const m = new AnimationMixer(skeleton());
    m.play(constant('a', 10));
    m.update(0);
    m.stopAll();
    expect(m.playing).toBe(0);
    expect(x0(m)).toBe(0);
    m.update(0.1);
    expect(x0(m)).toBe(0);
  });
});

describe('fades and crossfade', () => {
  it('fadeIn ramps the effective weight from 0 to the target', () => {
    const m = new AnimationMixer(skeleton());
    const a = m.play(constant('a', 10), { fadeIn: 1, weight: 0.5 });
    expect(a.effectiveWeight).toBe(0);
    m.update(0.5);
    expect(a.effectiveWeight).toBeCloseTo(0.25);
    expect(x0(m)).toBeCloseTo(2.5);
    m.update(0.5);
    expect(a.effectiveWeight).toBeCloseTo(0.5);
    m.update(5);
    expect(a.effectiveWeight).toBeCloseTo(0.5);
  });

  it('crossFade weights sum to 1 throughout and the outgoing action stops at the end', () => {
    const m = new AnimationMixer(skeleton());
    const from = m.play(constant('a', 0));
    m.update(0.1);
    const to = m.crossFade(from, constant('b', 10), 1);
    expect(to).toBeInstanceOf(AnimationAction);
    expect(to.layer).toBe(from.layer);
    for (let i = 1; i <= 8; i++) {
      m.update(0.125);
      if (i < 8) {
        expect(from.effectiveWeight + to.effectiveWeight).toBeCloseTo(1, 5);
        expect(from.effectiveWeight).toBeCloseTo(1 - i / 8, 5);
        // The composed pose is the weighted average: 0·(1−u) + 10·u.
        expect(x0(m)).toBeCloseTo((10 * i) / 8, 4);
      }
    }
    expect(from.active).toBe(false);
    expect(to.effectiveWeight).toBeCloseTo(1);
    expect(x0(m)).toBeCloseTo(10);
  });

  it('crossFade to a playing action fades it up; a mid-fade outgoing action keeps its current weight', () => {
    const m = new AnimationMixer(skeleton());
    const a = m.play(constant('a', 0));
    const b = m.play(constant('b', 10), { fadeIn: 2 });
    m.update(0.5); // b at 0.25
    expect(b.effectiveWeight).toBeCloseTo(0.25);
    const r = m.crossFade(a, b, 0.5);
    expect(r).toBe(b);
    m.update(0.25);
    expect(b.effectiveWeight).toBeCloseTo(0.625);
    expect(a.effectiveWeight).toBeCloseTo(0.5);
    m.update(0.25);
    expect(b.effectiveWeight).toBeCloseTo(1);
    expect(a.active).toBe(false);
  });

  it('stop with a fade releases the action when the fade ends', () => {
    const m = new AnimationMixer(skeleton());
    const a = m.play(constant('a', 10));
    m.update(0);
    m.stop(a, 1);
    m.update(0.5);
    expect(a.effectiveWeight).toBeCloseTo(0.5);
    expect(x0(m)).toBeCloseTo(5);
    m.update(0.5);
    expect(a.active).toBe(false);
    expect(x0(m)).toBe(0);
  });
});

describe('layers and additive', () => {
  it('a higher layer overrides the lower on the nodes it animates', () => {
    const m = new AnimationMixer(skeleton(2));
    m.play(constant('base', 10));
    m.play(ramp('upper', 4, 1, 1), { layer: 1 });
    m.update(0.5);
    expect(x0(m)).toBeCloseTo(10);
    expect(m.pose[POSE_NODE_FLOATS]).toBeCloseTo(2);
    // Half-weight upper layer: half-way between the lower result and its own value.
    m.stopAll();
    m.play(constant('base', 10));
    m.play(constant('upper', 20), { layer: 1, weight: 0.5 });
    m.update(0);
    expect(x0(m)).toBeCloseTo(15);
  });

  it('additive actions add their deltas on top of the layer, scaled by weight', () => {
    const m = new AnimationMixer(skeleton());
    m.play(constant('base', 10));
    const bob = m.play(constant('bob', 3), { blend: 'additive', layer: 1, weight: 0.5 });
    m.update(0);
    expect(x0(m)).toBeCloseTo(11.5);
    bob.weight = 1;
    m.update(0);
    expect(x0(m)).toBeCloseTo(13);
  });

  it('an additive rotation on top of a rest pose rotates the node', () => {
    const sk = skeleton(1);
    const m = new AnimationMixer(sk);
    const q = new Float32Array(4);
    quatFromAxisAngle(q, 0, 0, 0, 1, 0.5);
    m.play(
      {
        name: 'spin',
        duration: 1,
        channels: [
          { node: 0, path: 'rotation', interpolation: 'STEP', times: f32([0]), values: q },
        ],
      },
      { blend: 'additive' },
    );
    m.update(0);
    expect(2 * Math.atan2(m.pose[5]!, m.pose[6]!)).toBeCloseTo(0.5, 5);
  });
});

describe('events', () => {
  function clipWithEvents(): AnimationClip {
    const c = constant('ev', 0);
    c.events = [
      { time: 0, name: 'start' },
      { time: 0.5, name: 'mid' },
      { time: 1, name: 'end' },
    ];
    return c;
  }

  it('fires once per crossing, including the start on the first update', () => {
    const m = new AnimationMixer(skeleton());
    const log: string[] = [];
    const off = m.onEvent((name, action) => {
      expect(action.clip?.name).toBe('ev');
      log.push(name);
    });
    m.play(clipWithEvents());
    m.update(0.25);
    expect(log).toEqual(['start']);
    m.update(0.25);
    expect(log).toEqual(['start', 'mid']);
    m.update(0.1);
    expect(log).toEqual(['start', 'mid']);
    off();
    m.update(1);
    expect(log).toEqual(['start', 'mid']);
  });

  it('looping fires events across the wrap and once per loop', () => {
    const m = new AnimationMixer(skeleton());
    const log: string[] = [];
    m.onEvent((n) => log.push(n));
    m.play(clipWithEvents());
    m.update(0.75); // start, mid
    m.update(0.5); // end(1.0) and start(1.0 = 0 + d) at the wrap
    expect(log).toEqual(['start', 'mid', 'end', 'start']);
    log.length = 0;
    m.update(2); // t 0.25 → 2.25 unwrapped: mid, end+start, mid, end+start
    expect(log).toEqual(['mid', 'end', 'start', 'mid', 'end', 'start']);
  });

  it('a non-looping action fires the end event once and nothing after', () => {
    const m = new AnimationMixer(skeleton());
    const log: string[] = [];
    m.onEvent((n) => log.push(n));
    m.play(clipWithEvents(), { loop: false });
    m.update(3);
    expect(log).toEqual(['start', 'mid', 'end']);
    m.update(3);
    expect(log).toEqual(['start', 'mid', 'end']);
  });

  it('reversed playback fires events in reverse', () => {
    const m = new AnimationMixer(skeleton());
    const log: string[] = [];
    m.onEvent((n) => log.push(n));
    m.play(clipWithEvents(), { loop: false, speed: -1 });
    m.update(0.6);
    expect(log).toEqual(['end', 'mid']);
    m.update(1);
    expect(log).toEqual(['end', 'mid', 'start']);
  });
});
