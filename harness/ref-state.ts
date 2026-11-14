/**
 * What a reference-scene page (harness/ref-<scene>.html, E-041 A4) publishes on
 * `window.__harnessRef` for e2e/ref-scenes.spec.ts and a bench run.
 */
import type { BenchAdapterInfo } from './bench-state';

/** `renderer.stats` at `REF_STATS_FRAME`. */
export interface RefPageStats {
  drawCalls: number;
  triangles: number;
  instances: number;
  culled: number;
  shadowDraws: number;
  passes: number;
}

export interface HarnessRefState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** The scene id (`board`, `characters`, ...) and its size (`?size=`, else the default). */
  scene: string;
  size: number;
  /** Frames stepped on the fixed clock (frame `i` at `i * REF_DT`), counted once prepared. */
  frames: number;
  /** True once the measured frames are in (the scene keeps running after). */
  done: boolean;
  /** Frames measured (after `BENCH_WARMUP`). */
  measured: number;
  /** Median and 95th percentile of `performance.now()` around a frame's `step`. */
  cpuMs: number;
  cpuP95Ms: number;
  /** Median `renderer.onGpuTime` sample over the measured frames; null without timestamps. */
  gpuMs: number | null;
  gpuSamples: number;
  timestamps: boolean;
  /** `renderer.stats` at `REF_STATS_FRAME`, null before. */
  stats: RefPageStats | null;
  /** hud: DOM writes (mutation records) and layout reads per measured frame; null elsewhere. */
  dom: { writes: number; reads: number } | null;
  adapter: BenchAdapterInfo;
  userAgent: string;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessRef?: { state: HarnessRefState };
  }
}
