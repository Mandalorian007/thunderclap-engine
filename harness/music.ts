/**
 * Music harness page: the game audio toolkit on top of the mixer, no WebGPU, so
 * e2e/music.spec.ts can verify it on every matrix row. Noun-free.
 *
 * - `createMusic` at 120 bpm, 4/4 (a 2 s bar): a pad layer and a drums layer of two stems
 *   crossfaded by intensity (`pulse-low` 0..0.5, `pulse-high` 0.5..1), all synth-rendered.
 * - `createVariations`: three thuds, never the same twice in a row, with pitch and gain jitter.
 * - `createSend`: a reverb send on `sfx` driven by a slider.
 * - `createDucker`: a chime on `ui` ("dialogue") lowers `music`.
 * - The mixer's books (ws/audio-3): per-bus voice counts from `forEachVoice` (stems included),
 *   a looping probe voice on `sfx` with `sendTo(reverb)`, and `pause` / `unpause` (`?pause`).
 */
import {
  AudioEngine,
  BUS_NAMES,
  busGain,
  createDucker,
  createMusic,
  createSend,
  createVariations,
  type Layer,
  pluck,
  recipes,
  type SoundSpec,
  type Voice,
} from '@thunderclap/engine/audio';
import type { HarnessMusicApi, HarnessMusicState } from './music-state';

const BPM = 120;
const BAR = 2; // seconds, 4 beats at 120 bpm

/** `count` evenly spaced decaying sine hits across one bar. */
function pulses(count: number, pitch: number): SoundSpec {
  const layers: Layer[] = [];
  for (let i = 0; i < count; i++) {
    layers.push({
      source: { type: 'osc', wave: 'sine', freq: pitch, freqEnd: pitch * 0.5 },
      env: pluck(0.12),
      start: (i * BAR) / count,
      gain: i % (count / 4) === 0 ? 1 : 0.6,
    });
  }
  return { duration: BAR, normalize: 0.7, layers };
}

const audio = new AudioEngine();
audio.attach();
audio.define('pad', recipes.dronePad({ pitch: 110, length: BAR / 8, brightness: 0.3 }));
audio.define('pulse-low', pulses(4, 160));
audio.define('pulse-high', pulses(8, 220));
audio.define('step-a', recipes.thud({ pitch: 90, seed: 1 }));
audio.define('step-b', recipes.thud({ pitch: 110, seed: 2 }));
audio.define('step-c', recipes.thud({ pitch: 130, seed: 3 }));
audio.define('line', recipes.chime({ pitch: 660, length: 1.5 }));

const music = createMusic(audio, { bpm: BPM, beatsPerBar: 4 });
const reverb = createSend(audio, { kind: 'reverb', bus: 'sfx', amount: 0.3, seconds: 1.5 });
const ducker = createDucker(audio, {
  trigger: 'ui',
  target: 'music',
  amount: 0.7,
  attack: 0.05,
  release: 0.4,
});

const state: HarnessMusicState = {
  ready: false,
  audioState: audio.state,
  beat: 0,
  bar: 0,
  totalBeats: 0,
  beats: 0,
  intensity: 0,
  layerGains: { pad: 0, 'pulse-low': 0, 'pulse-high': 0 },
  lastVariation: -1,
  ducked: false,
  duckGain: 1,
  reverb: reverb.amount,
  frames: 0,
  voices: { master: 0, music: 0, sfx: 0, ui: 0 },
  sends: 0,
  paused: false,
  pausedBuses: [],
  pausedRate: false,
  busGains: { master: 1, music: 1, sfx: 1, ui: 1 },
  busTargets: { master: 1, music: 1, sfx: 1, ui: 1 },
};
const PAUSE_ON_RUN = new URLSearchParams(location.search).has('pause');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const readout = $('readout');
const beatDot = $('beat');
const intensitySlider = $<HTMLInputElement>('intensity');
const reverbSlider = $<HTMLInputElement>('reverb');

let footsteps = createVariations(audio, [], {});
/** Looping probe voices on `sfx`; the last one is the send probe. */
const probes: Voice[] = [];
let blink = 0;
music.onBeat(() => {
  state.beats++;
  blink = 0.1;
});

const api: HarnessMusicApi = {
  state,
  setIntensity(level) {
    music.setIntensity(level);
    intensitySlider.value = String(music.intensity);
  },
  step() {
    footsteps.play();
    state.lastVariation = footsteps.last;
  },
  speak() {
    ducker.watch(audio.play('line', { bus: 'ui' }));
  },
  setReverb(amount) {
    reverb.amount = amount;
    reverbSlider.value = String(reverb.amount);
  },
  playSfx() {
    probes.push(audio.loop('pad', { bus: 'sfx', gain: 0.3 }));
  },
  stopSfx() {
    for (const v of probes) v.stop(0.05);
    probes.length = 0;
  },
  sendProbe(amount) {
    probes.at(-1)?.sendTo(reverb, amount);
  },
  pause() {
    audio.pause();
  },
  unpause() {
    audio.unpause();
  },
};
window.__harnessMusic = api;

intensitySlider.addEventListener('input', () => api.setIntensity(Number(intensitySlider.value)));
reverbSlider.addEventListener('input', () => api.setReverb(Number(reverbSlider.value)));
$('step').addEventListener('click', () => api.step());
$('speak').addEventListener('click', () => api.speak());
$('probe').addEventListener('click', () => api.playSfx());
$('pause').addEventListener('click', () => (audio.paused ? api.unpause() : api.pause()));
audio.onStateChange(() => {
  if (audio.state !== 'running') return;
  $('hint').textContent = 'Audio running.';
  if (PAUSE_ON_RUN && !audio.paused) api.pause();
});

/** Zero-allocation voice tally: `forEachVoice` over the live set, counted into `state.voices`. */
const tally = (_v: Voice, bus: string) => {
  state.voices[bus] = (state.voices[bus] ?? 0) + 1;
  state.voices.master = (state.voices.master ?? 0) + 1;
};

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  music.update(dt);
  ducker.update(dt);
  blink = Math.max(0, blink - dt);
  beatDot.className = blink > 0 ? 'on' : '';
  state.audioState = audio.state;
  state.beat = music.beat;
  state.bar = music.bar;
  state.totalBeats = music.totalBeats;
  state.intensity = music.intensity;
  for (const name of Object.keys(state.layerGains)) state.layerGains[name] = music.gain(name);
  state.ducked = ducker.active;
  state.duckGain = ducker.gain;
  state.reverb = reverb.amount;
  for (const name of BUS_NAMES) {
    state.voices[name] = 0;
    state.busGains[name] = audio.busNode(name)?.gain.value ?? 1;
    state.busTargets[name] = busGain(audio.settings[name]);
  }
  audio.forEachVoice(undefined, tally);
  const probe = probes.at(-1) as { sendCount?: number } | undefined;
  state.sends = probe?.sendCount ?? 0;
  state.paused = audio.paused;
  state.pausedRate = audio.pausedRate;
  if (state.pausedBuses.join() !== audio.pausedBuses.join()) {
    state.pausedBuses = [...audio.pausedBuses];
  }
  state.frames++;
  readout.textContent =
    `audio ${state.audioState}\n` +
    `bar ${state.bar} beat ${state.beat} (${state.totalBeats} beats, ${state.beats} fired)\n` +
    `intensity ${state.intensity.toFixed(2)}  pad ${state.layerGains.pad!.toFixed(2)}  low ${state.layerGains['pulse-low']!.toFixed(2)}  high ${state.layerGains['pulse-high']!.toFixed(2)}\n` +
    `footstep ${state.lastVariation}  ducked ${state.ducked} (${state.duckGain.toFixed(2)})  reverb ${state.reverb.toFixed(2)}\n` +
    `voices music ${state.voices.music} sfx ${state.voices.sfx} ui ${state.voices.ui}  sends ${state.sends}  paused ${state.paused}${state.paused ? ` [${state.pausedBuses.join(' ')}]` : ''}`;
  requestAnimationFrame(frame);
}

async function boot(): Promise<void> {
  await audio.prepare();
  const buf = (n: string) => audio.buffer(n)!;
  footsteps = createVariations(audio, [buf('step-a'), buf('step-b'), buf('step-c')], {
    pitchJitter: 2,
    gainJitter: 3,
  });
  music.add({ name: 'pad', buffer: buf('pad'), layer: 'pad' });
  music.add({ name: 'pulse-low', buffer: buf('pulse-low'), layer: 'drums', intensity: [0, 0.5] });
  music.add({ name: 'pulse-high', buffer: buf('pulse-high'), layer: 'drums', intensity: [0.5, 1] });
  // Queued until the first gesture unlocks the context; they start together on the grid.
  music.play('pad', { at: 'now' });
  music.play('pulse-low', { at: 'now' });
  music.play('pulse-high', { at: 'now' });
  requestAnimationFrame(frame);
  state.ready = true;
}
void boot();
