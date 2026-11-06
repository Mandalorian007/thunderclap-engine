/**
 * A typed object pool (ws/core-2): reuse effect records, projectiles, labels or scratch objects
 * instead of allocating per event.
 *
 * - `acquire()` takes the most recently released free item (LIFO), or creates one while `size`
 *   is below `max`. Past `max` it returns `undefined`: that is how a game caps its effects (drop
 *   the spawn, or recycle its own oldest), never by growing without bound.
 * - `release(item)` calls `reset(item)` and returns the item to the free list; releasing an item
 *   that is not live (twice, or foreign) does nothing and returns false.
 * - `forEach(fn)` visits the live items only, newest index last, iterating backwards so `fn` may
 *   release the item it is given. Release swaps the last live item into the freed place, so the
 *   visit order is not acquisition order.
 *
 * Nothing allocates after the pool has grown to its peak (items are created by `create`, the
 * lists keep their capacity).
 */

export interface PoolOptions<T> {
  /** Make a new item. */
  create: () => T;
  /** Return an item to its idle state; called on `release` and `drain`. */
  reset?: (item: T) => void;
  /** Items created up front. Default 0. */
  initial?: number;
  /** Most items the pool will ever create. Default unbounded. */
  max?: number;
}

export interface Pool<T> {
  /** Items created so far (live plus free). */
  readonly size: number;
  /** Items acquired and not yet released. */
  readonly live: number;
  /** A free item, a new one while under `max`, or `undefined` at the cap. */
  acquire(): T | undefined;
  /** Reset `item` and make it free again; false when it was not live. */
  release(item: T): boolean;
  /** Visit live items (backwards; `fn` may release its item). No allocation. */
  forEach(fn: (item: T, index: number) => void): void;
  /** Release every live item. */
  drain(): void;
}

class PoolImpl<T extends object> implements Pool<T> {
  private readonly freeItems: T[] = [];
  private readonly liveItems: T[] = [];
  /** item → index in `liveItems`, or -1 when free. */
  private readonly index = new Map<T, number>();
  private readonly create: () => T;
  private readonly reset: ((item: T) => void) | undefined;
  private readonly max: number;

  constructor(opts: PoolOptions<T>) {
    this.create = opts.create;
    this.reset = opts.reset;
    this.max = opts.max ?? Number.POSITIVE_INFINITY;
    const initial = Math.min(opts.initial ?? 0, this.max);
    for (let i = 0; i < initial; i++) {
      const item = this.create();
      this.index.set(item, -1);
      this.freeItems.push(item);
    }
  }

  get size(): number {
    return this.index.size;
  }

  get live(): number {
    return this.liveItems.length;
  }

  acquire(): T | undefined {
    let item = this.freeItems.pop();
    if (item === undefined) {
      if (this.index.size >= this.max) return undefined;
      item = this.create();
    }
    this.index.set(item, this.liveItems.length);
    this.liveItems.push(item);
    return item;
  }

  release(item: T): boolean {
    const i = this.index.get(item);
    if (i === undefined || i < 0) return false;
    const live = this.liveItems;
    const last = live.pop()!;
    if (last !== item) {
      live[i] = last;
      this.index.set(last, i);
    }
    this.index.set(item, -1);
    this.reset?.(item);
    this.freeItems.push(item);
    return true;
  }

  forEach(fn: (item: T, index: number) => void): void {
    const live = this.liveItems;
    for (let i = live.length - 1; i >= 0; i--) {
      if (i >= live.length) continue;
      fn(live[i]!, i);
    }
  }

  drain(): void {
    const live = this.liveItems;
    while (live.length > 0) this.release(live[live.length - 1]!);
  }
}

/** A pool of `T` (an object type: items are tracked by identity); see the module comment. */
export function createPool<T extends object>(opts: PoolOptions<T>): Pool<T> {
  return new PoolImpl(opts);
}
