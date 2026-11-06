/**
 * A minimal WebAudio fake for the music, variations, send and ducker tests, in the style of
 * audio.test.ts. Params record their automation so a test can assert on schedule times.
 * Not a test file (Vitest only picks `*.test.ts`), not exported from the module.
 */
import { AudioEngine } from './audio';

export interface ParamEvent {
  type: 'set' | 'linear' | 'exp' | 'target' | 'cancel';
  value: number;
  time: number;
}

export class FakeParam {
  value: number;
  events: ParamEvent[] = [];
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
  get last(): ParamEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.type !== 'cancel') return this.events[i];
    }
    return undefined;
  }
}

export class FakeNode {
  outputs: FakeNode[] = [];
  connect<T extends FakeNode>(n: T): T {
    this.outputs.push(n);
    return n;
  }
  disconnect(target?: FakeNode) {
    this.outputs = target ? this.outputs.filter((o) => o !== target) : [];
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

export class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  playbackRate = new FakeParam(1);
  detune = new FakeParam(0);
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  offset: number | null = null;
  /** The `duration` argument of `start`, null when not given (a sprite one-shot passes it). */
  duration: number | null = null;
  stoppedAt: number | null = null;
  constructor(private readonly ctx: FakeContext) {
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
  get gainNode(): FakeGain {
    return this.outputs[0] as FakeGain;
  }
  get isSilentUnlock() {
    return (
      (this.buffer as { length: number } | null)?.length === 1 &&
      this.outputs[0] === this.ctx.destination
    );
  }
}

export class FakeConvolver extends FakeNode {
  buffer: unknown = null;
  normalize = false;
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  constructor(readonly context?: FakeContext) {
    super();
  }
}

/** A `PannerNode` in the modern AudioParam shape. */
export class FakePanner extends FakeNode {
  panningModel = 'HRTF';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  coneInnerAngle = 360;
  coneOuterAngle = 360;
  coneOuterGain = 0;
  positionX = new FakeParam(0);
  positionY = new FakeParam(0);
  positionZ = new FakeParam(0);
  orientationX = new FakeParam(1);
  orientationY = new FakeParam(0);
  orientationZ = new FakeParam(0);
  constructor(readonly context: FakeContext) {
    super();
  }
  get position(): number[] {
    return [this.positionX.value, this.positionY.value, this.positionZ.value];
  }
}

/** What a streamed stem plays through (`StreamElement`): a clock a test moves by hand. */
export class FakeMediaElement {
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

export class FakeMediaSource extends FakeNode {
  constructor(readonly mediaElement: FakeMediaElement) {
    super();
  }
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  /** What `getFloatTimeDomainData` fills: a constant level a test sets. */
  level = 0;
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(this.level);
  }
}

export class FakeContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  convolvers: FakeConvolver[] = [];
  biquads: FakeBiquad[] = [];
  analysers: FakeAnalyser[] = [];
  mediaSources: FakeMediaSource[] = [];
  onstatechange: (() => void) | null = null;
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(), { pan: new FakeParam(0) });
  }
  createConvolver() {
    const c = new FakeConvolver();
    this.convolvers.push(c);
    return c;
  }
  createBiquadFilter() {
    const f = new FakeBiquad(this);
    this.biquads.push(f);
    return f;
  }
  createMediaElementSource(el: FakeMediaElement) {
    const n = new FakeMediaSource(el);
    this.mediaSources.push(n);
    return n;
  }
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a;
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(), {
      threshold: new FakeParam(-24),
      knee: new FakeParam(30),
      ratio: new FakeParam(12),
      attack: new FakeParam(0.003),
      release: new FakeParam(0.25),
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
    this.state = 'running';
  }
  async suspend() {
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

/** `FakeContext` plus a listener and `createPanner`, for spatial voices. */
export class FakeSpatialContext extends FakeContext {
  panners: FakePanner[] = [];
  listener = {
    positionX: new FakeParam(0),
    positionY: new FakeParam(0),
    positionZ: new FakeParam(0),
    forwardX: new FakeParam(0),
    forwardY: new FakeParam(0),
    forwardZ: new FakeParam(-1),
    upX: new FakeParam(0),
    upY: new FakeParam(1),
    upZ: new FakeParam(0),
  };
  createPanner() {
    const p = new FakePanner(this);
    this.panners.push(p);
    return p;
  }
}

/** A buffer of `seconds` at the fake's rate (duration is what music scheduling reads). */
export function fakeBuffer(seconds: number): AudioBuffer {
  return {
    duration: seconds,
    length: Math.round(seconds * 48000),
    sampleRate: 48000,
  } as unknown as AudioBuffer;
}

/** A fake context and an engine on it. `unlock()` to get buses. */
export function setupEngine(settings?: unknown) {
  const ctx = new FakeContext();
  const audio = new AudioEngine({
    createContext: () => ctx as unknown as AudioContext,
    settings,
  });
  return { ctx, audio };
}

/** Like `setupEngine`, on a `FakeSpatialContext`. */
export function setupSpatialEngine(settings?: unknown) {
  const ctx = new FakeSpatialContext();
  const audio = new AudioEngine({
    createContext: () => ctx as unknown as AudioContext,
    settings,
  });
  return { ctx, audio };
}
