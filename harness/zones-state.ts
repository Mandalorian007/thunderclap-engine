/**
 * What the audio zones page (harness/zones.html) publishes on `window.__harnessZones` for
 * e2e/zones.spec.ts. Shared by the page (harness/zones.ts) and the spec.
 */

/** One zone as the page declared it: the sends the spec needs to check the max rule. */
export interface ZoneInfo {
  kind: 'sphere' | 'box';
  reverbSend: { music: number; sfx: number; ui: number };
}

/** The weights and sends of one frame. */
export interface ZoneSnapshot {
  weights: number[];
  sends: { music: number; sfx: number; ui: number };
  baseSends: { music: number; sfx: number; ui: number };
}

export interface HarnessZonesState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  logical: { width: number; height: number };
  /** The orbit: yaw in radians and the eye it places (the listener). */
  camera: { yaw: number; eye: [number, number, number] };
  /** `audio.state` (locked in a headless run: nothing plays, the bookkeeping still runs). */
  audioState: string;
  /** The zones in the order added: 0 the sphere room, 1 the box corridor. */
  zones: ZoneInfo[];
  /** `audio.zones.weights()` after the last update. */
  weights: number[];
  /** The largest weight seen per zone since load. */
  peaks: number[];
  /** `audio.effectiveReverbSendLevels` after the last update. */
  sends: { music: number; sfx: number; ui: number };
  /** `audio.reverbSendLevels`: what the page set. */
  baseSends: { music: number; sfx: number; ui: number };
  /**
   * Frames the spec checks the max rule on, kept by the page because the camera moves faster
   * than a poll from outside: `inside` is the first frame with the room's weight above 0.99,
   * `partial` the first with it part-way (0.05 < w < 0.95). Each holds that frame's weights
   * and sends.
   */
  inside: ZoneSnapshot | null;
  partial: ZoneSnapshot | null;
  /** The largest `ambientGain` seen per zone since load. */
  ambientPeaks: number[];
  /** Each zone's `ambientGain`. */
  ambientGains: number[];
  /** The following voice's `position` after the last update. */
  followPos: [number, number, number];
  /** The orbiting mesh's world translation (`Transform.world` floats 3, 7, 11). */
  moverPos: [number, number, number];
  stats: { drawCalls: number; instances: number };
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

declare global {
  interface Window {
    __harnessZones?: { state: HarnessZonesState };
  }
}
