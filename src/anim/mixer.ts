/**
 * `AnimationMixer`: plays clips on a skeleton as weighted, layered actions and writes one
 * `Pose` per `update(dt)`.
 *
 * Composition, per update: `pose = rest`; then for each layer in ascending order, the layer's
 * override actions are averaged by effective weight (so a crossfade whose weights sum to 1
 * neither shrinks nor overshoots) and lerped onto the pose by `min(1, Σ weights)`, then the
 * layer's additive actions are added with their own weights. An action's effective weight is
 * `action.weight × fade`, where fades come from `fadeIn`, `crossFade` and `stop(action, fade)`.
 *
 * Actions come from a fixed pool (`maxActions`, default 8); `play` reuses a finished slot and
 * throws when none is free. After the pool and the per-action cursors exist, `update` allocates
 * nothing.
 */
import {
  type AnimationClip,
  type BlendMode,
  type ClipCursor,
  createClipCursor,
  sampleClip,
} from './clip';
import { blendPose, createPose, type Pose, type Skeleton } from './pose';

export interface PlayOptions {
  /** Layer, ascending order of application. Default 0. */
  layer?: number;
  /** Target weight, 0..1. Default 1. */
  weight?: number;
  /** Loop at `clip.duration` (default true); `false` holds the last frame and sets `finished`. */
  loop?: boolean;
  /** Time scale; negative plays backwards. Default 1. */
  speed?: number;
  /** Seconds to fade the weight in from 0. Default 0. */
  fadeIn?: number;
  /** `'override'` (default) or `'additive'`, see `sampleClip`. */
  blend?: BlendMode;
  /** Start time in seconds. Default 0 (or `clip.duration` when `speed < 0`). */
  startTime?: number;
}

export type AnimationEventListener = (name: string, action: AnimationAction) => void;

/** One playing clip. Fields marked settable may be changed between updates. */
export class AnimationAction {
  /** The clip; `null` while the slot is free. */
  clip: AnimationClip | null = null;
  layer = 0;
  /** Target weight (settable). */
  weight = 1;
  /** Settable. */
  loop = true;
  /** Settable. */
  speed = 1;
  /** Current time in seconds, settable (wrapped into `[0, duration)` when looping). */
  time = 0;
  /** Settable: a paused action keeps its pose and weight but does not advance. */
  paused = false;
  blend: BlendMode = 'override';
  /** True once a non-looping action reached its end (or start when reversed). */
  finished = false;
  /** `weight × fade` from the last update; what the pose actually used. */
  effectiveWeight = 0;
  /** @internal */
  fadeFrom = 1;
  /** @internal */
  fadeTo = 1;
  /** @internal */
  fadeDuration = 0;
  /** @internal */
  fadeElapsed = 0;
  /** @internal first update after `play` includes events at exactly `startTime`. */
  fresh = true;
  /** @internal */
  cursor: ClipCursor = new Uint32Array(1);

  /** True while the action contributes to the mixer. */
  get active(): boolean {
    return this.clip !== null;
  }

  /** The fade factor now (0..1). */
  get fade(): number {
    if (this.fadeDuration <= 0) return this.fadeTo;
    const u = Math.min(1, this.fadeElapsed / this.fadeDuration);
    return this.fadeFrom + (this.fadeTo - this.fadeFrom) * u;
  }

  /** @internal */
  startFade(to: number, seconds: number): void {
    this.fadeFrom = this.fade;
    this.fadeTo = to;
    this.fadeDuration = seconds;
    this.fadeElapsed = 0;
  }
}

export interface AnimationMixerOptions {
  /** Pool size: the most actions playing (including fading out) at once. Default 8. */
  maxActions?: number;
}

export class AnimationMixer {
  readonly skeleton: Skeleton;
  /** The composed pose, rewritten by every `update`. */
  readonly pose: Pose;
  /** Every slot of the pool, free or not; filter on `active`. */
  readonly actions: readonly AnimationAction[];
  private readonly scratch: Pose;
  private readonly listeners: AnimationEventListener[] = [];

  constructor(skeleton: Skeleton, opts: AnimationMixerOptions = {}) {
    this.skeleton = skeleton;
    this.pose = createPose(skeleton);
    this.scratch = createPose(skeleton);
    const n = Math.max(1, opts.maxActions ?? 8);
    const pool: AnimationAction[] = [];
    for (let i = 0; i < n; i++) pool.push(new AnimationAction());
    this.actions = pool;
  }

  /** Number of active actions. */
  get playing(): number {
    let n = 0;
    for (const a of this.actions) if (a.clip) n++;
    return n;
  }

  /** Start `clip` in a free slot. Throws when the pool (`maxActions`) is full. */
  play(clip: AnimationClip, opts: PlayOptions = {}): AnimationAction {
    let slot: AnimationAction | null = null;
    for (const a of this.actions) {
      if (!a.clip) {
        slot = a;
        break;
      }
    }
    if (!slot)
      throw new Error(`AnimationMixer: all ${this.actions.length} action slots are playing`);
    slot.clip = clip;
    slot.layer = opts.layer ?? 0;
    slot.weight = opts.weight ?? 1;
    slot.loop = opts.loop ?? true;
    slot.speed = opts.speed ?? 1;
    slot.blend = opts.blend ?? 'override';
    slot.paused = false;
    slot.finished = false;
    slot.fresh = true;
    slot.time = opts.startTime ?? (slot.speed < 0 ? clip.duration : 0);
    slot.fadeFrom = 1;
    slot.fadeTo = 1;
    slot.fadeDuration = 0;
    slot.fadeElapsed = 0;
    if (opts.fadeIn && opts.fadeIn > 0) {
      slot.fadeFrom = 0;
      slot.fadeDuration = opts.fadeIn;
    }
    slot.effectiveWeight = slot.weight * slot.fade;
    if (slot.cursor.length < clip.channels.length) slot.cursor = createClipCursor(clip);
    else slot.cursor.fill(0);
    return slot;
  }

  /**
   * Fade `from` out over `seconds` (it stops at 0) while `to` fades in on the same layer; the
   * two effective weights sum to `from.weight` throughout when `to.weight` matches. `to` may be
   * a clip (started here) or an action already playing. Returns the incoming action.
   */
  crossFade(
    from: AnimationAction,
    to: AnimationClip | AnimationAction,
    seconds: number,
    opts: PlayOptions = {},
  ): AnimationAction {
    const target =
      to instanceof AnimationAction
        ? to
        : this.play(to, {
            layer: from.layer,
            weight: from.weight,
            blend: from.blend,
            ...opts,
            fadeIn: seconds,
          });
    if (target !== from) {
      if (to instanceof AnimationAction && (target.fade < 1 || target.fadeTo < 1)) {
        target.startFade(1, seconds);
        target.effectiveWeight = target.weight * target.fade;
      }
      this.stop(from, seconds);
    }
    return target;
  }

  /** Stop an action, at once or after a fade-out of `seconds`. */
  stop(action: AnimationAction, seconds = 0): void {
    if (!action.clip) return;
    if (seconds > 0) action.startFade(0, seconds);
    else this.release(action);
  }

  /** Stop every action at once. */
  stopAll(): void {
    for (const a of this.actions) if (a.clip) this.release(a);
    this.pose.set(this.skeleton.rest);
  }

  /** Listen for `clip.events` crossings. Returns the unsubscribe function. */
  onEvent(cb: AnimationEventListener): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Advance every action by `dt` seconds and recompose `pose`. */
  update(dt: number): void {
    const actions = this.actions;
    let minLayer = Number.POSITIVE_INFINITY;
    let maxLayer = Number.NEGATIVE_INFINITY;
    for (const a of actions) {
      if (!a.clip) continue;
      this.advance(a, dt);
      if (!a.clip) continue;
      if (a.layer < minLayer) minLayer = a.layer;
      if (a.layer > maxLayer) maxLayer = a.layer;
    }
    const pose = this.pose;
    pose.set(this.skeleton.rest);
    if (minLayer > maxLayer) return;
    const scratch = this.scratch;
    for (let layer = minLayer; layer <= maxLayer; layer++) {
      let sum = 0;
      for (const a of actions) {
        if (!a.clip || a.layer !== layer || a.blend !== 'override' || a.effectiveWeight <= 0)
          continue;
        if (sum === 0) scratch.set(pose);
        sum += a.effectiveWeight;
        sampleClip(a.clip, a.time, scratch, a.effectiveWeight / sum, 'override', a.cursor);
      }
      if (sum > 0) blendPose(pose, scratch, Math.min(sum, 1), pose);
      for (const a of actions) {
        if (!a.clip || a.layer !== layer || a.blend !== 'additive' || a.effectiveWeight <= 0)
          continue;
        sampleClip(a.clip, a.time, pose, a.effectiveWeight, 'additive', a.cursor);
      }
    }
  }

  private release(action: AnimationAction): void {
    action.clip = null;
    action.effectiveWeight = 0;
    action.fadeTo = 1;
    action.fadeFrom = 1;
    action.fadeDuration = 0;
  }

  private advance(a: AnimationAction, dt: number): void {
    const clip = a.clip!;
    if (a.fadeDuration > 0) {
      a.fadeElapsed += dt;
      if (a.fadeElapsed >= a.fadeDuration) {
        a.fadeFrom = a.fadeTo;
        a.fadeDuration = 0;
        if (a.fadeTo <= 0) {
          this.release(a);
          return;
        }
      }
    }
    a.effectiveWeight = a.weight * a.fade;
    const d = clip.duration;
    const prev = a.time;
    const fresh = a.fresh;
    a.fresh = false;
    if (a.paused || (a.finished && !a.loop)) {
      if (fresh) this.fireEvents(a, prev, prev, true);
      return;
    }
    let next = prev + dt * a.speed;
    if (d <= 0) {
      a.time = 0;
      if (!a.loop) a.finished = true;
      return;
    }
    if (!a.loop) {
      if (a.speed >= 0 && next >= d) {
        next = d;
        a.finished = true;
      } else if (a.speed < 0 && next <= 0) {
        next = 0;
        a.finished = true;
      }
      this.fireEvents(a, prev, next, fresh);
      a.time = next;
      return;
    }
    this.fireEvents(a, prev, next, fresh);
    // Wrap into [0, d).
    let w = next % d;
    if (w < 0) w += d;
    a.time = w;
  }

  /**
   * Fire events whose time lies in `(prev, next]` (or `[prev, next]` when `inclusive`),
   * unwrapped: looping actions see the clip repeated, so `e + k·duration` counts.
   */
  private fireEvents(a: AnimationAction, prev: number, next: number, inclusive: boolean): void {
    const clip = a.clip!;
    const events = clip.events;
    if (!events || events.length === 0 || this.listeners.length === 0) return;
    const d = clip.duration;
    const forward = next >= prev;
    const lo = forward ? prev : next;
    const hi = forward ? next : prev;
    // Loop repetitions that can touch [lo, hi]; events fire in playback order (k outer, the
    // clip's event order inner, both reversed when playing backwards).
    const loops = a.loop && d > 0;
    const kLo = loops ? Math.floor(lo / d) - 1 : 0;
    const kHi = loops ? Math.floor(hi / d) + 1 : 0;
    const n = events.length;
    for (let s = 0; s <= kHi - kLo; s++) {
      const k = forward ? kLo + s : kHi - s;
      for (let j = 0; j < n; j++) {
        const e = events[forward ? j : n - 1 - j]!;
        const et = e.time + k * d;
        if (this.crosses(et, prev, next, inclusive && k === 0, forward)) this.emit(e.name, a);
      }
    }
  }

  private crosses(
    et: number,
    prev: number,
    next: number,
    inclusive: boolean,
    forward: boolean,
  ): boolean {
    if (forward) return (inclusive ? et >= prev : et > prev) && et <= next;
    return (inclusive ? et <= prev : et < prev) && et >= next;
  }

  private emit(name: string, a: AnimationAction): void {
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i]!(name, a);
  }
}
