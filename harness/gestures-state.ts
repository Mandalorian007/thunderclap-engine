/**
 * What the gestures harness page (harness/gestures.html) publishes on `window.__harnessGestures`
 * for e2e/gestures.spec.ts. Shared by the page (harness/gestures.ts) and the spec.
 */
import type {
  GestureDevice,
  GestureKind,
  GesturePhase,
  GesturePoint,
} from '@thunderclap/engine/input';

/** One gesture report from one tick. Idle `move` reports (nothing changed) are not logged. */
export interface GestureLogEntry {
  kind: GestureKind;
  tick: number;
  x: number;
  y: number;
  inside: boolean;
  phase?: GesturePhase;
  device?: GestureDevice;
  dx?: number;
  dy?: number;
  pointers?: number;
  origin?: GesturePoint;
  scale?: number;
}

export interface HarnessGesturesState {
  /** True once the page is mounted. */
  ready: boolean;
  /** Ticks run (input updates). */
  ticks: number;
  /** Logical (game) size of the stage. */
  logical: { width: number; height: number };
  /** The stage's letterbox rect in CSS px, relative to the page. */
  rect: { x: number; y: number; width: number; height: number; scale: number };
  /** Every gesture report, in order. */
  log: GestureLogEntry[];
  /** `pressed` counts per action (each bound to one gesture). */
  pressed: Record<string, number>;
  /** `released` counts per action. */
  released: Record<string, number>;
  /** The magnify grid (game space) and its one refused cell. */
  grid: {
    left: number;
    top: number;
    pitch: number;
    cols: number;
    rows: number;
    refused: { x: number; y: number };
  };
  /** Every tick's aim (while a finger is down, and once with `ended` after it lifts). */
  aims: AimLogEntry[];
  /** Ticks on which the loupe element was shown. */
  loupeShown: number;
}

export interface AimLogEntry {
  tick: number;
  x: number;
  y: number;
  lifted: boolean;
  ended: boolean;
  loupe: boolean;
  /** The snapped cell, or `null`. */
  cell: { x: number; y: number } | null;
}

export interface HarnessGesturesApi {
  state: HarnessGesturesState;
  /** Block input (as a modal panel would). */
  setBlocked(blocked: boolean): void;
  /** Empty the log and counts. */
  clear(): void;
}

declare global {
  interface Window {
    __harnessGestures?: HarnessGesturesApi;
  }
}
