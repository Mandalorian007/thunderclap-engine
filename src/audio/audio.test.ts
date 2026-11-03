import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../save';
import { AudioEngine, busGain, DEFAULT_MIXER, sanitizeMixer } from './audio';
import { persistMixer } from './persist';
import { recipes } from './recipes';
import { validateSpec } from './synth';

// ---------------------------------------------------------------- minimal WebAudio fake

class FakeParam {
  value: number;
  constructor(v = 1) {
    this.value = v;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
}

class FakeNode {
  outputs: FakeNode[] = [];
  connect<T extends FakeNode>(n: T): T {
    this.outputs.push(n);
    return n;
  }
  disconnect(target?: FakeNode) {
    this.outputs = target ? this.outputs.filter((o) => o !== target) : [];
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  playbackRate = new FakeParam(1);
  detune = new FakeParam(0);
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor(private readonly ctx: FakeContext) {
    super();
    ctx.sources.push(this);
  }
  start(t = 0) {
    this.startedAt = t;
  }
  stop(t = 0) {
    this.stoppedAt = t;
    queueMicrotask(() => this.onended?.());
  }
  get isSilentUnlock() {
    return (
      (this.buffer as { length: number } | null)?.length === 1 &&
      this.outputs[0] === this.ctx.destination
    );
  }
}

class FakeContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  onstatechange: (() => void) | null = null;
  allowResume = true;
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(), { pan: new FakeParam(0) });
  }
  createBuffer(_c: number, length: number) {
    return { length };
  }
  async resume() {
    if (this.allowResume) this.state = 'running';
  }
  async suspend() {
    this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }
  get played() {
    return this.sources.filter((s) => !s.isSilentUnlock);
  }
}

/** Adds the nodes the limiter and reverb need (a plain FakeContext lacks them, like old browsers). */
class FullFakeContext extends FakeContext {
  convolvers: (FakeNode & { buffer: unknown; normalize: boolean })[] = [];
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(), {
      threshold: new FakeParam(-24),
      knee: new FakeParam(30),
      ratio: new FakeParam(12),
      attack: new FakeParam(0.003),
      release: new FakeParam(0.25),
    });
  }
  createConvolver() {
    const c = Object.assign(new FakeNode(), { buffer: null as unknown, normalize: false });
    this.convolvers.push(c);
    return c;
  }
  override createBuffer(channels: number, length: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      length,
      numberOfChannels: channels,
      data,
      copyToChannel(src: Float32Array, ch: number) {
        data[ch]!.set(src);
      },
    };
  }
}

/** Every node reachable from `from` (depth-first). */
function reachable(from: FakeNode, seen = new Set<FakeNode>()): Set<FakeNode> {
  if (seen.has(from)) return seen;
  seen.add(from);
  for (const o of from.outputs) reachable(o, seen);
  return seen;
}

const fakeBuffer = { duration: 1, length: 48000 } as unknown as AudioBuffer;

function setup(settings?: unknown) {
  const ctx = new FakeContext();
  const audio = new AudioEngine({ createContext: () => ctx as unknown as AudioContext, settings });
  audio.define('beep', async () => fakeBuffer);
  return { ctx, audio };
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------- tests

describe('mixer settings', () => {
  it('sanitizes anything into valid settings', () => {
    expect(sanitizeMixer(undefined)).toEqual(DEFAULT_MIXER);
    const s = sanitizeMixer({
      master: { volume: 7, muted: 'yes' },
      music: { volume: -1 },
      ui: null,
    });
    expect(s.master).toEqual({ volume: 1, muted: false });
    expect(s.music.volume).toBe(0);
    expect(s.ui).toEqual(DEFAULT_MIXER.ui);
    expect(busGain({ volume: 0.5, muted: false })).toBeCloseTo(0.25);
    expect(busGain({ volume: 1, muted: true })).toBe(0);
  });
});

describe('AudioEngine', () => {
  it('is locked until unlock, then builds buses with settings applied', async () => {
    const { ctx, audio } = setup({ music: { volume: 0.5, muted: false } });
    expect(audio.state).toBe('locked');
    expect(audio.context).toBeNull();
    expect(audio.play(fakeBuffer).playing).toBe(false);
    expect(await audio.unlock()).toBe(true);
    expect(audio.state).toBe('running');
    expect(audio.busNode('music')!.gain.value).toBeCloseTo(0.25);
    expect(audio.busNode('master')!.connect).toBeDefined();
    expect((audio.busNode('master') as unknown as FakeNode).outputs[0]).toBe(ctx.destination);
    expect((audio.busNode('sfx') as unknown as FakeNode).outputs[0]).toBe(audio.busNode('master'));
  });

  it('stays locked if the browser refuses to resume, and retries', async () => {
    const { ctx, audio } = setup();
    ctx.allowResume = false;
    expect(await audio.unlock()).toBe(false);
    expect(audio.state).toBe('locked');
    ctx.allowResume = true;
    expect(await audio.unlock()).toBe(true);
  });

  it('reports unavailable when WebAudio is missing', async () => {
    const audio = new AudioEngine({
      createContext: () => {
        throw new Error('nope');
      },
    });
    expect(await audio.unlock()).toBe(false);
    expect(audio.state).toBe('unavailable');
    expect(audio.loop(fakeBuffer).playing).toBe(false);
  });

  it('unlocks on the first gesture via attach()', async () => {
    const { audio } = setup();
    const target = new EventTarget();
    audio.attach({ target, pauseWhenHidden: false });
    target.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    audio.detach();
  });

  it('an iOS interruption pauses, and the next gesture brings sound back', async () => {
    const { ctx, audio } = setup();
    const target = new EventTarget();
    audio.attach({ target, pauseWhenHidden: false });
    target.dispatchEvent(new Event('touchend'));
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    // A call or Siri: Safari moves the context to 'interrupted' (not in the TS lib types).
    (ctx as { state: string }).state = 'interrupted';
    ctx.onstatechange?.();
    expect(audio.state).toBe('suspended');
    await audio.prepare();
    expect(audio.loop('beep').playing).toBe(true);
    target.dispatchEvent(new Event('pointerup'));
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    audio.detach();
  });

  it('re-arms the gesture listeners when the browser suspends a running context', async () => {
    const { ctx, audio } = setup();
    const target = new EventTarget();
    audio.attach({ target, pauseWhenHidden: false });
    target.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    // Android/iOS suspended it behind our back, and refuses a resume without a gesture.
    ctx.state = 'suspended';
    ctx.allowResume = false;
    ctx.onstatechange?.();
    expect(audio.state).toBe('suspended');
    target.dispatchEvent(new Event('keydown'));
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.state).toBe('suspended');
    ctx.allowResume = true;
    target.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    // Only 'closed' is final.
    ctx.state = 'closed';
    ctx.onstatechange?.();
    expect(audio.state).toBe('unavailable');
    audio.detach();
  });

  it('does not re-arm while paused on purpose', async () => {
    const { ctx, audio } = setup();
    const target = new EventTarget();
    audio.attach({ target, pauseWhenHidden: false });
    await audio.unlock();
    await audio.suspend();
    target.dispatchEvent(new Event('pointerdown'));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.state).toBe('suspended');
    audio.detach();
  });

  it('defers loops until unlock and drops one-shots while locked', async () => {
    const { ctx, audio } = setup();
    const music = audio.loop('beep', { gain: 0.5 });
    const shot = audio.play('beep');
    expect(music.playing).toBe(true);
    expect(shot.playing).toBe(false);
    await audio.unlock();
    await vi.waitFor(() => expect(ctx.played.length).toBe(1));
    const src = ctx.played[0]!;
    expect(src.loop).toBe(true);
    expect((src.outputs[0] as FakeGain).outputs[0]).toBe(audio.busNode('music'));
    music.stop();
    expect(src.stoppedAt).not.toBeNull();
  });

  it('a loop stopped before unlock never starts', async () => {
    const { ctx, audio } = setup();
    audio.loop('beep').stop();
    await audio.unlock();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.played.length).toBe(0);
  });

  it('plays one-shots on the requested bus with gain, rate and pan', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    await audio.prepare();
    const v = audio.play('beep', { bus: 'ui', gain: 0.3, rate: 2, pan: -0.5 });
    expect(v.playing).toBe(true);
    const src = ctx.played[0]!;
    expect(src.playbackRate.value).toBe(2);
    const gain = src.outputs[0] as FakeGain;
    expect(gain.gain.value).toBe(0.3);
    const pan = gain.outputs[0] as FakeNode & { pan: FakeParam };
    expect(pan.pan.value).toBe(-0.5);
    expect(pan.outputs[0]).toBe(audio.busNode('ui'));
    await vi.waitFor(() => {
      src.onended?.();
      expect(v.playing).toBe(false);
    });
  });

  it('prepare spreads slow synchronous render starts over several tasks', async () => {
    const audio = new AudioEngine();
    const busy = (ms: number) => {
      const t = performance.now();
      while (performance.now() - t < ms) {
        // spin: stands in for a graph build
      }
    };
    // Each start is 4 ms of synchronous work (48 ms in all).
    let started = 0;
    const names = Array.from({ length: 12 }, (_, i) => `s${i}`);
    for (const n of names)
      audio.define(n, () => {
        busy(4);
        started++;
        return Promise.resolve(fakeBuffer);
      });
    const done = audio.prepare(names);
    // The calling task stops after ~10 ms of starts and yields; the rest run in later tasks.
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThanOrEqual(3);
    await done;
    expect(started).toBe(12);
    expect(audio.buffer('s11')).toBe(fakeBuffer);
  });

  it('steals the oldest voice past maxVoices and stopAll filters by bus', async () => {
    const { ctx, audio } = setup();
    audio.define('tick', async () => fakeBuffer, { maxVoices: 2 });
    await audio.unlock();
    await audio.prepare();
    const a = audio.play('tick');
    audio.play('tick');
    audio.play('tick');
    expect(a.playing).toBe(false);
    expect(ctx.played[0]!.stoppedAt).not.toBeNull();
    const m = audio.loop('beep');
    audio.stopAll(0, 'sfx');
    expect(m.playing).toBe(true);
    audio.stopAll();
    expect(m.playing).toBe(false);
  });

  it('volume and mute changes update bus gains and notify', async () => {
    const { audio } = setup();
    const seen: number[] = [];
    audio.onSettingsChange((s) => seen.push(s.sfx.volume));
    audio.setVolume('sfx', 0.4); // before unlock: stored
    await audio.unlock();
    expect(audio.busNode('sfx')!.gain.value).toBeCloseTo(0.16);
    expect(audio.toggleMuted('sfx')).toBe(true);
    expect(audio.busNode('sfx')!.gain.value).toBe(0);
    audio.setVolume('sfx', 3);
    expect(audio.settings.sfx.volume).toBe(1);
    expect(seen).toEqual([0.4, 0.4, 1]);
  });

  it('suspend/resume pauses the context', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    await audio.suspend();
    expect(ctx.state).toBe('suspended');
    expect(audio.state).toBe('suspended');
    expect(audio.play('beep').playing).toBe(false);
    await audio.resume();
    expect(audio.state).toBe('running');
  });

  it('halt silences for good: no resume on a gesture, tab switch or resume()', async () => {
    const { ctx, audio } = setup();
    const target = new EventTarget();
    audio.attach({ target, pauseWhenHidden: false });
    await audio.unlock();
    await audio.prepare();
    const music = audio.loop('beep');
    expect(music.playing).toBe(true);
    await audio.halt();
    expect(audio.halted).toBe(true);
    expect(music.playing).toBe(false);
    expect(ctx.state).toBe('suspended');
    expect(audio.state).toBe('suspended');
    await audio.resume();
    expect(await audio.unlock()).toBe(false);
    target.dispatchEvent(new Event('pointerdown'));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.state).toBe('suspended');
    expect(audio.play('beep').playing).toBe(false);
    expect(audio.loop('beep').playing).toBe(false);
    expect(audio.voiceCount).toBe(0);
  });

  it('halt before unlock drops waiting loops and never unlocks', async () => {
    const { ctx, audio } = setup();
    const music = audio.loop('beep');
    await audio.halt();
    expect(music.playing).toBe(false);
    expect(await audio.unlock()).toBe(false);
    expect(audio.state).toBe('locked');
    expect(ctx.played.length).toBe(0);
  });

  it('warns on unknown sounds instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { audio } = setup();
    await audio.unlock();
    expect(audio.play('nope').playing).toBe(false);
    expect(warn).toHaveBeenCalled();
    await expect(audio.load('nope')).rejects.toThrow();
  });
});

describe('persistMixer', () => {
  it('loads saved settings and saves changes', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'thunderclap:g:audio',
      JSON.stringify({ v: 1, t: 0, d: { ...DEFAULT_MIXER, music: { volume: 0.1, muted: true } } }),
    );
    const { audio } = setup();
    const { store, unbind } = persistMixer(audio, {
      game: 'g',
      storage,
      debounceMs: 0,
      autoFlush: false,
    });
    expect(audio.settings.music).toEqual({ volume: 0.1, muted: true });
    audio.setVolume('master', 0.33);
    expect(JSON.parse(storage.getItem('thunderclap:g:audio')!).d.master.volume).toBe(0.33);
    expect(store.persistent).toBe(true);
    unbind();
    audio.setVolume('master', 0.5);
    expect(JSON.parse(storage.getItem('thunderclap:g:audio')!).d.master.volume).toBe(0.33);
  });

  it('works without storage', () => {
    const { audio } = setup();
    const { store } = persistMixer(audio, { game: 'g', storage: null, autoFlush: false });
    expect(store.persistent).toBe(false);
    expect(audio.settings).toEqual(DEFAULT_MIXER);
  });
});

describe('recipes', () => {
  it('every recipe produces a valid spec with default and varied options', () => {
    for (const [name, make] of Object.entries(recipes)) {
      for (const o of [
        {},
        { pitch: 300, length: 2, brightness: 1, seed: 9 },
        { length: 0.5, brightness: 0 },
      ]) {
        const spec = make(o);
        expect(validateSpec(spec), `${name} ${JSON.stringify(o)}`).toEqual([]);
      }
    }
  });

  it('loop recipes use whole-cycle frequencies', () => {
    const pad = recipes.dronePad({ pitch: 97.3 });
    for (const l of pad.layers) {
      if (l.source.type === 'osc') expect((l.source.freq * pad.duration) % 1).toBeCloseTo(0, 6);
    }
    expect(pad.loop).toBeDefined();
    expect(recipes.crackleLoop().loop).toBeDefined();
  });

  it('validateSpec catches mistakes', () => {
    const errs = validateSpec({
      duration: 0.1,
      layers: [
        {
          source: { type: 'osc', wave: 'sine', freq: 30000 },
          env: { attack: 0, decay: 0.5, sustain: 2, release: 0.1 },
          gate: 0.5,
          pan: 3,
        },
      ],
    });
    expect(errs.join('\n')).toMatch(/freq 30000/);
    expect(errs.join('\n')).toMatch(/after duration/);
    expect(errs.join('\n')).toMatch(/sustain/);
    expect(errs.join('\n')).toMatch(/pan/);
    expect(validateSpec({ duration: 0, layers: [] }).length).toBe(2);
  });
});

describe('master limiter and reverb', () => {
  function full(opts: Partial<ConstructorParameters<typeof AudioEngine>[0]> = {}) {
    const ctx = new FullFakeContext();
    const audio = new AudioEngine({ createContext: () => ctx as unknown as AudioContext, ...opts });
    return { ctx, audio };
  }

  it('puts a limiter between master and the output by default', async () => {
    const { ctx, audio } = full();
    await audio.unlock();
    const lim = audio.limiter as unknown as FakeNode & { threshold: FakeParam; ratio: FakeParam };
    expect(lim).not.toBeNull();
    expect((audio.busNode('master') as unknown as FakeNode).outputs).toEqual([lim]);
    expect(lim.outputs).toEqual([ctx.destination]);
    expect(lim.threshold.value).toBe(-1);
    expect(lim.ratio.value).toBe(20);
  });

  it('honours limiter options and limiter: false', async () => {
    const a = full({ limiter: { threshold: -3 } });
    await a.audio.unlock();
    expect((a.audio.limiter as unknown as { threshold: FakeParam }).threshold.value).toBe(-3);
    const b = full({ limiter: false });
    await b.audio.unlock();
    expect(b.audio.limiter).toBeNull();
    expect((b.audio.busNode('master') as unknown as FakeNode).outputs).toEqual([b.ctx.destination]);
  });

  it('skips the limiter where DynamicsCompressor is missing', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    expect(audio.limiter).toBeNull();
    expect((audio.busNode('master') as unknown as FakeNode).outputs[0]).toBe(ctx.destination);
  });

  it('has no reverb unless asked', async () => {
    const { ctx, audio } = full();
    await audio.unlock();
    expect(ctx.convolvers).toHaveLength(0);
    expect(audio.reverb).toBeNull();
  });

  it('routes bus sends through a procedural convolver back into master', async () => {
    const { ctx, audio } = full({ reverb: { seconds: 0.5, sends: { ui: 0.1 } } });
    await audio.unlock();
    expect(ctx.convolvers).toHaveLength(1);
    const conv = ctx.convolvers[0]!;
    const buf = conv.buffer as { numberOfChannels: number; length: number; data: Float32Array[] };
    expect(buf.numberOfChannels).toBe(2);
    expect(buf.length).toBe(24000);
    expect(buf.data[0]!.some((v) => v !== 0)).toBe(true);
    const master = audio.busNode('master') as unknown as FakeNode;
    expect(reachable(conv).has(master)).toBe(true);
    for (const bus of ['music', 'sfx', 'ui'] as const) {
      const node = audio.busNode(bus) as unknown as FakeNode;
      expect(node.outputs[0]).toBe(master); // dry path first
      const send = node.outputs[1] as FakeGain;
      expect(send.outputs).toEqual([conv]);
    }
    expect(audio.reverbSendLevels).toEqual({ music: 0.2, sfx: 0.25, ui: 0.1 });
    const sfxSend = (audio.busNode('sfx') as unknown as FakeNode).outputs[1] as FakeGain;
    audio.setReverbSend('sfx', 0.6);
    expect(sfxSend.gain.value).toBeCloseTo(0.6);
  });

  it('can be turned on after unlock, rebuilt and turned off', async () => {
    const { ctx, audio } = full();
    audio.setReverbSend('music', 0.5); // remembered while off
    await audio.unlock();
    audio.setReverb({ seconds: 0.2 });
    expect(ctx.convolvers).toHaveLength(1);
    const music = audio.busNode('music') as unknown as FakeNode;
    expect((music.outputs[1] as FakeGain).gain.value).toBe(0.5);
    audio.setReverb({ seconds: 0.3, decay: 5 });
    expect(ctx.convolvers).toHaveLength(2);
    expect(music.outputs).toHaveLength(2); // old send disconnected
    audio.setReverb(null);
    expect(music.outputs).toEqual([audio.busNode('master')]);
    expect(ctx.convolvers[1]!.outputs).toEqual([]);
  });

  it('is a no-op where ConvolverNode is missing', async () => {
    const ctx = new FakeContext();
    const audio = new AudioEngine({
      createContext: () => ctx as unknown as AudioContext,
      reverb: {},
    });
    await audio.unlock();
    expect((audio.busNode('music') as unknown as FakeNode).outputs).toHaveLength(1);
    audio.setReverbSend('music', 1);
  });
});
