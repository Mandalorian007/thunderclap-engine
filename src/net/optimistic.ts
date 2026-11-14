/**
 * Optimistic edits: show what the player did at once, before the server answers, and roll back
 * exactly what the server refused. Keyed by whatever names one editable thing (a cell, a tile, a
 * slot).
 *
 * Each key with an edit in flight keeps a shadow: the server's last confirmed value there (what it
 * was before the first edit, updated by `confirm` whenever the server sends that key). A refused
 * edit restores the shadow, never another prediction or a stale copy, so a value another player set
 * meanwhile, or the server's value under two stacked predictions, is what stays.
 */

/** Where the game keeps the values the edits show. */
export interface OptimisticStore<K, V> {
  /** The value shown at `key` (undefined: nothing there to predict over). */
  read(key: K): V | undefined;
  /** Shows `value` at `key`. */
  write(key: K, value: V): void;
}

interface Shadow<V> {
  confirmed: V;
  pending: number;
}

/** Keyed shadow-and-rollback for predicted edits. */
export class Optimistic<K, V> {
  readonly #store: OptimisticStore<K, V>;
  readonly #equal: (a: V, b: V) => boolean;
  readonly #shadows = new Map<K, Shadow<V>>();
  /** Edits rolled back, ever. */
  rollbacks = 0;

  constructor(store: OptimisticStore<K, V>, equal: (a: V, b: V) => boolean = Object.is) {
    this.#store = store;
    this.#equal = equal;
  }

  /** Keys with an edit in flight. */
  get size(): number {
    return this.#shadows.size;
  }

  /** Whether `key` has an edit in flight. */
  has(key: K): boolean {
    return this.#shadows.has(key);
  }

  /** The server's last confirmed value at `key` while an edit is in flight there. */
  confirmed(key: K): V | undefined {
    return this.#shadows.get(key)?.confirmed;
  }

  /**
   * Shows `value` at `key` now and returns the function that settles it: call it with whether the
   * server took the edit. A refusal rolls `key` back to the server's value; returns whether it did.
   */
  edit(key: K, value: V): (accepted: boolean) => boolean {
    const current = this.#store.read(key);
    if (current === undefined) return () => false;
    let shadow = this.#shadows.get(key);
    if (!shadow) {
      shadow = { confirmed: current, pending: 0 };
      this.#shadows.set(key, shadow);
    }
    shadow.pending++;
    this.#store.write(key, value);
    const s = shadow;
    let settled = false;
    return (accepted) => {
      if (settled) return false;
      settled = true;
      s.pending--;
      let rolled = false;
      const now = this.#store.read(key);
      if (!accepted && now !== undefined && !this.#equal(now, s.confirmed)) {
        this.#store.write(key, s.confirmed);
        this.rollbacks++;
        rolled = true;
      }
      if (s.pending === 0 && this.#shadows.get(key) === s) this.#shadows.delete(key);
      return rolled;
    };
  }

  /**
   * Runs `send` (the command that makes the edit) with `value` shown at `key` until it settles:
   * resolved is taken, rejected is refused. Resolves to whether the server took it.
   */
  async run(key: K, value: V, send: () => Promise<unknown>): Promise<boolean> {
    const settle = this.edit(key, value);
    try {
      await send();
      settle(true);
      return true;
    } catch {
      settle(false);
      return false;
    }
  }

  /**
   * The server sent `value` at `key` (an update that covers it): the new confirmed value under any
   * edit in flight there. The game writes it to the store as usual; call this as it does.
   */
  confirm(key: K, value: V): void {
    const s = this.#shadows.get(key);
    if (s) s.confirmed = value;
  }

  /** Forgets every shadow (a new connection: what is shown comes again from the server). */
  clear(): void {
    this.#shadows.clear();
  }
}
