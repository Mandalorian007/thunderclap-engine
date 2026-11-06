/**
 * What the music harness page (harness/music.html) publishes on `window.__harnessMusic` for
 * e2e/music.spec.ts. Shared by the page (harness/music.ts) and the spec.
 */
export interface HarnessMusicState {
  /** True once every stem and one-shot is rendered and the loop runs. */
  ready: boolean;
  /** `audio.state`: `locked` until the first gesture, then `running`. */
  audioState: string;
  /** `music.beat` (beat in the bar), `music.bar`, `music.totalBeats`. */
  beat: number;
  bar: number;
  totalBeats: number;
  /** Times `onBeat` fired. */
  beats: number;
  /** `music.intensity`. */
  intensity: number;
  /** `music.gain(name)` for each stem. */
  layerGains: Record<string, number>;
  /** `footsteps.last`. */
  lastVariation: number;
  /** `ducker.active` and `ducker.gain`. */
  ducked: boolean;
  duckGain: number;
  /** `reverb.amount`. */
  reverb: number;
  /** Frames the update loop has run. */
  frames: number;
}

export interface HarnessMusicApi {
  state: HarnessMusicState;
  /** `music.setIntensity`. */
  setIntensity(level: number): void;
  /** One footstep through `createVariations`. */
  step(): void;
  /** A line of "dialogue" on the `ui` bus, watched by the ducker. */
  speak(): void;
  /** The reverb send's amount. */
  setReverb(amount: number): void;
}

declare global {
  interface Window {
    __harnessMusic?: HarnessMusicApi;
  }
}
