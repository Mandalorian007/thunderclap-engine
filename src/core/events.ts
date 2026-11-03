/**
 * Tiny typed event emitter.
 *
 * ```ts
 * const bus = new Emitter<{ resize: { w: number; h: number }; tick: undefined }>();
 * const off = bus.on('resize', ({ w }) => ...);
 * bus.emit('resize', { w: 1, h: 2 });
 * ```
 *
 * Listener arrays are copy-on-write, so `emit` never allocates and listeners may safely
 * subscribe/unsubscribe during dispatch (changes apply from the next emit).
 */
// biome-ignore lint/suspicious/noExplicitAny: event maps are arbitrary records
export type EventMap = Record<string, any>;
type Listener<T> = (payload: T) => void;

export class Emitter<M extends EventMap> {
  private readonly map = new Map<keyof M, Listener<never>[]>();

  on<K extends keyof M>(type: K, fn: Listener<M[K]>): () => void {
    const prev = this.map.get(type) ?? [];
    this.map.set(type, [...prev, fn as Listener<never>]);
    return () => this.off(type, fn);
  }

  once<K extends keyof M>(type: K, fn: Listener<M[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof M>(type: K, fn: Listener<M[K]>): void {
    const prev = this.map.get(type);
    if (!prev) return;
    const i = prev.indexOf(fn as Listener<never>);
    if (i < 0) return;
    const next = prev.slice();
    next.splice(i, 1);
    if (next.length) this.map.set(type, next);
    else this.map.delete(type);
  }

  emit<K extends keyof M>(type: K, ...payload: M[K] extends void ? [] : [M[K]]): void {
    const list = this.map.get(type) as Listener<M[K]>[] | undefined;
    if (!list) return;
    const p = payload[0] as M[K];
    for (let i = 0; i < list.length; i++) list[i]!(p);
  }

  listenerCount(type: keyof M): number {
    return this.map.get(type)?.length ?? 0;
  }

  clear(): void {
    this.map.clear();
  }
}
