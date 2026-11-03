/**
 * Procedural synth: a declarative `SoundSpec` (layers of oscillators / noise / crackle, each
 * with an envelope, optional glide, FM, vibrato, tremolo and filters) rendered once into an
 * `AudioBuffer` with an `OfflineAudioContext`. Specs are plain data: easy to tweak, diff and test.
 */
import { fillCrackle, fillNoise, foldLoop, type NoiseColor, normalize } from './dsp';
import { type Envelope, envelopeLength, scheduleEnvelope } from './envelope';

export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface OscSource {
  type: 'osc';
  wave: Wave;
  /** Start frequency, Hz. */
  freq: number;
  /** Glide target, Hz. */
  freqEnd?: number;
  /** Glide time, seconds from layer start. Default: the layer's whole envelope. */
  glide?: number;
  /** Default `exp` (musical pitch sweep). */
  glideCurve?: 'exp' | 'linear';
  /** Cents. */
  detune?: number;
  /** Pitch wobble: `rate` Hz, `depth` cents. */
  vibrato?: { rate: number; depth: number };
  /**
   * Frequency modulation (bells, metallic tones): modulator at `freq * ratio`, deviation
   * `index * freq` Hz, ramping to `indexEnd` over the envelope.
   */
  fm?: { ratio: number; index: number; indexEnd?: number };
}

export interface NoiseSource {
  type: 'noise';
  color: NoiseColor;
  seed?: number;
}

export interface CrackleSource {
  type: 'crackle';
  /** Average clicks per second. */
  density: number;
  seed?: number;
  /** Seconds each click rings. Default 0.004. */
  clickDecay?: number;
}

export type Source = OscSource | NoiseSource | CrackleSource;

export interface FilterSpec {
  type: BiquadFilterType;
  /** Cutoff/centre Hz. */
  freq: number;
  /** Sweep target Hz (exponential, over the layer's envelope). */
  freqEnd?: number;
  q?: number;
  /** dB, for shelf/peaking types. */
  gain?: number;
}

export interface Layer {
  source: Source;
  env: Envelope;
  /** Peak gain of this layer. Default 1. */
  gain?: number;
  /** Seconds after the sound starts. Default 0. */
  start?: number;
  /** Seconds from layer start to note-off. Default: as long as fits before `duration`. */
  gate?: number;
  /** -1..1. Makes the render stereo. */
  pan?: number;
  filter?: FilterSpec | readonly FilterSpec[];
  /** Amplitude wobble: `rate` Hz, `depth` 0..1. */
  tremolo?: { rate: number; depth: number };
}

export interface SoundSpec {
  /** Seconds. For loops, the loop length. */
  duration: number;
  layers: readonly Layer[];
  /** Master gain applied before normalisation. Default 1. */
  gain?: number;
  /** Peak-normalise to this level (e.g. 0.8). Default: no normalisation. */
  normalize?: number;
  /** Default 44100. */
  sampleRate?: number;
  /** Default: 2 if any layer pans, else 1. */
  channels?: 1 | 2;
  /** Render `crossfade` extra seconds and fold them into the head for a seamless loop. */
  loop?: { crossfade: number };
}

function layerFilters(layer: Layer): readonly FilterSpec[] {
  if (!layer.filter) return [];
  return Array.isArray(layer.filter) ? layer.filter : [layer.filter as FilterSpec];
}

/** Default gate: note-off early enough for the release to finish inside `duration`. */
export function layerGate(layer: Layer, duration: number): number {
  if (layer.gate !== undefined) return layer.gate;
  return Math.max(0, duration - (layer.start ?? 0) - layer.env.release);
}

export function specChannels(spec: SoundSpec): 1 | 2 {
  return spec.channels ?? (spec.layers.some((l) => l.pan) ? 2 : 1);
}

/** Problems with a spec, or an empty array. Used by tests and in dev before rendering. */
export function validateSpec(spec: SoundSpec): string[] {
  const errs: string[] = [];
  const sr = spec.sampleRate ?? 44100;
  const nyquist = sr / 2;
  if (!(spec.duration > 0) || spec.duration > 60)
    errs.push(`duration ${spec.duration} not in (0, 60]`);
  if (spec.layers.length === 0) errs.push('no layers');
  if (spec.loop && !(spec.loop.crossfade >= 0 && spec.loop.crossfade < spec.duration))
    errs.push('loop crossfade must be in [0, duration)');
  spec.layers.forEach((l, i) => {
    const at = `layer ${i}`;
    const start = l.start ?? 0;
    const gate = layerGate(l, spec.duration);
    const end = start + envelopeLength(l.env, gate);
    if (start < 0) errs.push(`${at}: negative start`);
    if (!spec.loop && end > spec.duration + 1e-6)
      errs.push(`${at}: ends at ${end.toFixed(3)}s, after duration ${spec.duration}s`);
    for (const k of ['attack', 'decay', 'release'] as const)
      if (!(l.env[k] >= 0)) errs.push(`${at}: env.${k} must be ≥ 0`);
    if (!(l.env.sustain >= 0 && l.env.sustain <= 1)) errs.push(`${at}: env.sustain not in [0, 1]`);
    if (l.pan !== undefined && Math.abs(l.pan) > 1) errs.push(`${at}: pan not in [-1, 1]`);
    if (l.source.type === 'osc') {
      const { freq, freqEnd } = l.source;
      if (!(freq > 0 && freq < nyquist)) errs.push(`${at}: freq ${freq} out of range`);
      if (freqEnd !== undefined && !(freqEnd > 0 && freqEnd < nyquist))
        errs.push(`${at}: freqEnd ${freqEnd} out of range`);
    }
    if (l.source.type === 'crackle' && !(l.source.density > 0)) errs.push(`${at}: density ≤ 0`);
    for (const f of layerFilters(l)) {
      if (!(f.freq > 0 && f.freq < nyquist)) errs.push(`${at}: filter freq ${f.freq} out of range`);
      if (f.freqEnd !== undefined && !(f.freqEnd > 0 && f.freqEnd < nyquist))
        errs.push(`${at}: filter freqEnd ${f.freqEnd} out of range`);
    }
  });
  return errs;
}

export type OfflineContextFactory = (
  channels: number,
  length: number,
  sampleRate: number,
) => OfflineAudioContext;

const defaultOffline: OfflineContextFactory = (channels, length, sampleRate) =>
  new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate });

function rampFreq(
  param: AudioParam,
  from: number,
  to: number | undefined,
  start: number,
  time: number,
  curve: 'exp' | 'linear',
) {
  param.setValueAtTime(from, start);
  if (to === undefined || time <= 0) return;
  if (curve === 'exp') param.exponentialRampToValueAtTime(Math.max(1e-3, to), start + time);
  else param.linearRampToValueAtTime(to, start + time);
}

function buildSource(
  ctx: BaseAudioContext,
  layer: Layer,
  start: number,
  sweep: number,
  renderLen: number,
): { node: AudioScheduledSourceNode; extra: AudioScheduledSourceNode[] } {
  const src = layer.source;
  if (src.type === 'osc') {
    const osc = ctx.createOscillator();
    osc.type = src.wave;
    const curve = src.glideCurve ?? 'exp';
    const glide = src.glide ?? sweep;
    rampFreq(osc.frequency, src.freq, src.freqEnd, start, glide, curve);
    if (src.detune) osc.detune.value = src.detune;
    const extra: AudioScheduledSourceNode[] = [];
    if (src.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = src.vibrato.rate;
      const depth = ctx.createGain();
      depth.gain.value = src.vibrato.depth;
      lfo.connect(depth).connect(osc.detune);
      extra.push(lfo);
    }
    if (src.fm) {
      const mod = ctx.createOscillator();
      const ratio = src.fm.ratio;
      rampFreq(
        mod.frequency,
        src.freq * ratio,
        src.freqEnd !== undefined ? src.freqEnd * ratio : undefined,
        start,
        glide,
        curve,
      );
      const dev = ctx.createGain();
      dev.gain.setValueAtTime(src.fm.index * src.freq, start);
      if (src.fm.indexEnd !== undefined)
        dev.gain.linearRampToValueAtTime(
          src.fm.indexEnd * (src.freqEnd ?? src.freq),
          start + sweep,
        );
      mod.connect(dev).connect(osc.frequency);
      extra.push(mod);
    }
    return { node: osc, extra };
  }
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.ceil((renderLen - start) * sr));
  const data = new Float32Array(len);
  if (src.type === 'noise') fillNoise(data, src.color, src.seed ?? 1);
  else fillCrackle(data, sr, src.density, src.seed ?? 1, src.clickDecay);
  const buf = ctx.createBuffer(1, len, sr);
  buf.copyToChannel(data, 0);
  const node = ctx.createBufferSource();
  node.buffer = buf;
  return { node, extra: [] };
}

/** Render a spec to an `AudioBuffer`. Rendering needs no user gesture. */
export async function renderSound(
  spec: SoundSpec,
  createOffline: OfflineContextFactory = defaultOffline,
): Promise<AudioBuffer> {
  if (import.meta.env?.DEV) {
    const errs = validateSpec(spec);
    if (errs.length) console.warn(`[audio] sound spec problems:\n  ${errs.join('\n  ')}`);
  }
  const sr = spec.sampleRate ?? 44100;
  const channels = specChannels(spec);
  const fade = spec.loop ? spec.loop.crossfade : 0;
  const loopLen = Math.round(spec.duration * sr);
  const fadeLen = Math.round(fade * sr);
  const renderLen = (loopLen + fadeLen) / sr;
  const ctx = createOffline(channels, loopLen + fadeLen, sr);

  const master = ctx.createGain();
  master.gain.value = spec.gain ?? 1;
  master.connect(ctx.destination);

  for (const layer of spec.layers) {
    const start = layer.start ?? 0;
    // In a loop, layers default to sounding through the crossfade tail too.
    const gate =
      spec.loop && layer.gate === undefined ? renderLen - start : layerGate(layer, spec.duration);
    const sweep = envelopeLength(layer.env, gate);
    const { node, extra } = buildSource(ctx, layer, start, sweep, renderLen);

    let out: AudioNode = node;
    for (const f of layerFilters(layer)) {
      const bq = ctx.createBiquadFilter();
      bq.type = f.type;
      rampFreq(bq.frequency, f.freq, f.freqEnd, start, sweep, 'exp');
      if (f.q !== undefined) bq.Q.value = f.q;
      if (f.gain !== undefined) bq.gain.value = f.gain;
      out = out.connect(bq);
    }
    const amp = ctx.createGain();
    scheduleEnvelope(amp.gain, layer.env, start, gate, layer.gain ?? 1);
    out = out.connect(amp);
    if (layer.tremolo) {
      const trem = ctx.createGain();
      trem.gain.value = 1 - layer.tremolo.depth / 2;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = layer.tremolo.rate;
      const depth = ctx.createGain();
      depth.gain.value = layer.tremolo.depth / 2;
      lfo.connect(depth).connect(trem.gain);
      extra.push(lfo);
      out = out.connect(trem);
    }
    if (channels === 2 && layer.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = layer.pan;
      out = out.connect(pan);
    }
    out.connect(master);
    const stopAt = Math.min(renderLen, start + sweep + 0.02);
    for (const n of [node, ...extra]) {
      n.start(start);
      n.stop(stopAt);
    }
  }

  const rendered = await ctx.startRendering();
  let result = rendered;
  if (spec.loop) {
    result = ctx.createBuffer(channels, loopLen, sr);
    for (let c = 0; c < channels; c++) {
      result.copyToChannel(foldLoop(rendered.getChannelData(c), loopLen, fadeLen), c);
    }
  }
  if (spec.normalize !== undefined) {
    const chans: Float32Array[] = [];
    for (let c = 0; c < result.numberOfChannels; c++) chans.push(result.getChannelData(c));
    normalize(chans, spec.normalize);
  }
  return result;
}
