/**
 * Audio-4 harness page (ws/audio-4): occlusion, Doppler, sprites and streamed music on the
 * mixer, no WebGPU, so e2e/audio4.spec.ts can verify them on every matrix row. Noun-free.
 *
 * - `?occlude`: a looping emitter behind a wall the listener orbits; the page's probe is a
 *   segment-vs-box test, the engine ramps the voice's lowpass. `?still` parks the listener
 *   behind the wall.
 * - `?doppler`: an emitter sweeps past the listener at 20 m/s; the readout is its Doppler
 *   multiplier. `?still` parks it.
 * - `?sprites`: three clips cut from one synthesised buffer, on keys 1-3 or the buttons.
 * - `?stream`: a synthesised 8 s track encoded as a WAV Blob URL and streamed through a media
 *   element; the beat grid follows the element's clock.
 */
import {
  AudioEngine,
  createMusic,
  DEFAULT_OCCLUSION,
  type Layer,
  type Music,
  occlusionCutoff,
  recipes,
  type SoundSpec,
  type Voice,
} from '@thunderclap/engine/audio';
import type { HarnessAudio4Api, HarnessAudio4State } from './audio4-state';

const params = new URLSearchParams(location.search);
const MODES = ['occlude', 'doppler', 'sprites', 'stream'] as const;
const mode = MODES.find((m) => params.has(m)) ?? 'occlude';
let still = params.has('still');

const audio = new AudioEngine();
audio.attach();
audio.define('hum', recipes.dronePad({ pitch: 220, length: 0.5, brightness: 0.6 }));
audio.define('clip-one', recipes.chime({ pitch: 660, length: 0.4 }));
audio.define('clip-two', recipes.thud({ pitch: 90, length: 0.4 }));
audio.define('clip-three', recipes.zap({ pitch: 440, length: 0.4 }));

/** An 8 s track: one decaying sine every beat at 120 bpm, accented on the bar. */
function track(): SoundSpec {
  const layers: Layer[] = [];
  for (let i = 0; i < 16; i++) {
    layers.push({
      source: { type: 'osc', wave: 'sine', freq: i % 4 === 0 ? 220 : 165, freqEnd: 110 },
      env: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 },
      start: i * 0.5,
      gain: i % 4 === 0 ? 1 : 0.6,
    });
  }
  return { duration: 8, normalize: 0.7, layers };
}
audio.define('track', track());

const state: HarnessAudio4State = {
  ready: false,
  audioState: audio.state,
  mode,
  still,
  frames: 0,
  occlusion: 0,
  cutoff: DEFAULT_OCCLUSION.openCutoff,
  angle: 0,
  listener: [0, 0, 3],
  rate: 1,
  emitterX: -30,
  lastClip: '',
  voices: 0,
  grid: { bar: 0, beat: 0, totalBeats: 0 },
  streaming: false,
  background: false,
  paused: false,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const readout = $('readout');
const map = $<HTMLCanvasElement>('map');
const g2d = map.getContext('2d');
$('mode').textContent = `?${mode}${still ? '&still' : ''}`;

// ---------------------------------------------------------------- occlusion: a wall between

/** The wall: an axis-aligned box the segment listener → emitter is tested against. */
const WALL = { min: [-1.5, -1, -2.1], max: [1.5, 1, -1.9] };
const EMITTER = [0, 0, -4];
const ORBIT_RADIUS = 3;
const ORBIT_SPEED = Math.PI / 2; // one lap in 4 s

/** Slab test: does the segment a → b pass through the box? */
function segmentHitsBox(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i]! - a[i]!;
    const lo = WALL.min[i]!;
    const hi = WALL.max[i]!;
    if (Math.abs(d) < 1e-9) {
      if (a[i]! < lo || a[i]! > hi) return false;
      continue;
    }
    let ta = (lo - a[i]!) / d;
    let tb = (hi - a[i]!) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

let angle = 0;
let emitter: Voice | null = null;
let music: Music | null = null;
let streamEl: HTMLMediaElement | null = null;
let emitterX = -30;
const DOPPLER_SPEED = 20;

audio.occlusion = {
  probe: (listener, at, out) => {
    out.amount = segmentHitsBox(listener, at) ? 1 : 0;
  },
  interval: 0.1,
};

const api: HarnessAudio4Api = {
  state,
  playClip(name) {
    if (mode !== 'sprites') return;
    audio.play(`fx#${name}`);
    state.lastClip = name;
  },
  setStill(s) {
    still = s;
    state.still = s;
    $('mode').textContent = `?${mode}${still ? '&still' : ''}`;
  },
  background(hidden) {
    audio.background(hidden);
  },
};
window.__harnessAudio4 = api;

for (const [id, name] of [
  ['clip1', 'one'],
  ['clip2', 'two'],
  ['clip3', 'three'],
] as const) {
  $(id).addEventListener('click', () => api.playClip(name));
}
window.addEventListener('keydown', (e) => {
  const name = { Digit1: 'one', Digit2: 'two', Digit3: 'three' }[e.code];
  if (name) api.playClip(name);
});
$('still').addEventListener('click', () => api.setStill(!still));
$('bg').addEventListener('click', () => api.background(!audio.inBackground));
audio.onStateChange(() => {
  if (audio.state === 'running') $('hint').textContent = 'Audio running.';
});

/** Top-down map: listener (dot), emitter (ring), wall (bar). 1 unit = 24 px, origin centred. */
function drawMap(): void {
  if (!g2d) return;
  const s = 24;
  const cx = 120;
  const cz = 120;
  g2d.fillStyle = '#111';
  g2d.fillRect(0, 0, 240, 240);
  if (mode === 'occlude') {
    g2d.fillStyle = state.occlusion > 0.5 ? '#a33' : '#555';
    g2d.fillRect(cx + WALL.min[0]! * s, cz + WALL.min[2]! * s, 3 * s, 0.2 * s + 2);
    g2d.strokeStyle = '#fc6';
    g2d.beginPath();
    g2d.arc(cx + EMITTER[0]! * s, cz + EMITTER[2]! * s, 6, 0, Math.PI * 2);
    g2d.stroke();
    g2d.fillStyle = '#6cf';
    g2d.beginPath();
    g2d.arc(cx + state.listener[0]! * s, cz + state.listener[2]! * s, 5, 0, Math.PI * 2);
    g2d.fill();
  } else if (mode === 'doppler') {
    g2d.fillStyle = '#6cf';
    g2d.beginPath();
    g2d.arc(cx, cz, 5, 0, Math.PI * 2);
    g2d.fill();
    g2d.strokeStyle = state.rate > 1 ? '#6f6' : '#f66';
    g2d.beginPath();
    g2d.arc(cx + emitterX * 3, cz - 2 * s, 6, 0, Math.PI * 2);
    g2d.stroke();
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (mode === 'occlude') {
    if (!still) angle += ORBIT_SPEED * dt;
    const x = ORBIT_RADIUS * Math.sin(angle);
    const z = ORBIT_RADIUS * Math.cos(angle);
    state.listener[0] = x;
    state.listener[2] = z;
    state.angle = angle;
    // Facing the emitter.
    audio.listener.set(state.listener, [EMITTER[0]! - x, 0, EMITTER[2]! - z]);
  } else if (mode === 'doppler') {
    if (!still) {
      emitterX += DOPPLER_SPEED * dt;
      if (emitterX > 30) emitterX = -30;
    }
    emitter?.setPosition(emitterX, 0, -2);
    state.emitterX = emitterX;
  }
  audio.update(dt);
  music?.update(dt);
  state.audioState = audio.state;
  const e = emitter as (Voice & { doppler?: number }) | null;
  state.occlusion = emitter?.occlusion ?? 0;
  state.cutoff = occlusionCutoff(
    state.occlusion,
    DEFAULT_OCCLUSION.openCutoff,
    DEFAULT_OCCLUSION.closedCutoff,
  );
  state.rate = e?.doppler ?? 1;
  state.voices = audio.voices('sfx').length;
  if (music) {
    state.grid.bar = music.bar;
    state.grid.beat = music.beat;
    state.grid.totalBeats = music.totalBeats;
  }
  state.streaming =
    streamEl !== null && !streamEl.paused && music?.playing.includes('track') === true;
  state.background = audio.inBackground;
  state.paused = audio.paused;
  state.frames++;
  drawMap();
  readout.textContent =
    `audio ${state.audioState}  mode ${mode}${still ? ' (still)' : ''}  background ${state.background}\n` +
    `occlusion ${state.occlusion.toFixed(2)}  cutoff ${state.cutoff.toFixed(0)} Hz  angle ${state.angle.toFixed(2)}\n` +
    `doppler ${state.rate.toFixed(4)}  emitter x ${state.emitterX.toFixed(1)}\n` +
    `sprites last ${state.lastClip || '-'}  sfx voices ${state.voices}\n` +
    `stream ${state.streaming}  bar ${state.grid.bar} beat ${state.grid.beat} (${state.grid.totalBeats})`;
  requestAnimationFrame(frame);
}

/** Three clips laid out in one buffer with 100 ms gaps: `[startMs, lengthMs]` per clip. */
function buildSheet(): { buffer: AudioBuffer; sprites: Record<string, [number, number]> } {
  const parts = [audio.buffer('clip-one')!, audio.buffer('clip-two')!, audio.buffer('clip-three')!];
  const rate = parts[0]!.sampleRate;
  const gap = Math.round(rate * 0.1);
  const total = parts.reduce((n, b) => n + b.length + gap, 0);
  const buffer = new AudioBuffer({ length: total, sampleRate: rate, numberOfChannels: 1 });
  const data = buffer.getChannelData(0);
  const sprites: Record<string, [number, number]> = {};
  let at = 0;
  for (const [i, name] of ['one', 'two', 'three'].entries()) {
    const b = parts[i]!;
    data.set(b.getChannelData(0), at);
    sprites[name] = [Math.round((at / rate) * 1000), Math.round((b.length / rate) * 1000)];
    at += b.length + gap;
  }
  return { buffer, sprites };
}

/** 16-bit PCM WAV of a mono buffer, as a Blob URL the media element can stream. */
function wavUrl(buffer: AudioBuffer): string {
  const n = buffer.length;
  const rate = buffer.sampleRate;
  const bytes = new ArrayBuffer(44 + n * 2);
  const v = new DataView(bytes);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  const d = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, d[i]!));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

async function boot(): Promise<void> {
  await audio.prepare();
  if (mode === 'occlude') {
    // Queued until the gesture; the orbit starts behind the wall.
    emitter = audio.loop('hum', { at: EMITTER, bus: 'sfx', gain: 0.5 });
  } else if (mode === 'doppler') {
    emitter = audio.loop('hum', {
      at: [emitterX, 0, -2],
      bus: 'sfx',
      gain: 0.5,
      spatial: { doppler: 1, occlude: false },
    });
  } else if (mode === 'sprites') {
    const sheet = buildSheet();
    audio.defineSprites('fx', sheet, { maxVoices: 6 });
  } else {
    const url = wavUrl(audio.buffer('track')!);
    music = createMusic(audio, {
      bpm: 120,
      beatsPerBar: 4,
      createElement: () => {
        streamEl = document.createElement('audio');
        return streamEl;
      },
    });
    music.add({ name: 'track', url });
    music.play('track', { stream: true });
  }
  requestAnimationFrame(frame);
  state.ready = true;
}
void boot();
