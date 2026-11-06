/**
 * What the audio-4 harness page (harness/audio4.html) publishes on `window.__harnessAudio4`
 * for e2e/audio4.spec.ts. Shared by the page (harness/audio4.ts) and the spec.
 */
export interface HarnessAudio4State {
  /** True once the sounds are rendered and the loop runs. */
  ready: boolean;
  /** `audio.state`: `locked` until the first gesture, then `running`. */
  audioState: string;
  /** The page's mode from the URL (`occlude`, `doppler`, `sprites`, `stream`) and whether `?still` parks it. */
  mode: string;
  still: boolean;
  /** Frames the update loop has run. */
  frames: number;
  /** `?occlude`: the emitter voice's `occlusion` and the lowpass cutoff that amount asks for. */
  occlusion: number;
  cutoff: number;
  /** `?occlude`: the listener's orbit angle (radians) and position. */
  angle: number;
  listener: number[];
  /** `?doppler`: the emitter's Doppler multiplier on its rate and its x position. */
  rate: number;
  emitterX: number;
  /** `?sprites`: the last clip played and the live `sfx` voices. */
  lastClip: string;
  voices: number;
  /** `?stream`: `music.bar`, `music.beat`, `music.totalBeats`; `streaming` while the element plays. */
  grid: { bar: number; beat: number; totalBeats: number };
  streaming: boolean;
  /** `audio.inBackground` (the `background` flag) and `audio.paused`. */
  background: boolean;
  paused: boolean;
}

export interface HarnessAudio4Api {
  state: HarnessAudio4State;
  /** `?sprites`: play one clip of the sheet (`one`, `two`, `three`). */
  playClip(name: string): void;
  /** Park or release the orbit / the emitter's travel. */
  setStill(still: boolean): void;
  /** `audio.background(hidden)`. */
  background(hidden: boolean): void;
}

declare global {
  interface Window {
    __harnessAudio4?: HarnessAudio4Api;
  }
}
