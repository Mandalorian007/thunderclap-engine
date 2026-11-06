/**
 * Runtime audio: an `AudioContext` created and resumed on the first user gesture, four buses
 * (master ← music, sfx, ui), named sounds rendered from specs, one-shots and loops.
 */
import { reverbImpulse, volumeToGain } from './dsp';
import type { Send } from './send';
import { type OfflineContextFactory, renderSound, type SoundSpec } from './synth';
import { AudioZones } from './zones';

export const BUS_NAMES = ['master', 'music', 'sfx', 'ui'] as const;
export type BusName = (typeof BUS_NAMES)[number];
/** Buses a sound can play on (everything feeds master). */
export type OutputBus = Exclude<BusName, 'master'>;

export interface BusSettings {
  /** Slider position 0..1 (mapped to gain with a squared curve). */
  volume: number;
  muted: boolean;
}
export type MixerSettings = Record<BusName, BusSettings>;

export const DEFAULT_MIXER: Readonly<MixerSettings> = {
  master: { volume: 0.8, muted: false },
  music: { volume: 0.7, muted: false },
  sfx: { volume: 0.9, muted: false },
  ui: { volume: 0.8, muted: false },
};

/** Clamp and fill gaps so any (possibly hand-edited) object becomes valid settings. */
export function sanitizeMixer(input: unknown): MixerSettings {
  const src = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const out = {} as MixerSettings;
  for (const bus of BUS_NAMES) {
    const b = (typeof src[bus] === 'object' && src[bus] !== null ? src[bus] : {}) as Record<
      string,
      unknown
    >;
    const vol =
      typeof b.volume === 'number' && Number.isFinite(b.volume)
        ? b.volume
        : DEFAULT_MIXER[bus].volume;
    out[bus] = {
      volume: Math.min(1, Math.max(0, vol)),
      muted: typeof b.muted === 'boolean' ? b.muted : DEFAULT_MIXER[bus].muted,
    };
  }
  return out;
}

/** Effective linear gain for a bus. */
export function busGain(s: BusSettings): number {
  return s.muted ? 0 : volumeToGain(s.volume);
}

/**
 * - `locked`: waiting for a user gesture (or no context yet).
 * - `running`: playing.
 * - `suspended`: unlocked but paused (tab hidden or `suspend()`).
 * - `unavailable`: no WebAudio in this browser; everything is a silent no-op.
 */
export type AudioState = 'locked' | 'running' | 'suspended' | 'unavailable';

export interface PlayOptions {
  /** Default `sfx` for `play`, `music` for `loop`. */
  bus?: OutputBus;
  /** Linear gain on top of the bus. Default 1. */
  gain?: number;
  /** Playback rate (1 = original, 2 = octave up). Default 1. */
  rate?: number;
  /** Cents. */
  detune?: number;
  /**
   * 2D stereo position, -1 (left) .. 1 (right), through a `StereoPannerNode`. The shorthand
   * for a flat game (a sound from the left of the board). Ignored when `at` is set.
   */
  pan?: number;
  /**
   * World position `[x, y, z]` of the emitter. Routes the voice through a pooled `PannerNode`
   * (distance and direction relative to `audio.listener`); move it with `Voice.setPosition`.
   * Read once at play time (the array is not kept). Takes precedence over `pan`.
   */
  at?: ArrayLike<number>;
  /** How a voice with `at` attenuates and pans. Ignored without `at`. */
  spatial?: SpatialOptions;
  /** Seconds from now. */
  delay?: number;
  /** Seconds to fade in. Default 0 for one-shots, 0.5 for loops. */
  fadeIn?: number;
}

/** A playing (or pending) sound. Every method is safe to call at any time. */
export interface Voice {
  /** Stop, optionally fading out over `fade` seconds. */
  stop(fade?: number): void;
  setGain(gain: number, ramp?: number): void;
  setRate(rate: number, ramp?: number): void;
  /**
   * Move a spatial voice (one played with `at`) to world `(x, y, z)`. Writes the voice's own
   * `PannerNode` in place, so it is safe to call every frame. No-op on a non-spatial voice;
   * on a voice still waiting to start, the position is kept and applied at start.
   */
  setPosition(x: number, y: number, z: number): void;
  /** Point a spatial voice's cone (`spatial.cone`) along `(x, y, z)`. Same rules as `setPosition`. */
  setDirection(x: number, y: number, z: number): void;
  /**
   * Make a spatial voice read its position from `target.world` (a 3×4 row-major world matrix,
   * translation at floats 3, 7 and 11, such as a `Transform`'s) on every `audio.update(dt)`,
   * so the game stops copying positions. `null` stops following. No-op on a non-spatial voice.
   */
  follow(target: { readonly world: ArrayLike<number> } | null): void;
  /**
   * Route a copy of this voice into an effect: a parallel path from the voice's output (after
   * its gain and panner) through a send gain of `amount` into `input`, a `Send` (its `input`)
   * or any `AudioNode`. The dry path to the bus is untouched. Calling again with the same
   * `input` ramps the amount over `ramp` seconds (default 0.05); `amount` 0 disconnects it and
   * frees the gain. At most `MAX_VOICE_SENDS` (4) inputs per voice; the fifth throws a
   * `RangeError`. Torn down with the voice. No-op on an inert voice.
   */
  sendTo(input: AudioNode | Send, amount: number, ramp?: number): void;
  /** World position of a spatial voice as last set or followed (zeros on a non-spatial voice). */
  readonly position: ArrayLike<number>;
  readonly playing: boolean;
}

/** Sends one voice can hold at once (`Voice.sendTo`). */
export const MAX_VOICE_SENDS = 4;

/** `stopAll` as an options object (the positional `stopAll(fade?, bus?)` form still works). */
export interface StopAllOptions {
  /** Seconds to fade out. Default 0. */
  fade?: number;
  /** Only this bus. */
  bus?: OutputBus;
  /** Buses left playing, e.g. `['music']` to keep the score through a scene change. */
  except?: readonly BusName[];
}

/** `audio.pause` options. */
export interface PauseOptions {
  /** Buses that keep playing. Default `['ui']` (menu clicks stay audible). `master` never ramps. */
  keep?: readonly OutputBus[];
}

/** Seconds `pause` / `unpause` ramp bus gains and voice rates over. */
const PAUSE_RAMP = 0.05;

/**
 * Internal: write `value` to an AudioParam as a linear ramp over `ramp` seconds from `t`,
 * cancelling what was scheduled (a step when `ramp` is 0).
 */
export function rampParamTo(param: AudioParam, value: number, t: number, ramp: number): void {
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
  if (ramp > 0) param.linearRampToValueAtTime(value, t + ramp);
  else param.setValueAtTime(value, t);
}

function sendInputOf(target: AudioNode | Send): AudioNode | null {
  return typeof (target as AudioNode).connect === 'function'
    ? (target as AudioNode)
    : (target as Send).input;
}

interface SendTap {
  target: AudioNode | Send;
  gain: GainNode | null;
  amount: number;
}

/**
 * Internal: the parallel sends behind `Voice.sendTo`, one per voice, shared by the mixer's own
 * voices and music stems. `attach` names the node to tap once it exists; sends set before that
 * are built then. Each live send is one `GainNode`: tap → gain → input.
 */
export class VoiceSends {
  private readonly taps: SendTap[] = [];
  private from: AudioNode | null = null;
  private ctx: AudioContext | null = null;

  /** True once `attach` ran (the sends are in the graph). */
  get attached(): boolean {
    return this.from !== null;
  }

  /** Live sends. */
  get count(): number {
    return this.taps.length;
  }

  /** The voice's output node is known: build the sends set so far. */
  attach(ctx: AudioContext, from: AudioNode): void {
    this.ctx = ctx;
    this.from = from;
    for (const tap of this.taps) if (!tap.gain) this.build(tap, 0);
  }

  set(target: AudioNode | Send, amount: number, ramp: number): void {
    const i = this.taps.findIndex((t) => t.target === target);
    if (!(amount > 0)) {
      if (i >= 0) this.remove(i);
      return;
    }
    if (i < 0) {
      if (this.taps.length >= MAX_VOICE_SENDS) {
        throw new RangeError(`a voice has at most ${MAX_VOICE_SENDS} sends`);
      }
      const tap: SendTap = { target, gain: null, amount };
      this.taps.push(tap);
      if (this.from) this.build(tap, ramp);
      return;
    }
    const tap = this.taps[i]!;
    tap.amount = amount;
    if (tap.gain && this.ctx) rampParamTo(tap.gain.gain, amount, this.ctx.currentTime, ramp);
  }

  private build(tap: SendTap, ramp: number): void {
    const ctx = this.ctx;
    const from = this.from;
    if (!ctx || !from) return;
    const input = sendInputOf(tap.target);
    // A `Send` without a node (context lacks the effect) stays pending and silent.
    if (!input) return;
    const g = ctx.createGain();
    if (ramp > 0) {
      g.gain.value = 0;
      rampParamTo(g.gain, tap.amount, ctx.currentTime, ramp);
    } else {
      g.gain.value = tap.amount;
    }
    from.connect(g);
    g.connect(input);
    tap.gain = g;
  }

  private remove(i: number): void {
    const tap = this.taps[i]!;
    this.taps.splice(i, 1);
    if (!tap.gain) return;
    try {
      this.from?.disconnect(tap.gain);
    } catch {
      // Not connected.
    }
    tap.gain.disconnect();
  }

  /** Disconnect and drop every send (the voice ended). */
  dispose(): void {
    for (let i = this.taps.length - 1; i >= 0; i--) this.remove(i);
    this.from = null;
  }
}

/** Anything with a 3×4 world matrix a voice can follow (`Voice.follow`). */
export interface FollowTarget {
  readonly world: ArrayLike<number>;
}

/** Distance model of a spatial voice (`PannerNode.distanceModel`). */
export type Rolloff = 'linear' | 'inverse' | 'exponential';

/** Directional emitter: full gain inside `inner`, `outerGain` beyond `outer` (degrees, whole angle). */
export interface ConeOptions {
  /** Degrees. Default 360. */
  inner?: number;
  /** Degrees. Default 360. */
  outer?: number;
  /** Linear gain outside the outer cone. Default 0. */
  outerGain?: number;
}

/** Attenuation and panning of a voice played with `PlayOptions.at`. */
export interface SpatialOptions {
  /** Distance (world units) at which attenuation starts. Default 1. */
  refDistance?: number;
  /** Distance beyond which the voice gets no quieter. Default 10000. */
  maxDistance?: number;
  /** Distance model. Default `'inverse'`. */
  rolloff?: Rolloff;
  /** How fast the model attenuates. Default 1 (WebAudio clamps it to 0..1 for `linear`). */
  rolloffFactor?: number;
  /** `'equalpower'` (default, cheap) or `'HRTF'` (binaural, for headphones and headsets). */
  panningModel?: PanningModelType;
  /** Directional emitter. Omit for an omnidirectional one. */
  cone?: ConeOptions;
  /** Cone direction `[x, y, z]`. Default `[1, 0, 0]` (the WebAudio default). */
  direction?: ArrayLike<number>;
}

/** Anything with a world→view matrix and an eye position, such as the renderer's `Camera`. */
export interface CameraLike {
  /** Column-major world→view matrix (16 numbers). */
  readonly view: ArrayLike<number>;
  /** Eye position in world space. */
  readonly position: ArrayLike<number>;
}

/**
 * Where the ears are: one per `AudioEngine` (`audio.listener`), written to the context's
 * `AudioListener`. Safe before unlock: the pose is kept and applied when the context exists.
 * Every method writes in place and allocates nothing, so call `fromCamera` every frame.
 */
export class SpatialListener {
  /** px, py, pz, fx, fy, fz, ux, uy, uz. */
  private readonly pose = new Float64Array([0, 0, 0, 0, 0, -1, 0, 1, 0]);
  /** Current pose, read-only (change it with `set` or `fromCamera`). */
  readonly position: ArrayLike<number> = this.pose.subarray(0, 3);
  readonly forward: ArrayLike<number> = this.pose.subarray(3, 6);
  readonly up: ArrayLike<number> = this.pose.subarray(6, 9);

  /** Built by `AudioEngine`; reach it as `audio.listener`. */
  constructor(private readonly engine: AudioEngine) {}

  /** Place the listener at `position`, facing `forward`, with `up` (default `[0, 1, 0]`). */
  set(position: ArrayLike<number>, forward: ArrayLike<number>, up?: ArrayLike<number>): void {
    const p = this.pose;
    p[0] = position[0] ?? 0;
    p[1] = position[1] ?? 0;
    p[2] = position[2] ?? 0;
    p[3] = forward[0] ?? 0;
    p[4] = forward[1] ?? 0;
    p[5] = forward[2] ?? -1;
    p[6] = up ? (up[0] ?? 0) : 0;
    p[7] = up ? (up[1] ?? 1) : 1;
    p[8] = up ? (up[2] ?? 0) : 0;
    this.apply();
  }

  /**
   * Follow a camera: position from `camera.position`, forward and up from the view matrix
   * (forward is minus its third row, up its second; the view looks down -z).
   */
  fromCamera(camera: CameraLike): void {
    const v = camera.view;
    const pos = camera.position;
    const p = this.pose;
    p[0] = pos[0]!;
    p[1] = pos[1]!;
    p[2] = pos[2]!;
    p[3] = -v[2]!;
    p[4] = -v[6]!;
    p[5] = -v[10]!;
    p[6] = v[1]!;
    p[7] = v[5]!;
    p[8] = v[9]!;
    this.apply();
  }

  /** Write the pose to the context's listener (on every change, and when the context is built). */
  apply(): void {
    const l = this.engine.context?.listener;
    if (!l) return;
    const p = this.pose;
    if (l.positionX) {
      l.positionX.value = p[0]!;
      l.positionY.value = p[1]!;
      l.positionZ.value = p[2]!;
      l.forwardX.value = p[3]!;
      l.forwardY.value = p[4]!;
      l.forwardZ.value = p[5]!;
      l.upX.value = p[6]!;
      l.upY.value = p[7]!;
      l.upZ.value = p[8]!;
    } else {
      // Older Safari: the deprecated setters.
      const legacy = l as unknown as LegacyListener;
      legacy.setPosition?.(p[0]!, p[1]!, p[2]!);
      legacy.setOrientation?.(p[3]!, p[4]!, p[5]!, p[6]!, p[7]!, p[8]!);
    }
  }
}

interface LegacyListener {
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
}
interface LegacyPanner {
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(x: number, y: number, z: number): void;
}

function writePannerPosition(p: PannerNode, x: number, y: number, z: number): void {
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else {
    (p as unknown as LegacyPanner).setPosition?.(x, y, z);
  }
}

function writePannerDirection(p: PannerNode, x: number, y: number, z: number): void {
  if (p.orientationX) {
    p.orientationX.value = x;
    p.orientationY.value = y;
    p.orientationZ.value = z;
  } else {
    (p as unknown as LegacyPanner).setOrientation?.(x, y, z);
  }
}

type SoundSource = SoundSpec | (() => Promise<AudioBuffer>);

interface SoundEntry {
  source: SoundSource;
  buffer: AudioBuffer | null;
  pending: Promise<AudioBuffer> | null;
  /** Voices currently playing, oldest first, for voice-stealing. */
  voices: VoiceImpl[];
  maxVoices: number;
}

const NULL_VOICE: Voice = {
  stop() {},
  setGain() {},
  setRate() {},
  setPosition() {},
  setDirection() {},
  follow() {},
  sendTo() {},
  position: new Float64Array(3),
  playing: false,
};

/** One-shots requested while their buffer is still rendering are dropped after this long. */
const MAX_LATE_START = 0.15;
/** `prepare` yields once the synchronous render starts in one turn take this long (ms). */
const PREPARE_SLICE_MS = 10;

/** Resolve on a fresh task (not a microtask), so frames and input can run in between. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

class VoiceImpl implements Voice {
  private src: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private stopped = false;
  private targetGain: number;
  private rate: number;
  private ended = false;
  private panner: PannerNode | null = null;
  /** The last node before the bus (gain, panner or stereo panner): what the sends tap. */
  private tail: AudioNode | null = null;
  private sends: VoiceSends | null = null;
  /** `audio.pause` set the playback rate to 0; `rate` keeps the value to restore. */
  private frozen = false;
  /** Emitter position and cone direction (kept for a voice that has not started yet). */
  private readonly spatial: boolean;
  private readonly pos = new Float64Array(3);
  private target: FollowTarget | null = null;
  private dx = 1;
  private dy = 0;
  private dz = 0;

  constructor(
    private readonly engine: AudioEngine,
    readonly loop: boolean,
    private readonly opts: PlayOptions,
    private readonly onEnd: (v: VoiceImpl) => void,
  ) {
    this.targetGain = opts.gain ?? 1;
    this.rate = opts.rate ?? 1;
    const at = opts.at;
    this.spatial = at !== undefined;
    if (at) {
      this.pos[0] = at[0] ?? 0;
      this.pos[1] = at[1] ?? 0;
      this.pos[2] = at[2] ?? 0;
      const d = opts.spatial?.direction;
      if (d) {
        this.dx = d[0] ?? 0;
        this.dy = d[1] ?? 0;
        this.dz = d[2] ?? 0;
      }
    }
  }

  get playing(): boolean {
    return !this.stopped && !this.ended;
  }

  get position(): ArrayLike<number> {
    return this.pos;
  }

  get started(): boolean {
    return this.src !== null;
  }

  get bus(): OutputBus {
    return this.opts.bus ?? (this.loop ? 'music' : 'sfx');
  }

  /** Create nodes and start. Returns false if it can't (no context). */
  start(buffer: AudioBuffer): boolean {
    const ctx = this.engine.context;
    if (!ctx || this.stopped) return false;
    const bus = this.engine.busNode(this.bus);
    if (!bus) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = this.loop;
    // Starting on a paused bus whose voices are frozen: start frozen too.
    if (this.engine.isBusPaused(this.bus) && this.engine.pausedRate) this.frozen = true;
    src.playbackRate.value = this.frozen ? 0 : this.rate;
    if (this.opts.detune) src.detune.value = this.opts.detune;
    const g = ctx.createGain();
    const t = ctx.currentTime + (this.opts.delay ?? 0);
    const fadeIn = this.opts.fadeIn ?? (this.loop ? 0.5 : 0);
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(this.targetGain, t + fadeIn);
    } else {
      g.gain.value = this.targetGain;
    }
    let tail: AudioNode = g;
    const panner = this.spatial ? this.engine.acquirePanner(this.opts.spatial) : null;
    if (panner) {
      writePannerPosition(panner, this.pos[0]!, this.pos[1]!, this.pos[2]!);
      writePannerDirection(panner, this.dx, this.dy, this.dz);
      g.connect(panner);
      tail = panner;
      this.panner = panner;
    } else if (this.opts.pan && !this.spatial) {
      const p = ctx.createStereoPanner();
      p.pan.value = this.opts.pan;
      g.connect(p);
      tail = p;
    }
    src.connect(g);
    tail.connect(bus);
    this.tail = tail;
    this.sends?.attach(ctx, tail);
    src.onended = () => {
      this.ended = true;
      this.sends?.dispose();
      this.sends = null;
      g.disconnect();
      tail.disconnect();
      this.tail = null;
      if (this.panner) {
        this.engine.releasePanner(this.panner);
        this.panner = null;
      }
      this.onEnd(this);
    };
    src.start(t);
    this.src = src;
    this.gainNode = g;
    return true;
  }

  stop(fade = 0): void {
    if (this.stopped) return;
    this.stopped = true;
    const ctx = this.engine.context;
    if (!this.src || !this.gainNode || !ctx) {
      this.onEnd(this);
      return;
    }
    const t = ctx.currentTime;
    try {
      if (fade > 0) {
        const g = this.gainNode.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0, t + fade);
        this.src.stop(t + fade);
      } else {
        this.src.stop(t);
      }
    } catch {
      // Already stopped.
    }
    // Out of the mixer's books now (not when `onended` fires); the nodes are torn down there.
    this.onEnd(this);
  }

  sendTo(input: AudioNode | Send, amount: number, ramp = 0.05): void {
    if (this.ended) return;
    this.sends ??= new VoiceSends();
    const sends = this.sends;
    const ctx = this.engine.context;
    if (this.tail && ctx && !sends.attached) sends.attach(ctx, this.tail);
    sends.set(input, amount, ramp);
  }

  /** Live sends (tests, diagnostics). */
  get sendCount(): number {
    return this.sends?.count ?? 0;
  }

  /** Internal: whether this voice's `playbackRate` accepts 0 (null before it has a source). */
  rateZeroAllowed(): boolean | null {
    if (!this.src) return null;
    const min = this.src.playbackRate.minValue;
    return !(typeof min === 'number' && min > 0);
  }

  /** Internal (`audio.pause`): hold the source at rate 0, keeping `rate` for `thawRate`. */
  freezeRate(ramp: number): void {
    if (this.frozen) return;
    this.frozen = true;
    const ctx = this.engine.context;
    if (this.src && ctx) rampParamTo(this.src.playbackRate, 0, ctx.currentTime, ramp);
  }

  /** Internal (`audio.unpause`): back to the rate the game set. */
  thawRate(ramp: number): void {
    if (!this.frozen) return;
    this.frozen = false;
    const ctx = this.engine.context;
    if (this.src && ctx) rampParamTo(this.src.playbackRate, this.rate, ctx.currentTime, ramp);
  }

  setGain(gain: number, ramp = 0.05): void {
    this.targetGain = gain;
    const ctx = this.engine.context;
    if (!this.gainNode || !ctx) return;
    this.gainNode.gain.setTargetAtTime(gain, ctx.currentTime, Math.max(0.001, ramp / 3));
  }

  setRate(rate: number, ramp = 0.05): void {
    this.rate = rate;
    const ctx = this.engine.context;
    // While frozen by `pause` the new rate waits for `unpause`.
    if (!this.src || !ctx || this.frozen) return;
    this.src.playbackRate.setTargetAtTime(rate, ctx.currentTime, Math.max(0.001, ramp / 3));
  }

  setPosition(x: number, y: number, z: number): void {
    if (!this.spatial) return;
    this.pos[0] = x;
    this.pos[1] = y;
    this.pos[2] = z;
    if (this.panner) writePannerPosition(this.panner, x, y, z);
  }

  follow(target: FollowTarget | null): void {
    if (!this.spatial) return;
    this.target = target;
    this.engine.trackFollower(this, target !== null && this.playing);
  }

  /** Internal: copy the followed matrix's translation into the panner. */
  syncFollow(): void {
    const m = this.target?.world;
    if (m) this.setPosition(m[3]!, m[7]!, m[11]!);
  }

  setDirection(x: number, y: number, z: number): void {
    if (!this.spatial) return;
    this.dx = x;
    this.dy = y;
    this.dz = z;
    if (this.panner) writePannerDirection(this.panner, x, y, z);
  }
}

/** Master limiter (a `DynamicsCompressorNode` between master and the output). */
export interface LimiterOptions {
  /** dB. Default -1. */
  threshold?: number;
  /** dB. Default 0 (hard knee). */
  knee?: number;
  /** Default 20. */
  ratio?: number;
  /** Seconds. Default 0.003. */
  attack?: number;
  /** Seconds. Default 0.25. */
  release?: number;
}

export const DEFAULT_LIMITER: Readonly<Required<LimiterOptions>> = {
  threshold: -1,
  knee: 0,
  ratio: 20,
  attack: 0.003,
  release: 0.25,
};

/** Shared convolution reverb: per-bus sends into one procedural room, returned to master. */
export interface ReverbOptions {
  /** Impulse length in seconds. Default 2. */
  seconds?: number;
  /** Tail shape: `(1 - t)^decay`. Higher = shorter, drier. Default 3. */
  decay?: number;
  /** Impulse noise seed. Default 1. */
  seed?: number;
  /** Wet return level into master (linear). Default 1. */
  wet?: number;
  /** Send level per bus (linear, 0 = dry). Default music 0.2, sfx 0.25, ui 0. */
  sends?: Partial<Record<OutputBus, number>>;
}

export const DEFAULT_REVERB_SENDS: Readonly<Record<OutputBus, number>> = {
  music: 0.2,
  sfx: 0.25,
  ui: 0,
};

interface ReverbNodes {
  convolver: ConvolverNode;
  wet: GainNode;
  sends: Record<OutputBus, GainNode>;
}

export interface AudioEngineOptions {
  /** Create the realtime context. Called lazily, inside a user gesture. */
  createContext?: () => AudioContext;
  /** Offline renderer factory (tests). */
  createOffline?: OfflineContextFactory;
  /** Initial mixer settings (e.g. from a save). */
  settings?: unknown;
  /**
   * Master limiter that catches stacked one-shots before they clip. Default on
   * (`DEFAULT_LIMITER`); `false` connects master straight to the output.
   */
  limiter?: boolean | LimiterOptions;
  /** Optional shared reverb (off by default). Change later with `setReverb`. */
  reverb?: ReverbOptions | null;
}

export interface AttachAudioOptions {
  /** Where to listen for the unlocking gesture. Default `window`. */
  target?: EventTarget;
  /** Suspend while the tab is hidden. Default true. */
  pauseWhenHidden?: boolean;
}

const GESTURES = ['pointerdown', 'pointerup', 'keydown', 'touchend', 'mousedown', 'click'] as const;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private _state: AudioState = 'locked';
  private buses: Partial<Record<BusName, GainNode>> = {};
  private _settings: MixerSettings;
  private readonly sounds = new Map<string, SoundEntry>();
  private readonly deferred = new Set<{ voice: VoiceImpl; sound: string | AudioBuffer }>();
  private readonly active = new Set<VoiceImpl>();
  private readonly stateListeners = new Set<(s: AudioState) => void>();
  private readonly settingsListeners = new Set<(s: Readonly<MixerSettings>) => void>();
  private readonly createContext: () => AudioContext;
  private readonly createOffline: OfflineContextFactory | undefined;
  private detachFns: (() => void)[] = [];
  /** Gesture listeners: armed while audio should run but the browser won't let it. */
  private gestureTarget: EventTarget | null = null;
  private gesturesArmed = false;
  private userSuspended = false;
  private hidden = false;
  private _halted = false;
  private readonly limiterOpts: Required<LimiterOptions> | null;
  private limiterNode: DynamicsCompressorNode | null = null;
  private reverbOpts: ReverbOptions | null;
  /** The base sends (what the game set); the zones add `zoneSends` on top (`max`). */
  private reverbSends: Record<OutputBus, number>;
  private readonly zoneSends: Record<OutputBus, number> = { music: 0, sfx: 0, ui: 0 };
  private readonly effectiveSends: Record<OutputBus, number> = { music: 0, sfx: 0, ui: 0 };
  private readonly appliedSends: Record<OutputBus, number> = { music: 0, sfx: 0, ui: 0 };
  private reverbNodes: ReverbNodes | null = null;
  private _zones: AudioZones | null = null;
  /** Spatial voices following a matrix (`Voice.follow`), synced in `update`. */
  private readonly followers = new Set<VoiceImpl>();
  /** Panners of ended spatial voices, reused by the next ones (cleared with the context). */
  private readonly pannerPool: PannerNode[] = [];
  private _listener: SpatialListener | null = null;
  /** Externally owned voices (`register`): music stems, a game's own players. */
  private readonly registered = new Map<Voice, BusName>();
  private _paused = false;
  private readonly pausedList: OutputBus[] = [];
  private _pausedRate = false;
  /** Whether this context's `playbackRate` accepts 0, once a voice told us. */
  private rateZeroOk: boolean | null = null;
  /** Registered voices frozen by `pause`, with the rate to restore. */
  private readonly frozenExternal = new Map<Voice, number>();

  constructor(opts: AudioEngineOptions = {}) {
    this._settings = sanitizeMixer(opts.settings);
    const lim = opts.limiter ?? true;
    this.limiterOpts = lim === false ? null : { ...DEFAULT_LIMITER, ...(lim === true ? {} : lim) };
    this.reverbOpts = opts.reverb ?? null;
    this.reverbSends = { ...DEFAULT_REVERB_SENDS, ...opts.reverb?.sends };
    for (const b of BUS_NAMES) {
      if (b !== 'master') this.effectiveSends[b] = this.appliedSends[b] = this.reverbSends[b];
    }
    this.createOffline = opts.createOffline;
    this.createContext =
      opts.createContext ??
      (() => {
        const Ctor =
          globalThis.AudioContext ??
          (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctor) throw new Error('WebAudio unavailable');
        return new Ctor({ latencyHint: 'interactive' });
      });
  }

  get state(): AudioState {
    return this._state;
  }
  /** The realtime context, once created (after the first gesture). */
  get context(): AudioContext | null {
    return this.ctx;
  }
  get settings(): Readonly<MixerSettings> {
    return this._settings;
  }
  /** Where spatial voices are heard from. A 3D game calls `audio.listener.fromCamera(camera)` each frame. */
  get listener(): SpatialListener {
    this._listener ??= new SpatialListener(this);
    return this._listener;
  }
  /**
   * Regions that drive ambient loops and reverb sends by listener position. Built on first use;
   * advanced by `update(dt)`.
   */
  get zones(): AudioZones {
    this._zones ??= new AudioZones(this);
    return this._zones;
  }
  /**
   * Per-frame bookkeeping: the zones (weights, ambient gains, reverb sends) and the followers
   * (`Voice.follow`). `createGame`'s loop calls it after input, before the scenes. Safe before
   * unlock and when audio is unavailable: the numbers still move, nothing plays.
   */
  update(dt: number): void {
    this._zones?.update(dt);
    for (const v of this.followers) v.syncFollow();
  }
  /** Internal: a voice starts or stops following a matrix. */
  trackFollower(v: VoiceImpl, on: boolean): void {
    if (on) this.followers.add(v);
    else this.followers.delete(v);
  }
  /** Idle panners waiting for the next spatial voice (tests, diagnostics). */
  get pooledPanners(): number {
    return this.pannerPool.length;
  }
  /** True after `halt()`: silent for good. */
  get halted(): boolean {
    return this._halted;
  }

  onStateChange(fn: (s: AudioState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  onSettingsChange(fn: (s: Readonly<MixerSettings>) => void): () => void {
    this.settingsListeners.add(fn);
    return () => this.settingsListeners.delete(fn);
  }

  private setState(s: AudioState) {
    if (s === this._state) return;
    this._state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Listen for the first user gesture to unlock audio, and pause while hidden. Returns detach.
   *
   * Phones take audio away again after unlock: iOS interrupts the context for a call, Siri or
   * an alarm (state `interrupted`) and may leave it suspended after an app switch; Android
   * suspends it in the background. Whenever the context is not running but should be, the
   * gesture listeners are re-armed so the next tap brings sound back, and `pageshow` / `focus`
   * try a resume without one.
   */
  attach(opts: AttachAudioOptions = {}): () => void {
    const target = opts.target ?? (typeof window !== 'undefined' ? window : undefined);
    if (target) {
      this.gestureTarget = target;
      this.armGestures();
      this.detachFns.push(() => {
        this.disarmGestures();
        this.gestureTarget = null;
      });
    }
    if (opts.pauseWhenHidden !== false && typeof document !== 'undefined') {
      const visible = () => document.visibilityState !== 'hidden';
      const onVis = () => {
        this.hidden = !visible();
        void this.syncSuspension();
      };
      // pagehide (iOS app switch, bfcache) and freeze can arrive while still "visible".
      const onAway = () => {
        this.hidden = true;
        void this.syncSuspension();
      };
      const onBack = () => {
        this.hidden = !visible();
        void this.syncSuspension();
      };
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('pagehide', onAway);
      window.addEventListener('pageshow', onBack);
      window.addEventListener('focus', onBack);
      document.addEventListener('freeze', onAway);
      document.addEventListener('resume', onBack);
      this.detachFns.push(() => {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('pagehide', onAway);
        window.removeEventListener('pageshow', onBack);
        window.removeEventListener('focus', onBack);
        document.removeEventListener('freeze', onAway);
        document.removeEventListener('resume', onBack);
      });
    }
    return () => this.detach();
  }

  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
  }

  private readonly onGesture = () => {
    void this.unlock().then((ok) => {
      if (ok) this.disarmGestures();
    });
  };

  private armGestures() {
    const target = this.gestureTarget;
    if (!target || this.gesturesArmed || this._halted) return;
    this.gesturesArmed = true;
    for (const g of GESTURES) target.addEventListener(g, this.onGesture, true);
  }

  private disarmGestures() {
    const target = this.gestureTarget;
    if (!target || !this.gesturesArmed) return;
    this.gesturesArmed = false;
    for (const g of GESTURES) target.removeEventListener(g, this.onGesture, true);
  }

  /**
   * Create/resume the context. Must run inside a user-gesture handler the first time
   * (`attach` does this for you). Resolves true once audio is running.
   */
  async unlock(): Promise<boolean> {
    if (this._state === 'unavailable' || this._halted) return false;
    if (!this.ctx) {
      try {
        this.ctx = this.createContext();
      } catch {
        this.setState('unavailable');
        return false;
      }
      this.buildBuses();
      this.ctx.onstatechange = () => this.onContextState();
    }
    // iOS Safari: a silent buffer started inside the gesture fully unlocks output.
    try {
      const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = silent;
      s.connect(this.ctx.destination);
      s.start();
    } catch {
      // ignore
    }
    if (this.ctx.state !== 'running' && !this.hidden && !this.userSuspended) {
      try {
        await this.ctx.resume();
      } catch {
        // Not allowed yet; a later gesture will retry.
      }
    }
    this.onContextState();
    return this.ctx.state === 'running' || (this._state === 'suspended' && this.isPaused());
  }

  private isPaused(): boolean {
    return this.hidden || this.userSuspended || this._halted;
  }

  private onContextState() {
    const ctx = this.ctx;
    if (!ctx) return;
    // `interrupted` (iOS: call, Siri, alarm, another app's audio) is a pause the browser chose;
    // only `closed` is final.
    const state = ctx.state as AudioContextState | 'interrupted';
    if (state === 'running') {
      this.setState('running');
      this.startDeferred();
    } else if (state === 'closed') {
      this.setState('unavailable');
    } else {
      // Suspended before ever running means the browser still wants a gesture.
      this.setState(this._state === 'locked' && !this.isPaused() ? 'locked' : 'suspended');
      // Should be playing but isn't: the next tap or key brings it back.
      if (!this.isPaused()) this.armGestures();
    }
  }

  /** Pause all audio (e.g. game paused). Pair with `resume()`. */
  async suspend(): Promise<void> {
    this.userSuspended = true;
    await this.syncSuspension();
  }

  async resume(): Promise<void> {
    this.userSuspended = false;
    await this.syncSuspension();
  }

  private async syncSuspension() {
    const ctx = this.ctx;
    if (!ctx || this._state === 'unavailable' || this._state === 'locked') return;
    try {
      if (this.isPaused() && ctx.state === 'running') {
        await ctx.suspend();
        this.setState('suspended');
      } else if (!this.isPaused() && ctx.state !== 'running') {
        await ctx.resume();
      }
    } catch {
      // ignore
    }
    this.onContextState();
  }

  /**
   * Fall silent for good, e.g. when the page can no longer run (GPU device lost) and only a
   * reload helps. Stops every voice, drops loops waiting for unlock, removes the gesture and
   * visibility listeners and suspends the context. After this, `unlock`, `resume`, `play`,
   * `loop` and `prepare` do nothing, so no timer or tab switch can bring sound back.
   */
  async halt(): Promise<void> {
    if (this._halted) return;
    this._halted = true;
    this.detach();
    this.stopAll();
    this.deferred.clear();
    await this.syncSuspension();
  }

  /** Close the context and drop everything. */
  async dispose(): Promise<void> {
    this.detach();
    this.stopAll();
    this.deferred.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.buses = {};
    this.limiterNode = null;
    this.reverbNodes = null;
    this.pannerPool.length = 0;
    this.registered.clear();
    this.frozenExternal.clear();
    this.pausedList.length = 0;
    this._paused = false;
    this._pausedRate = false;
    if (ctx) await ctx.close().catch(() => {});
    this.setState('locked');
  }

  // ------------------------------------------------------------ mixer

  private buildBuses() {
    const ctx = this.ctx!;
    const master = ctx.createGain();
    this.limiterNode = this.limiterOpts ? createLimiter(ctx, this.limiterOpts) : null;
    if (this.limiterNode) {
      master.connect(this.limiterNode);
      this.limiterNode.connect(ctx.destination);
    } else {
      master.connect(ctx.destination);
    }
    this.buses.master = master;
    for (const name of BUS_NAMES) {
      if (name === 'master') continue;
      const g = ctx.createGain();
      g.connect(master);
      this.buses[name] = g;
    }
    for (const name of BUS_NAMES) this.buses[name]!.gain.value = busGain(this._settings[name]);
    // Paused before the context existed: the paused buses are born silent.
    for (const name of this.pausedList) this.buses[name]!.gain.value = 0;
    this.buildReverb();
    this._listener?.apply();
  }

  /**
   * Internal: a `PannerNode` set up from `opts`, from the pool when one is idle. Null where the
   * context has no panner (the voice then plays unspatialised, straight into its bus).
   */
  acquirePanner(opts: SpatialOptions | undefined): PannerNode | null {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.createPanner !== 'function') return null;
    const p = this.pannerPool.pop() ?? ctx.createPanner();
    p.panningModel = opts?.panningModel ?? 'equalpower';
    p.distanceModel = opts?.rolloff ?? 'inverse';
    p.refDistance = opts?.refDistance ?? 1;
    p.maxDistance = opts?.maxDistance ?? 10000;
    p.rolloffFactor = opts?.rolloffFactor ?? 1;
    p.coneInnerAngle = opts?.cone?.inner ?? 360;
    p.coneOuterAngle = opts?.cone?.outer ?? 360;
    p.coneOuterGain = opts?.cone?.outerGain ?? 0;
    return p;
  }

  /** Internal: take back an ended voice's (disconnected) panner. Dropped if its context is gone. */
  releasePanner(p: PannerNode): void {
    if (this.ctx && p.context === this.ctx) this.pannerPool.push(p);
  }

  /** The master limiter node, once the context exists (null when disabled or unsupported). */
  get limiter(): DynamicsCompressorNode | null {
    return this.limiterNode;
  }

  /** Current reverb settings (`null` = off). */
  get reverb(): Readonly<ReverbOptions> | null {
    return this.reverbOpts;
  }

  /**
   * Turn the shared reverb on (or rebuild it with a new room), or off with `null`. Safe before
   * unlock: it is built with the buses. Rebuilding renders a new impulse, so do it rarely
   * (scene changes), not per frame. Sends given here replace the matching current sends.
   */
  setReverb(opts: ReverbOptions | null): void {
    this.reverbOpts = opts;
    if (opts?.sends) {
      this.reverbSends = { ...this.reverbSends, ...opts.sends };
      for (const b of BUS_NAMES) if (b !== 'master') this.applySend(b, false);
    }
    this.teardownReverb();
    this.buildReverb();
  }

  /**
   * Change one bus's base reverb send (linear, ramped). Remembered while reverb is off. The
   * zones (`audio.zones`) raise the effective send above it, never below.
   */
  setReverbSend(bus: OutputBus, level: number): void {
    const v = Math.max(0, Number.isFinite(level) ? level : 0);
    this.reverbSends = { ...this.reverbSends, [bus]: v };
    this.applySend(bus, true);
  }

  /** Internal: the zones' contribution to one bus's send; `max(base, zone)` reaches the graph. */
  setZoneReverbSend(bus: OutputBus, level: number): void {
    this.zoneSends[bus] = Math.max(0, Number.isFinite(level) ? level : 0);
    this.applySend(bus, false);
  }

  /** Write `max(base, zone)` to the send node when it moved by more than 1e-3 (or `force`). */
  private applySend(bus: OutputBus, force: boolean): void {
    const v = Math.max(this.reverbSends[bus], this.zoneSends[bus]);
    this.effectiveSends[bus] = v;
    if (!force && Math.abs(v - this.appliedSends[bus]) <= 1e-3) return;
    this.appliedSends[bus] = v;
    const node = this.reverbNodes?.sends[bus];
    if (node && this.ctx) node.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  /** Base send levels per bus (what `setReverbSend` and the reverb options set). */
  get reverbSendLevels(): Readonly<Record<OutputBus, number>> {
    return this.reverbSends;
  }

  /** What reaches the reverb per bus: `max(base, zones)`. The same object every call. */
  get effectiveReverbSendLevels(): Readonly<Record<OutputBus, number>> {
    return this.effectiveSends;
  }

  private buildReverb() {
    const ctx = this.ctx;
    const opts = this.reverbOpts;
    const master = this.buses.master;
    if (!ctx || !opts || !master || typeof ctx.createConvolver !== 'function') return;
    const ir = reverbImpulse(ctx.sampleRate, opts.seconds ?? 2, opts.decay ?? 3, opts.seed ?? 1);
    const buffer = ctx.createBuffer(ir.length, ir[0]!.length, ctx.sampleRate);
    ir.forEach((ch, i) => {
      buffer.copyToChannel(ch, i);
    });
    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = buffer;
    const wet = ctx.createGain();
    wet.gain.value = opts.wet ?? 1;
    convolver.connect(wet);
    wet.connect(master);
    const sends = {} as Record<OutputBus, GainNode>;
    for (const name of BUS_NAMES) {
      if (name === 'master') continue;
      const g = ctx.createGain();
      const level = Math.max(this.reverbSends[name], this.zoneSends[name]);
      this.effectiveSends[name] = level;
      this.appliedSends[name] = level;
      g.gain.value = level;
      this.buses[name]!.connect(g);
      g.connect(convolver);
      sends[name] = g;
    }
    this.reverbNodes = { convolver, wet, sends };
  }

  private teardownReverb() {
    const r = this.reverbNodes;
    if (!r) return;
    this.reverbNodes = null;
    for (const name of BUS_NAMES) {
      if (name === 'master') continue;
      const bus = this.buses[name];
      try {
        bus?.disconnect(r.sends[name]);
      } catch {
        // Not connected.
      }
      r.sends[name].disconnect();
    }
    r.convolver.disconnect();
    r.wet.disconnect();
  }

  /** Internal: the GainNode for a bus, once the context exists. */
  busNode(name: BusName): GainNode | null {
    return this.buses[name] ?? null;
  }

  private applyBus(name: BusName) {
    const node = this.buses[name];
    if (!node || !this.ctx) return;
    // A paused bus stays silent; the new setting is applied by `unpause`.
    if (this.isBusPaused(name)) return;
    // Short time-constant ramp avoids zipper clicks.
    node.gain.setTargetAtTime(busGain(this._settings[name]), this.ctx.currentTime, 0.015);
  }

  // ------------------------------------------------------------ pause

  /**
   * The pause-menu recipe: ramp every output bus except `keep` (default `['ui']`, so menu
   * clicks stay audible) to silence over 50 ms and hold the voices on those buses still by
   * setting their playback rate to 0, where the context's `playbackRate` allows it (every
   * current browser; elsewhere the voices keep running under the muted bus). `unpause` ramps
   * the bus gains back to the mixer settings and the rates back to what the game set. Music
   * stems pause the same way through their registered voices. The context keeps running
   * (`suspend()` is the other tool); `master` never ramps. Idempotent.
   */
  pause(opts: PauseOptions = {}): void {
    if (this._paused) return;
    this._paused = true;
    const keep = opts.keep ?? ['ui'];
    this.pausedList.length = 0;
    for (const b of BUS_NAMES) if (b !== 'master' && !keep.includes(b)) this.pausedList.push(b);
    const ctx = this.ctx;
    const t = ctx?.currentTime ?? 0;
    if (ctx) {
      for (const b of this.pausedList) {
        const node = this.buses[b];
        if (node) rampParamTo(node.gain, 0, t, PAUSE_RAMP);
      }
    }
    if (this.rateZeroOk === null) {
      for (const v of this.active) {
        const ok = v.rateZeroAllowed();
        if (ok !== null) {
          this.rateZeroOk = ok;
          break;
        }
      }
    }
    this._pausedRate = this.rateZeroOk !== false;
    if (!this._pausedRate) return;
    for (const v of this.active) if (this.isBusPaused(v.bus)) v.freezeRate(PAUSE_RAMP);
    for (const [v, b] of this.registered) {
      const rate = (v as Partial<RatedVoice>).rate;
      if (!this.isBusPaused(b) || typeof rate !== 'number') continue;
      this.frozenExternal.set(v, rate);
      v.setRate(0, PAUSE_RAMP);
    }
  }

  /** Undo `pause`: bus gains back to the settings, voice rates back to the game's. */
  unpause(): void {
    if (!this._paused) return;
    this._paused = false;
    const ctx = this.ctx;
    if (ctx) {
      for (const b of this.pausedList) {
        const node = this.buses[b];
        if (node) rampParamTo(node.gain, busGain(this._settings[b]), ctx.currentTime, PAUSE_RAMP);
      }
    }
    this.pausedList.length = 0;
    for (const v of this.active) v.thawRate(PAUSE_RAMP);
    for (const [v, rate] of this.frozenExternal) v.setRate(rate, PAUSE_RAMP);
    this.frozenExternal.clear();
    this._pausedRate = false;
  }

  /** True between `pause` and `unpause`. */
  get paused(): boolean {
    return this._paused;
  }

  /** The buses `pause` silenced (empty while not paused). The same array every call. */
  get pausedBuses(): readonly OutputBus[] {
    return this.pausedList;
  }

  /**
   * Which pause path ran: true when the paused voices' playback rates were set to 0 as well
   * (they resume where they stopped), false when the context refuses rate 0 and the buses were
   * only muted (the voices keep running). False while not paused.
   */
  get pausedRate(): boolean {
    return this._pausedRate;
  }

  /** Internal: whether `pause` silenced this bus. */
  isBusPaused(bus: BusName): boolean {
    return this._paused && this.pausedList.includes(bus as OutputBus);
  }

  private emitSettings() {
    for (const fn of this.settingsListeners) fn(this._settings);
  }

  setVolume(bus: BusName, volume: number): void {
    this._settings = {
      ...this._settings,
      [bus]: { ...this._settings[bus], volume: Math.min(1, Math.max(0, volume)) },
    };
    this.applyBus(bus);
    this.emitSettings();
  }

  setMuted(bus: BusName, muted: boolean): void {
    this._settings = { ...this._settings, [bus]: { ...this._settings[bus], muted } };
    this.applyBus(bus);
    this.emitSettings();
  }

  toggleMuted(bus: BusName): boolean {
    this.setMuted(bus, !this._settings[bus].muted);
    return this._settings[bus].muted;
  }

  /** Replace all settings (sanitized), e.g. after loading a save. */
  applySettings(settings: unknown): void {
    this._settings = sanitizeMixer(settings);
    for (const b of BUS_NAMES) this.applyBus(b);
    this.emitSettings();
  }

  // ------------------------------------------------------------ sounds

  /**
   * Register a named sound from a spec (rendered lazily or via `prepare`) or an async buffer
   * factory. `maxVoices` caps simultaneous plays of this sound (oldest is stolen). Default 8.
   */
  define(name: string, source: SoundSource, opts: { maxVoices?: number } = {}): void {
    const prev = this.sounds.get(name);
    for (const v of prev?.voices ?? []) v.stop();
    this.sounds.set(name, {
      source,
      buffer: null,
      pending: null,
      voices: [],
      maxVoices: opts.maxVoices ?? 8,
    });
  }

  has(name: string): boolean {
    return this.sounds.has(name);
  }

  /** Render (or fetch) the buffer for a sound. Needs no gesture. Cached. */
  load(name: string): Promise<AudioBuffer> {
    const e = this.sounds.get(name);
    if (!e) return Promise.reject(new Error(`unknown sound "${name}"`));
    if (e.buffer) return Promise.resolve(e.buffer);
    if (!e.pending) {
      const src = e.source;
      e.pending = (typeof src === 'function' ? src() : renderSound(src, this.createOffline)).then(
        (buf) => {
          e.buffer = buf;
          e.pending = null;
          return buf;
        },
        (err) => {
          e.pending = null;
          throw err;
        },
      );
    }
    return e.pending;
  }

  /** Render several (default: all) defined sounds up front. Call at boot or behind a loading screen. */
  async prepare(names: readonly string[] = [...this.sounds.keys()]): Promise<void> {
    if (this._halted) return;
    // Starting a spec render builds its graph (and fills any noise) synchronously, a few ms
    // each. Started all at once, a batch of them is one long main-thread task (50+ ms), so
    // yield to the event loop whenever the builds in this turn pass `PREPARE_SLICE_MS`.
    const pending: Promise<AudioBuffer>[] = [];
    let t0 = performance.now();
    for (const n of names) {
      if (this._halted) return;
      const p = this.load(n);
      // Awaited below; the no-op catch keeps a rejection during a yield from being "unhandled".
      p.catch(() => {});
      pending.push(p);
      if (performance.now() - t0 >= PREPARE_SLICE_MS) {
        await yieldToEventLoop();
        t0 = performance.now();
      }
    }
    await Promise.all(pending);
  }

  /** Rendered buffer if ready. */
  buffer(name: string): AudioBuffer | null {
    return this.sounds.get(name)?.buffer ?? null;
  }

  /**
   * Fire a one-shot. Dropped (returns an inert voice) while audio is locked, suspended or
   * unavailable: a click sound arriving seconds late after unlock would be wrong.
   */
  play(sound: string | AudioBuffer, opts: PlayOptions = {}): Voice {
    if (this._state !== 'running' || !this.ctx || this._halted) return NULL_VOICE;
    return this.startVoice(sound, false, opts, false);
  }

  /**
   * Start a loop (music, ambience). If audio is still locked, it starts as soon as it unlocks.
   * Stop it with `voice.stop(fade)`.
   */
  loop(sound: string | AudioBuffer, opts: PlayOptions = {}): Voice {
    if (this._state === 'unavailable' || this._halted) return NULL_VOICE;
    return this.startVoice(sound, true, opts, this._state !== 'running');
  }

  private startVoice(
    sound: string | AudioBuffer,
    loop: boolean,
    opts: PlayOptions,
    defer: boolean,
  ): Voice {
    const entry = typeof sound === 'string' ? this.sounds.get(sound) : undefined;
    if (typeof sound === 'string' && !entry) {
      console.warn(`[audio] unknown sound "${sound}"`);
      return NULL_VOICE;
    }
    const voice: VoiceImpl = new VoiceImpl(this, loop, opts, (v) => {
      this.active.delete(v);
      this.followers.delete(v);
      if (entry) {
        const i = entry.voices.indexOf(v);
        if (i >= 0) entry.voices.splice(i, 1);
      }
      for (const d of this.deferred) if (d.voice === v) this.deferred.delete(d);
    });
    this.active.add(voice);
    if (entry) {
      entry.voices.push(voice);
      while (entry.voices.length > entry.maxVoices) entry.voices.shift()!.stop(0.02);
    }
    if (defer) {
      this.deferred.add({ voice, sound });
      if (typeof sound === 'string') void this.load(sound).catch(() => {});
      return voice;
    }
    const buf = typeof sound === 'string' ? entry!.buffer : sound;
    if (buf) {
      voice.start(buf);
    } else {
      const requested = this.ctx!.currentTime;
      void this.load(sound as string).then(
        (b) => {
          const late = (this.ctx?.currentTime ?? Infinity) - requested;
          if (loop || late <= MAX_LATE_START) voice.start(b);
          else voice.stop();
        },
        (err) => {
          console.warn(`[audio] failed to render "${String(sound)}":`, err);
          voice.stop();
        },
      );
    }
    return voice;
  }

  private startDeferred() {
    for (const d of [...this.deferred]) {
      this.deferred.delete(d);
      if (!d.voice.playing) continue;
      if (typeof d.sound !== 'string') {
        d.voice.start(d.sound);
        continue;
      }
      void this.load(d.sound).then(
        (b) => {
          if (d.voice.playing && !d.voice.started) d.voice.start(b);
        },
        () => d.voice.stop(),
      );
    }
  }

  /**
   * Stop every voice the mixer knows (its own and the registered ones, so music stems too),
   * with an optional fade, or only those on `bus`. The options form adds `except`:
   * `stopAll({ except: ['music'] })` clears the effects and keeps the score.
   */
  stopAll(fade: number | StopAllOptions = 0, bus?: OutputBus): void {
    const o: StopAllOptions = typeof fade === 'object' ? fade : { fade, bus };
    const f = o.fade ?? 0;
    const hit = (b: BusName) => (!o.bus || b === o.bus) && !o.except?.includes(b);
    for (const v of [...this.active]) if (hit(v.bus)) v.stop(f);
    for (const [v, b] of [...this.registered]) if (hit(b)) v.stop(f);
  }

  /**
   * The live voices (playing or waiting to start, not yet stopped or ended) on `bus`, or on
   * every bus when `bus` is omitted or `master`. A voice leaves the list the moment `stop` is
   * called or its source ends. Allocates one array per call; `forEachVoice` allocates nothing.
   */
  voices(bus?: BusName): readonly Voice[] {
    const out: Voice[] = [];
    this.forEachVoice(bus, (v) => {
      out.push(v);
    });
    return out;
  }

  /** `voices(bus)` without the array: `fn(voice, bus)` for each live voice. */
  forEachVoice(bus: BusName | undefined, fn: (voice: Voice, bus: BusName) => void): void {
    const all = bus === undefined || bus === 'master';
    for (const v of this.active) if (all || v.bus === bus) fn(v, v.bus);
    for (const [v, b] of this.registered) if ((all || b === bus) && v.playing) fn(v, b);
  }

  /**
   * Put an externally owned voice (anything implementing `Voice`) on the mixer's books, so
   * `voices`, `voiceCount`, `stopAll` and `pause` see it; `createMusic` does this for each
   * playing stem. A registered voice with a numeric `rate` property has its rate frozen by
   * `pause` and restored by `unpause`. Returns the unregister; a voice whose `playing` is false
   * is skipped meanwhile.
   */
  register(voice: Voice, bus: BusName): () => void {
    this.registered.set(voice, bus);
    return () => {
      this.registered.delete(voice);
      this.frozenExternal.delete(voice);
    };
  }

  /** Number of live voices: `voices().length` without the array. */
  get voiceCount(): number {
    let n = this.active.size;
    for (const [v] of this.registered) if (v.playing) n++;
    return n;
  }
}

/** A registered voice that also exposes its rate, so `pause` can freeze and restore it. */
interface RatedVoice extends Voice {
  rate: number;
}

function createLimiter(
  ctx: AudioContext,
  o: Required<LimiterOptions>,
): DynamicsCompressorNode | null {
  if (typeof ctx.createDynamicsCompressor !== 'function') return null;
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = o.threshold;
  c.knee.value = o.knee;
  c.ratio.value = o.ratio;
  c.attack.value = o.attack;
  c.release.value = o.release;
  return c;
}
