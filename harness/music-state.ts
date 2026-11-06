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
  /** Live voices per bus from `audio.forEachVoice` (`master` is every bus; stems count). */
  voices: Record<string, number>;
  /** Live sends on the probe voice (0 without one). */
  sends: number;
  /** `audio.paused`, `audio.pausedBuses` and whether the paused voices were frozen (`audio.pausedRate`). */
  paused: boolean;
  pausedBuses: string[];
  pausedRate: boolean;
  /** Each bus node's `gain.value`, and the value its settings ask for (`busGain(settings)`). */
  busGains: Record<string, number>;
  busTargets: Record<string, number>;
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
  /** Start one looping probe voice on `sfx` (several may run); the newest is the probe for `sendProbe`. */
  playSfx(): void;
  /** Stop every probe voice. */
  stopSfx(): void;
  /** `probe.sendTo(reverb, amount)` on the newest probe voice. */
  sendProbe(amount: number): void;
  /** `audio.pause()` / `audio.unpause()`; `?pause` in the URL pauses once audio runs. */
  pause(): void;
  unpause(): void;
}

declare global {
  interface Window {
    __harnessMusic?: HarnessMusicApi;
  }
}
