/**
 * Runtime audio: an `AudioContext` created and resumed on the first user gesture, four buses
 * (master ← music, sfx, ui), named sounds rendered from specs, one-shots and loops.
 */
import { reverbImpulse, volumeToGain } from './dsp';
import {
  DEFAULT_OCCLUSION,
  type OccludableVoice,
  type OcclusionOptions,
  OcclusionScheduler,
} from './occlusion';
import type { Send } from './send';
import { parseSpriteRef, type SpriteSchedule, type SpriteSheet, spriteSchedule } from './sprites';
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

export interface AudioPlayOptions {
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
  /**
   * Insert one pooled `BiquadFilterNode` of `kind` between the voice's gain and its panner or
   * bus (ws/audio-4), ramping `cutoff` (Hz) and `q` over `ramp` seconds (default 0.05); calling
   * again retunes it, `null` removes it and returns the node to the pool. Independent of the
   * occlusion lowpass: an occluded voice with a filter has two biquads in series. No-op on an
   * inert voice; set before start, it is applied at start.
   */
  filter(kind: VoiceFilterKind | null, opts?: VoiceFilterOptions): void;
  /** World position of a spatial voice as last set or followed (zeros on a non-spatial voice). */
  readonly position: ArrayLike<number>;
  readonly playing: boolean;
  /** Live sends (`sendTo` inputs with a non-zero amount). */
  readonly sendCount: number;
  /** The last answer of `audio.occlusion.probe` for this voice, 0 clear .. 1 occluded (0 when unprobed). */
  readonly occlusion: number;
  /**
   * The Doppler multiplier on the playback rate as of the last `audio.update` (1 without
   * `spatial.doppler`, and on every voice the mixer did not start; diagnostics).
   */
  readonly doppler: number;
}

/** `Voice.filter` kinds (the `BiquadFilterNode` types a voice offers). */
export type VoiceFilterKind = 'lowpass' | 'highpass' | 'bandpass';

export interface VoiceFilterOptions {
  /** Hz. Default 1000. */
  cutoff?: number;
  /** Resonance. Default 1. */
  q?: number;
  /** Seconds the cutoff and Q ramp over. Default 0.05. */
  ramp?: number;
}

/** m/s, the Doppler reference (`SpatialOptions.doppler`). */
export const SPEED_OF_SOUND = 343;
/** m/s: a move faster than this between two `update`s is a teleport, not a velocity. */
export const DEFAULT_MAX_DOPPLER_SPEED = 100;

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

  /** The voice's output node changed (a filter went in or out): move the taps to `from`. */
  retarget(from: AudioNode): void {
    const old = this.from;
    if (old === from) return;
    this.from = from;
    for (const tap of this.taps) {
      if (!tap.gain) continue;
      try {
        old?.disconnect(tap.gain);
      } catch {
        // Not connected.
      }
      from.connect(tap.gain);
    }
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
export interface AudioFollowTarget {
  readonly world: ArrayLike<number>;
  /** A counter that moves whenever `world` may have (a `Transform.changed`); lets the follower skip the read. */
  readonly changed?: number;
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

/** Attenuation and panning of a voice played with `AudioPlayOptions.at`. */
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
  /**
   * Doppler factor (ws/audio-4): 0 (default) off; 1 the textbook shift
   * `(c - v_listener·n) / (c - v_emitter·n)` with `c = SPEED_OF_SOUND`, applied as a
   * `playbackRate` multiplier on top of `setRate`. Velocities come from successive
   * `setPosition` / `follow` and `listener.set` / `fromCamera` calls per `audio.update(dt)`.
   */
  doppler?: number;
  /**
   * m/s above which a move between two updates counts as a teleport and resets the velocity
   * instead of chirping. Default `DEFAULT_MAX_DOPPLER_SPEED` (100).
   */
  maxDopplerSpeed?: number;
  /** Probe this voice through `audio.occlusion` (ws/audio-4). Default true when a probe is set. */
  occlude?: boolean;
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
  /** Position at the previous `audio.update`, and the velocity derived from it (m/s). */
  private readonly prev = new Float64Array(3);
  private hasPrev = false;
  private readonly vel = new Float64Array(3);
  /** Velocity over the last `audio.update(dt)` (ws/audio-4), read-only; zeros after a teleport. */
  readonly velocity: ArrayLike<number> = this.vel;
  /** m/s above which a move between updates resets the velocity (a teleport). Default 100. */
  maxSpeed = DEFAULT_MAX_DOPPLER_SPEED;

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

  /** Internal (`audio.update`): derive the velocity from the move since the last call. */
  tick(dt: number): void {
    const p = this.pose;
    const q = this.prev;
    const v = this.vel;
    if (this.hasPrev && dt > 0) {
      const vx = (p[0]! - q[0]!) / dt;
      const vy = (p[1]! - q[1]!) / dt;
      const vz = (p[2]! - q[2]!) / dt;
      const teleport = vx * vx + vy * vy + vz * vz > this.maxSpeed * this.maxSpeed;
      v[0] = teleport ? 0 : vx;
      v[1] = teleport ? 0 : vy;
      v[2] = teleport ? 0 : vz;
    } else {
      v[0] = v[1] = v[2] = 0;
    }
    q[0] = p[0]!;
    q[1] = p[1]!;
    q[2] = p[2]!;
    this.hasPrev = true;
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
  filter() {},
  position: new Float64Array(3),
  playing: false,
  sendCount: 0,
  occlusion: 0,
  doppler: 1,
};

/** Internal: set a pooled biquad's type, cutoff and Q (a step, or a ramp from the current values). */
function tuneBiquad(
  f: BiquadFilterNode,
  type: BiquadFilterType,
  cutoff: number,
  q: number,
  t: number,
  ramp: number,
): void {
  f.type = type;
  rampParamTo(f.frequency, cutoff, t, ramp);
  rampParamTo(f.Q, q, t, ramp);
}

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

class VoiceImpl implements Voice, OccludableVoice {
  private src: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private stopped = false;
  private targetGain: number;
  private rate: number;
  private ended = false;
  private panner: PannerNode | null = null;
  /** The node after the filters (panner or stereo panner), or null when the chain ends at the bus. */
  private out: AudioNode | null = null;
  /** `out` is connected to the bus (done once; `relink` never breaks that link). */
  private outWired = false;
  private bus_: GainNode | null = null;
  /** The last node before the bus (gain, filter, panner or stereo panner): what the sends tap. */
  private tail: AudioNode | null = null;
  private sends: VoiceSends | null = null;
  /** `audio.pause` set the playback rate to 0; `rate` keeps the value to restore. */
  private frozen = false;
  /** Emitter position and cone direction (kept for a voice that has not started yet). */
  private readonly spatial: boolean;
  private readonly pos = new Float64Array(3);
  private target: AudioFollowTarget | null = null;
  /** `target.changed` at the last `syncFollow`; a target without one is read every update. */
  private followSeen = -1;
  private dx = 1;
  private dy = 0;
  private dz = 0;
  /** `Voice.filter`: the pooled biquad and what it was last asked for (applied at start). */
  private userFilter: BiquadFilterNode | null = null;
  private userKind: VoiceFilterKind | null = null;
  private userCutoff = 1000;
  private userQ = 1;
  /** Occlusion: the pooled lowpass and the last probe (ws/audio-4). */
  private occFilter: BiquadFilterNode | null = null;
  private occAmount = 0;
  private occGain = 1;
  private occApplied = false;
  occlusionProbedAt = Number.NEGATIVE_INFINITY;
  /** Doppler: the previous position per update, and the multiplier on `rate`. */
  private readonly prevPos = new Float64Array(3);
  private hasPrev = false;
  private dopplerRate = 1;

  constructor(
    private readonly engine: AudioEngine,
    readonly loop: boolean,
    private readonly opts: AudioPlayOptions,
    private readonly onEnd: (v: VoiceImpl) => void,
    /** A sprite clip's range, or null for the whole buffer. */
    private readonly schedule: SpriteSchedule | null = null,
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

  get occlusion(): number {
    return this.occAmount;
  }

  /** Internal: a spatial voice `audio.occlusion` may probe (`spatial.occlude` not false). */
  get occludable(): boolean {
    return this.spatial && this.panner !== null && this.opts.spatial?.occlude !== false;
  }

  /** The Doppler multiplier on `rate` as of the last `audio.update` (1 without `spatial.doppler`; diagnostics). */
  get doppler(): number {
    return this.dopplerRate;
  }

  /** Internal: `spatial.doppler` above 0. */
  get dopplerFactor(): number {
    return this.spatial ? Math.max(0, this.opts.spatial?.doppler ?? 0) : 0;
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
    src.playbackRate.value = this.frozen ? 0 : this.rate * this.dopplerRate;
    if (this.opts.detune) src.detune.value = this.opts.detune;
    const sched = this.schedule;
    if (sched && this.loop) {
      src.loopStart = sched.loopStart;
      src.loopEnd = sched.loopEnd;
    }
    const g = ctx.createGain();
    const t = ctx.currentTime + (this.opts.delay ?? 0);
    const fadeIn = this.opts.fadeIn ?? (this.loop ? 0.5 : 0);
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(this.targetGain, t + fadeIn);
    } else {
      g.gain.value = this.targetGain;
    }
    const panner = this.spatial ? this.engine.acquirePanner(this.opts.spatial) : null;
    if (panner) {
      writePannerPosition(panner, this.pos[0]!, this.pos[1]!, this.pos[2]!);
      writePannerDirection(panner, this.dx, this.dy, this.dz);
      this.out = panner;
      this.panner = panner;
    } else if (this.opts.pan && !this.spatial) {
      const p = ctx.createStereoPanner();
      p.pan.value = this.opts.pan;
      this.out = p;
    }
    src.connect(g);
    this.gainNode = g;
    this.bus_ = bus;
    // A filter asked for before start.
    if (this.userKind && !this.userFilter) {
      const f = this.engine.acquireBiquad();
      if (f) {
        tuneBiquad(f, this.userKind, this.userCutoff, this.userQ, t, 0);
        this.userFilter = f;
      }
    }
    this.relink();
    src.onended = () => {
      this.ended = true;
      this.sends?.dispose();
      this.sends = null;
      g.disconnect();
      this.out?.disconnect();
      this.out = null;
      this.outWired = false;
      this.tail = null;
      this.bus_ = null;
      if (this.userFilter) {
        this.userFilter.disconnect();
        this.engine.releaseBiquad(this.userFilter);
        this.userFilter = null;
      }
      if (this.occFilter) {
        this.occFilter.disconnect();
        this.engine.releaseBiquad(this.occFilter);
        this.occFilter = null;
      }
      if (this.panner) {
        this.engine.releasePanner(this.panner);
        this.panner = null;
      }
      this.onEnd(this);
    };
    if (sched) {
      if (this.loop) src.start(t, sched.offset);
      else src.start(t, sched.offset, sched.duration);
    } else {
      src.start(t);
    }
    this.src = src;
    this.engine.trackSpatial(this);
    return true;
  }

  /**
   * (Re)wire gain → [user filter] → [occlusion lowpass] → [panner | stereo panner] → bus and
   * point the sends at the new tail. Only the links that can change are touched.
   */
  private relink(): void {
    const g = this.gainNode;
    const bus = this.bus_;
    const ctx = this.engine.context;
    if (!g || !bus || !ctx) return;
    // The panner (or stereo panner) stays last, so its own links (bus, send taps) are kept;
    // only the nodes before it are rewired.
    g.disconnect();
    this.userFilter?.disconnect();
    this.occFilter?.disconnect();
    let node: AudioNode = g;
    if (this.userFilter) {
      node.connect(this.userFilter);
      node = this.userFilter;
    }
    if (this.occFilter) {
      node.connect(this.occFilter);
      node = this.occFilter;
    }
    if (this.out) {
      node.connect(this.out);
      node = this.out;
      if (!this.outWired) {
        this.out.connect(bus);
        this.outWired = true;
      }
    } else {
      node.connect(bus);
    }
    this.tail = node;
    if (this.sends) {
      if (this.sends.attached) this.sends.retarget(node);
      else this.sends.attach(ctx, node);
    }
  }

  filter(kind: VoiceFilterKind | null, o: VoiceFilterOptions = {}): void {
    if (this.ended || this.stopped) return;
    const ctx = this.engine.context;
    const ramp = o.ramp ?? 0.05;
    if (kind === null) {
      this.userKind = null;
      const f = this.userFilter;
      if (!f) return;
      this.userFilter = null;
      this.relink();
      this.engine.releaseBiquad(f);
      return;
    }
    this.userKind = kind;
    this.userCutoff = o.cutoff ?? this.userCutoff;
    this.userQ = o.q ?? this.userQ;
    if (!this.src || !ctx) return;
    if (this.userFilter) {
      tuneBiquad(this.userFilter, kind, this.userCutoff, this.userQ, ctx.currentTime, ramp);
      return;
    }
    const f = this.engine.acquireBiquad();
    if (!f) return;
    tuneBiquad(f, kind, this.userCutoff, this.userQ, ctx.currentTime, 0);
    this.userFilter = f;
    this.relink();
  }

  /** Internal (`OcclusionScheduler`): ramp the lowpass and the voice gain to the probe's answer. */
  applyOcclusion(amount: number, cutoff: number, gain: number, ramp: number): void {
    const ctx = this.engine.context;
    if (!ctx || !this.gainNode || this.ended) return;
    const t = ctx.currentTime;
    if (!this.occFilter) {
      const f = this.engine.acquireBiquad();
      if (!f) return;
      f.type = 'lowpass';
      f.frequency.value = this.engine.occlusion?.openCutoff ?? DEFAULT_OCCLUSION.openCutoff;
      f.Q.value = 0.7;
      this.occFilter = f;
      this.relink();
    }
    if (this.occApplied && Math.abs(amount - this.occAmount) <= 1e-3) return;
    this.occApplied = true;
    this.occAmount = amount;
    this.occGain = gain;
    rampParamTo(this.occFilter.frequency, cutoff, t, ramp);
    this.gainNode.gain.setTargetAtTime(this.targetGain * gain, t, Math.max(0.001, ramp / 3));
  }

  /**
   * Internal (`audio.update`): the emitter's velocity from its move since the last update, and
   * the Doppler ratio against the listener's, written to `playbackRate` when it changed.
   */
  syncDoppler(dt: number, listener: SpatialListener): void {
    const f = this.dopplerFactor;
    const p = this.pos;
    const q = this.prevPos;
    let ratio = 1;
    if (this.hasPrev && dt > 0 && f > 0) {
      const max = this.opts.spatial?.maxDopplerSpeed ?? DEFAULT_MAX_DOPPLER_SPEED;
      let vx = (p[0]! - q[0]!) / dt;
      let vy = (p[1]! - q[1]!) / dt;
      let vz = (p[2]! - q[2]!) / dt;
      if (vx * vx + vy * vy + vz * vz > max * max) vx = vy = vz = 0;
      const lp = listener.position;
      const lv = listener.velocity;
      // n: unit vector from the emitter to the listener.
      let nx = lp[0]! - p[0]!;
      let ny = lp[1]! - p[1]!;
      let nz = lp[2]! - p[2]!;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-6) {
        nx /= len;
        ny /= len;
        nz /= len;
        const c = SPEED_OF_SOUND;
        const vl = f * (lv[0]! * nx + lv[1]! * ny + lv[2]! * nz);
        const ve = f * (vx * nx + vy * ny + vz * nz);
        const lim = c * 0.9;
        ratio = (c - Math.min(lim, Math.max(-lim, vl))) / (c - Math.min(lim, Math.max(-lim, ve)));
      }
    }
    q[0] = p[0]!;
    q[1] = p[1]!;
    q[2] = p[2]!;
    this.hasPrev = true;
    if (Math.abs(ratio - this.dopplerRate) <= 1e-4) return;
    this.dopplerRate = ratio;
    const ctx = this.engine.context;
    if (!this.src || !ctx || this.frozen) return;
    this.src.playbackRate.setTargetAtTime(this.rate * ratio, ctx.currentTime, 0.01);
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
    if (this.src && ctx) {
      rampParamTo(this.src.playbackRate, this.rate * this.dopplerRate, ctx.currentTime, ramp);
    }
  }

  setGain(gain: number, ramp = 0.05): void {
    this.targetGain = gain;
    const ctx = this.engine.context;
    if (!this.gainNode || !ctx) return;
    this.gainNode.gain.setTargetAtTime(
      gain * this.occGain,
      ctx.currentTime,
      Math.max(0.001, ramp / 3),
    );
  }

  setRate(rate: number, ramp = 0.05): void {
    this.rate = rate;
    const ctx = this.engine.context;
    // While frozen by `pause` the new rate waits for `unpause`.
    if (!this.src || !ctx || this.frozen) return;
    this.src.playbackRate.setTargetAtTime(
      rate * this.dopplerRate,
      ctx.currentTime,
      Math.max(0.001, ramp / 3),
    );
  }

  setPosition(x: number, y: number, z: number): void {
    if (!this.spatial) return;
    this.pos[0] = x;
    this.pos[1] = y;
    this.pos[2] = z;
    if (this.panner) writePannerPosition(this.panner, x, y, z);
  }

  follow(target: AudioFollowTarget | null): void {
    if (!this.spatial) return;
    this.target = target;
    this.followSeen = -1;
    this.engine.trackFollower(this, target !== null && this.playing);
  }

  /**
   * Internal: copy the followed matrix's translation into the panner. A target with a
   * `changed` counter (a `Transform`) is read only when it moved since the last sync.
   */
  syncFollow(): void {
    const t = this.target;
    if (!t) return;
    const c = t.changed;
    if (c !== undefined) {
      if (c === this.followSeen) return;
      this.followSeen = c;
    }
    const m = t.world;
    this.setPosition(m[3]!, m[7]!, m[11]!);
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
  /** Biquads of ended voices' filters and occlusion lowpasses, reused the same way. */
  private readonly biquadPool: BiquadFilterNode[] = [];
  /**
   * The game's occlusion probe (ws/audio-4), or null for none. Set it once; every spatial voice
   * (unless `spatial.occlude` is false) is then probed round-robin from `update`.
   */
  occlusion: OcclusionOptions | null = null;
  private readonly occluder = new OcclusionScheduler();
  /** Started spatial voices the probe may ask about, in start order. */
  private readonly occludable: VoiceImpl[] = [];
  /** Started voices with a Doppler factor. */
  private readonly dopplers = new Set<VoiceImpl>();
  /** Sprite sheets by name (`defineSprites`); the buffer itself is a sound of the same name. */
  private readonly spriteSheets = new Map<string, SpriteSheet>();
  private readonly scratchSchedule: SpriteSchedule = {
    offset: 0,
    duration: 0,
    loopStart: 0,
    loopEnd: 0,
  };
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
  /**
   * Per-bus keyed multipliers on the settings gain (`setBusScale`: the duckers). Parallel
   * key/value arrays, searched linearly (a bus has a handful of keys), so a per-frame
   * `setBusScale` on an existing key allocates nothing. `scales` caches each bus's product.
   */
  private readonly scaleKeys: Record<BusName, string[]> = {
    master: [],
    music: [],
    sfx: [],
    ui: [],
  };
  private readonly scaleValues: Record<BusName, number[]> = {
    master: [],
    music: [],
    sfx: [],
    ui: [],
  };
  private readonly scales: Record<BusName, number> = { master: 1, music: 1, sfx: 1, ui: 1 };

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
    if (this.dopplers.size > 0) {
      const l = this.listener;
      l.tick(dt);
      for (const v of this.dopplers) v.syncDoppler(dt, l);
    }
    const occ = this.occlusion;
    if (occ && this.ctx && this.occludable.length > 0 && this._state === 'running') {
      this.occluder.run(occ, this.listener.position, this.occludable, this.ctx.currentTime);
    }
  }
  /** Internal: a voice starts or stops following a matrix. */
  trackFollower(v: VoiceImpl, on: boolean): void {
    if (on) this.followers.add(v);
    else this.followers.delete(v);
  }
  /** Internal: a spatial voice started; it joins the occlusion and Doppler rounds it asks for. */
  trackSpatial(v: VoiceImpl): void {
    if (v.occludable) this.occludable.push(v);
    if (v.dopplerFactor > 0) this.dopplers.add(v);
  }
  private untrackSpatial(v: VoiceImpl): void {
    this.dopplers.delete(v);
    const i = this.occludable.indexOf(v);
    if (i >= 0) this.occludable.splice(i, 1);
  }
  /** Idle panners waiting for the next spatial voice (tests, diagnostics). */
  get pooledPanners(): number {
    return this.pannerPool.length;
  }
  /** Idle biquads waiting for the next `Voice.filter` or occluded voice (tests, diagnostics). */
  get pooledFilters(): number {
    return this.biquadPool.length;
  }
  /** Voices `occlusion.probe` may be asked about (tests, diagnostics). */
  get occludedVoiceCount(): number {
    return this.occludable.length;
  }
  /**
   * The page lifecycle's flag (ws/audio-4): `true` suspends the context while the app is hidden
   * or backgrounded, `false` brings back whatever the user state is (`suspend()` still holds it
   * suspended; otherwise it resumes). `attach({ pauseWhenHidden })` and `createGame`'s host
   * lifecycle call this; a game with its own lifecycle source can too. Independent of `pause()`.
   */
  background(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    // Bus writes held while hidden (`applyBus`) land now, before the context resumes.
    if (!hidden) for (const b of BUS_NAMES) this.applyBus(b);
    void this.syncSuspension();
  }
  /** True while `background(true)` holds (the document hidden or the app in the background). */
  get inBackground(): boolean {
    return this.hidden;
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
      const onVis = () => this.background(!visible());
      // pagehide (iOS app switch, bfcache) and freeze can arrive while still "visible".
      const onAway = () => this.background(true);
      const onBack = () => this.background(!visible());
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
    this.biquadPool.length = 0;
    this.occludable.length = 0;
    this.dopplers.clear();
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
    for (const name of BUS_NAMES) this.buses[name]!.gain.value = this.busTarget(name);
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

  /** Internal: a `BiquadFilterNode` from the pool, or a new one. Null where the context has none. */
  acquireBiquad(): BiquadFilterNode | null {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.createBiquadFilter !== 'function') return null;
    return this.biquadPool.pop() ?? ctx.createBiquadFilter();
  }

  /** Internal: take back a (disconnected) biquad. Dropped if its context is gone. */
  releaseBiquad(f: BiquadFilterNode): void {
    if (this.ctx && f.context === this.ctx) this.biquadPool.push(f);
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

  /** What a bus gain should be when nothing holds it: the settings gain times its scale. */
  private busTarget(name: BusName): number {
    return busGain(this._settings[name]) * this.scales[name];
  }

  private applyBus(name: BusName, timeConstant = 0.015) {
    const node = this.buses[name];
    if (!node || !this.ctx) return;
    // A paused bus stays silent; the new value is applied by `unpause`. In the background the
    // write waits for `background(false)`, so nothing is queued on a suspended clock.
    if (this.isBusPaused(name) || this.hidden) return;
    // Short time-constant ramp avoids zipper clicks.
    node.gain.setTargetAtTime(this.busTarget(name), this.ctx.currentTime, timeConstant);
  }

  /**
   * Multiply a bus's settings gain by `scale` (0..1) under `key` (default `'default'`),
   * approached with time constant `timeConstant` seconds (default 0.015). A bus keeps one scale
   * per key and its effective scale is the product of them all, so two duckers on one bus
   * combine instead of fighting. The bus gain is always `busGain(settings[bus]) × product`, so
   * `setVolume` and `setMuted` keep composing with it. The engine owns the write: while `pause`
   * holds the bus or `inBackground` is true the scale is only stored, and `unpause` /
   * `background(false)` ramp to the scaled gain; set before the context exists, the bus is
   * built at it. `createDucker` drives this with a key of its own.
   */
  setBusScale(bus: BusName, scale: number, timeConstant?: number, key = 'default'): void {
    const s = Number.isFinite(scale) ? Math.min(1, Math.max(0, scale)) : 1;
    const keys = this.scaleKeys[bus];
    const values = this.scaleValues[bus];
    const i = keys.indexOf(key);
    if (i >= 0) {
      if (values[i] === s) return;
      values[i] = s;
    } else {
      keys.push(key);
      values.push(s);
    }
    this.updateBusScale(bus, timeConstant);
  }

  /**
   * Remove `key`'s scale from `bus` (a no-op for a key never set), ramping to the product of
   * the keys left with time constant `timeConstant` (default 0.015). `Ducker.dispose` calls it.
   */
  clearBusScale(bus: BusName, key: string, timeConstant?: number): void {
    const keys = this.scaleKeys[bus];
    const values = this.scaleValues[bus];
    const i = keys.indexOf(key);
    if (i < 0) return;
    keys.splice(i, 1);
    values.splice(i, 1);
    this.updateBusScale(bus, timeConstant);
  }

  /**
   * `key`'s `setBusScale` multiplier on `bus` (1 for a key never set or cleared), or, with
   * `key` omitted, the bus's effective scale: the product of all its keys (1 by default).
   */
  busScale(bus: BusName, key?: string): number {
    if (key === undefined) return this.scales[bus];
    const i = this.scaleKeys[bus].indexOf(key);
    return i < 0 ? 1 : this.scaleValues[bus][i]!;
  }

  /** Recompute a bus's product of keyed scales and write the bus if it changed. */
  private updateBusScale(bus: BusName, timeConstant?: number): void {
    const values = this.scaleValues[bus];
    let p = 1;
    for (let j = 0; j < values.length; j++) p *= values[j]!;
    if (p === this.scales[bus]) return;
    this.scales[bus] = p;
    this.applyBus(bus, timeConstant);
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

  /** Undo `pause`: bus gains back to the settings (times any `setBusScale`), voice rates back to the game's. */
  unpause(): void {
    if (!this._paused) return;
    this._paused = false;
    const ctx = this.ctx;
    if (ctx) {
      for (const b of this.pausedList) {
        const node = this.buses[b];
        // Back to the scaled gain (a duck in progress), not the raw setting. Held in the
        // background, `background(false)` writes it.
        if (node && !this.hidden)
          rampParamTo(node.gain, this.busTarget(b), ctx.currentTime, PAUSE_RAMP);
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
    this.spriteSheets.delete(name);
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

  /**
   * Register a sprite sheet (ws/audio-4): one buffer (or a factory for it) and named
   * `[startMs, lengthMs]` ranges. `play('name#clip')` and `loop('name#clip')` then play one range
   * (a loop repeats between the clip's `loopPoints`, or its whole range); `play('name')` still
   * plays the whole buffer. `maxVoices` caps the sheet's simultaneous plays, every clip counted.
   */
  defineSprites(name: string, sheet: SpriteSheet, opts: { maxVoices?: number } = {}): void {
    const source: SoundSource = sheet.buffer
      ? ((() => Promise.resolve(sheet.buffer!)) as () => Promise<AudioBuffer>)
      : (sheet.source ?? (() => Promise.reject(new Error(`sprite sheet "${name}" has no buffer`))));
    this.define(name, source, opts);
    const e = this.sounds.get(name)!;
    if (sheet.buffer) e.buffer = sheet.buffer;
    this.spriteSheets.set(name, sheet);
  }

  /** The sprite sheet registered under `name`, if any. */
  spriteSheet(name: string): SpriteSheet | null {
    return this.spriteSheets.get(name) ?? null;
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
  play(sound: string | AudioBuffer, opts: AudioPlayOptions = {}): Voice {
    if (this._state !== 'running' || !this.ctx || this._halted) return NULL_VOICE;
    return this.startVoice(sound, false, opts, false);
  }

  /**
   * Start a loop (music, ambience). If audio is still locked, it starts as soon as it unlocks.
   * Stop it with `voice.stop(fade)`.
   */
  loop(sound: string | AudioBuffer, opts: AudioPlayOptions = {}): Voice {
    if (this._state === 'unavailable' || this._halted) return NULL_VOICE;
    return this.startVoice(sound, true, opts, this._state !== 'running');
  }

  private startVoice(
    sound: string | AudioBuffer,
    loop: boolean,
    opts: AudioPlayOptions,
    defer: boolean,
  ): Voice {
    let schedule: SpriteSchedule | null = null;
    if (typeof sound === 'string') {
      const ref = parseSpriteRef(sound);
      if (ref) {
        const sheet = this.spriteSheets.get(ref.sheet);
        if (!sheet) throw new Error(`[audio] unknown sprite sheet "${ref.sheet}"`);
        schedule = { ...spriteSchedule(sheet, ref.sheet, ref.clip, this.scratchSchedule) };
        sound = ref.sheet;
      }
    }
    const entry = typeof sound === 'string' ? this.sounds.get(sound) : undefined;
    if (typeof sound === 'string' && !entry) {
      console.warn(`[audio] unknown sound "${sound}"`);
      return NULL_VOICE;
    }
    const voice: VoiceImpl = new VoiceImpl(
      this,
      loop,
      opts,
      (v) => {
        this.active.delete(v);
        this.followers.delete(v);
        this.untrackSpatial(v);
        if (entry) {
          const i = entry.voices.indexOf(v);
          if (i >= 0) entry.voices.splice(i, 1);
        }
        for (const d of this.deferred) if (d.voice === v) this.deferred.delete(d);
      },
      schedule,
    );
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

/** `createVoiceAdapter` options. */
export interface VoiceAdapterOptions {
  /** The raw source: a buffer or oscillator source, a media element source, a worklet. */
  source: AudioNode;
  /** Bus the adapter's gain feeds. Default `sfx`. */
  bus?: OutputBus;
  /** Linear gain to start at. Default 1. */
  gain?: number;
  /** Called once the voice is stopped (after its fade) or `end()` ran. */
  onEnd?: () => void;
  /** Put the voice on the mixer's books (`audio.register`). Default true. */
  register?: boolean;
}

/** The `Voice` `createVoiceAdapter` returns; `rate` lets `audio.pause` freeze and restore it. */
export interface VoiceAdapter extends Voice {
  rate: number;
  /** The gain node between the source and the bus. */
  readonly gainNode: GainNode | null;
  /** Internal to the owner: the source ended on its own; tear down without a fade. */
  end(): void;
}

/**
 * A `Voice` over a raw `AudioNode` another owner runs (ws/audio-4): source → gain → bus, with
 * `setGain`, `stop(fade)` (ramps the gain, stops a scheduled source at the fade's end, else
 * disconnects it then), `setRate` (writes the source's `playbackRate` when it has one, so
 * `audio.pause` freezes it), `sendTo` and `filter` on the same pool as the mixer's voices. Not
 * spatial: `setPosition`, `follow` and `occlusion` are inert. Registered with the mixer unless
 * `register` is false, so `voices`, `stopAll` and `pause` see it. Null context: an inert voice.
 */
export function createVoiceAdapter(audio: AudioEngine, opts: VoiceAdapterOptions): VoiceAdapter {
  const ctx = audio.context;
  const bus = opts.bus ?? 'sfx';
  const busNode = audio.busNode(bus);
  const inert: VoiceAdapter = {
    ...NULL_VOICE,
    rate: 1,
    gainNode: null,
    end() {},
  };
  if (!ctx || !busNode) return inert;
  const g = ctx.createGain();
  g.gain.value = opts.gain ?? 1;
  const source = opts.source;
  let filterNode: BiquadFilterNode | null = null;
  let sends: VoiceSends | null = null;
  let playing = true;
  let unregister: (() => void) | null = null;
  const rateParam = (source as Partial<AudioBufferSourceNode>).playbackRate;
  const relink = () => {
    g.disconnect();
    filterNode?.disconnect();
    const tail: AudioNode = filterNode ? g.connect(filterNode) : g;
    tail.connect(busNode);
    if (sends) {
      if (sends.attached) sends.retarget(tail);
      else sends.attach(ctx, tail);
    }
  };
  const teardown = () => {
    if (!playing) return;
    playing = false;
    unregister?.();
    unregister = null;
    sends?.dispose();
    sends = null;
    try {
      source.disconnect(g);
    } catch {
      // Not connected.
    }
    g.disconnect();
    if (filterNode) {
      filterNode.disconnect();
      audio.releaseBiquad(filterNode);
      filterNode = null;
    }
    opts.onEnd?.();
  };
  const voice: VoiceAdapter = {
    rate: 1,
    get gainNode() {
      return playing ? g : null;
    },
    stop(fade = 0) {
      if (!playing) return;
      const t = ctx.currentTime;
      rampParamTo(g.gain, 0, t, fade);
      const scheduled = source as Partial<AudioScheduledSourceNode>;
      if (typeof scheduled.stop === 'function') {
        const prev = scheduled.onended;
        scheduled.onended = (ev) => {
          if (typeof prev === 'function') prev.call(source as AudioScheduledSourceNode, ev);
          teardown();
        };
        try {
          scheduled.stop(t + fade);
        } catch {
          teardown();
        }
      } else if (fade > 0) {
        setTimeout(teardown, fade * 1000);
      } else {
        teardown();
      }
      unregister?.();
      unregister = null;
    },
    end: teardown,
    setGain(gain, ramp = 0.05) {
      if (!playing) return;
      g.gain.setTargetAtTime(gain, ctx.currentTime, Math.max(0.001, ramp / 3));
    },
    setRate(rate, ramp = 0.05) {
      voice.rate = rate;
      if (rateParam && playing) rampParamTo(rateParam, rate, ctx.currentTime, ramp);
    },
    setPosition() {},
    setDirection() {},
    follow() {},
    sendTo(input, amount, ramp = 0.05) {
      if (!playing) return;
      sends ??= new VoiceSends();
      if (!sends.attached) sends.attach(ctx, filterNode ?? g);
      sends.set(input, amount, ramp);
    },
    filter(kind, o = {}) {
      if (!playing) return;
      if (kind === null) {
        if (!filterNode) return;
        const f = filterNode;
        filterNode = null;
        relink();
        audio.releaseBiquad(f);
        return;
      }
      const ramp = o.ramp ?? 0.05;
      if (filterNode) {
        tuneBiquad(filterNode, kind, o.cutoff ?? 1000, o.q ?? 1, ctx.currentTime, ramp);
        return;
      }
      const f = audio.acquireBiquad();
      if (!f) return;
      tuneBiquad(f, kind, o.cutoff ?? 1000, o.q ?? 1, ctx.currentTime, 0);
      filterNode = f;
      relink();
    },
    position: new Float64Array(3),
    get playing() {
      return playing;
    },
    get sendCount() {
      return sends?.count ?? 0;
    },
    occlusion: 0,
    doppler: 1,
  };
  source.connect(g);
  g.connect(busNode);
  if (opts.register !== false) unregister = audio.register(voice, bus);
  return voice;
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
