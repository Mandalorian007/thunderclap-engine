/**
 * What the intents harness page (harness/intents.html) publishes on `window.__harnessIntents` for
 * e2e/intents-quality.spec.ts. Shared by the page (harness/intents.ts) and the spec.
 */

/** One intent the sink received. `x`, `y` are the aim's screen point (game space), absent for a centre aim. */
export interface IntentLogEntry {
  intent: string;
  /** For a hold: `start`, `aim` or `end`. */
  phase?: 'start' | 'aim' | 'end';
  x?: number;
  y?: number;
  /** True when the aim was `null` (the view's centre). */
  centre?: boolean;
  /** Cycle delta or select index. */
  n?: number;
  /** A hold's press time on the page clock. */
  at?: number;
  tick: number;
}

export interface HarnessIntentsState {
  ready: boolean;
  ticks: number;
  logical: { width: number; height: number };
  /** Every intent, in order. */
  log: IntentLogEntry[];
  /** The hold intent held now, or null. */
  holding: string | null;
  /** The view's aim screen point, or null. */
  aim: [number, number] | null;
}

export interface HarnessIntentsApi {
  state: HarnessIntentsState;
  /** Pins the intents' clock (ms); `null` unpins it. */
  setClock(ms: number | null): void;
  /** Aims at the centre (as under a pointer lock) while true. */
  setCentred(on: boolean): void;
  clear(): void;
}

declare global {
  interface Window {
    __harnessIntents?: HarnessIntentsApi;
  }
}
