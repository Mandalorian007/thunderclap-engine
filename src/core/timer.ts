/**
 * Delayed and repeating calls on the game's own clock (ws/core-2).
 *
 * The scheduler owns the bookkeeping, not time (the `tween` convention): it advances only when the
 * game calls `update(dt)`, normally from a fixed step or a scene's `update`, so a paused loop, a
 * replay or a test steps it exactly. A timer fires on the first `update` at which the scheduler's
 * time reaches its due time (within 1e-9 s, so `after(1, fn)` under 60 steps of 1/60 fires on the
 * 60th). Fires within one `update` run in due order (ties in scheduling order); an `every` that
 * fell several periods behind in one long `dt` fires once per period, in order with the rest.
 * A timer scheduled from inside a callback waits for the next `update`, even with 0 seconds.
 *
 * Handles are integers: a slot in a reused table plus a generation, so a stale handle (a timer
 * that fired or was cancelled, its slot since reused) never touches the new occupant. The slot
 * table and the heap grow to the peak number of live timers and are reused, and `update` creates
 * no closures, so steady-state scheduling allocates nothing beyond the callbacks a game passes.
 */

/** A timer handle; 0 is never a live handle. */
export type TimerHandle = number;

export interface EveryOptions {
  /** Fire this many times, then end. Default: until cancelled. */
  count?: number;
}

export interface Cooldown {
  readonly name: string;
  /** Seconds a `use()` blocks for. */
  readonly duration: number;
  /** True when `use()` would succeed. */
  readonly ready: boolean;
  /** Seconds until ready, 0 when ready. */
  readonly remaining: number;
  /** 0 just used .. 1 ready (for a cooldown bar). */
  readonly progress: number;
  /** If ready, start the cooldown and return true; otherwise false. */
  use(): boolean;
  /** Ready now. */
  reset(): void;
}

export interface Scheduler {
  /** Seconds this scheduler has advanced (paused updates do not count). */
  readonly time: number;
  /** Live timers (cooldowns not counted). */
  readonly active: number;
  readonly paused: boolean;
  /** Call `fn` once after `seconds`. */
  after(seconds: number, fn: () => void): TimerHandle;
  /** Call `fn` every `seconds` (the first after one period); `count` ends it after that many. */
  every(seconds: number, fn: () => void, opts?: EveryOptions): TimerHandle;
  /**
   * The cooldown called `name`, created ready on first use; later calls return the same object
   * (and set its duration to `seconds`), so calling it per frame allocates nothing.
   */
  cooldown(name: string, seconds: number): Cooldown;
  /** Seconds until `handle` fires next, or -1 when it is not live. */
  remaining(handle: TimerHandle): number;
  /** Stop a timer; false when the handle is not live. Safe from inside a callback. */
  cancel(handle: TimerHandle): boolean;
  /** Advance by `dt` seconds and fire what is due. Does nothing while paused. */
  update(dt: number): void;
  /** Cancel every timer and make every cooldown ready. */
  clear(): void;
  /** Hold every timer and cooldown where it is until `resume()`. */
  pause(): void;
  resume(): void;
}

const EPS = 1e-9;
const SLOT_BITS = 2 ** 20;

interface Entry {
  gen: number;
  live: boolean;
  due: number;
  interval: number;
  /** Fires left for `every`; Infinity when unbounded; 1 for `after`. */
  left: number;
  fn: (() => void) | null;
  seq: number;
  /** Index in the heap, or -1 when waiting in `incoming` (or free). */
  heapIndex: number;
}

class CooldownImpl implements Cooldown {
  left = 0;
  constructor(
    readonly name: string,
    public duration: number,
  ) {}
  get ready(): boolean {
    return this.left <= EPS;
  }
  get remaining(): number {
    return this.left <= EPS ? 0 : this.left;
  }
  get progress(): number {
    if (this.duration <= 0 || this.left <= EPS) return 1;
    return 1 - this.left / this.duration;
  }
  use(): boolean {
    if (this.left > EPS) return false;
    this.left = this.duration;
    return true;
  }
  reset(): void {
    this.left = 0;
  }
}

class SchedulerImpl implements Scheduler {
  private now = 0;
  private seq = 0;
  private isPaused = false;
  private updating = false;
  private live = 0;
  private readonly entries: Entry[] = [];
  private readonly free: number[] = [];
  /** Min-heap of slot indices by (due, seq). */
  private readonly heap: number[] = [];
  /** Slots scheduled during `update`, joined to the heap when it returns. */
  private readonly incoming: number[] = [];
  private readonly cooldowns = new Map<string, CooldownImpl>();
  private readonly cooldownList: CooldownImpl[] = [];

  get time(): number {
    return this.now;
  }
  get active(): number {
    return this.live;
  }
  get paused(): boolean {
    return this.isPaused;
  }

  after(seconds: number, fn: () => void): TimerHandle {
    return this.add(seconds, 0, 1, fn);
  }

  every(seconds: number, fn: () => void, opts?: EveryOptions): TimerHandle {
    const count = opts?.count ?? Number.POSITIVE_INFINITY;
    if (!(count >= 1)) return 0;
    const s = Math.max(0, seconds);
    return this.add(s, s, Math.floor(count), fn);
  }

  cooldown(name: string, seconds: number): Cooldown {
    let c = this.cooldowns.get(name);
    if (!c) {
      c = new CooldownImpl(name, Math.max(0, seconds));
      this.cooldowns.set(name, c);
      this.cooldownList.push(c);
    } else c.duration = Math.max(0, seconds);
    return c;
  }

  remaining(handle: TimerHandle): number {
    const e = this.lookup(handle);
    return e ? Math.max(0, e.due - this.now) : -1;
  }

  cancel(handle: TimerHandle): boolean {
    const e = this.lookup(handle);
    if (!e) return false;
    e.live = false;
    e.fn = null;
    this.live--;
    // In the heap: out now. Otherwise it waits in `incoming`, which frees it when the update ends.
    if (e.heapIndex >= 0) {
      this.heapRemove(e.heapIndex);
      e.heapIndex = -1;
      this.release(handle % SLOT_BITS);
    }
    return true;
  }

  update(dt: number): void {
    if (this.isPaused || !(dt > 0)) return;
    this.now += dt;
    const cds = this.cooldownList;
    for (let i = 0; i < cds.length; i++) {
      const c = cds[i]!;
      if (c.left > 0) c.left = Math.max(0, c.left - dt);
    }
    this.updating = true;
    try {
      const heap = this.heap;
      const limit = this.now + EPS;
      while (heap.length > 0) {
        const slot = heap[0]!;
        const e = this.entries[slot]!;
        if (e.due > limit) break;
        this.heapRemove(0);
        e.heapIndex = -1;
        const fn = e.fn!;
        e.left--;
        const repeat = e.left > 0;
        if (repeat) {
          e.due += e.interval;
          e.seq = this.seq++;
          // A zero period fires once per update; otherwise catch up within this one.
          if (e.interval > 0) this.heapPush(slot);
          else this.incoming.push(slot);
        } else {
          e.live = false;
          e.fn = null;
          this.live--;
          // Its handle is stale from here (a reuse bumps the generation), so `fn` may reuse it.
          this.release(slot);
        }
        fn();
      }
    } finally {
      this.updating = false;
      this.joinIncoming();
    }
  }

  clear(): void {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.live) this.cancel(e.gen * SLOT_BITS + i);
    }
    for (let i = 0; i < this.cooldownList.length; i++) this.cooldownList[i]!.reset();
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private add(seconds: number, interval: number, left: number, fn: () => void): TimerHandle {
    let slot = this.free.pop();
    if (slot === undefined) {
      slot = this.entries.length;
      if (slot >= SLOT_BITS) throw new RangeError('Scheduler: too many live timers');
      this.entries.push({
        gen: 0,
        live: false,
        due: 0,
        interval: 0,
        left: 0,
        fn: null,
        seq: 0,
        heapIndex: -1,
      });
    }
    const e = this.entries[slot]!;
    e.gen++;
    e.live = true;
    e.due = this.now + Math.max(0, seconds);
    e.interval = interval;
    e.left = left;
    e.fn = fn;
    e.seq = this.seq++;
    e.heapIndex = -1;
    this.live++;
    if (this.updating) this.incoming.push(slot);
    else this.heapPush(slot);
    return e.gen * SLOT_BITS + slot;
  }

  private lookup(handle: TimerHandle): Entry | null {
    if (!Number.isInteger(handle) || handle <= 0) return null;
    const slot = handle % SLOT_BITS;
    const e = this.entries[slot];
    if (!e?.live || e.gen !== Math.floor(handle / SLOT_BITS)) return null;
    return e;
  }

  private release(slot: number): void {
    this.free.push(slot);
  }

  private joinIncoming(): void {
    const inc = this.incoming;
    for (let i = 0; i < inc.length; i++) {
      const slot = inc[i]!;
      if (this.entries[slot]!.live) this.heapPush(slot);
      else this.release(slot);
    }
    inc.length = 0;
  }

  private less(a: number, b: number): boolean {
    const ea = this.entries[a]!;
    const eb = this.entries[b]!;
    return ea.due < eb.due || (ea.due === eb.due && ea.seq < eb.seq);
  }

  private place(i: number, slot: number): void {
    this.heap[i] = slot;
    this.entries[slot]!.heapIndex = i;
  }

  private heapPush(slot: number): void {
    this.heap.push(slot);
    this.siftUp(this.heap.length - 1);
  }

  private heapRemove(i: number): void {
    const heap = this.heap;
    const last = heap.pop()!;
    if (i < heap.length) {
      this.place(i, last);
      this.siftDown(i);
      this.siftUp(this.entries[last]!.heapIndex);
    }
  }

  private siftUp(i: number): void {
    const heap = this.heap;
    const slot = heap[i]!;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(slot, heap[p]!)) break;
      this.place(i, heap[p]!);
      i = p;
    }
    this.place(i, slot);
  }

  private siftDown(i: number): void {
    const heap = this.heap;
    const n = heap.length;
    const slot = heap[i]!;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && this.less(heap[r]!, heap[l]!) ? r : l;
      if (!this.less(heap[c]!, slot)) break;
      this.place(i, heap[c]!);
      i = c;
    }
    this.place(i, slot);
  }
}

/** A scheduler on the caller's clock; see the module comment. */
export function createScheduler(): Scheduler {
  return new SchedulerImpl();
}
