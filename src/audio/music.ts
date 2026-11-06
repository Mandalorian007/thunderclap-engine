/**
 * Music on a beat grid: looping stems started sample-accurately on the next beat or bar from the
 * context clock, grouped in layers, crossfaded by `fadeBeats` and by an intensity level. Sits on
 * the mixer's buses; it owns its own `AudioBufferSourceNode`s so they can start at an offset
 * that keeps every stem in phase with the grid. Each playing stem is registered with the mixer
 * through a `Voice` adapter, so `audio.voices('music')`, `stopAll` and `pause` see it.
 *
 * A stem with a `url` can also be streamed (`play(name, { stream: true })`, ws/audio-4): a
 * `MediaElementAudioSourceNode` over an `<audio>` element the page decodes as it goes, so a long
 * track costs no decoded buffer. The grid then follows the element's `currentTime`.
 */
import {
  type AudioEngine,
  type OutputBus,
  rampParamTo,
  type Voice,
  type VoiceFilterKind,
  type VoiceFilterOptions,
  VoiceSends,
} from './audio';

export interface MusicOptions {
  bpm: number;
  /** Beats in a bar. Default 4. */
  beatsPerBar?: number;
  /** Bus the stems play on. Default `music`. */
  bus?: OutputBus;
  /** Beats a `setIntensity` crossfade takes. Default 1. */
  intensityFadeBeats?: number;
  /**
   * Makes the media element a streamed stem plays through. Default `document.createElement('audio')`
   * where a document exists; without one (and without `createMediaElementSource` on the
   * context) streamed stems fall back to their buffer.
   */
  createElement?: () => StreamElement;
}

/** What music needs from an `<audio>` element (a fake in tests). */
export interface StreamElement {
  src: string;
  loop: boolean;
  currentTime: number;
  /** NaN until the metadata loaded. */
  readonly duration: number;
  readonly paused: boolean;
  playbackRate: number;
  play(): Promise<void> | void;
  pause(): void;
}

/** A looping piece of music: a buffer (or a streamable URL) whose length is a whole number of bars. */
export interface Stem {
  name: string;
  /** The decoded loop. Optional when `url` is set and the stem is only ever streamed. */
  buffer?: AudioBuffer;
  /** A URL to stream the stem from (`play(name, { stream: true })`). */
  url?: string;
  /**
   * Layer the stem belongs to (default: its own name). Within a layer, stems with an `intensity`
   * range are mixed by `setIntensity`; a stem without one replaces the layer's other rangeless
   * stem when played (a crossfade).
   */
  layer?: string;
  /**
   * Intensity range `[lo, hi]` (0..1) over which the stem is at full gain. Between the `hi` of one
   * stem and the `lo` of the next in the same layer (sorted by `lo`) the two crossfade linearly,
   * so their gains sum to 1 at every level. Below the first stem's `lo` the first stem plays,
   * above the last stem's `hi` the last one does.
   */
  intensity?: readonly [number, number];
}

export type MusicStart = 'now' | 'beat' | 'bar';

export interface MusicPlayOptions {
  /** Overrides the stem's layer. */
  layer?: string;
  /** Fade-in length in beats (and fade-out of a stem this one replaces). Default 0 for a stem joining a layer, 1 for a replacement. */
  fadeBeats?: number;
  /** When to start: immediately, on the next beat, or on the next bar. Default `bar`. */
  at?: MusicStart;
  /** Linear gain on top of the intensity gain. Default 1. */
  gain?: number;
  /**
   * Stream the stem from its `url` through a media element instead of a decoded buffer
   * (ws/audio-4). A streamed stem starts now, in phase with the grid (`at` is ignored); if the
   * grid has not started it starts from the element's clock. Falls back to the buffer path
   * where the context has no `createMediaElementSource` or no element can be made.
   */
  stream?: boolean;
}

export interface Music {
  /** Register a stem so `play(name)` finds it. Replaces a stem of the same name. */
  add(stem: Stem): void;
  /** Start a stem (by name, or a stem registered on the fly) aligned to the grid. */
  play(stem: string | Stem, opts?: MusicPlayOptions): void;
  /** Stop one layer (or every stem) with a fade in beats (default 1). */
  stop(layer?: string, fadeBeats?: number): void;
  /** Crossfade stems that declare an `intensity` range. 0..1. */
  setIntensity(level: number): void;
  readonly intensity: number;
  /** Beat within the current bar, 0-based. */
  readonly beat: number;
  /** Bars since the grid started, 0-based. */
  readonly bar: number;
  /** Beats since the grid started. */
  readonly totalBeats: number;
  /** Seconds per beat. */
  readonly beatDuration: number;
  /** Context time of the next beat / bar boundary (0 before the context exists). */
  nextBeatTime(): number;
  nextBarTime(): number;
  /** Called once per beat crossed by `update`, with the beat in the bar and the bar. Returns unsubscribe. */
  onBeat(cb: (beat: number, bar: number) => void): () => void;
  /** Current target gain of a stem (intensity × play gain; 0 when not playing). */
  gain(name: string): number;
  /** Names of the stems playing now. */
  readonly playing: readonly string[];
  /** Advance `beat`/`bar` from the context clock and fire `onBeat`. Call once per frame. */
  update(dt: number): void;
  /** Stop everything at once and drop the grid. */
  dispose(): void;
}

interface Playing {
  stem: Stem;
  layer: string;
  /** The buffer source, or null for a streamed stem. */
  src: AudioBufferSourceNode | null;
  /** The element and its node of a streamed stem. */
  el: StreamElement | null;
  elNode: AudioNode | null;
  /** Context time a stopping stream's fade ends (it is paused then, from `update`). */
  stopAt: number;
  gainNode: GainNode;
  /** `Voice.filter`'s pooled biquad between the gain and the bus. */
  filterNode: BiquadFilterNode | null;
  playGain: number;
  target: number;
  stopping: boolean;
  /** The stem as the mixer sees it (`mixer.register`); `unregister` while it is on the books. */
  voice: StemVoice;
  unregister: (() => void) | null;
  sends: VoiceSends | null;
}

/** A stem's `Voice` adapter; `rate` lets `audio.pause` freeze and restore it. */
interface StemVoice extends Voice {
  rate: number;
}

interface Pending {
  stem: Stem;
  opts: MusicPlayOptions;
}

/** Gains of a sorted run of stems (by `lo`) at `level`, linear crossfades, summing to 1. */
export function intensityGains(
  ranges: readonly (readonly [number, number])[],
  level: number,
  out: number[],
): number[] {
  const n = ranges.length;
  out.length = n;
  if (n === 0) return out;
  const x = Math.min(1, Math.max(0, level));
  for (let i = 0; i < n; i++) out[i] = 0;
  if (x <= ranges[0]![1] || n === 1) {
    out[0] = 1;
    if (n === 1) return out;
  }
  for (let i = 0; i < n - 1; i++) {
    const hi = ranges[i]![1];
    const nextLo = ranges[i + 1]![0];
    const a = Math.min(hi, nextLo);
    const b = Math.max(hi, nextLo);
    if (x < a) break;
    if (x >= b) {
      out[i] = 0;
      out[i + 1] = 1;
      continue;
    }
    // In the transition between stem i and stem i+1.
    const t = b > a ? (x - a) / (b - a) : 1;
    out[i] = 1 - t;
    out[i + 1] = t;
    break;
  }
  return out;
}

export function createMusic(mixer: AudioEngine, opts: MusicOptions): Music {
  const bpm = opts.bpm;
  const beatsPerBar = Math.max(1, Math.round(opts.beatsPerBar ?? 4));
  const bus: OutputBus = opts.bus ?? 'music';
  const beatDuration = 60 / bpm;
  const intensityFade = (opts.intensityFadeBeats ?? 1) * beatDuration;
  const stems = new Map<string, Stem>();
  const active = new Map<string, Playing>();
  const pending: Pending[] = [];
  const beatListeners = new Set<(beat: number, bar: number) => void>();
  const playingNames: string[] = [];
  const scratchRanges: [number, number][] = [];
  const scratchGains: number[] = [];
  const scratchStems: Playing[] = [];
  const scratchLayers: string[] = [];
  /** Streams fading out, paused once their `stopAt` passes. */
  const stoppingStreams: Playing[] = [];
  let origin = -1;
  /** The streamed stem whose element clock the grid follows (the first one playing). */
  let clockStream: Playing | null = null;
  const makeElement =
    opts.createElement ??
    (typeof document !== 'undefined'
      ? () => document.createElement('audio') as unknown as StreamElement
      : null);
  let lastBeat = -1;
  let intensity = 0;
  let unsub: (() => void) | null = null;
  let disposed = false;

  const ctxTime = () => mixer.context?.currentTime ?? 0;

  function ensureGrid(): boolean {
    const ctx = mixer.context;
    if (!ctx || mixer.state !== 'running' || !mixer.busNode(bus)) return false;
    if (origin < 0) {
      origin = ctx.currentTime;
      lastBeat = -1;
    }
    return true;
  }

  function startTime(at: MusicStart): number {
    const now = ctxTime();
    if (at === 'now') return now;
    const unit = at === 'beat' ? beatDuration : beatDuration * beatsPerBar;
    const k = Math.ceil((now - origin) / unit - 1e-9);
    return origin + Math.max(k, 0) * unit;
  }

  function layerOf(stem: Stem, o: MusicPlayOptions): string {
    return o.layer ?? stem.layer ?? stem.name;
  }

  /** Recompute the intensity gain of every playing stem in `layer` and ramp to it. */
  function applyLayer(layer: string, fade: number, when: number): void {
    scratchStems.length = 0;
    for (const p of active.values()) {
      if (p.layer === layer && !p.stopping && p.stem.intensity) scratchStems.push(p);
    }
    scratchStems.sort((a, b) => a.stem.intensity![0] - b.stem.intensity![0]);
    scratchRanges.length = 0;
    for (const p of scratchStems) {
      const r = p.stem.intensity!;
      scratchRanges.push([r[0], r[1]]);
    }
    intensityGains(scratchRanges, intensity, scratchGains);
    for (let i = 0; i < scratchStems.length; i++) {
      const p = scratchStems[i]!;
      ramp(p, scratchGains[i]! * p.playGain, fade, when);
    }
  }

  function ramp(p: Playing, target: number, fade: number, when: number): void {
    if (p.target === target && fade > 0) return;
    p.target = target;
    const g = p.gainNode.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    if (fade > 0) g.linearRampToValueAtTime(target, when + fade);
    else g.setValueAtTime(target, when);
  }

  function startStem(stem: Stem, o: MusicPlayOptions): void {
    const ctx = mixer.context!;
    const busNode = mixer.busNode(bus)!;
    const layer = layerOf(stem, o);
    const streamed =
      o.stream === true &&
      stem.url !== undefined &&
      makeElement !== null &&
      typeof ctx.createMediaElementSource === 'function';
    if (!streamed && !stem.buffer) {
      console.warn(
        `[audio] stem "${stem.name}" has no buffer${stem.url ? ' and cannot stream here' : ''}`,
      );
      return;
    }
    // A stream cannot be scheduled ahead: it starts now, and so do the fades around it.
    const when = streamed ? ctxTime() : startTime(o.at ?? 'bar');
    const existing = active.get(stem.name);
    if (existing) stopOne(existing, (o.fadeBeats ?? 1) * beatDuration, when);
    // A rangeless stem replaces the layer's other rangeless stems (a crossfade).
    let replaced = false;
    if (!stem.intensity) {
      for (const p of active.values()) {
        if (p.layer === layer && !p.stopping && !p.stem.intensity && p.stem.name !== stem.name) {
          stopOne(p, (o.fadeBeats ?? 1) * beatDuration, when);
          replaced = true;
        }
      }
    }
    const fade = (o.fadeBeats ?? (replaced ? 1 : 0)) * beatDuration;
    const gainNode = ctx.createGain();
    const playGain = o.gain ?? 1;
    const p: Playing = {
      stem,
      layer,
      src: null,
      el: null,
      elNode: null,
      stopAt: 0,
      gainNode,
      filterNode: null,
      playGain,
      target: 0,
      stopping: false,
      voice: null as unknown as StemVoice,
      unregister: null,
      sends: null,
    };
    p.voice = stemVoice(p);
    const target = stem.intensity ? 0 : playGain;
    if (fade > 0) {
      gainNode.gain.setValueAtTime(0, when);
      gainNode.gain.linearRampToValueAtTime(target, when + fade);
    } else {
      gainNode.gain.setValueAtTime(target, when);
    }
    p.target = target;
    gainNode.connect(busNode);
    if (streamed) {
      const el = makeElement!();
      el.src = stem.url!;
      el.loop = true;
      const node = ctx.createMediaElementSource(el as unknown as HTMLMediaElement);
      node.connect(gainNode);
      p.el = el;
      p.elNode = node;
      // In phase with the grid where the element's length is known; else it sets the grid.
      const duration = el.duration;
      if (Number.isFinite(duration) && duration > 0) {
        el.currentTime = (((when - origin) % duration) + duration) % duration;
      }
      if (clockStream === null) {
        clockStream = p;
        if (active.size === 0) {
          origin = when - (Number.isFinite(el.currentTime) ? el.currentTime : 0);
          lastBeat = -1;
        }
      }
      void Promise.resolve(el.play()).catch(() => {});
    } else {
      const src = ctx.createBufferSource();
      src.buffer = stem.buffer!;
      src.loop = true;
      p.src = src;
      src.connect(gainNode);
      src.onended = () => endOne(p);
      // Keep the loop in phase with the grid: offset by the grid time elapsed, modulo the loop.
      const duration = stem.buffer!.duration;
      const offset = duration > 0 ? (((when - origin) % duration) + duration) % duration : 0;
      src.start(when, offset);
    }
    active.set(stem.name, p);
    p.unregister = mixer.register(p.voice, bus);
    if (stem.intensity) applyLayer(layer, fade, when);
  }

  /** The stem's source is done (buffer ended, or stream paused after its fade): tear it down. */
  function endOne(p: Playing): void {
    p.sends?.dispose();
    p.sends = null;
    p.gainNode.disconnect();
    if (p.filterNode) {
      p.filterNode.disconnect();
      mixer.releaseBiquad(p.filterNode);
      p.filterNode = null;
    }
    if (p.el) {
      p.el.pause();
      p.elNode?.disconnect();
      p.el.src = '';
      if (clockStream === p) clockStream = null;
    }
    p.unregister?.();
    p.unregister = null;
    if (active.get(p.stem.name) === p) active.delete(p.stem.name);
  }

  /** Wire gain → [filter] → bus and move the sends to the tail. */
  function relink(p: Playing): void {
    const busNode = mixer.busNode(bus);
    const ctx = mixer.context;
    if (!busNode || !ctx) return;
    p.gainNode.disconnect();
    p.filterNode?.disconnect();
    const tail: AudioNode = p.filterNode ? p.gainNode.connect(p.filterNode) : p.gainNode;
    tail.connect(busNode);
    if (p.sends) {
      if (p.sends.attached) p.sends.retarget(tail);
      else p.sends.attach(ctx, tail);
    }
  }

  /** Streams cannot `stop(when)`: pause the ones whose fade has ended. */
  function reapStreams(now: number): void {
    for (let i = stoppingStreams.length - 1; i >= 0; i--) {
      const p = stoppingStreams[i]!;
      if (now < p.stopAt) continue;
      stoppingStreams.splice(i, 1);
      endOne(p);
    }
  }

  /** Follow the clock stream's element: the grid origin is its `currentTime` ago, modulo its length. */
  function followClock(now: number): void {
    const p = clockStream;
    if (!p || p.stopping) return;
    const el = p.el!;
    const t = el.currentTime;
    const duration = el.duration;
    if (!Number.isFinite(t) || el.paused) return;
    let o = now - t;
    if (Number.isFinite(duration) && duration > 0 && origin >= 0) {
      // The element wrapped; keep the origin the candidate nearest the one we had.
      o -= Math.round((o - origin) / duration) * duration;
    }
    origin = o;
  }

  /** The `Voice` the mixer sees for a stem: stop fades in seconds, gain and rate write its nodes. */
  function stemVoice(p: Playing): StemVoice {
    const voice: StemVoice = {
      rate: 1,
      stop(fade = 0) {
        stopOne(p, fade, ctxTime());
      },
      setGain(gain, r = 0.05) {
        p.playGain = gain;
        const when = ctxTime();
        if (p.stopping) return;
        if (p.stem.intensity) applyLayer(p.layer, r, when);
        else ramp(p, gain, r, when);
      },
      setRate(rate, r = 0.05) {
        voice.rate = rate;
        if (p.src) {
          rampParamTo(p.src.playbackRate, rate, ctxTime(), r);
        } else if (p.el && !p.stopping) {
          // An element cannot run at 0: pause it, and resume where it was.
          if (rate <= 0) {
            p.el.pause();
          } else {
            p.el.playbackRate = rate;
            if (p.el.paused) void Promise.resolve(p.el.play()).catch(() => {});
          }
        }
      },
      setPosition() {},
      setDirection() {},
      follow() {},
      sendTo(input, amount, r = 0.05) {
        p.sends ??= new VoiceSends();
        const sends = p.sends;
        if (!sends.attached) sends.attach(mixer.context!, p.filterNode ?? p.gainNode);
        sends.set(input, amount, r);
      },
      filter(kind: VoiceFilterKind | null, o: VoiceFilterOptions = {}) {
        if (p.stopping) return;
        const now = ctxTime();
        const ramp = o.ramp ?? 0.05;
        if (kind === null) {
          const f = p.filterNode;
          if (!f) return;
          p.filterNode = null;
          relink(p);
          mixer.releaseBiquad(f);
          return;
        }
        let f = p.filterNode;
        const fresh = f === null;
        f ??= mixer.acquireBiquad();
        if (!f) return;
        f.type = kind;
        rampParamTo(f.frequency, o.cutoff ?? 1000, now, fresh ? 0 : ramp);
        rampParamTo(f.Q, o.q ?? 1, now, fresh ? 0 : ramp);
        if (fresh) {
          p.filterNode = f;
          relink(p);
        }
      },
      position: new Float64Array(3),
      get playing() {
        return !p.stopping;
      },
      get sendCount() {
        return p.sends?.count ?? 0;
      },
      occlusion: 0,
      doppler: 1,
    };
    return voice;
  }

  function stopOne(p: Playing, fade: number, when: number): void {
    if (p.stopping) return;
    p.stopping = true;
    active.delete(p.stem.name);
    p.unregister?.();
    p.unregister = null;
    const g = p.gainNode.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    if (fade > 0) {
      g.linearRampToValueAtTime(0, when + fade);
    } else {
      g.setValueAtTime(0, when);
    }
    if (p.src) {
      try {
        p.src.stop(when + fade);
      } catch {
        // Already stopped.
      }
    } else if (p.el) {
      if (clockStream === p) {
        clockStream = null;
        for (const q of active.values()) if (q.el && !q.stopping) clockStream = q;
      }
      p.stopAt = when + fade;
      if (fade > 0) stoppingStreams.push(p);
      else endOne(p);
    }
  }

  function flushPending(): void {
    if (!ensureGrid()) return;
    for (const q of pending) startStem(q.stem, q.opts);
    pending.length = 0;
  }

  function watchUnlock(): void {
    if (unsub) return;
    unsub = mixer.onStateChange((s) => {
      if (s === 'running') flushPending();
    });
  }

  const music: Music = {
    add(stem) {
      stems.set(stem.name, stem);
    },
    play(stem, o = {}) {
      if (disposed) return;
      const s = typeof stem === 'string' ? stems.get(stem) : stem;
      if (!s) {
        console.warn(`[audio] unknown stem "${String(stem)}"`);
        return;
      }
      if (typeof stem !== 'string') stems.set(s.name, s);
      if (!ensureGrid()) {
        pending.push({ stem: s, opts: o });
        watchUnlock();
        return;
      }
      startStem(s, o);
    },
    stop(layer, fadeBeats = 1) {
      const fade = fadeBeats * beatDuration;
      const when = ctxTime();
      for (const p of [...active.values()]) {
        if (layer === undefined || p.layer === layer) stopOne(p, fade, when);
      }
      if (layer === undefined) pending.length = 0;
      else
        for (let i = pending.length - 1; i >= 0; i--) {
          if (layerOf(pending[i]!.stem, pending[i]!.opts) === layer) pending.splice(i, 1);
        }
    },
    setIntensity(level) {
      intensity = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
      if (origin < 0) return;
      const when = ctxTime();
      // One pass per distinct layer that has ranged stems.
      scratchLayers.length = 0;
      for (const p of active.values()) {
        if (!p.stem.intensity || p.stopping || scratchLayers.includes(p.layer)) continue;
        scratchLayers.push(p.layer);
      }
      for (const layer of scratchLayers) applyLayer(layer, intensityFade, when);
    },
    get intensity() {
      return intensity;
    },
    get beat() {
      return origin < 0
        ? 0
        : Math.max(0, Math.floor((ctxTime() - origin) / beatDuration)) % beatsPerBar;
    },
    get bar() {
      return origin < 0
        ? 0
        : Math.floor(Math.max(0, Math.floor((ctxTime() - origin) / beatDuration)) / beatsPerBar);
    },
    get totalBeats() {
      return origin < 0 ? 0 : Math.max(0, Math.floor((ctxTime() - origin) / beatDuration));
    },
    beatDuration,
    nextBeatTime() {
      return origin < 0 ? 0 : startTime('beat');
    },
    nextBarTime() {
      return origin < 0 ? 0 : startTime('bar');
    },
    onBeat(cb) {
      beatListeners.add(cb);
      return () => beatListeners.delete(cb);
    },
    gain(name) {
      return active.get(name)?.target ?? 0;
    },
    get playing() {
      playingNames.length = 0;
      for (const p of active.values()) playingNames.push(p.stem.name);
      return playingNames;
    },
    update() {
      if (disposed || !ensureGrid()) return;
      const now = ctxTime();
      if (stoppingStreams.length > 0) reapStreams(now);
      if (clockStream) followClock(now);
      const total = Math.max(0, Math.floor((now - origin) / beatDuration));
      if (total === lastBeat) return;
      if (lastBeat < 0) lastBeat = total - 1;
      // Fire each beat crossed since the last update (a long frame skips none).
      for (let b = lastBeat + 1; b <= total; b++) {
        const beat = b % beatsPerBar;
        const bar = Math.floor(b / beatsPerBar);
        for (const fn of beatListeners) fn(beat, bar);
      }
      lastBeat = total;
    },
    dispose() {
      disposed = true;
      music.stop(undefined, 0);
      for (const p of stoppingStreams) endOne(p);
      stoppingStreams.length = 0;
      beatListeners.clear();
      unsub?.();
      unsub = null;
      origin = -1;
    },
  };
  return music;
}
