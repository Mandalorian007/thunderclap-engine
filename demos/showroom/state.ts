/**
 * What the showroom demo publishes on `window.__demo` for `e2e/demos/showroom.spec.ts`. Shared
 * by the page (`main.ts`) and the spec. The spec reads it as `(window as { __demo?:
 * ShowroomState }).__demo`; nothing here augments `Window`, so other demos' state files can
 * coexist in one typecheck.
 */

/** The five post looks, in key order (`1`..`5`). */
export const LOOK_NAMES = ['neutral', 'warm', 'rays', 'contrast', 'off'] as const;
export type LookName = (typeof LOOK_NAMES)[number];

/** A point on the canvas, logical px (the camera's `screen`, 1920×1080). */
export interface ShowroomProbe {
  x: number;
  y: number;
}

export interface ShowroomState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frame: number;
  /** Running average of frames per second (EMA over frame time). */
  fps: number;
  /** `renderer.timing.gpuMs` of the last sample, or null before the first one. */
  gpuMs: number | null;
  /** Where `gpuMs` comes from: GPU timestamps or the queue (`FrameTiming.source`). */
  gpuSource: 'timestamp' | 'queue';
  /** `renderer.stats.drawCalls` of the last frame. */
  drawCalls: number;
  /** `renderer.stats` of the last frame. */
  stats: { drawCalls: number; instances: number; shadowDraws: number };
  /** The post look in force (set at the key press; the blend may still be running). */
  look: LookName;
  /** `post.blending`. */
  blending: boolean;
  /** World positions of the three point lights, recomputed every frame. */
  lightPositions: [number, number, number][];
  /** `?still`: lights parked, strip steady, look blends finish at once. */
  still: boolean;
  logical: { width: number; height: number };
  /** The sphere grid: metallic 0..1 across `cols`, roughness 0..1 down `rows`. */
  grid: { cols: number; rows: number };
  /** Screen position (logical px) of the middle sphere's point nearest the eye. */
  probe: ShowroomProbe;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}
