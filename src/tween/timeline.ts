/**
 * Groups and the manager. `SequenceTween` runs its children one after another, carrying the
 * leftover of a child's last step into the next; `ParallelTween` advances all of them and ends
 * with the last. Both are tweens themselves (delay, loops, yoyo, callbacks), so they nest.
 *
 * `Tweens` holds the root tweens and ticks them with `update(dt)`. A tween that completes or is
 * killed, even inside the update that is running, is compacted out at the end of that update;
 * tweens created during an update start on the next one.
 */
import {
  DelayTween,
  PropertyTween,
  type Tween,
  TweenBase,
  type TweenOptions,
  type TweenOwner,
  type TweenProps,
  ValueTween,
} from './tween';

/** Base of the two groups: takes the children out of the manager and drives them itself. */
abstract class GroupTween extends TweenBase {
  protected readonly children: TweenBase[];

  constructor(children: Tween[], opts: TweenOptions) {
    super(0, opts);
    this.children = children.map((c) => {
      if (!(c instanceof TweenBase)) throw new Error('tween: not a tween of this module');
      if (c.grouped) throw new Error('tween: a tween can join only one group');
      c.grouped = true;
      c.owner = null;
      c.listed = false;
      return c;
    });
    this.duration = this.childDuration();
  }

  /** @internal Kill the children whose target is `target`. */
  killTarget(target: object): void {
    for (const c of this.children) killTargetIn(c, target);
  }

  /** The length of one iteration, from the children's totals. */
  protected abstract childDuration(): number;

  /** Seconds of this iteration consumed, from the children. */
  protected abstract childConsumed(): number;

  protected resetChildren(): void {
    for (const c of this.children) c.reset(true);
  }

  protected onIteration(): void {
    this.resetChildren();
    this.capture();
  }

  protected capture(): void {
    const rev = this.reversed;
    for (const c of this.children) c.parentReversed = rev;
  }

  protected applyAt(): void {}

  /** Bookkeeping after the children moved: progress, callbacks, loops, completion. */
  protected settle(leftover: number, allDone: boolean): number {
    const consumed = this.childConsumed();
    this.elapsed = Number.isFinite(consumed) ? consumed : this.elapsed;
    this.progress = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
    if (allDone) {
      this.elapsed = this.duration;
      this.progress = 1;
    }
    this.onUpdate?.(this);
    if (this.killed) return 0;
    if (!allDone) return 0;
    if (this.canLoop()) {
      this.nextIteration();
      return leftover > 0 ? this.run(leftover) : 0;
    }
    this.finish();
    return leftover;
  }
}

/** @internal */
export function killTargetIn(t: TweenBase, target: object): void {
  if (t instanceof PropertyTween) {
    if (t.target === target) t.kill();
  } else if (t instanceof GroupTween) {
    t.killTarget(target);
  }
}

export class SequenceTween extends GroupTween {
  protected childDuration(): number {
    let s = 0;
    for (const c of this.children) s += c.total;
    return s;
  }

  protected childConsumed(): number {
    let s = 0;
    for (const c of this.children) s += c.consumed;
    return s;
  }

  protected override run(local: number): number {
    const kids = this.children;
    const n = kids.length;
    const rev = this.reversed;
    let i = 0;
    while (local > 0) {
      while (i < n && kids[rev ? n - 1 - i : i]!.done) i++;
      if (i === n) break;
      const child = kids[rev ? n - 1 - i : i]!;
      const rest = child.advance(local);
      if (this.killed) return 0;
      if (!child.done) break; // still running: paused, held, or it used the time
      local = rest;
    }
    let allDone = true;
    for (let j = 0; j < n; j++) if (!kids[j]!.done) allDone = false;
    return this.settle(allDone ? local : 0, allDone);
  }
}

export class ParallelTween extends GroupTween {
  protected childDuration(): number {
    let s = 0;
    for (const c of this.children) s = Math.max(s, c.total);
    return s;
  }

  protected childConsumed(): number {
    let s = 0;
    for (const c of this.children) s = Math.max(s, c.consumed);
    return s;
  }

  protected override run(local: number): number {
    const kids = this.children;
    let allDone = true;
    let leftover = local;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!;
      const rest = c.advance(local);
      if (this.killed) return 0;
      if (!c.done) allDone = false;
      if (rest < leftover) leftover = rest;
    }
    return this.settle(allDone ? leftover : 0, allDone);
  }
}

/** Creates and ticks tweens. One per game is plenty; call `update(dt)` from your frame hook. */
export class Tweens implements TweenOwner {
  private readonly list: TweenBase[] = [];
  private updating = false;

  /** Tweens that have neither completed nor been killed (a group counts once). */
  get active(): number {
    let n = 0;
    const list = this.list;
    for (let i = 0; i < list.length; i++) if (!list[i]!.done) n++;
    return n;
  }

  /** Advance every root tween by `dt` seconds. Negative or NaN counts as 0. */
  update(dt: number): void {
    if (this.updating) throw new Error('tween: update called from inside update');
    this.updating = true;
    const list = this.list;
    const n = list.length;
    const step = Math.max(dt, 0);
    try {
      for (let i = 0; i < n; i++) {
        const t = list[i]!;
        if (!t.grouped) t.advance(step);
      }
    } finally {
      this.updating = false;
    }
    this.compact();
  }

  /**
   * Animate number fields of `target` to the values in `props` (`'x'`, `'position.0'`,
   * `'style.opacity'`; typed-array indices work) over `seconds`. Start values are read when
   * the tween starts (after its delay).
   */
  to(target: object, props: TweenProps, seconds: number, opts: TweenOptions = {}): Tween {
    return this.add(new PropertyTween(target, props, seconds, opts));
  }

  /** Animate one number, calling `onUpdate(value, tween)` every step. */
  value(
    from: number,
    to: number,
    seconds: number,
    onUpdate: (value: number, tween: Tween) => void,
    opts: TweenOptions = {},
  ): Tween {
    return this.add(new ValueTween(from, to, seconds, onUpdate, opts));
  }

  /** Nothing for `seconds`: a gap in a sequence, or a timer with `then`. */
  delay(seconds: number, opts: TweenOptions = {}): Tween {
    return this.add(new DelayTween(seconds, opts));
  }

  /**
   * Run tweens one after another, carrying leftover time from one into the next. A
   * `TweenOptions` object as the last argument applies to the whole (delay, loops, yoyo, …).
   */
  sequence(...tweens: (Tween | TweenOptions)[]): Tween {
    const [kids, opts] = splitArgs(tweens);
    return this.addGroup(new SequenceTween(kids, opts));
  }

  /** Run tweens together; ends when the last one has. Options as for `sequence`. */
  parallel(...tweens: (Tween | TweenOptions)[]): Tween {
    const [kids, opts] = splitArgs(tweens);
    return this.addGroup(new ParallelTween(kids, opts));
  }

  /** Kill every property tween on `target`, inside groups too. */
  kill(target: object): void {
    const list = this.list;
    for (let i = 0; i < list.length; i++) killTargetIn(list[i]!, target);
    if (!this.updating) this.compact();
  }

  /** Kill every tween. */
  killAll(): void {
    const list = this.list;
    for (let i = 0; i < list.length; i++) list[i]!.kill();
    if (!this.updating) this.compact();
  }

  /** @internal */
  readd(t: TweenBase): void {
    if (t.listed || t.grouped) return;
    t.listed = true;
    this.list.push(t);
  }

  private add(t: TweenBase): Tween {
    t.owner = this;
    t.listed = true;
    this.list.push(t);
    return t;
  }

  /** A group took its children out of the root list. */
  private addGroup(t: TweenBase): Tween {
    if (!this.updating) this.compact();
    return this.add(t);
  }

  private compact(): void {
    const list = this.list;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (t.done || t.grouped) t.listed = false;
      else list[w++] = t;
    }
    list.length = w;
  }
}

function splitArgs(args: (Tween | TweenOptions)[]): [Tween[], TweenOptions] {
  const last = args[args.length - 1];
  if (last !== undefined && !(last instanceof TweenBase)) {
    return [args.slice(0, -1) as Tween[], last as TweenOptions];
  }
  return [args as Tween[], {}];
}

/** A new tween manager. */
export function createTweens(): Tweens {
  return new Tweens();
}
