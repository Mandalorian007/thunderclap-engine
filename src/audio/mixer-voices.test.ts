/**
 * The mixer's picture of what plays (ws/audio-3): `voices`, `forEachVoice`, `Voice.sendTo`,
 * `register`, music stems as voices, `stopAll({ except })` and the `pause` / `unpause` recipe,
 * all on the recording fake context.
 */
import { describe, expect, it } from 'vitest';
import { type AudioEngine, type BusName, busGain, MAX_VOICE_SENDS, type Voice } from './audio';
import {
  type FakeGain,
  type FakeNode,
  type FakeParam,
  type FakeSource,
  fakeBuffer,
  setupEngine,
} from './fake-context.test-util';
import { createMusic } from './music';
import { createSend } from './send';
import { createVariations } from './variations';

async function running() {
  const { ctx, audio } = setupEngine();
  await audio.unlock();
  ctx.currentTime = 5;
  return { ctx, audio };
}

/** Let the fake's `stop` deliver `onended`. */
const settle = () => new Promise<void>((r) => queueMicrotask(r));

/** A bus gain as the recording fake. */
const param = (bus: BusName, audio: AudioEngine) =>
  audio.busNode(bus)!.gain as unknown as FakeParam;

function fakeVoice(
  bus: 'sfx' | 'music' = 'sfx',
): Voice & { stops: number[]; rates: number[]; playing: boolean } {
  const v = {
    stops: [] as number[],
    rates: [] as number[],
    playing: true,
    position: new Float64Array(3),
    stop(fade = 0) {
      v.stops.push(fade);
      v.playing = false;
    },
    setGain() {},
    setRate(r: number) {
      v.rates.push(r);
    },
    setPosition() {},
    setDirection() {},
    follow() {},
    sendTo() {},
    filter() {},
    sendCount: 0,
    occlusion: 0,
    bus,
  };
  return v;
}

describe('voices and forEachVoice', () => {
  it('lists exactly the live voices on a bus and drops stopped and ended ones at once', async () => {
    const { ctx, audio } = await running();
    const a = audio.play(fakeBuffer(1));
    const b = audio.play(fakeBuffer(1));
    const m = audio.loop(fakeBuffer(2));
    const u = audio.play(fakeBuffer(1), { bus: 'ui' });
    expect(audio.voices('sfx')).toEqual([a, b]);
    expect(audio.voices('music')).toEqual([m]);
    expect(audio.voices('ui')).toEqual([u]);
    expect(audio.voices()).toHaveLength(4);
    expect(audio.voices('master')).toHaveLength(4);
    expect(audio.voiceCount).toBe(4);
    // Stopped: gone the same frame, before `onended`.
    a.stop(0.5);
    expect(audio.voices('sfx')).toEqual([b]);
    expect(audio.voiceCount).toBe(3);
    // Ended naturally: the source's `onended` drops it.
    (ctx.played[1] as FakeSource).onended?.();
    expect(b.playing).toBe(false);
    expect(audio.voices('sfx')).toEqual([]);
    expect(audio.voiceCount).toBe(2);
    // A fresh array each call; forEachVoice walks the same set without one.
    expect(audio.voices()).not.toBe(audio.voices());
    const seen: [Voice, string][] = [];
    audio.forEachVoice(undefined, (v, bus) => {
      seen.push([v, bus]);
    });
    expect(seen).toEqual([
      [m, 'music'],
      [u, 'ui'],
    ]);
    const onlyUi: Voice[] = [];
    audio.forEachVoice('ui', (v) => {
      onlyUi.push(v);
    });
    expect(onlyUi).toEqual([u]);
  });

  it('counts loops waiting for unlock as live', () => {
    const { audio } = setupEngine();
    const m = audio.loop(fakeBuffer(1));
    expect(audio.voices('music')).toEqual([m]);
    m.stop();
    expect(audio.voices('music')).toEqual([]);
  });
});

describe('Voice.sendTo', () => {
  it('builds one gain from the voice output into the send input; 0 disconnects; the fifth throws', async () => {
    const { ctx, audio } = await running();
    const muffle = createSend(audio, { kind: 'lowpass', bus: 'sfx', cutoff: 800 });
    const v = audio.play(fakeBuffer(1));
    const out = (ctx.played[0] as FakeSource).gainNode;
    const bus = audio.busNode('sfx') as unknown as FakeNode;
    expect(out.outputs).toEqual([bus]);
    v.sendTo(muffle, 1, 0);
    expect(out.outputs).toHaveLength(2);
    const tap = out.outputs[1] as FakeGain;
    expect(tap.gain.value).toBe(1);
    expect(tap.outputs).toEqual([muffle.input]);
    // The dry path is untouched.
    expect(out.outputs[0]).toBe(bus);
    // Same input again: the amount ramps, no second gain.
    v.sendTo(muffle, 0.4, 0.1);
    expect(out.outputs).toHaveLength(2);
    expect(tap.gain.last).toEqual({ type: 'linear', value: 0.4, time: 5.1 });
    // 0 removes it and frees the gain.
    v.sendTo(muffle, 0);
    expect(out.outputs).toEqual([bus]);
    expect(tap.outputs).toEqual([]);
    // Any node works as the input, up to MAX_VOICE_SENDS of them.
    const nodes = Array.from({ length: MAX_VOICE_SENDS + 1 }, () => ctx.createGain());
    for (let i = 0; i < MAX_VOICE_SENDS; i++) v.sendTo(nodes[i] as unknown as AudioNode, 0.5);
    expect(out.outputs).toHaveLength(1 + MAX_VOICE_SENDS);
    expect(() => v.sendTo(nodes[MAX_VOICE_SENDS] as unknown as AudioNode, 0.5)).toThrow(RangeError);
    // Torn down with the voice.
    v.stop();
    await settle();
    expect(out.outputs).toEqual([]);
    for (let i = 0; i < MAX_VOICE_SENDS; i++) {
      expect((nodes[i] as FakeGain).outputs).toEqual([]);
    }
    // After the end: a no-op.
    v.sendTo(muffle, 1);
    expect(out.outputs).toEqual([]);
  });

  it('taps a spatial voice after its panner and a pending loop once it starts', async () => {
    const { ctx, audio } = setupEngine();
    const target = ctx.createGain();
    const m = audio.loop(fakeBuffer(1), { bus: 'sfx', pan: 0.5 });
    m.sendTo(target as unknown as AudioNode, 0.7); // before unlock: kept
    await audio.unlock();
    const src = ctx.played[0] as FakeSource;
    const panner = src.gainNode.outputs[0] as FakeNode;
    expect(panner.outputs[0]).toBe(audio.busNode('sfx'));
    expect((panner.outputs[1] as FakeGain).outputs).toEqual([target]);
    expect((panner.outputs[1] as FakeGain).gain.value).toBe(0.7);
  });

  it('is a no-op on the inert voice and on variations without buffers', async () => {
    const { audio } = setupEngine();
    const target = {} as AudioNode;
    expect(() => audio.play(fakeBuffer(1)).sendTo(target, 1)).not.toThrow();
    const empty = createVariations(audio, []);
    expect(() => empty.play().sendTo(target, 1)).not.toThrow();
    await audio.unlock();
    const steps = createVariations(audio, [fakeBuffer(0.2)]);
    expect(() => steps.play().sendTo(audio.busNode('ui')!, 1)).not.toThrow();
  });
});

describe('register', () => {
  it('puts an external voice on the books until unregistered', async () => {
    const { audio } = await running();
    const ext = fakeVoice();
    expect(audio.voiceCount).toBe(0);
    const off = audio.register(ext, 'sfx');
    expect(audio.voiceCount).toBe(1);
    expect(audio.voices('sfx')).toEqual([ext]);
    expect(audio.voices('music')).toEqual([]);
    audio.stopAll(0.2, 'music');
    expect(ext.stops).toEqual([]);
    audio.stopAll(0.2);
    expect(ext.stops).toEqual([0.2]);
    // Stopped: `playing` false hides it even before unregister.
    expect(audio.voiceCount).toBe(0);
    ext.playing = true;
    expect(audio.voiceCount).toBe(1);
    off();
    expect(audio.voiceCount).toBe(0);
    audio.stopAll();
    expect(ext.stops).toEqual([0.2]);
  });
});

describe('music stems as voices', () => {
  async function stems() {
    const { ctx, audio } = await running();
    const m = createMusic(audio, { bpm: 120 });
    m.add({ name: 'pad', buffer: fakeBuffer(2) });
    m.add({ name: 'low', buffer: fakeBuffer(2), layer: 'drums', intensity: [0, 0.5] });
    m.play('pad', { at: 'now' });
    m.play('low', { at: 'now' });
    return { ctx, audio, m };
  }

  it('appear on the music bus while playing and vanish on stop', async () => {
    const { ctx, audio, m } = await stems();
    expect(audio.voices('music')).toHaveLength(2);
    expect(audio.voiceCount).toBe(2);
    const [pad] = audio.voices('music');
    expect(pad!.playing).toBe(true);
    m.stop('pad', 0);
    expect(audio.voices('music')).toHaveLength(1);
    expect(pad!.playing).toBe(false);
    // The adapter writes the stem's nodes.
    const [low] = audio.voices('music');
    low!.setRate(0.5, 0);
    expect((ctx.played[1] as FakeSource).playbackRate.value).toBe(0.5);
    low!.setGain(0.25, 0);
    expect(m.gain('low')).toBe(0.25);
    low!.stop(0.5);
    expect((ctx.played[1] as FakeSource).stoppedAt).toBe(5.5);
    expect(audio.voices('music')).toEqual([]);
    expect(m.playing).toEqual([]);
  });

  it('stopAll stops them unless except: music; a stem can sendTo', async () => {
    const { ctx, audio, m } = await stems();
    const sfx = audio.play(fakeBuffer(1));
    audio.stopAll({ except: ['music'] });
    expect(sfx.playing).toBe(false);
    expect(m.playing).toEqual(['pad', 'low']);
    expect(audio.voices('music')).toHaveLength(2);
    const target = ctx.createGain();
    audio.voices('music')[0]!.sendTo(target as unknown as AudioNode, 1, 0);
    const padGain = (ctx.played[0] as FakeSource).gainNode;
    expect((padGain.outputs[1] as FakeGain).outputs).toEqual([target]);
    audio.stopAll(0.25);
    expect(m.playing).toEqual([]);
    expect(audio.voiceCount).toBe(0);
    expect((ctx.played[0] as FakeSource).stoppedAt).toBe(5.25);
    await settle();
    expect(padGain.outputs).toEqual([]);
    expect(target.outputs).toEqual([]);
  });
});

describe('pause and unpause', () => {
  it('ramps every bus but the kept ones to 0 and back to the exact settings', async () => {
    const { ctx, audio } = await running();
    audio.setVolume('sfx', 0.5);
    const sfx = param('sfx', audio);
    const music = param('music', audio);
    const ui = param('ui', audio);
    const master = param('master', audio);
    const uiBefore = ui.value;
    const masterBefore = master.value;
    expect(audio.paused).toBe(false);
    expect(audio.pausedBuses).toEqual([]);
    audio.pause();
    expect(audio.paused).toBe(true);
    expect(audio.pausedBuses).toEqual(['music', 'sfx']);
    expect(sfx.last).toEqual({ type: 'linear', value: 0, time: 5.05 });
    expect(music.last).toEqual({ type: 'linear', value: 0, time: 5.05 });
    expect(ui.value).toBe(uiBefore);
    expect(master.value).toBe(masterBefore);
    // Settings changed while paused wait for unpause.
    audio.setVolume('sfx', 0.3);
    expect(sfx.value).toBe(0);
    expect(audio.settings.sfx.volume).toBe(0.3);
    ctx.currentTime = 7;
    audio.unpause();
    expect(audio.paused).toBe(false);
    expect(audio.pausedBuses).toEqual([]);
    expect(sfx.last).toEqual({
      type: 'linear',
      value: busGain({ volume: 0.3, muted: false }),
      time: 7.05,
    });
    expect(music.last).toEqual({
      type: 'linear',
      value: busGain(audio.settings.music),
      time: 7.05,
    });
    expect(ui.value).toBe(uiBefore);
    // Idempotent.
    audio.unpause();
    expect(sfx.last!.time).toBe(7.05);
    // keep picks the buses.
    audio.pause({ keep: ['music', 'sfx'] });
    expect(audio.pausedBuses).toEqual(['ui']);
    expect(ui.last).toEqual({ type: 'linear', value: 0, time: 7.05 });
    audio.unpause();
  });

  it('freezes the affected voices and stems at rate 0 and restores the rates they had', async () => {
    const { ctx, audio } = await running();
    const sfx = audio.play(fakeBuffer(1), { rate: 1.5 });
    const click = audio.play(fakeBuffer(1), { bus: 'ui' });
    const m = createMusic(audio, { bpm: 120 });
    m.play({ name: 'pad', buffer: fakeBuffer(2) }, { at: 'now' });
    const stem = audio.voices('music')[0]!;
    stem.setRate(0.8, 0);
    const ext = fakeVoice('music');
    audio.register(ext, 'music');
    const [sfxSrc, uiSrc, padSrc] = ctx.played as FakeSource[];
    audio.pause();
    expect(audio.pausedRate).toBe(true);
    expect(sfxSrc!.playbackRate.last).toEqual({ type: 'linear', value: 0, time: 5.05 });
    expect(padSrc!.playbackRate.last).toEqual({ type: 'linear', value: 0, time: 5.05 });
    expect(uiSrc!.playbackRate.value).toBe(1);
    // A voice without a rate is only muted through its bus.
    expect(ext.rates).toEqual([]);
    // A rate set while frozen waits.
    sfx.setRate(2, 0);
    expect(sfxSrc!.playbackRate.value).toBe(0);
    // A voice started while paused starts frozen.
    const late = audio.play(fakeBuffer(1));
    const lateSrc = ctx.played[3]!;
    expect(lateSrc.playbackRate.value).toBe(0);
    expect(late.playing).toBe(true);
    ctx.currentTime = 9;
    audio.unpause();
    expect(audio.pausedRate).toBe(false);
    expect(sfxSrc!.playbackRate.last).toEqual({ type: 'linear', value: 2, time: 9.05 });
    expect(padSrc!.playbackRate.last).toEqual({ type: 'linear', value: 0.8, time: 9.05 });
    expect(lateSrc.playbackRate.last).toEqual({ type: 'linear', value: 1, time: 9.05 });
    expect(uiSrc!.playbackRate.events).toEqual([]);
    expect(click.playing).toBe(true);
  });

  it('only mutes where the context refuses rate 0, and says so', async () => {
    const { ctx, audio } = await running();
    audio.play(fakeBuffer(1));
    const src = ctx.played[0]!;
    src.playbackRate.minValue = 0.01;
    audio.pause();
    expect(audio.paused).toBe(true);
    expect(audio.pausedRate).toBe(false);
    expect(src.playbackRate.events).toEqual([]);
    expect(audio.busNode('sfx')!.gain.value).toBe(0);
    audio.unpause();
    expect(src.playbackRate.events).toEqual([]);
  });

  it('is safe before unlock: paused buses are built silent and unpause restores them', async () => {
    const { audio } = setupEngine();
    audio.pause();
    expect(audio.paused).toBe(true);
    await audio.unlock();
    expect(audio.busNode('sfx')!.gain.value).toBe(0);
    expect(audio.busNode('ui')!.gain.value).toBe(busGain(audio.settings.ui));
    audio.unpause();
    expect(param('sfx', audio).last!.value).toBe(busGain(audio.settings.sfx));
  });
});
