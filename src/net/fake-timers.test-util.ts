import type { Timers } from './transport';

/** Manual timers for tests: `advance(ms)` runs what is due, in order, flushing promises between. */
export class FakeTimers implements Timers {
  #now = 0;
  #seq = 0;
  readonly #due = new Map<number, { at: number; seq: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#due.set(id, { at: this.#now + Math.max(0, ms), seq: id, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#due.delete(handle as number);
  }

  /** Runs everything due within `ms`, then flushes promise callbacks. */
  async advance(ms = 0): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      await flush();
      let next: { at: number; seq: number; fn: () => void; id: number } | null = null;
      for (const [id, t] of this.#due) {
        if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) {
          next = { ...t, id };
        }
      }
      if (!next) break;
      this.#due.delete(next.id);
      this.#now = Math.max(this.#now, next.at);
      next.fn();
    }
    this.#now = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
