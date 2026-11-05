/**
 * What the rays harness page (harness/rays.html) publishes on `window.__harnessRays` for
 * e2e/rays.spec.ts. Shared by the page (harness/rays.ts) and the spec.
 */

/** One router event. */
export interface RayLogEntry {
  kind: 'hit' | 'hitEnd' | 'select' | 'secondary';
  tick: number;
  device: string;
  /** The hit target's id, or `null` (the ground plane, or nothing). */
  target: string | null;
}

export interface RayBoxInfo {
  id: string;
  /** Centre of the box's nearest face on screen, logical px of the stage. */
  x: number;
  y: number;
}

export interface HarnessRaysState {
  ready: boolean;
  ticks: number;
  /** `ortho`: `Camera.ortho2d` over flat quads; `persp`: a perspective camera over 3D boxes. */
  mode: 'ortho' | 'persp';
  logical: { width: number; height: number };
  /** The stage's letterbox rect in CSS px, relative to the page. */
  rect: { x: number; y: number; width: number; height: number; scale: number };
  boxes: RayBoxInfo[];
  /** Box ids some pointer is on now. */
  hovered: string[];
  /** Box ids toggled on by select. */
  selected: string[];
  log: RayLogEntry[];
  /** The pad cursor (logical px), or `null` while hidden. */
  cursor: { x: number; y: number } | null;
  /** Ticks the `select` action was pressed. */
  selectPresses: number;
}

export interface HarnessRaysApi {
  state: HarnessRaysState;
  setBlocked(blocked: boolean): void;
  /** The fake gamepad's left stick and pressed buttons. */
  setPad(axes: [number, number], pressed: number[]): void;
  /** Put the pad cursor at a logical point (shows it). */
  cursorTo(x: number, y: number): void;
  clear(): void;
}

declare global {
  interface Window {
    __harnessRays?: HarnessRaysApi;
  }
}
