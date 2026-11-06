/**
 * `createAnimGraph`: a small state graph on top of `AnimationMixer`. States hold one clip or a
 * 1D blend space; transitions carry a condition over a shared parameter object, a fade time
 * and an optional exit time; the game sets parameters each frame and calls `update(dt)`.
 *
 * Every clip of every state is started on the mixer at construction with weight 0 and stays in
 * its slot for the life of the graph: the graph owns the weights, so a transition is a lerp of
 * every state's weight toward the target (1 for the state entered, 0 for the rest), and the
 * weights sum to 1 at every instant, also when a fade is interrupted by another. A 1D blend
 * space weights the two points around the parameter and, with `syncPhase` (default), keeps
 * one normalised phase across its clips so blended cycles stay in step. After construction
 * `update` allocates nothing; conditions receive the same parameter object every time.
 */
import type { AnimationClip } from './clip';
import type { AnimationAction, AnimationMixer } from './mixer';

/** The parameters the game sets; the same object is passed to every condition. */
export type AnimGraphParams = Record<string, number | boolean>;

/** A state playing one clip. `speed` default 1, `loop` default true. */
export interface AnimGraphClipState {
  clip: AnimationClip;
  speed?: number;
  loop?: boolean;
}

/** One sample of a 1D blend space: `clip` at parameter value `at`. */
export interface AnimGraphBlendPoint {
  at: number;
  clip: AnimationClip;
}

/**
 * A state blending clips along one numeric parameter. The two points around the parameter
 * value share the weight linearly; beyond the ends the nearest point takes it all.
 * `syncPhase` (default true) runs every clip at one normalised time, at the rate of the blended
 * cycle length, so walk and run keep their feet in step; `false` plays each at its own speed.
 */
export interface AnimGraphBlendState {
  blend: {
    param: string;
    points: AnimGraphBlendPoint[];
    syncPhase?: boolean;
  };
}

export type AnimGraphStateDesc = AnimGraphClipState | AnimGraphBlendState;

export interface AnimGraphTransition {
  /** The state this leaves, or `'*'` for any state other than `to`. */
  from: string | '*';
  to: string;
  /** Read `params`; return true to take the transition. Must not allocate. */
  when: (params: AnimGraphParams) => boolean;
  /** Cross-fade seconds; 0 switches at once. */
  fade: number;
  /**
   * Normalised time (0..1) the current state must have passed before the transition can fire:
   * `time / duration` for a clip, the shared phase for a synced blend space (the first point's
   * phase otherwise). A finished non-looping clip counts as 1.
   */
  exitTime?: number;
}

export interface AnimGraphDesc {
  params: AnimGraphParams;
  states: Record<string, AnimGraphStateDesc>;
  /** Evaluated in order every update; the first whose condition holds wins. */
  transitions: AnimGraphTransition[];
  initial: string;
}

/** `(from, to)` of the change that fired the callback. */
export type AnimGraphListener = (from: string, to: string) => void;

export interface AnimGraph {
  /** The parameters, the object `desc.params` was copied into; conditions read this. */
  readonly params: AnimGraphParams;
  /** The current state (the target of the latest transition, from the instant it fires). */
  readonly state: string;
  /** The state the latest transition left, or `state` before any transition. */
  readonly previous: string;
  /** Set one parameter. Throws for a name `desc.params` did not declare. */
  set(param: string, value: number | boolean): void;
  /** Read one parameter. */
  get(param: string): number | boolean;
  /**
   * Evaluate the transitions (in order; first match wins), advance the fades and the blend
   * phases, write every action's weight, speed and time, then `mixer.update(dt)`.
   */
  update(dt: number): void;
  /** Fired after the state changes to `state` (`from` is the state left). Returns unsubscribe. */
  onEnter(state: string, fn: AnimGraphListener): () => void;
  /** Fired before `onEnter` when the state leaves `state` (`to` is the state entered). */
  onExit(state: string, fn: AnimGraphListener): () => void;
  /** The state's share of the pose, 0..1 (1 once its fade-in finished). */
  weight(state: string): number;
  /** The mixer actions of a state, in `points` order for a blend space (one for a clip). */
  actions(state: string): readonly AnimationAction[];
  /** Normalised time (0..1) of a state: its clip's `time / duration` or the blend phase. */
  phase(state: string): number;
  /** Force `state` now (or over `fade` seconds), ignoring the transitions. */
  go(state: string, fade?: number): void;
}

interface StateNode {
  name: string;
  actions: AnimationAction[];
  /** Blend space: sorted parameter values, one per action; empty for a clip state. */
  at: Float32Array;
  /** Blend space: each clip's duration. */
  durations: Float32Array;
  /** Blend space: the current per-point weights (sum 1). */
  blendWeights: Float32Array;
  blendParam: string;
  syncPhase: boolean;
  /** Synced blend space: the shared normalised phase, 0..1. */
  phase: number;
  /** Clip state: the speed multiplier. */
  speed: number;
  /** Overall weight now, and the weight the current fade started from. */
  weight: number;
  fadeFrom: number;
  /** 1 for the state being entered, else 0. */
  target: number;
  enter: AnimGraphListener[];
  exit: AnimGraphListener[];
}

class AnimGraphImpl implements AnimGraph {
  readonly params: AnimGraphParams;
  private readonly mixer: AnimationMixer;
  private readonly nodes: StateNode[] = [];
  private readonly byName = new Map<string, StateNode>();
  private readonly transitions: AnimGraphTransition[];
  private current: StateNode;
  private prev: StateNode;
  private fadeDuration = 0;
  private fadeElapsed = 0;

  constructor(mixer: AnimationMixer, desc: AnimGraphDesc) {
    this.mixer = mixer;
    this.params = { ...desc.params };
    this.transitions = desc.transitions.slice();
    for (const name of Object.keys(desc.states)) {
      const node = this.build(name, desc.states[name]!);
      this.nodes.push(node);
      this.byName.set(name, node);
    }
    for (const t of this.transitions) {
      if (t.from !== '*' && !this.byName.has(t.from))
        throw new Error(`AnimGraph: transition from unknown state '${t.from}'`);
      if (!this.byName.has(t.to))
        throw new Error(`AnimGraph: transition to unknown state '${t.to}'`);
    }
    const initial = this.byName.get(desc.initial);
    if (!initial) throw new Error(`AnimGraph: unknown initial state '${desc.initial}'`);
    this.current = initial;
    this.prev = initial;
    initial.weight = 1;
    initial.fadeFrom = 1;
    initial.target = 1;
    this.restart(initial);
    for (const n of this.nodes) this.apply(n);
  }

  get state(): string {
    return this.current.name;
  }

  get previous(): string {
    return this.prev.name;
  }

  set(param: string, value: number | boolean): void {
    if (!(param in this.params)) throw new Error(`AnimGraph: unknown param '${param}'`);
    this.params[param] = value;
  }

  get(param: string): number | boolean {
    const v = this.params[param];
    if (v === undefined) throw new Error(`AnimGraph: unknown param '${param}'`);
    return v;
  }

  onEnter(state: string, fn: AnimGraphListener): () => void {
    return subscribe(this.node(state).enter, fn);
  }

  onExit(state: string, fn: AnimGraphListener): () => void {
    return subscribe(this.node(state).exit, fn);
  }

  weight(state: string): number {
    return this.node(state).weight;
  }

  actions(state: string): readonly AnimationAction[] {
    return this.node(state).actions;
  }

  phase(state: string): number {
    return this.phaseOf(this.node(state));
  }

  go(state: string, fade = 0): void {
    this.transition(this.node(state), fade);
  }

  update(dt: number): void {
    const transitions = this.transitions;
    const current = this.current;
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i]!;
      if (t.from === '*' ? t.to === current.name : t.from !== current.name) continue;
      if (t.exitTime !== undefined && this.phaseOf(current) < t.exitTime) continue;
      if (!t.when(this.params)) continue;
      this.transition(this.byName.get(t.to)!, t.fade);
      break;
    }
    // Fades: every state lerps from where the fade found it toward its target.
    const nodes = this.nodes;
    if (this.fadeDuration > 0) {
      this.fadeElapsed += dt;
      const u = Math.min(1, this.fadeElapsed / this.fadeDuration);
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        n.weight = n.fadeFrom + (n.target - n.fadeFrom) * u;
      }
      if (u >= 1) this.fadeDuration = 0;
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      this.apply(n);
      if (n.at.length > 0 && n.syncPhase) {
        // The mixer advances every clip by dt × d_i / D this update, so the phase gains dt / D.
        const cycle = this.blendedCycle(n);
        if (cycle > 0) {
          let p = (n.phase + dt / cycle) % 1;
          if (p < 0) p += 1;
          n.phase = p;
        }
      }
    }
    this.mixer.update(dt);
  }

  private build(name: string, desc: AnimGraphStateDesc): StateNode {
    const node: StateNode = {
      name,
      actions: [],
      at: new Float32Array(0),
      durations: new Float32Array(0),
      blendWeights: new Float32Array(0),
      blendParam: '',
      syncPhase: false,
      phase: 0,
      speed: 1,
      weight: 0,
      fadeFrom: 0,
      target: 0,
      enter: [],
      exit: [],
    };
    if ('blend' in desc) {
      const { param, points, syncPhase = true } = desc.blend;
      if (points.length === 0) throw new Error(`AnimGraph: state '${name}' has no blend points`);
      if (!(param in this.params))
        throw new Error(`AnimGraph: state '${name}' blends on unknown param '${param}'`);
      const sorted = points.slice().sort((a, b) => a.at - b.at);
      node.at = new Float32Array(sorted.length);
      node.durations = new Float32Array(sorted.length);
      node.blendWeights = new Float32Array(sorted.length);
      node.blendParam = param;
      node.syncPhase = syncPhase;
      for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i]!;
        node.at[i] = p.at;
        node.durations[i] = p.clip.duration;
        node.actions.push(this.mixer.play(p.clip, { weight: 0 }));
      }
    } else {
      node.speed = desc.speed ?? 1;
      node.actions.push(
        this.mixer.play(desc.clip, { weight: 0, speed: node.speed, loop: desc.loop ?? true }),
      );
    }
    return node;
  }

  private node(name: string): StateNode {
    const n = this.byName.get(name);
    if (!n) throw new Error(`AnimGraph: unknown state '${name}'`);
    return n;
  }

  /** Switch to `to`: callbacks, restart its clips and start the fade. */
  private transition(to: StateNode, fade: number): void {
    const from = this.current;
    if (to === from) return;
    this.prev = from;
    this.current = to;
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      n.fadeFrom = n.weight;
      n.target = n === to ? 1 : 0;
    }
    this.restart(to);
    if (fade > 0) {
      this.fadeDuration = fade;
      this.fadeElapsed = 0;
    } else {
      this.fadeDuration = 0;
      for (let i = 0; i < nodes.length; i++) nodes[i]!.weight = nodes[i]!.target;
    }
    fire(from.exit, from.name, to.name);
    fire(to.enter, from.name, to.name);
  }

  /** Rewind a state's clips so it plays from its start when entered. */
  private restart(n: StateNode): void {
    const actions = n.actions;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]!;
      a.time = a.speed < 0 ? a.clip!.duration : 0;
      a.finished = false;
      a.paused = false;
    }
    n.phase = 0;
  }

  /** Write the node's weight (and blend weights, speeds, times) onto its actions. */
  private apply(n: StateNode): void {
    const actions = n.actions;
    if (n.at.length === 0) {
      actions[0]!.weight = n.weight;
      return;
    }
    this.blendWeightsOf(n);
    const sync = n.syncPhase;
    const cycle = sync ? this.blendedCycle(n) : 0;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]!;
      a.weight = n.weight * n.blendWeights[i]!;
      if (sync) {
        const d = n.durations[i]!;
        a.speed = cycle > 0 ? d / cycle : 0;
        a.time = n.phase * d;
      }
    }
  }

  /** Weights of the two points around the parameter, into `n.blendWeights`. */
  private blendWeightsOf(n: StateNode): void {
    const v = this.params[n.blendParam];
    const x = typeof v === 'number' ? v : v ? 1 : 0;
    const at = n.at;
    const w = n.blendWeights;
    w.fill(0);
    const last = at.length - 1;
    if (x <= at[0]!) {
      w[0] = 1;
      return;
    }
    if (x >= at[last]!) {
      w[last] = 1;
      return;
    }
    let i = 0;
    while (at[i + 1]! < x) i++;
    const span = at[i + 1]! - at[i]!;
    const t = span > 0 ? (x - at[i]!) / span : 1;
    w[i] = 1 - t;
    w[i + 1] = t;
  }

  /** Cycle length of a blend space now: the weighted mean of its clips' durations. */
  private blendedCycle(n: StateNode): number {
    let d = 0;
    for (let i = 0; i < n.durations.length; i++) d += n.blendWeights[i]! * n.durations[i]!;
    return d;
  }

  private phaseOf(n: StateNode): number {
    if (n.at.length > 0 && n.syncPhase) return n.phase;
    const a = n.actions[0]!;
    const d = a.clip!.duration;
    if (a.finished || d <= 0) return 1;
    return a.time / d;
  }
}

function subscribe(list: AnimGraphListener[], fn: AnimGraphListener): () => void {
  list.push(fn);
  return () => {
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}

function fire(list: AnimGraphListener[], from: string, to: string): void {
  for (let i = 0; i < list.length; i++) list[i]!(from, to);
}

/**
 * Build a graph over `mixer`. Every clip of every state is started on the mixer here (weight
 * 0, one action slot each: size `maxActions` to fit), so nothing is created later.
 */
export function createAnimGraph(mixer: AnimationMixer, desc: AnimGraphDesc): AnimGraph {
  return new AnimGraphImpl(mixer, desc);
}
