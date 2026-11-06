/**
 * `createAnimGraph`: a small state graph on top of `AnimationMixer`. States hold one clip or a
 * 1D blend space; transitions carry a condition over a shared parameter object, a fade time
 * and an optional exit time; the game sets parameters each frame and calls `update(dt)`.
 *
 * Every clip of every state is started on the mixer at construction with weight 0 and stays in
 * its slot for the life of the graph: the graph owns the weights, so a transition is a lerp of
 * every state's weight toward the target (1 for the state entered, 0 for the rest), and the
 * weights sum to 1 at every instant, also when a fade is interrupted by another. A 1D blend
 * space weights the two points around the parameter; a 2D one (two parameters, points
 * anywhere in the plane: a strafe set) weights every point by gradient-band interpolation
 * (Johansen: each point's weight is the smallest of its clamped "how far toward me rather than
 * toward point j" terms, normalised) after clamping the query to the convex hull of the points,
 * computed once. Both keep one normalised phase across their clips with `syncPhase` (default)
 * so blended cycles stay in step. A transition with `matchPose` starts its target at the clip
 * frame nearest the pose it leaves (`match.ts`) when the graph was built with `match`. After
 * construction `update` allocates nothing; conditions receive the same parameter object every
 * time.
 */
import type { AnimationClip } from './clip';
import {
  buildPoseFeatures,
  findBestFrame,
  firstRoot,
  type PoseFeatures,
  type PoseMatch,
  rootSpacePositions,
} from './match';
import type { AnimationAction, AnimationMixer } from './mixer';
import { poseToWorld, WORLD_NODE_FLOATS } from './pose';

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

/** One sample of a 2D blend space: `clip` at the parameter pair `at`. */
export interface AnimGraphBlendPoint2D {
  at: [number, number];
  clip: AnimationClip;
}

/** A 1D blend space: the two points around `param` share the weight linearly. */
export interface AnimGraphBlend1D {
  param: string;
  points: AnimGraphBlendPoint[];
  syncPhase?: boolean;
}

/**
 * A 2D blend space over two parameters (a strafe set: `[forward, sideways]`). Weights come
 * from gradient-band interpolation over the points (any layout, no triangulation): a query on
 * a point returns that clip alone, the centre of three equal-sided points returns a third each,
 * and a query outside the points' convex hull is clamped to the hull first.
 */
export interface AnimGraphBlend2D {
  params: [string, string];
  points: AnimGraphBlendPoint2D[];
  syncPhase?: boolean;
}

/**
 * A state blending clips along one numeric parameter (`AnimGraphBlend1D`) or over two
 * (`AnimGraphBlend2D`). `syncPhase` (default true) runs every clip at one normalised time, at
 * the rate of the blended cycle length, so walk and run keep their feet in step; `false` plays
 * each at its own speed.
 */
export interface AnimGraphBlendState {
  blend: AnimGraphBlend1D | AnimGraphBlend2D;
}

export type AnimGraphStateDesc = AnimGraphClipState | AnimGraphBlendState;

/**
 * Pose matching for transitions (`AnimGraphTransition.matchPose`): the graph builds
 * `PoseFeatures` for every clip of every state over these joints at construction, tracks the
 * pose's world matrices and joint velocities each update, and starts a matched transition's
 * target at the nearest frame. Without this a `matchPose` transition starts at 0.
 */
export interface AnimGraphMatchDesc {
  /** Node indices to match on (feet, hands, head). */
  joints: ArrayLike<number>;
  /** Samples per second of the features. Default 30. */
  sampleRate?: number;
  /** Weight of the velocity term, see `findBestFrame`. Default 0.05. */
  velocityWeight?: number;
  /** The node whose frame is root space. Default: the first node with no parent. */
  root?: number;
}

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
  /**
   * Start the target at the clip frame nearest the pose being left (`findBestFrame` over the
   * features built from `AnimGraphDesc.match`) instead of at 0. For a blend space the point
   * with the largest weight at that instant is matched and its time sets the shared phase.
   */
  matchPose?: boolean;
}

export interface AnimGraphDesc {
  params: AnimGraphParams;
  states: Record<string, AnimGraphStateDesc>;
  /** Evaluated in order every update; the first whose condition holds wins. */
  transitions: AnimGraphTransition[];
  initial: string;
  /** Pose-matching features for `matchPose` transitions; absent, they start at 0. */
  match?: AnimGraphMatchDesc;
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
  /**
   * Force `state` now (or over `fade` seconds), ignoring the transitions; `matchPose` as on a
   * transition (needs the graph's `match`).
   */
  go(state: string, fade?: number, opts?: { matchPose?: boolean }): void;
}

interface StateNode {
  name: string;
  actions: AnimationAction[];
  /** 0 for a clip state, 1 or 2 for a blend space. */
  dims: number;
  /** 1D blend space: sorted parameter values, one per action; empty otherwise. */
  at: Float32Array;
  /** 2D blend space: `x y` per point, in `actions` order; empty otherwise. */
  at2: Float32Array;
  /** 2D blend space: point indices of the convex hull, counter-clockwise. */
  hull: Int16Array;
  /** The second parameter of a 2D blend space. */
  blendParamY: string;
  /** Pose features per action (when the graph has `match`), else empty. */
  features: PoseFeatures[];
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
  /**
   * Pose matching (`desc.match`): the pose's world matrices after each update, the feature
   * joints' root-space positions of this and the previous update, and their velocity.
   */
  private readonly match: AnimGraphMatchDesc | null;
  private readonly matchJoints: Int16Array;
  private readonly matchRoot: number;
  private readonly world: Float32Array;
  private posNow: Float32Array;
  private posPrev: Float32Array;
  private readonly velocity: Float32Array;
  private worldTicks = 0;
  private readonly matchOut: PoseMatch = { time: 0, cost: 0 };

  constructor(mixer: AnimationMixer, desc: AnimGraphDesc) {
    this.mixer = mixer;
    this.params = { ...desc.params };
    this.transitions = desc.transitions.slice();
    this.match = desc.match ?? null;
    this.matchJoints = Int16Array.from(desc.match?.joints ?? []);
    const nodes = mixer.skeleton.parents.length;
    this.world = new Float32Array(this.match ? nodes * WORLD_NODE_FLOATS : 0);
    this.posNow = new Float32Array(this.matchJoints.length * 3);
    this.posPrev = new Float32Array(this.matchJoints.length * 3);
    this.velocity = new Float32Array(this.matchJoints.length * 3);
    this.matchRoot = desc.match?.root ?? firstRoot(mixer.skeleton);
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

  go(state: string, fade = 0, opts?: { matchPose?: boolean }): void {
    this.transition(this.node(state), fade, opts?.matchPose === true);
  }

  update(dt: number): void {
    const transitions = this.transitions;
    const current = this.current;
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i]!;
      if (t.from === '*' ? t.to === current.name : t.from !== current.name) continue;
      if (t.exitTime !== undefined && this.phaseOf(current) < t.exitTime) continue;
      if (!t.when(this.params)) continue;
      this.transition(this.byName.get(t.to)!, t.fade, t.matchPose === true);
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
      if (n.dims > 0 && n.syncPhase) {
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
    if (this.match) this.track(dt);
  }

  /** Pose matching: world matrices of the new pose and the feature joints' root-space velocity. */
  private track(dt: number): void {
    const prev = this.posNow;
    const now = this.posPrev;
    this.posNow = now;
    this.posPrev = prev;
    poseToWorld(this.mixer.skeleton, this.mixer.pose, this.world);
    rootSpacePositions(this.world, this.matchRoot, this.matchJoints, now);
    this.worldTicks++;
    // A frozen frame (dt 0, a pause) says nothing about the velocity: keep the last one.
    if (this.worldTicks > 1 && dt > 0) {
      const v = this.velocity;
      const inv = 1 / dt;
      for (let i = 0; i < v.length; i++) v[i] = (now[i]! - prev[i]!) * inv;
    }
  }

  private build(name: string, desc: AnimGraphStateDesc): StateNode {
    const node: StateNode = {
      name,
      actions: [],
      dims: 0,
      at: new Float32Array(0),
      at2: new Float32Array(0),
      hull: new Int16Array(0),
      blendParamY: '',
      features: [],
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
      const blend = desc.blend;
      const points = blend.points;
      if (points.length === 0) throw new Error(`AnimGraph: state '${name}' has no blend points`);
      node.syncPhase = blend.syncPhase ?? true;
      node.durations = new Float32Array(points.length);
      node.blendWeights = new Float32Array(points.length);
      if ('params' in blend) {
        for (const param of blend.params) {
          if (!(param in this.params))
            throw new Error(`AnimGraph: state '${name}' blends on unknown param '${param}'`);
        }
        node.dims = 2;
        node.blendParam = blend.params[0];
        node.blendParamY = blend.params[1];
        node.at2 = new Float32Array(points.length * 2);
        for (let i = 0; i < points.length; i++) {
          const p = blend.points[i]!;
          node.at2[i * 2] = p.at[0];
          node.at2[i * 2 + 1] = p.at[1];
          node.durations[i] = p.clip.duration;
          node.actions.push(this.mixer.play(p.clip, { weight: 0 }));
        }
        node.hull = convexHull(node.at2);
      } else {
        const param = blend.param;
        if (!(param in this.params))
          throw new Error(`AnimGraph: state '${name}' blends on unknown param '${param}'`);
        node.dims = 1;
        const sorted = blend.points.slice().sort((a, b) => a.at - b.at);
        node.at = new Float32Array(sorted.length);
        node.blendParam = param;
        for (let i = 0; i < sorted.length; i++) {
          const p = sorted[i]!;
          node.at[i] = p.at;
          node.durations[i] = p.clip.duration;
          node.actions.push(this.mixer.play(p.clip, { weight: 0 }));
        }
      }
    } else {
      node.speed = desc.speed ?? 1;
      node.actions.push(
        this.mixer.play(desc.clip, { weight: 0, speed: node.speed, loop: desc.loop ?? true }),
      );
    }
    const match = this.match;
    if (match) {
      for (const a of node.actions) {
        node.features.push(
          buildPoseFeatures(a.clip!, this.mixer.skeleton, {
            joints: match.joints,
            sampleRate: match.sampleRate,
            root: match.root,
          }),
        );
      }
    }
    return node;
  }

  private node(name: string): StateNode {
    const n = this.byName.get(name);
    if (!n) throw new Error(`AnimGraph: unknown state '${name}'`);
    return n;
  }

  /** Switch to `to`: callbacks, restart its clips (at the matched frame) and start the fade. */
  private transition(to: StateNode, fade: number, matchPose = false): void {
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
    if (matchPose && this.match && this.worldTicks > 0 && to.features.length > 0) {
      // Match the pose being left against the target clip (the heaviest point of a blend).
      let index = 0;
      if (to.dims > 0) {
        this.blendWeightsOf(to);
        for (let i = 1; i < to.blendWeights.length; i++) {
          if (to.blendWeights[i]! > to.blendWeights[index]!) index = i;
        }
      }
      const m = findBestFrame(
        to.features[index]!,
        this.world,
        this.velocity,
        this.match,
        this.matchOut,
      );
      const a = to.actions[index]!;
      const d = a.clip!.duration;
      const time = d > 0 ? Math.min(m.time, d) : 0;
      if (to.dims > 0 && to.syncPhase) {
        to.phase = d > 0 ? time / d : 0;
        for (let i = 0; i < to.actions.length; i++) {
          to.actions[i]!.time = to.phase * to.durations[i]!;
        }
      } else {
        a.time = time;
      }
    }
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
    if (n.dims === 0) {
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

  private paramValue(name: string): number {
    const v = this.params[name];
    return typeof v === 'number' ? v : v ? 1 : 0;
  }

  /** Blend weights of the state at the current parameters, into `n.blendWeights`. */
  private blendWeightsOf(n: StateNode): void {
    if (n.dims === 2) {
      gradientBand(
        n.at2,
        n.hull,
        this.paramValue(n.blendParam),
        this.paramValue(n.blendParamY),
        n.blendWeights,
      );
      return;
    }
    const x = this.paramValue(n.blendParam);
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
    if (n.dims > 0 && n.syncPhase) return n.phase;
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

/** Twice the signed area of (a, b, c): > 0 when counter-clockwise. */
function cross(pts: Float32Array, a: number, b: number, c: number): number {
  return (
    (pts[b * 2]! - pts[a * 2]!) * (pts[c * 2 + 1]! - pts[a * 2 + 1]!) -
    (pts[b * 2 + 1]! - pts[a * 2 + 1]!) * (pts[c * 2]! - pts[a * 2]!)
  );
}

/**
 * Convex hull of `x y` pairs (Andrew's monotone chain), counter-clockwise point indices;
 * collinear points on an edge are left out. One point → `[i]`; a segment → its two ends.
 * Called once per 2D blend state at construction.
 */
function convexHull(pts: Float32Array): Int16Array {
  const n = pts.length / 2;
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) => pts[a * 2]! - pts[b * 2]! || pts[a * 2 + 1]! - pts[b * 2 + 1]!);
  // Drop duplicate points so a repeated sample cannot wedge the chain.
  const unique: number[] = [];
  for (const i of order) {
    const last = unique[unique.length - 1];
    if (last === undefined || pts[i * 2] !== pts[last * 2] || pts[i * 2 + 1] !== pts[last * 2 + 1])
      unique.push(i);
  }
  if (unique.length < 3) return Int16Array.from(unique);
  const hull: number[] = [];
  for (const i of unique) {
    while (hull.length >= 2 && cross(pts, hull[hull.length - 2]!, hull[hull.length - 1]!, i) <= 0)
      hull.pop();
    hull.push(i);
  }
  const lowerLength = hull.length + 1;
  for (let k = unique.length - 2; k >= 0; k--) {
    const i = unique[k]!;
    while (
      hull.length >= lowerLength &&
      cross(pts, hull[hull.length - 2]!, hull[hull.length - 1]!, i) <= 0
    )
      hull.pop();
    hull.push(i);
  }
  hull.pop();
  return Int16Array.from(hull);
}

/** Clamp (x, y) to the hull: nearest point on its boundary when outside. */
const clamped = new Float32Array(2);
function clampToHull(pts: Float32Array, hull: Int16Array, x: number, y: number): void {
  clamped[0] = x;
  clamped[1] = y;
  const h = hull.length;
  if (h === 0) return;
  if (h === 1) {
    clamped[0] = pts[hull[0]! * 2]!;
    clamped[1] = pts[hull[0]! * 2 + 1]!;
    return;
  }
  if (h >= 3) {
    let inside = true;
    for (let k = 0; k < h; k++) {
      const a = hull[k]!;
      const b = hull[(k + 1) % h]!;
      const c =
        (pts[b * 2]! - pts[a * 2]!) * (y - pts[a * 2 + 1]!) -
        (pts[b * 2 + 1]! - pts[a * 2 + 1]!) * (x - pts[a * 2]!);
      if (c < 0) {
        inside = false;
        break;
      }
    }
    if (inside) return;
  }
  // Outside (or a segment hull): the nearest point over every edge.
  let best = Number.POSITIVE_INFINITY;
  const edges = h === 2 ? 1 : h;
  for (let k = 0; k < edges; k++) {
    const a = hull[k]!;
    const b = hull[(k + 1) % h]!;
    const ax = pts[a * 2]!;
    const ay = pts[a * 2 + 1]!;
    const ex = pts[b * 2]! - ax;
    const ey = pts[b * 2 + 1]! - ay;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / len2 : 0;
    t = Math.min(1, Math.max(0, t));
    const px = ax + ex * t;
    const py = ay + ey * t;
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < best) {
      best = d;
      clamped[0] = px;
      clamped[1] = py;
    }
  }
}

/**
 * Gradient-band interpolation: `w_i = min over j≠i of clamp(1 − ((q − a_i)·(a_j − a_i)) /
 * |a_j − a_i|², 0, 1)`, normalised to sum 1. A query on a sample gives that sample 1; the
 * weights are continuous in `q`. The query is first clamped to the hull. Allocation-free.
 */
function gradientBand(
  pts: Float32Array,
  hull: Int16Array,
  x: number,
  y: number,
  w: Float32Array,
): void {
  clampToHull(pts, hull, x, y);
  const qx = clamped[0]!;
  const qy = clamped[1]!;
  const n = pts.length / 2;
  let sum = 0;
  let nearest = 0;
  let nearestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const ix = pts[i * 2]!;
    const iy = pts[i * 2 + 1]!;
    const dx = qx - ix;
    const dy = qy - iy;
    const d = dx * dx + dy * dy;
    if (d < nearestD) {
      nearestD = d;
      nearest = i;
    }
    let wi = 1;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const ex = pts[j * 2]! - ix;
      const ey = pts[j * 2 + 1]! - iy;
      const len2 = ex * ex + ey * ey;
      if (len2 === 0) continue;
      let v = 1 - (dx * ex + dy * ey) / len2;
      v = Math.min(1, Math.max(0, v));
      if (v < wi) wi = v;
    }
    w[i] = wi;
    sum += wi;
  }
  if (sum > 0) {
    for (let i = 0; i < n; i++) w[i] = w[i]! / sum;
  } else {
    w.fill(0);
    w[nearest] = 1;
  }
}

/**
 * Build a graph over `mixer`. Every clip of every state is started on the mixer here (weight
 * 0, one action slot each: size `maxActions` to fit), so nothing is created later.
 */
export function createAnimGraph(mixer: AnimationMixer, desc: AnimGraphDesc): AnimGraph {
  return new AnimGraphImpl(mixer, desc);
}
