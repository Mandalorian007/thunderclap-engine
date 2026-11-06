/**
 * What the input page (harness/input.html, ws/input-3) publishes on `window.__harnessInput` for
 * e2e/input.spec.ts. Shared by the page (harness/input.ts) and the spec.
 */
import type { Binding, InputDevice, LookMode } from '@thunderclap/engine/input';

export interface HarnessInputState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** `input.update()` calls. */
  ticks: number;
  /** The look mode the page booted in: `'orbit'` with `?orbit`, else `'locked'`. */
  mode: LookMode;
  /** The orbit view: yaw (+ turns right) and pitch (+ looks up), radians. */
  yaw: number;
  pitch: number;
  /** `look.locked`. */
  locked: boolean;
  /** `serializeBindings(input.bindings())`. */
  bindings: string;
  /** `findConflicts` on the live map, one line per shared binding: `"Space: jump, fire"`. */
  conflicts: string[];
  /** The action a `listen` is waiting for, or null. */
  listening: string | null;
  /** `charge` (hold C) progress 0..1 this tick. */
  holdProgress: number;
  /** Times `charge` fired (`pressed`). */
  holdFired: number;
  /** Ms from the key going down to the last `charge` fire, -1 before the first. */
  holdFiredAfterMs: number;
  /** Times `combo` (Shift+K chord) fired. */
  chordFired: number;
  /** `input.lastDevice`. */
  lastDevice: InputDevice;
  /** `input.glyphFor('jump').label` for `lastDevice`. */
  glyph: string;
  /** `'rumble'` events seen (one per chord fire, plus `rumble()` calls from the api). */
  rumbles: number;
  /** The last gesture report that reached an action: a pan or a long press. */
  panOrLong: 'pan' | 'longPress' | null;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessInputApi {
  state: HarnessInputState;
  /** `input.listen(action)`: the next key, mouse or pad button rebinds `action`; null if cancelled. */
  listen(action: string): Promise<Binding | null>;
  /** `input.rebind(action, bindings)`. */
  rebind(action: string, bindings: Binding[]): void;
  /** `look.setMode`. */
  setMode(mode: LookMode): void;
  /** Pin the gesture clock (ms) or `null` to follow `performance.now()`. */
  setClock(ms: number | null): void;
  /** `input.rumble()` (true when a pad played it). */
  rumble(): boolean;
}

declare global {
  interface Window {
    __harnessInput?: HarnessInputApi;
  }
}
