import { afterEach, describe, expect, it } from 'vitest';
import type { AnimationChannel, AnimationClip } from './clip';
import { type AnimGraph, type AnimGraphDesc, createAnimGraph } from './graph';
import { AnimationMixer } from './mixer';
import { POSE_NODE_FLOATS, type Skeleton } from './pose';

const f32 = (a: number[]) => new Float32Array(a);
function skeleton(nodes = 1): Skeleton {
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
function ramp(name: string, to: number, duration = 1): AnimationClip {
  const ch: AnimationChannel = {
    node: 0,
    path: 'translation',
    interpolation: 'LINEAR',
    times: f32([0, duration]),
    values: f32([0, 0, 0, to, 0, 0]),
  };
  return { name, duration, channels: [ch] };
}
/** Constant node 0 translation x. */
function constant(name: string, x: number, duration = 1): AnimationClip {
  return {
    name,
    duration,
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

const idle = constant('idle', 0, 2);
const walk = constant('walk', 1, 1);
const run = constant('run', 2, 0.5);
const jump = ramp('jump', 10, 0.5);

function locomotion(extra: Partial<AnimGraphDesc> = {}): { mixer: AnimationMixer; g: AnimGraph } {
  const mixer = new AnimationMixer(skeleton());
  const g = createAnimGraph(mixer, {
    params: { speed: 0, jump: false },
    states: {
      move: {
        blend: {
          param: 'speed',
          points: [
            { at: 0, clip: idle },
            { at: 0.5, clip: walk },
            { at: 1, clip: run },
          ],
        },
      },
      jump: { clip: jump, loop: false },
    },
    transitions: [
      { from: '*', to: 'jump', when: (p) => p.jump === true, fade: 0 },
      { from: 'jump', to: 'move', when: () => true, fade: 0.2, exitTime: 1 },
    ],
    initial: 'move',
    ...extra,
  });
  return { mixer, g };
}

const x0 = (m: AnimationMixer) => m.pose[0]!;
const weights = (g: AnimGraph, s: string) => g.actions(s).map((a) => a.weight);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

describe('createAnimGraph construction', () => {
  it('starts every clip on the mixer, the initial state at weight 1', () => {
    const { mixer, g } = locomotion();
    expect(mixer.playing).toBe(4);
    expect(g.state).toBe('move');
    expect(g.previous).toBe('move');
    expect(g.weight('move')).toBe(1);
    expect(g.weight('jump')).toBe(0);
    expect(weights(g, 'move')).toEqual([1, 0, 0]);
    g.update(0.1);
    expect(x0(mixer)).toBe(0);
  });

  it('rejects unknown states, params and initial', () => {
    const mixer = new AnimationMixer(skeleton());
    const base: AnimGraphDesc = {
      params: { a: 0 },
      states: { s: { clip: idle } },
      transitions: [],
      initial: 's',
    };
    expect(() => createAnimGraph(mixer, { ...base, initial: 'nope' })).toThrow(/initial/);
    expect(() =>
      createAnimGraph(new AnimationMixer(skeleton()), {
        ...base,
        transitions: [{ from: 's', to: 'nope', when: () => true, fade: 0 }],
      }),
    ).toThrow(/unknown state 'nope'/);
    expect(() =>
      createAnimGraph(new AnimationMixer(skeleton()), {
        ...base,
        states: { s: { blend: { param: 'zzz', points: [{ at: 0, clip: idle }] } } },
      }),
    ).toThrow(/unknown param/);
    const g = createAnimGraph(new AnimationMixer(skeleton()), base);
    expect(() => g.set('b', 1)).toThrow(/unknown param/);
    expect(() => g.weight('t')).toThrow(/unknown state/);
  });

  it('copies the params and passes the same object to every condition', () => {
    const seen: object[] = [];
    const params = { go: false };
    const mixer = new AnimationMixer(skeleton());
    const g = createAnimGraph(mixer, {
      params,
      states: { a: { clip: idle }, b: { clip: walk } },
      transitions: [
        {
          from: 'a',
          to: 'b',
          when: (p) => {
            seen.push(p);
            return p.go === true;
          },
          fade: 0,
        },
      ],
      initial: 'a',
    });
    g.update(0.1);
    g.update(0.1);
    expect(seen[0]).toBe(g.params);
    expect(seen[1]).toBe(g.params);
    expect(g.params).not.toBe(params);
    g.set('go', true);
    expect(g.get('go')).toBe(true);
    expect(params.go).toBe(false);
  });
});

describe('transitions', () => {
  it('fires on a boolean parameter and switches at once with fade 0', () => {
    const { mixer, g } = locomotion();
    g.update(0.1);
    g.set('jump', true);
    g.update(0.1);
    expect(g.state).toBe('jump');
    expect(g.previous).toBe('move');
    expect(g.weight('jump')).toBe(1);
    expect(g.weight('move')).toBe(0);
    // The jump clip restarted from 0 on entry and advanced one step.
    expect(g.actions('jump')[0]!.time).toBeCloseTo(0.1);
    expect(x0(mixer)).toBeCloseTo(2);
  });

  it('exitTime gates a transition until the clip passes that point', () => {
    const { g } = locomotion();
    g.set('jump', true);
    g.update(0.1);
    g.set('jump', false);
    expect(g.state).toBe('jump');
    g.update(0.2);
    g.update(0.1); // jump time 0.4 of 0.5: not finished
    expect(g.state).toBe('jump');
    g.update(0.1); // reaches 0.5, finished → phase 1
    expect(g.state).toBe('jump');
    g.update(0.01); // the gate reads the phase before advancing: now 1
    expect(g.state).toBe('move');
  });

  it('cross-fades with weights summing to 1 and settles after the fade', () => {
    const { g } = locomotion();
    g.set('jump', true);
    g.update(0.1);
    g.set('jump', false);
    g.update(0.5);
    g.update(0.01); // → move over 0.2 s
    expect(g.state).toBe('move');
    expect(g.weight('move')).toBeCloseTo(0.05);
    expect(g.weight('jump')).toBeCloseTo(0.95);
    g.update(0.1);
    expect(g.weight('move')).toBeCloseTo(0.55);
    expect(g.weight('move') + g.weight('jump')).toBeCloseTo(1);
    g.update(0.2);
    expect(g.weight('move')).toBe(1);
    expect(g.weight('jump')).toBe(0);
  });

  it('an interrupted fade continues from the weights it had, still summing to 1', () => {
    const mixer = new AnimationMixer(skeleton());
    const g = createAnimGraph(mixer, {
      params: { s: 0 },
      states: { a: { clip: idle }, b: { clip: walk }, c: { clip: run } },
      transitions: [
        { from: 'a', to: 'b', when: (p) => p.s === 1, fade: 1 },
        { from: 'b', to: 'c', when: (p) => p.s === 2, fade: 1 },
      ],
      initial: 'a',
    });
    g.set('s', 1);
    g.update(0.5);
    expect(g.weight('a')).toBeCloseTo(0.5);
    expect(g.weight('b')).toBeCloseTo(0.5);
    g.set('s', 2);
    g.update(0.5);
    expect(g.state).toBe('c');
    expect(g.weight('a')).toBeCloseTo(0.25);
    expect(g.weight('b')).toBeCloseTo(0.25);
    expect(g.weight('c')).toBeCloseTo(0.5);
    expect(g.weight('a') + g.weight('b') + g.weight('c')).toBeCloseTo(1);
  });

  it('evaluates in order: the first matching transition wins', () => {
    const mixer = new AnimationMixer(skeleton());
    const g = createAnimGraph(mixer, {
      params: { go: true },
      states: { a: { clip: idle }, b: { clip: walk }, c: { clip: run } },
      transitions: [
        { from: 'a', to: 'c', when: () => false, fade: 0 },
        { from: 'a', to: 'b', when: (p) => p.go === true, fade: 0 },
        { from: 'a', to: 'c', when: (p) => p.go === true, fade: 0 },
      ],
      initial: 'a',
    });
    g.update(0.1);
    expect(g.state).toBe('b');
  });

  it("'*' applies from any state except its target, and only one transition fires per update", () => {
    const mixer = new AnimationMixer(skeleton());
    let entered = 0;
    const g = createAnimGraph(mixer, {
      params: { x: true },
      states: { a: { clip: idle }, b: { clip: walk, loop: false } },
      transitions: [{ from: '*', to: 'b', when: (p) => p.x === true, fade: 0 }],
      initial: 'a',
    });
    g.onEnter('b', () => entered++);
    g.update(0.1);
    g.update(0.1);
    g.update(0.1);
    expect(g.state).toBe('b');
    expect(entered).toBe(1);
  });

  it('go() forces a state regardless of the transitions', () => {
    const { g } = locomotion();
    g.go('jump', 0.5);
    expect(g.state).toBe('jump');
    g.update(0.25);
    expect(g.weight('jump')).toBeCloseTo(0.5);
    g.go('move');
    expect(g.weight('move')).toBe(1);
    expect(g.weight('jump')).toBe(0);
  });
});

describe('enter and exit callbacks', () => {
  it('fire once per change, exit before enter, with (from, to), and unsubscribe', () => {
    const { g } = locomotion();
    const log: string[] = [];
    const offExit = g.onExit('move', (from, to) => log.push(`exit ${from}>${to}`));
    g.onEnter('jump', (from, to) => log.push(`enter ${from}>${to}`));
    g.onEnter('move', (from, to) => log.push(`enter ${from}>${to}`));
    g.set('jump', true);
    g.update(0.1);
    g.update(0.1);
    expect(log).toEqual(['exit move>jump', 'enter move>jump']);
    g.set('jump', false);
    g.update(0.5);
    g.update(0.1);
    g.update(0.1);
    expect(log).toEqual(['exit move>jump', 'enter move>jump', 'enter jump>move']);
    offExit();
    g.set('jump', true);
    g.update(0.1);
    expect(log).toHaveLength(4);
    expect(log[3]).toBe('enter move>jump');
  });
});

describe('1D blend spaces', () => {
  it('weights the point exactly at the parameter', () => {
    const { g } = locomotion();
    g.set('speed', 0.5);
    g.update(0.01);
    expect(weights(g, 'move').map((w) => +w.toFixed(6))).toEqual([0, 1, 0]);
  });

  it('splits the weight linearly between the two nearest points', () => {
    const { g, mixer } = locomotion();
    g.set('speed', 0.75);
    g.update(0.01);
    const w = weights(g, 'move');
    expect(w[0]).toBeCloseTo(0);
    expect(w[1]).toBeCloseTo(0.5);
    expect(w[2]).toBeCloseTo(0.5);
    expect(sum(w)).toBeCloseTo(1);
    // walk x = 1, run x = 2 → 1.5
    expect(x0(mixer)).toBeCloseTo(1.5);
    g.set('speed', 0.125);
    g.update(0.01);
    expect(weights(g, 'move')[0]).toBeCloseTo(0.75);
    expect(weights(g, 'move')[1]).toBeCloseTo(0.25);
  });

  it('clamps beyond the end points to the nearest one', () => {
    const { g } = locomotion();
    g.set('speed', -3);
    g.update(0.01);
    expect(weights(g, 'move')).toEqual([1, 0, 0]);
    g.set('speed', 7);
    g.update(0.01);
    expect(weights(g, 'move')).toEqual([0, 0, 1]);
  });

  it('sorts the points by `at` and scales blend weights by the state weight', () => {
    const mixer = new AnimationMixer(skeleton());
    const g = createAnimGraph(mixer, {
      params: { s: 0.5, go: false },
      states: {
        m: {
          blend: {
            param: 's',
            points: [
              { at: 1, clip: run },
              { at: 0, clip: idle },
            ],
          },
        },
        j: { clip: jump },
      },
      transitions: [{ from: 'm', to: 'j', when: (p) => p.go === true, fade: 1 }],
      initial: 'm',
    });
    expect(g.actions('m')[0]!.clip).toBe(idle);
    expect(g.actions('m')[1]!.clip).toBe(run);
    g.set('go', true);
    g.update(0.5);
    expect(weights(g, 'm')).toEqual([0.25, 0.25]);
    expect(g.actions('j')[0]!.weight).toBeCloseTo(0.5);
  });

  it('phase sync keeps the normalised time equal across the blended clips', () => {
    const { g } = locomotion();
    g.set('speed', 0.75); // walk (1 s) and run (0.5 s), half each: cycle 0.75 s
    for (let i = 0; i < 7; i++) g.update(0.1);
    const [a, b, c] = g.actions('move');
    const phase = g.phase('move');
    expect(phase).toBeCloseTo((0.7 / 0.75) % 1);
    expect(a!.time / idle.duration).toBeCloseTo(phase);
    expect(b!.time / walk.duration).toBeCloseTo(phase);
    expect(c!.time / run.duration).toBeCloseTo(phase);
    // Speeds scale each clip to the blended cycle.
    expect(b!.speed).toBeCloseTo(1 / 0.75);
    expect(c!.speed).toBeCloseTo(0.5 / 0.75);
    // Phase wraps with the cycle.
    g.update(0.1);
    expect(g.phase('move')).toBeCloseTo((0.8 / 0.75) % 1);
  });

  it('syncPhase: false leaves each clip at its own speed', () => {
    const mixer = new AnimationMixer(skeleton());
    const g = createAnimGraph(mixer, {
      params: { s: 0.5 },
      states: {
        m: {
          blend: {
            param: 's',
            syncPhase: false,
            points: [
              { at: 0, clip: walk },
              { at: 1, clip: run },
            ],
          },
        },
      },
      transitions: [],
      initial: 'm',
    });
    g.update(0.3);
    const [a, b] = g.actions('m');
    expect(a!.speed).toBe(1);
    expect(b!.speed).toBe(1);
    expect(a!.time).toBeCloseTo(0.3);
    expect(b!.time).toBeCloseTo(0.3);
    expect(weights(g, 'm')).toEqual([0.5, 0.5]);
  });
});

describe('allocation', () => {
  const g = globalThis as Record<string, unknown>;
  const names = ['Float32Array', 'Uint32Array', 'Int16Array', 'Array', 'Map', 'Set', 'Object'];
  const saved = names.map((n) => g[n]);
  afterEach(() => {
    names.forEach((n, i) => {
      g[n] = saved[i];
    });
  });

  it('update allocates nothing over 1000 frames', () => {
    const { g: graph } = locomotion();
    graph.onEnter('jump', () => {});
    graph.update(0.016);
    let constructed = 0;
    for (const n of names) {
      g[n] = new Proxy(saved[names.indexOf(n)] as object, {
        construct(target, args, newTarget) {
          constructed++;
          return Reflect.construct(target as new (...a: unknown[]) => object, args, newTarget);
        },
      });
    }
    for (let i = 0; i < 1000; i++) {
      graph.set('speed', (i % 100) / 100);
      graph.set('jump', i % 90 === 0);
      graph.update(0.016);
    }
    expect(constructed).toBe(0);
    expect(graph.state).toBeDefined();
  });

  it('a 2D blend space and pose-matched transitions allocate nothing over 500 frames', () => {
    const pts: [number, number][] = [];
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) pts.push([x, y]);
    const mixer = new AnimationMixer(skeleton(2), { maxActions: 16 });
    const graph = createAnimGraph(mixer, {
      params: { px: 0, py: 0, go: false },
      states: {
        m: {
          blend: {
            params: ['px', 'py'],
            points: pts.map((at, i) => ({ at, clip: constant(`p${i}`, i, 1) })),
          },
        },
        j: { clip: jump, loop: false },
      },
      transitions: [
        { from: 'm', to: 'j', when: (p) => p.go === true, fade: 0.1, matchPose: true },
        { from: 'j', to: 'm', when: () => true, fade: 0.1, exitTime: 1, matchPose: true },
      ],
      initial: 'm',
      match: { joints: [1] },
    });
    graph.update(0.016);
    let constructed = 0;
    for (const n of names) {
      g[n] = new Proxy(saved[names.indexOf(n)] as object, {
        construct(target, args, newTarget) {
          constructed++;
          return Reflect.construct(target as new (...a: unknown[]) => object, args, newTarget);
        },
      });
    }
    for (let i = 0; i < 500; i++) {
      graph.set('px', Math.sin(i * 0.1) * 1.5);
      graph.set('py', Math.cos(i * 0.07) * 1.5);
      graph.set('go', i % 90 === 0);
      graph.update(0.016);
    }
    expect(constructed).toBe(0);
  });
});

describe('2D blend spaces', () => {
  const S = Math.sqrt(3) / 2;
  const grid: [number, number][] = [];
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) grid.push([x, y]);
  function strafe(points: [number, number][]) {
    const mixer = new AnimationMixer(skeleton(), { maxActions: 16 });
    const g = createAnimGraph(mixer, {
      params: { px: 0, py: 0 },
      states: {
        m: {
          blend: {
            params: ['px', 'py'],
            points: points.map((at, i) => ({ at, clip: constant(`p${i}`, i, 1) })),
          },
        },
      },
      transitions: [],
      initial: 'm',
    });
    return { mixer, g };
  }
  function at(g: AnimGraph, px: number, py: number): number[] {
    g.set('px', px);
    g.set('py', py);
    g.update(0);
    return weights(g, 'm');
  }

  it('a query on a sample returns that clip at 1 (3×3 grid)', () => {
    const { g } = strafe(grid);
    for (let i = 0; i < grid.length; i++) {
      const w = at(g, grid[i]![0], grid[i]![1]);
      expect(w[i]).toBeCloseTo(1, 6);
      expect(sum(w)).toBeCloseTo(1, 6);
      for (let j = 0; j < w.length; j++) if (j !== i) expect(w[j]).toBeCloseTo(0, 6);
    }
  });

  it('the centre of three equilateral samples returns a third each', () => {
    const { g } = strafe([
      [0, 1],
      [-S, -0.5],
      [S, -0.5],
    ]);
    const w = at(g, 0, 0);
    expect(w[0]).toBeCloseTo(1 / 3, 6);
    expect(w[1]).toBeCloseTo(1 / 3, 6);
    expect(w[2]).toBeCloseTo(1 / 3, 6);
  });

  it('weights sum to 1 and stay non-negative off the grid', () => {
    const { g } = strafe(grid);
    for (let k = 0; k < 50; k++) {
      const w = at(g, Math.sin(k * 7.1) * 1.3, Math.cos(k * 3.3) * 1.3);
      expect(sum(w)).toBeCloseTo(1, 5);
      for (const v of w) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('a query outside the hull clamps to the hull', () => {
    const { g } = strafe(grid);
    // Far right: the same as the right edge midpoint, the (1, 0) sample alone.
    expect(at(g, 10, 0)).toEqual(at(g, 1, 0));
    expect(at(g, 1, 0)[5]).toBeCloseTo(1, 6);
    // Far corner: the corner sample alone.
    expect(at(g, 10, 10)[8]).toBeCloseTo(1, 6);
    // Off the top edge between two samples: only those two share the weight.
    const w = at(g, 0.5, 5);
    expect(w[7]).toBeCloseTo(0.5, 6);
    expect(w[8]).toBeCloseTo(0.5, 6);
  });

  it('degenerate layouts: one point, and points on a line', () => {
    expect(at(strafe([[2, 3]]).g, -5, 9)).toEqual([1]);
    const { g } = strafe([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    const w = at(g, 0.5, 7);
    expect(w[0]).toBeCloseTo(0.5, 6);
    expect(w[1]).toBeCloseTo(0.5, 6);
    expect(w[2]).toBeCloseTo(0, 6);
  });

  it('rejects an unknown parameter', () => {
    const mixer = new AnimationMixer(skeleton());
    expect(() =>
      createAnimGraph(mixer, {
        params: { px: 0 },
        states: { m: { blend: { params: ['px', 'py'], points: [{ at: [0, 0], clip: idle }] } } },
        transitions: [],
        initial: 'm',
      }),
    ).toThrow(/unknown param 'py'/);
  });
});

describe('matchPose transitions', () => {
  /** Node 1 x ramps 0 → 1 over 1 s, so each frame of the clip has a distinct pose. */
  function travel(name: string): AnimationClip {
    return {
      name,
      duration: 1,
      channels: [
        {
          node: 1,
          path: 'translation',
          interpolation: 'LINEAR',
          times: f32([0, 1]),
          values: f32([0, 0, 0, 1, 0, 0]),
        },
      ],
    };
  }

  it('starts the target at the frame nearest the pose left, within one sample', () => {
    const mixer = new AnimationMixer(skeleton(2));
    const g = createAnimGraph(mixer, {
      params: { go: false },
      states: { a: { clip: travel('a') }, b: { clip: travel('b') } },
      transitions: [{ from: 'a', to: 'b', when: (p) => p.go === true, fade: 0.1, matchPose: true }],
      initial: 'a',
      match: { joints: [1], sampleRate: 30 },
    });
    for (let i = 0; i < 24; i++) g.update(1 / 60); // t = 0.4
    g.set('go', true);
    g.update(1 / 60);
    const t = g.actions('b')[0]!.time;
    // Matched at 0.4 (± one sample at 30 Hz) then advanced by one update.
    expect(Math.abs(t - (0.4 + 1 / 60))).toBeLessThanOrEqual(1 / 30 + 1e-6);
  });

  it('without match features the target starts at 0', () => {
    const mixer = new AnimationMixer(skeleton(2));
    const g = createAnimGraph(mixer, {
      params: { go: false },
      states: { a: { clip: travel('a') }, b: { clip: travel('b') } },
      transitions: [{ from: 'a', to: 'b', when: (p) => p.go === true, fade: 0, matchPose: true }],
      initial: 'a',
    });
    for (let i = 0; i < 24; i++) g.update(1 / 60);
    g.set('go', true);
    g.update(1 / 60);
    expect(g.actions('b')[0]!.time).toBeCloseTo(1 / 60, 6);
  });

  it('go() with matchPose matches too, and a blend target sets its phase', () => {
    const mixer = new AnimationMixer(skeleton(2));
    const g = createAnimGraph(mixer, {
      params: { s: 0 },
      states: {
        a: { clip: travel('a') },
        m: {
          blend: {
            param: 's',
            points: [
              { at: 0, clip: travel('m0') },
              { at: 1, clip: travel('m1') },
            ],
          },
        },
      },
      transitions: [],
      initial: 'a',
      match: { joints: [1] },
    });
    for (let i = 0; i < 36; i++) g.update(1 / 60); // t = 0.6
    g.go('m', 0, { matchPose: true });
    expect(Math.abs(g.phase('m') - 0.6)).toBeLessThanOrEqual(1 / 30 + 1e-6);
    g.go('a', 0);
    expect(g.actions('a')[0]!.time).toBe(0);
  });
});
