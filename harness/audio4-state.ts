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
  /**
   * `?sprites`, for specs on a loaded machine (a 200 ms clip can start and end between two
   * reads): the live `sfx` voices counted inside `playClip`, right after the play, and how many
   * `playClip` voices have played and stopped playing since boot.
   */
  voicesAtPlay: number;
  clipsPlayed: number;
  clipsEnded: number;
  /** `?stream`: `music.bar`, `music.beat`, `music.totalBeats`; `streaming` while the element plays. */
  grid: { bar: number; beat: number; totalBeats: number };
  streaming: boolean;
  /** `audio.inBackground` (the `background` flag) and `audio.paused`. */
  background: boolean;
  paused: boolean;
  /**
   * `?fit`: the custom buses and the `ambient` bus's gain and voices, the voice budget's
   * stats, the voices panned through the PannerNode fallback and the watchdog's restarts.
   */
  fit: {
    customBuses: string[];
    ambientGain: number;
    ambientVoices: number;
    live: number;
    stolen: number;
    dropped: number;
    panFallbacks: number;
    watchdogRestarts: number;
  };
}

export interface HarnessAudio4Api {
  state: HarnessAudio4State;
  /** `?sprites`: play one clip of the sheet (`one`, `two`, `three`). */
  playClip(name: string): void;
  /** Park or release the orbit / the emitter's travel. */
  setStill(still: boolean): void;
  /** `audio.background(hidden)`. */
  background(hidden: boolean): void;
  /** `?fit`: play `count` one-shots at `priority` against the three-voice budget. */
  burst(count: number, priority: number): void;
  /** `?fit`: the `ambient` bus's volume and mute. */
  setBus(volume: number, muted: boolean): void;
}

declare global {
  interface Window {
    __harnessAudio4?: HarnessAudio4Api;
  }
}
