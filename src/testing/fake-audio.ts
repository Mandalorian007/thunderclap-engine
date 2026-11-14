/**
 * A recording WebAudio fake for unit tests, in Node with no browser: an `AudioContext` whose
 * params record their automation, whose sources record start and stop, and whose clock moves only
 * when a test calls `advance`. Hand it to `new AudioEngine({ createContext: () => fake.asAudioContext() })`.
 * Used by the engine's own audio tests and exported from `@thunderclap-engine/engine/testing`.
 */

/** What `createFakeAudioContext` builds. */
export interface FakeAudioContextOptions {
  /** Add an `AudioListener` and `createPanner`, for spatial voices. Default false. */
  spatial?: boolean;
  /** Keep `createStereoPanner`. False removes it, as on old WebKit. Default true. */
  stereoPanner?: boolean;
  /** Default 48000. */
  sampleRate?: number;
}

export interface FakeAudioParamEvent {
  type: 'set' | 'linear' | 'exp' | 'target' | 'cancel';
  value: number;
  time: number;
}

export class FakeAudioParam {
  value: number;
  events: FakeAudioParamEvent[] = [];
  /** Lower bound, like `AudioParam.minValue`; unset means any value (a test may raise it). */
  minValue?: number;
  constructor(v = 1) {
    this.value = v;
  }
  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.events.push({ type: 'set', value: v, time: t });
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.events.push({ type: 'linear', value: v, time: t });
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.events.push({ type: 'exp', value: v, time: t });
  }
  setTargetAtTime(v: number, t: number) {
    this.value = v;
    this.events.push({ type: 'target', value: v, time: t });
  }
  cancelScheduledValues(t: number) {
    this.events.push({ type: 'cancel', value: 0, time: t });
  }
  /** The last ramp or set (ignoring cancels). */
  get last(): FakeAudioParamEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.type !== 'cancel') return this.events[i];
    }
    return undefined;
  }
}

export class FakeAudioNode {
  outputs: FakeAudioNode[] = [];
  connect<T extends FakeAudioNode>(n: T): T {
    this.outputs.push(n);
    return n;
  }
  disconnect(target?: FakeAudioNode) {
    this.outputs = target ? this.outputs.filter((o) => o !== target) : [];
  }
}

export class FakeAudioGain extends FakeAudioNode {
  gain = new FakeAudioParam(1);
}

export class FakeAudioSource extends FakeAudioNode {
  buffer: unknown = null;
  loop = false;
  playbackRate = new FakeAudioParam(1);
  detune = new FakeAudioParam(0);
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  offset: number | null = null;
  /** The `duration` argument of `start`, null when not given (a sprite one-shot passes it). */
  duration: number | null = null;
  stoppedAt: number | null = null;
  constructor(private readonly ctx: FakeAudioContext) {
    super();
    ctx.sources.push(this);
  }
  start(t = 0, offset?: number, duration?: number) {
    this.startedAt = t;
    this.offset = offset ?? null;
    this.duration = duration ?? null;
  }
  stop(t = 0) {
    this.stoppedAt = t;
    queueMicrotask(() => this.onended?.());
  }
  /** The gain node this source feeds (the voice gain). */
  get gainNode(): FakeAudioGain {
    return this.outputs[0] as FakeAudioGain;
  }
  get isSilentUnlock() {
    return (
      (this.buffer as { length: number } | null)?.length === 1 &&
      this.outputs[0] === this.ctx.destination
    );
  }
}

export class FakeAudioConvolver extends FakeAudioNode {
  buffer: unknown = null;
  normalize = false;
}

export class FakeAudioBiquad extends FakeAudioNode {
  type = 'lowpass';
  frequency = new FakeAudioParam(350);
  Q = new FakeAudioParam(1);
  constructor(readonly context?: FakeAudioContext) {
    super();
  }
}

/** A `PannerNode` in the modern AudioParam shape. */
export class FakeAudioPanner extends FakeAudioNode {
  panningModel = 'HRTF';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  coneInnerAngle = 360;
  coneOuterAngle = 360;
  coneOuterGain = 0;
  positionX = new FakeAudioParam(0);
  positionY = new FakeAudioParam(0);
  positionZ = new FakeAudioParam(0);
  orientationX = new FakeAudioParam(1);
  orientationY = new FakeAudioParam(0);
  orientationZ = new FakeAudioParam(0);
  constructor(readonly context: FakeAudioContext) {
    super();
  }
  get position(): number[] {
    return [this.positionX.value, this.positionY.value, this.positionZ.value];
  }
}

/** What a streamed stem plays through (`StreamElement`): a clock a test moves by hand. */
export class FakeAudioMediaElement {
  src = '';
  loop = false;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  playbackRate = 1;
  plays = 0;
  constructor(duration = Number.NaN) {
    this.duration = duration;
  }
  async play() {
    this.paused = false;
    this.plays++;
  }
  pause() {
    this.paused = true;
  }
}

export class FakeAudioMediaSource extends FakeAudioNode {
  constructor(readonly mediaElement: FakeAudioMediaElement) {
    super();
  }
}

export class FakeAudioAnalyser extends FakeAudioNode {
  fftSize = 2048;
  /** What `getFloatTimeDomainData` fills: a constant level a test sets. */
  level = 0;
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(this.level);
  }
}

export class FakeAudioContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeAudioNode();
  sources: FakeAudioSource[] = [];
  convolvers: FakeAudioConvolver[] = [];
  biquads: FakeAudioBiquad[] = [];
  analysers: FakeAudioAnalyser[] = [];
  mediaSources: FakeAudioMediaSource[] = [];
  onstatechange: (() => void) | null = null;
  /** Calls to `suspend()` and `resume()`, in order (what a watchdog restart looks like). */
  stateCalls: ('suspend' | 'resume')[] = [];
  constructor(opts: FakeAudioContextOptions = {}) {
    if (opts.sampleRate !== undefined) this.sampleRate = opts.sampleRate;
    if (opts.stereoPanner === false) {
      (this as { createStereoPanner?: unknown }).createStereoPanner = undefined;
    }
  }
  /** Move `currentTime` on by `seconds`, as the audio thread does while it renders. */
  advance(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.currentTime += seconds;
  }
  /** This fake typed as the `AudioContext` an `AudioEngine`'s `createContext` returns. */
  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
  createGain() {
    return new FakeAudioGain();
  }
  createBufferSource() {
    return new FakeAudioSource(this);
  }
  createStereoPanner() {
    return Object.assign(new FakeAudioNode(), { pan: new FakeAudioParam(0) });
  }
  createConvolver() {
    const c = new FakeAudioConvolver();
    this.convolvers.push(c);
    return c;
  }
  createBiquadFilter() {
    const f = new FakeAudioBiquad(this);
    this.biquads.push(f);
    return f;
  }
  createMediaElementSource(el: FakeAudioMediaElement) {
    const n = new FakeAudioMediaSource(el);
    this.mediaSources.push(n);
    return n;
  }
  createAnalyser() {
    const a = new FakeAudioAnalyser();
    this.analysers.push(a);
    return a;
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeAudioNode(), {
      threshold: new FakeAudioParam(-24),
      knee: new FakeAudioParam(30),
      ratio: new FakeAudioParam(12),
      attack: new FakeAudioParam(0.003),
      release: new FakeAudioParam(0.25),
    });
  }
  createBuffer(channels: number, length: number, sampleRate = this.sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      length,
      numberOfChannels: channels,
      sampleRate,
      duration: length / sampleRate,
      data,
      copyToChannel(src: Float32Array, ch: number) {
        data[ch]!.set(src);
      },
    };
  }
  async resume() {
    this.stateCalls.push('resume');
    this.state = 'running';
  }
  async suspend() {
    this.stateCalls.push('suspend');
    this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }
  /** Sources other than the iOS silent unlock buffer. */
  get played() {
    return this.sources.filter((s) => !s.isSilentUnlock);
  }
}

/** `FakeAudioContext` plus a listener and `createPanner`, for spatial voices. */
export class FakeAudioSpatialContext extends FakeAudioContext {
  panners: FakeAudioPanner[] = [];
  listener = {
    positionX: new FakeAudioParam(0),
    positionY: new FakeAudioParam(0),
    positionZ: new FakeAudioParam(0),
    forwardX: new FakeAudioParam(0),
    forwardY: new FakeAudioParam(0),
    forwardZ: new FakeAudioParam(-1),
    upX: new FakeAudioParam(0),
    upY: new FakeAudioParam(1),
    upZ: new FakeAudioParam(0),
  };
  createPanner() {
    const p = new FakeAudioPanner(this);
    this.panners.push(p);
    return p;
  }
}

/** A fake context: `FakeAudioSpatialContext` when `spatial`, else `FakeAudioContext`. */
export function createFakeAudioContext(
  opts: FakeAudioContextOptions & { spatial: true },
): FakeAudioSpatialContext;
export function createFakeAudioContext(opts?: FakeAudioContextOptions): FakeAudioContext;
export function createFakeAudioContext(opts: FakeAudioContextOptions = {}): FakeAudioContext {
  return opts.spatial ? new FakeAudioSpatialContext(opts) : new FakeAudioContext(opts);
}
