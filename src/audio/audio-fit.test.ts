// ws/audio-fit: custom buses, the voice budget, the audio session, the pan fallback, the spec
// envelope, impulse shaping, wake without pauseWhenHidden, the lazy context, the watchdog, the
// public fake and the volume curve.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeAudioContext,
  FakeAudioContext,
  FakeAudioGain,
  FakeAudioNode,
  FakeAudioParam,
  type FakeAudioSpatialContext,
} from '../testing/fake-audio';
import { AudioEngine, type AudioEngineOptions, busGain } from './audio';
import { impulseResponse, reverbImpulse, volumeToGain } from './dsp';
import { renderSound, type SoundSpec, validateSpec } from './synth';

const BUF = { duration: 1, length: 48000, sampleRate: 48000 } as unknown as AudioBuffer;

function engine(opts: AudioEngineOptions = {}, ctx = createFakeAudioContext()) {
  let made = 0;
  const audio = new AudioEngine({
    ...opts,
    createContext: () => {
      made++;
      return ctx.asAudioContext();
    },
  });
  return { ctx, audio, made: () => made };
}

/** The gain node a voice feeds into (its bus), following its single-output chain from the source. */
function busOf(ctx: FakeAudioContext): FakeAudioNode {
  const src = ctx.played.at(-1)!;
  let n: FakeAudioNode = src.gainNode;
  while (n.outputs.length === 1 && !(n.outputs[0] instanceof FakeAudioGain)) n = n.outputs[0]!;
  return n.outputs[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('custom buses', () => {
  it('adds a bus into master with its own volume and mute', async () => {
    const { ctx, audio } = engine();
    audio.addBus('ambient', { volume: 0.5 });
    await audio.unlock();
    const node = audio.busNode('ambient') as unknown as FakeAudioGain;
    expect(node).not.toBeNull();
    expect(node.outputs[0]).toBe(audio.busNode('master'));
    expect(node.gain.value).toBeCloseTo(0.25);
    audio.play(BUF, { bus: 'ambient' });
    expect(busOf(ctx)).toBe(node);
    audio.setVolume('ambient', 1);
    expect(node.gain.value).toBeCloseTo(1);
    audio.setMuted('ambient', true);
    expect(node.gain.value).toBe(0);
    expect(audio.toggleMuted('ambient')).toBe(false);
    expect(audio.busSettings('ambient')).toEqual({ volume: 1, muted: false });
    expect(audio.customBuses).toEqual(['ambient']);
    expect(audio.hasBus('ambient')).toBe(true);
    expect(audio.voices('ambient')).toHaveLength(1);
  });

  it('keeps custom settings out of MixerSettings and onSettingsChange', async () => {
    const { audio } = engine();
    const seen = vi.fn();
    audio.onSettingsChange(seen);
    audio.addBus('ambient');
    audio.setVolume('ambient', 0.3);
    expect(seen).not.toHaveBeenCalled();
    expect(Object.keys(audio.settings)).toEqual(['master', 'music', 'sfx', 'ui']);
    audio.applySettings({});
    expect(audio.busSettings('ambient')!.volume).toBeCloseTo(0.3);
  });

  it('throws on a built-in name, and drops a play on an unknown bus', async () => {
    const { ctx, audio } = engine();
    expect(() => audio.addBus('music')).toThrow(RangeError);
    await audio.unlock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(audio.play(BUF, { bus: 'nope' }).playing).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(ctx.played).toHaveLength(0);
    audio.setVolume('nope', 0.5);
    expect(audio.busSettings('nope')).toBeNull();
  });

  it('builds a bus added after unlock, scales it, pauses it unless kept', async () => {
    const { audio } = engine();
    await audio.unlock();
    audio.addBus('ambient');
    const node = audio.busNode('ambient') as unknown as FakeAudioGain;
    audio.setBusScale('ambient', 0.5);
    expect(audio.busScale('ambient')).toBe(0.5);
    expect(node.gain.value).toBeCloseTo(0.5);
    audio.pause();
    expect(audio.pausedCustomBuses).toEqual(['ambient']);
    expect(node.gain.value).toBe(0);
    audio.unpause();
    expect(node.gain.value).toBeCloseTo(0.5);
    audio.pause({ keep: ['ambient'] });
    expect(audio.pausedCustomBuses).toEqual([]);
    expect(node.gain.value).toBeCloseTo(0.5);
    audio.unpause();
  });

  it('removeBus stops its voices and forgets it', async () => {
    const { ctx, audio } = engine();
    audio.addBus('ambient');
    await audio.unlock();
    const v = audio.loop(BUF, { bus: 'ambient' });
    expect(v.playing).toBe(true);
    audio.stopAll({ except: ['ambient'] });
    expect(v.playing).toBe(true);
    audio.removeBus('ambient');
    expect(v.playing).toBe(false);
    expect(audio.hasBus('ambient')).toBe(false);
    expect(audio.busNode('ambient')).toBeNull();
    expect(ctx.played).toHaveLength(1);
  });
});

describe('voice budget', () => {
  it('cuts the lowest priority voice, oldest among equals, and drops when none qualifies', async () => {
    const { audio } = engine({ voiceBudget: { max: 2 } });
    await audio.unlock();
    const a = audio.play(BUF, { priority: 1 });
    const b = audio.play(BUF, { priority: 0 });
    const c = audio.play(BUF, { priority: 0 });
    expect(b.playing).toBe(false);
    expect(a.playing && c.playing).toBe(true);
    // c (0) goes before a (1).
    const d = audio.play(BUF, { priority: 1 });
    expect(c.playing).toBe(false);
    expect(d.playing).toBe(true);
    // Everything playing outranks a 0.
    const e = audio.play(BUF, { priority: 0 });
    expect(e.playing).toBe(false);
    expect(audio.voiceBudgetStats).toEqual({ live: 2, stolen: 2, dropped: 1 });
  });

  it('steal oldest cuts the oldest voice of no higher priority', async () => {
    const { audio } = engine({ voiceBudget: { max: 2, steal: 'oldest' } });
    await audio.unlock();
    const a = audio.play(BUF, { priority: 5 });
    const b = audio.play(BUF, { priority: 1 });
    const c = audio.play(BUF, { priority: 2 });
    expect([a.playing, b.playing, c.playing]).toEqual([true, false, true]);
  });

  it('takes the priority from define, leaves loops alone by default, and the sound cap goes first', async () => {
    const { audio } = engine({ voiceBudget: { max: 2 } });
    audio.define('hit', () => Promise.resolve(BUF), { maxVoices: 1, priority: 3 });
    audio.define('tick', () => Promise.resolve(BUF));
    await audio.prepare();
    await audio.unlock();
    const music = audio.loop(BUF);
    const t = audio.play('tick');
    const h1 = audio.play('hit');
    expect(audio.voiceBudgetStats.live).toBe(2);
    // The sound's own cap replaces h1; the budget has nothing to cut.
    const h2 = audio.play('hit');
    expect([music.playing, t.playing, h1.playing, h2.playing]).toEqual([true, true, false, true]);
    expect(audio.voiceBudgetStats.stolen).toBe(0);
    // A tick (0) cannot cut a hit (3) but can cut the older tick.
    const t2 = audio.play('tick');
    expect([t.playing, t2.playing, h2.playing]).toEqual([false, true, true]);
    expect(music.playing).toBe(true);
  });

  it('setVoiceBudget validates and clears', () => {
    const { audio } = engine();
    expect(audio.voiceBudget).toBeNull();
    expect(() => audio.setVoiceBudget({ max: 0 })).toThrow(RangeError);
    audio.setVoiceBudget({ max: 4 });
    expect(audio.voiceBudget).toEqual({ max: 4, steal: 'lowest', stealFade: 0.03, loops: false });
    audio.setVoiceBudget(null);
    expect(audio.voiceBudget).toBeNull();
  });
});

describe('audio session', () => {
  it('sets navigator.audioSession.type on unlock when asked, and only then', async () => {
    const session = { type: 'auto' };
    vi.stubGlobal('navigator', { audioSession: session });
    await engine().audio.unlock();
    expect(session.type).toBe('auto');
    await engine({ audioSession: 'playback' }).audio.unlock();
    expect(session.type).toBe('playback');
  });

  it('is a no-op where the browser has no audioSession', async () => {
    vi.stubGlobal('navigator', {});
    const { audio } = engine({ audioSession: 'playback' });
    expect(await audio.unlock()).toBe(true);
  });
});

describe('pan fallback', () => {
  function spatialNoStereo() {
    const ctx = createFakeAudioContext({ spatial: true, stereoPanner: false });
    return { ...engine({}, ctx), ctx: ctx as FakeAudioSpatialContext };
  }

  it('plays pan through an equal-power panner beside the listener', async () => {
    const { ctx, audio } = spatialNoStereo();
    await audio.unlock();
    audio.play(BUF, { pan: 1 });
    const p = ctx.panners[0]!;
    expect(p.panningModel).toBe('equalpower');
    expect(p.rolloffFactor).toBe(0);
    expect(p.position[0]).toBeCloseTo(1);
    expect(p.position[2]).toBeCloseTo(0);
    audio.play(BUF, { pan: -0.5 });
    const q = ctx.panners[1]!;
    expect(q.position[0]).toBeCloseTo(-Math.SQRT1_2);
    expect(q.position[2]).toBeCloseTo(-Math.SQRT1_2);
    expect(audio.panFallbackCount).toBe(2);
  });

  it('follows the listener and returns the panner to the pool', async () => {
    const { ctx, audio } = spatialNoStereo();
    await audio.unlock();
    const v = audio.play(BUF, { pan: 1 });
    // Facing +x: the right ear points to +z.
    audio.listener.set([10, 0, 0], [1, 0, 0]);
    const p = ctx.panners[0]!;
    expect(p.position[0]).toBeCloseTo(10);
    expect(p.position[2]).toBeCloseTo(1);
    v.stop();
    ctx.played[0]!.onended?.();
    expect(audio.panFallbackCount).toBe(0);
    expect(audio.pooledPanners).toBe(1);
  });

  it('keeps the StereoPannerNode where there is one, and plays centred with neither', async () => {
    const withStereo = engine({}, createFakeAudioContext({ spatial: true }));
    await withStereo.audio.unlock();
    withStereo.audio.play(BUF, { pan: 1 });
    expect((withStereo.ctx as FakeAudioSpatialContext).panners).toHaveLength(0);
    const bare = engine({}, createFakeAudioContext({ stereoPanner: false }));
    await bare.audio.unlock();
    expect(bare.audio.play(BUF, { pan: 1 }).playing).toBe(true);
    expect(bare.audio.panFallbackCount).toBe(0);
  });
});

describe('spec envelope', () => {
  /** A just-enough OfflineAudioContext: gains and oscillators that record, nothing rendered. */
  function offline() {
    const gains: FakeAudioGain[] = [];
    const ctx = {
      sampleRate: 8000,
      destination: new FakeAudioNode(),
      createGain() {
        const g = new FakeAudioGain();
        gains.push(g);
        return g;
      },
      createOscillator() {
        return Object.assign(new FakeAudioNode(), {
          type: 'sine',
          frequency: new FakeAudioParam(440),
          detune: new FakeAudioParam(0),
          start() {},
          stop() {},
        });
      },
      startRendering: async () => ({ numberOfChannels: 1 }),
    };
    return { gains, factory: () => ctx as unknown as OfflineAudioContext };
  }
  const layer = {
    source: { type: 'osc', wave: 'sine', freq: 440 },
    env: { attack: 0, decay: 0, sustain: 1, release: 0 },
  } as const;

  it('shapes every layer together on the master gain', async () => {
    const { gains, factory } = offline();
    const spec: SoundSpec = {
      duration: 1,
      gain: 0.5,
      layers: [layer, layer],
      env: { attack: 0.2, decay: 0, sustain: 1, release: 0.3 },
    };
    expect(validateSpec(spec)).toEqual([]);
    await renderSound(spec, factory);
    const master = gains[0]!.gain;
    const peak = Math.max(...master.events.map((e) => e.value));
    expect(peak).toBeCloseTo(0.5);
    expect(master.events.some((e) => e.type === 'linear' && Math.abs(e.time - 0.2) < 1e-9)).toBe(
      true,
    );
    // Without env the master is a constant, as before.
    const plain = offline();
    await renderSound({ duration: 1, gain: 0.5, layers: [layer] }, plain.factory);
    expect(plain.gains[0]!.gain.events).toEqual([]);
    expect(plain.gains[0]!.gain.value).toBe(0.5);
  });

  it('validates the envelope', () => {
    const bad: SoundSpec = {
      duration: 1,
      layers: [layer],
      env: { attack: -1, decay: 0, sustain: 2, release: 0 },
      envGate: 2,
    };
    const errs = validateSpec(bad);
    expect(errs.some((e) => e.startsWith('env.attack'))).toBe(true);
    expect(errs.some((e) => e.startsWith('env.sustain'))).toBe(true);
    expect(errs.some((e) => e.startsWith('env ends'))).toBe(true);
  });
});

describe('impulse shaping', () => {
  it('gives exactly the plain samples without damping or early reflections', () => {
    const plain = reverbImpulse(8000, 0.5, 3, 7, 2);
    expect(reverbImpulse(8000, 0.5, 3, 7, 2, {})).toEqual(plain);
    expect(reverbImpulse(8000, 0.5, 3, 7, 2, { damping: 0 })).toEqual(plain);
  });

  it('damping darkens the tail and keeps the onset', () => {
    const plain = reverbImpulse(8000, 1, 1, 3, 1)[0]!;
    const damped = reverbImpulse(8000, 1, 1, 3, 1, { damping: 1 })[0]!;
    expect(damped[0]).toBe(plain[0]);
    /** Mean absolute sample-to-sample change over a window: high-frequency energy. */
    const rough = (x: Float32Array, a: number, b: number) => {
      let s = 0;
      let e = 0;
      for (let i = a + 1; i < b; i++) {
        s += Math.abs(x[i]! - x[i - 1]!);
        e += Math.abs(x[i]!);
      }
      return s / e;
    };
    expect(rough(damped, 6000, 7900)).toBeLessThan(rough(plain, 6000, 7900) * 0.7);
    expect(reverbImpulse(8000, 1, 1, 3, 1, { damping: 1 })[0]).toEqual(damped);
  });

  it('early reflections add seeded taps inside their window', () => {
    const plain = reverbImpulse(8000, 0.5, 3, 2, 1)[0]!;
    const early = reverbImpulse(8000, 0.5, 3, 2, 1, {
      early: { count: 4, time: 0.05, gain: 0.8 },
    })[0]!;
    const moved: number[] = [];
    for (let i = 0; i < plain.length; i++) if (early[i] !== plain[i]) moved.push(i);
    expect(moved.length).toBe(4);
    expect(Math.max(...moved)).toBeLessThanOrEqual(0.05 * 8000);
    expect(Math.abs(early[moved[0]!]! - plain[moved[0]!]!)).toBeCloseTo(0.8, 5);
    const again = reverbImpulse(8000, 0.5, 3, 2, 1, { early: { count: 4, time: 0.05, gain: 0.8 } });
    expect(again[0]).toEqual(early);
  });

  it('impulseResponse and the engine reverb take the same options', async () => {
    const ctx = createFakeAudioContext({ sampleRate: 8000 });
    const buf = impulseResponse(ctx.asAudioContext(), {
      seconds: 0.25,
      damping: 0.5,
    }) as unknown as {
      data: Float32Array[];
    };
    expect(buf.data[0]).toEqual(reverbImpulse(8000, 0.25, 3, 1, 2, { damping: 0.5 })[0]);
    const { audio } = engine({ reverb: { seconds: 0.25, damping: 0.5 } }, ctx);
    await audio.unlock();
    const conv = ctx.convolvers[0]!.buffer as { data: Float32Array[] };
    expect(conv.data[0]).toEqual(buf.data[0]);
  });
});

describe('wake without pauseWhenHidden', () => {
  it('pageshow and focus resume a context the browser stopped', async () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const { ctx, audio } = engine();
    const target = new EventTarget();
    audio.attach({ target, pauseWhenHidden: false });
    target.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    ctx.state = 'suspended';
    ctx.onstatechange?.();
    expect(audio.state).toBe('suspended');
    win.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    ctx.state = 'suspended';
    ctx.onstatechange?.();
    win.dispatchEvent(new Event('pageshow'));
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    audio.detach();
    ctx.state = 'suspended';
    ctx.onstatechange?.();
    win.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.state).toBe('suspended');
  });

  it('wake leaves a context the game suspended alone', async () => {
    const { ctx, audio } = engine();
    await audio.unlock();
    await audio.suspend();
    audio.wake();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.state).toBe('suspended');
  });
});

describe('lazy context', () => {
  it('creates no context on a gesture while master is muted, then on unmute', async () => {
    const { audio, made } = engine({ lazyContext: true, settings: { master: { muted: true } } });
    expect(await audio.unlock()).toBe(false);
    expect(made()).toBe(0);
    expect(audio.state).toBe('locked');
    expect(audio.loop(BUF).playing).toBe(true);
    expect(made()).toBe(0);
    audio.setMuted('master', false);
    await vi.waitFor(() => expect(audio.state).toBe('running'));
    expect(made()).toBe(1);
  });

  it('volume 0 holds it too; applySettings or a play once audible creates it', async () => {
    const a = engine({ lazyContext: true, settings: { master: { volume: 0 } } });
    await a.audio.unlock();
    expect(a.made()).toBe(0);
    a.audio.applySettings({ master: { volume: 0.5 } });
    await vi.waitFor(() => expect(a.audio.state).toBe('running'));
    // No gesture yet: an unmute alone waits for one.
    const b = engine({ lazyContext: true, settings: { master: { muted: true } } });
    b.audio.setMuted('master', false);
    b.audio.play(BUF);
    expect(b.made()).toBe(0);
  });

  it('off by default: a gesture while muted still creates the context', async () => {
    const { audio, made } = engine({ settings: { master: { muted: true } } });
    expect(await audio.unlock()).toBe(true);
    expect(made()).toBe(1);
  });
});

describe('watchdog', () => {
  it('restarts a running context whose clock stands still', async () => {
    const { ctx, audio } = engine({ watchdog: { stall: 0.5 } });
    await audio.unlock();
    ctx.stateCalls.length = 0;
    for (let i = 0; i < 3; i++) {
      ctx.advance(0.2);
      audio.update(0.2);
    }
    expect(audio.watchdogRestarts).toBe(0);
    for (let i = 0; i < 4; i++) audio.update(0.2);
    await vi.waitFor(() => expect(audio.watchdogRestarts).toBe(1));
    await vi.waitFor(() => expect(ctx.stateCalls).toEqual(['suspend', 'resume']));
    expect(audio.state).toBe('running');
  });

  it('is off by default and quiet while suspended on purpose', async () => {
    const off = engine();
    await off.audio.unlock();
    for (let i = 0; i < 20; i++) off.audio.update(0.2);
    expect(off.audio.watchdogRestarts).toBe(0);
    const on = engine({ watchdog: true });
    await on.audio.unlock();
    await on.audio.suspend();
    for (let i = 0; i < 20; i++) on.audio.update(0.2);
    expect(on.audio.watchdogRestarts).toBe(0);
  });
});

describe('the public fake', () => {
  it('builds plain, spatial and stereo-less contexts with a clock a test moves', () => {
    const plain = createFakeAudioContext();
    expect(plain).toBeInstanceOf(FakeAudioContext);
    expect('createPanner' in plain).toBe(false);
    expect(typeof plain.createStereoPanner).toBe('function');
    const spatial = createFakeAudioContext({ spatial: true, sampleRate: 44100 });
    expect(typeof spatial.createPanner).toBe('function');
    expect(spatial.sampleRate).toBe(44100);
    const old = createFakeAudioContext({ stereoPanner: false });
    expect(typeof (old as { createStereoPanner?: unknown }).createStereoPanner).toBe('undefined');
    plain.advance(0.5);
    plain.advance(-1);
    expect(plain.currentTime).toBe(0.5);
    expect(plain.asAudioContext()).toBe(plain);
  });
});

describe('volume curve', () => {
  it('maps linearly when asked, squared by default', async () => {
    expect(volumeToGain(0.5)).toBe(0.25);
    expect(volumeToGain(0.5, 'linear')).toBe(0.5);
    expect(busGain({ volume: 0.5, muted: false }, 'linear')).toBe(0.5);
    const lin = engine({ volumeCurve: 'linear', settings: { music: { volume: 0.5 } } });
    expect(lin.audio.volumeCurve).toBe('linear');
    await lin.audio.unlock();
    expect((lin.audio.busNode('music') as unknown as FakeAudioGain).gain.value).toBe(0.5);
    const sq = engine({ settings: { music: { volume: 0.5 } } });
    expect(sq.audio.volumeCurve).toBe('squared');
    await sq.audio.unlock();
    expect((sq.audio.busNode('music') as unknown as FakeAudioGain).gain.value).toBe(0.25);
  });
});
