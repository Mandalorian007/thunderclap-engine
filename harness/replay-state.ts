/**
 * What the input replay page (harness/replay.html) publishes on `window.__harnessReplay` for
 * e2e/replay.spec.ts. Shared by the page (harness/replay.ts) and the spec.
 */

export type ReplayPhase = 'record' | 'replay' | 'live';

export interface HarnessReplayState {
  /** True once boot resolved (whether or not WebGPU came up). */
  ready: boolean;
  /** 'ok', a `GpuFailureReason` or an error message. */
  gpu: string;
  /** Frames presented. */
  frames: number;
  /** `record`: the scripted session is being recorded; `replay`: it plays back; `live`: DOM input. */
  phase: ReplayPhase;
  /** Ticks the recorder captured (the script's length once recording is done). */
  recordedTicks: number;
  /** `playback.tick`: ticks fed so far. */
  replayTick: number;
  /** The sprite after the recorded session, logical px. */
  positionAfterRecord: [number, number] | null;
  /** The sprite after the replayed session. */
  positionAfterReplay: [number, number] | null;
  /** Null until the replay is done; then whether every tick's action states and the positions matched. */
  equal: boolean | null;
  /** Ticks on which the replayed action states differed from the recorded ones. */
  mismatches: number;
  /** The first differing tick, for diagnosis. */
  firstMismatch: { tick: number; recorded: string; replayed: string } | null;
  /** `serializeRecording(recording)` once recording is done. */
  json: string;
  /** `serializeRecording(parseRecording(json)) === json`. */
  roundTrip: boolean | null;
  /** The sprite now. */
  position: [number, number];
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

export interface HarnessReplayApi {
  state: HarnessReplayState;
}

declare global {
  interface Window {
    __harnessReplay?: HarnessReplayApi;
  }
}
