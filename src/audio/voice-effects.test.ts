/** ws/audio-4: Doppler, per-voice filters, the voice adapter, `background` and follow skipping. */
import { describe, expect, it, vi } from 'vitest';
import { Transform } from '../render/transform';
import { createVoiceAdapter, SPEED_OF_SOUND } from './audio';
import { FakeGain, fakeBuffer, setupEngine, setupSpatialEngine } from './fake-context.test-util';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Doppler', () => {
  it('an emitter approaching at 10 m/s raises the rate by the textbook ratio', async () => {
    const { ctx, audio } = setupSpatialEngine();
    await audio.unlock();
    const v = audio.loop(fakeBuffer(1), { at: [-20, 0, 0], spatial: { doppler: 1 } });
    const src = ctx.played[0]!;
    audio.update(0.1); // first update: no previous position, rate untouched
    expect(src.playbackRate.last).toBeUndefined();
    v.setPosition(-19, 0, 0);
    audio.update(0.1);
    const want = SPEED_OF_SOUND / (SPEED_OF_SOUND - 10);
    expect(src.playbackRate.last!.type).toBe('target');
    expect(src.playbackRate.last!.value).toBeCloseTo(want, 6);
    // Receding: below 1. A moving listener counts too.
    v.setPosition(-20, 0, 0);
    audio.update(0.1);
    expect(src.playbackRate.last!.value).toBeCloseTo(SPEED_OF_SOUND / (SPEED_OF_SOUND + 10), 6);
    audio.listener.set([-1, 0, 0], [0, 0, -1]);
    audio.update(0.1);
    expect(Array.from(audio.listener.velocity)).toEqual([-10, 0, 0]);
    expect(src.playbackRate.last!.value).toBeCloseTo((SPEED_OF_SOUND + 10) / SPEED_OF_SOUND, 6);
  });

  it('setRate multiplies with the shift; a teleport leaves the rate at the setRate value', async () => {
    const { ctx, audio } = setupSpatialEngine();
    await audio.unlock();
    const v = audio.loop(fakeBuffer(1), { at: [-20, 0, 0], spatial: { doppler: 1 } });
    const src = ctx.played[0]!;
    audio.update(0.1);
    v.setPosition(-19, 0, 0);
    audio.update(0.1);
    v.setRate(1.5, 0);
    expect(src.playbackRate.last!.value).toBeCloseTo(
      1.5 * (SPEED_OF_SOUND / (SPEED_OF_SOUND - 10)),
      6,
    );
    v.setPosition(40, 0, 0); // 590 m/s in 0.1 s: a teleport
    audio.update(0.1);
    expect(src.playbackRate.last!.value).toBe(1.5);
    // Doppler off: a plain spatial voice never writes the rate from update.
    const flat = audio.loop(fakeBuffer(1), { at: [0, 0, 5] });
    const fs = ctx.played[1]!;
    audio.update(0.1);
    flat.setPosition(0, 0, 4);
    audio.update(0.1);
    expect(fs.playbackRate.last).toBeUndefined();
  });
});

describe('Voice.filter', () => {
  it('inserts one pooled biquad between the gain and the panner, retunes, removes and reuses it', async () => {
    const { ctx, audio } = setupSpatialEngine();
    await audio.unlock();
    ctx.currentTime = 1;
    const before = ctx.biquads.length;
    const v = audio.loop(fakeBuffer(1), { at: [1, 0, 0] });
    const src = ctx.played[0]!;
    const g = src.gainNode;
    const panner = ctx.panners[0]!;
    expect(g.outputs[0]).toBe(panner);
    const busIn = panner.outputs[0]!;
    v.filter('highpass', { cutoff: 200, q: 2 });
    const f = ctx.biquads.at(-1)!;
    expect(ctx.biquads.length).toBe(before + 1);
    expect(f.type).toBe('highpass');
    expect(f.frequency.value).toBe(200);
    expect(f.Q.value).toBe(2);
    expect(g.outputs).toEqual([f]);
    expect(f.outputs).toEqual([panner]);
    expect(panner.outputs).toEqual([busIn]);
    // Retune ramps in place, no new node.
    v.filter('lowpass', { cutoff: 1500, ramp: 0.2 });
    expect(ctx.biquads.length).toBe(before + 1);
    expect(f.type).toBe('lowpass');
    expect(f.frequency.last).toEqual({ type: 'linear', value: 1500, time: 1.2 });
    // Sends tap the tail (the panner), after the filter.
    const target = new FakeGain();
    v.sendTo(target as unknown as AudioNode, 0.5);
    expect(v.sendCount).toBe(1);
    expect(panner.outputs.some((n) => n.outputs[0] === target)).toBe(true);
    // Removing it restores gain → panner and pools the node.
    v.filter(null);
    expect(g.outputs).toEqual([panner]);
    expect(audio.pooledFilters).toBe(1);
    expect(panner.outputs.some((n) => n.outputs[0] === target)).toBe(true);
    // The next filter reuses it.
    v.filter('bandpass', { cutoff: 800 });
    expect(ctx.biquads.length).toBe(before + 1);
    expect(audio.pooledFilters).toBe(0);
  });

  it('a filter set before start is applied at start; occluded + filtered is two nodes in order', async () => {
    const { ctx, audio } = setupSpatialEngine();
    await audio.unlock();
    audio.occlusion = {
      probe: (_l, _e, out) => {
        out.amount = 1;
      },
    };
    let release: (b: AudioBuffer) => void = () => {};
    audio.define('late', () => new Promise<AudioBuffer>((r) => (release = r)));
    const v = audio.loop('late', { at: [1, 0, 0] });
    v.filter('highpass', { cutoff: 300 });
    expect(ctx.biquads).toHaveLength(0);
    release(fakeBuffer(1));
    await tick();
    const src = ctx.played[0]!;
    const user = ctx.biquads[0]!;
    expect(user.type).toBe('highpass');
    expect(src.gainNode.outputs).toEqual([user]);
    audio.update(1 / 60);
    const occ = ctx.biquads[1]!;
    expect(occ.type).toBe('lowpass');
    expect(src.gainNode.outputs).toEqual([user]);
    expect(user.outputs).toEqual([occ]);
    expect(occ.outputs).toEqual([ctx.panners[0]]);
    v.stop();
    await tick();
    expect(audio.pooledFilters).toBe(2);
  });

  it('a non-spatial voice filters between its gain and the bus', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    const v = audio.play(fakeBuffer(1), { bus: 'ui' });
    v.filter('lowpass', { cutoff: 900 });
    const src = ctx.played[0]!;
    const f = ctx.biquads.at(-1)!;
    expect(src.gainNode.outputs).toEqual([f]);
    expect(f.outputs).toEqual([audio.busNode('ui')]);
  });
});

describe('createVoiceAdapter', () => {
  it('wraps a raw source as a registered voice with stop, gain, rate, sends and filter', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    ctx.currentTime = 3;
    const source = ctx.createBufferSource();
    let ended = 0;
    const v = createVoiceAdapter(audio as never, {
      source: source as unknown as AudioNode,
      bus: 'music',
      gain: 0.5,
      onEnd: () => ended++,
    });
    expect(v.playing).toBe(true);
    expect(v.sendCount).toBe(0);
    expect(v.occlusion).toBe(0);
    expect(audio.voices('music')).toEqual([v]);
    const g = source.gainNode;
    expect(g.gain.value).toBe(0.5);
    expect(g.outputs).toEqual([audio.busNode('music')]);
    v.setGain(0.25, 0.3);
    expect(g.gain.last).toMatchObject({ type: 'target', value: 0.25 });
    v.setRate(0.5, 0);
    expect(v.rate).toBe(0.5);
    expect(source.playbackRate.last).toMatchObject({ value: 0.5 });
    v.filter('lowpass', { cutoff: 400 });
    const f = ctx.biquads.at(-1)!;
    expect(g.outputs).toEqual([f]);
    expect(f.outputs).toEqual([audio.busNode('music')]);
    const target = new FakeGain();
    v.sendTo(target as unknown as AudioNode, 0.7);
    expect(v.sendCount).toBe(1);
    expect(f.outputs.some((n) => n.outputs[0] === target)).toBe(true);
    // pause freezes it like any registered voice, unpause restores the rate.
    audio.pause();
    expect(source.playbackRate.last).toMatchObject({ value: 0 });
    audio.unpause();
    expect(source.playbackRate.last).toMatchObject({ value: 0.5 });
    v.stop(0.5);
    expect(g.gain.last).toEqual({ type: 'linear', value: 0, time: 3.5 });
    expect(source.stoppedAt).toBe(3.5);
    expect(audio.voices('music')).toEqual([]);
    await tick();
    expect(ended).toBe(1);
    expect(v.playing).toBe(false);
    expect(audio.pooledFilters).toBe(1);
    expect(g.outputs).toEqual([]);
  });

  it('a source without stop is disconnected after the fade; no context gives an inert voice', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, audio } = setupEngine();
      await audio.unlock();
      const source = ctx.createGain();
      const v = createVoiceAdapter(audio as never, { source: source as unknown as AudioNode });
      expect(audio.voices('sfx')).toEqual([v]);
      v.stop(0.2);
      expect(v.playing).toBe(true);
      vi.advanceTimersByTime(250);
      expect(v.playing).toBe(false);
      expect(source.outputs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    const { audio: locked } = setupEngine();
    const inert = createVoiceAdapter(locked as never, {
      source: new FakeGain() as unknown as AudioNode,
    });
    expect(inert.playing).toBe(false);
    expect(inert.gainNode).toBeNull();
    inert.stop();
    inert.filter('lowpass');
  });
});

describe('audio.background', () => {
  it('suspends while hidden and restores the user state, which suspend() keeps', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    expect(ctx.state).toBe('running');
    audio.background(true);
    await tick();
    expect(ctx.state).toBe('suspended');
    expect(audio.inBackground).toBe(true);
    audio.background(false);
    await tick();
    expect(ctx.state).toBe('running');
    // A user suspend outlives a background round trip.
    await audio.suspend();
    expect(ctx.state).toBe('suspended');
    audio.background(true);
    await tick();
    audio.background(false);
    await tick();
    expect(ctx.state).toBe('suspended');
    await audio.resume();
    expect(ctx.state).toBe('running');
    // pause() is a different state: a hidden page does not unpause.
    audio.pause();
    audio.background(true);
    await tick();
    audio.background(false);
    await tick();
    expect(ctx.state).toBe('running');
    expect(audio.paused).toBe(true);
  });
});

describe('Voice.follow and Transform.changed', () => {
  it('a follower under a parked transform reads it once, then only when it changes', async () => {
    const { audio } = setupSpatialEngine();
    await audio.unlock();
    const t = new Transform({ x: 1, y: 2, z: 3 });
    const v = audio.loop(fakeBuffer(1), { at: [0, 0, 0] });
    const spy = vi.spyOn(v, 'setPosition');
    v.follow(t);
    audio.update(1 / 60);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(Array.from(v.position)).toEqual([1, 2, 3]);
    for (let i = 0; i < 10; i++) audio.update(1 / 60);
    expect(spy).toHaveBeenCalledTimes(1);
    t.setPosition(4, 5, 6);
    audio.update(1 / 60);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(Array.from(v.position)).toEqual([4, 5, 6]);
    // A parent's move counts.
    const parent = new Transform({ x: 10 });
    t.parent = parent;
    audio.update(1 / 60);
    expect(spy).toHaveBeenCalledTimes(3);
    parent.setPosition(20, 0, 0);
    audio.update(1 / 60);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(v.position[0]).toBe(24);
    // A plain matrix without a counter is read every update.
    const m = new Float32Array([1, 0, 0, 7, 0, 1, 0, 8, 0, 0, 1, 9]);
    v.follow({ world: m });
    audio.update(1 / 60);
    audio.update(1 / 60);
    expect(spy).toHaveBeenCalledTimes(6);
  });
});
