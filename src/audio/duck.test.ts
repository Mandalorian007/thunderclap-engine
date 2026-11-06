import { describe, expect, it } from 'vitest';
import { busGain } from './audio';
import { createDucker } from './duck';
import { type FakeGain, fakeBuffer, setupEngine } from './fake-context.test-util';

const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe('createDucker', () => {
  it('ducks the target while a watched voice plays, with a linear attack and release', async () => {
    const { audio } = setupEngine();
    await audio.unlock();
    const music = audio.busNode('music') as unknown as FakeGain;
    const base = busGain(audio.settings.music);
    const d = createDucker(audio, {
      trigger: 'ui',
      target: 'music',
      amount: 0.5,
      attack: 0.1,
      release: 0.4,
    });
    d.update(1 / 60);
    expect(d.active).toBe(false);
    expect(d.level).toBe(0);
    expect(d.gain).toBe(1);
    expect(music.gain.value).toBeCloseTo(base);

    const voice = d.watch(audio.play(fakeBuffer(1), { bus: 'ui' }));
    expect(voice.playing).toBe(true);
    d.update(0.05);
    expect(d.active).toBe(true);
    expect(d.level).toBeCloseTo(0.5);
    expect(d.gain).toBeCloseTo(0.75);
    expect(music.gain.value).toBeCloseTo(base * 0.75);
    d.update(0.05);
    expect(d.level).toBe(1);
    expect(music.gain.value).toBeCloseTo(base * 0.5);
    d.update(1);
    expect(d.level).toBe(1);

    voice.stop();
    await tick();
    d.update(0.1);
    expect(d.active).toBe(false);
    expect(d.level).toBeCloseTo(0.75);
    expect(music.gain.value).toBeCloseTo(base * (1 - 0.5 * 0.75));
    d.update(0.3);
    expect(d.level).toBe(0);
    expect(music.gain.value).toBeCloseTo(base);
    d.update(1);
    expect(d.level).toBe(0);
  });

  it('keeps following the mixer volume and restores it on dispose', async () => {
    const { audio } = setupEngine();
    await audio.unlock();
    const music = audio.busNode('music') as unknown as FakeGain;
    const d = createDucker(audio, { trigger: 'ui', target: 'music', amount: 1, attack: 0.01 });
    d.watch(audio.play(fakeBuffer(1), { bus: 'ui' }));
    d.update(0.02);
    expect(music.gain.value).toBe(0);
    audio.setVolume('music', 0.5);
    // The mixer wrote 0.25; the ducker put the duck back on top.
    expect(music.gain.value).toBe(0);
    d.dispose();
    expect(music.gain.value).toBeCloseTo(0.25);
    d.update(1);
    expect(d.active).toBe(false);
    expect(music.gain.value).toBeCloseTo(0.25);
  });

  it('sidechain: an analyser on the trigger bus above threshold counts as active', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    const d = createDucker(audio, {
      trigger: 'sfx',
      target: 'music',
      threshold: -20,
      attack: 0.01,
    });
    d.update(0.02);
    expect(ctx.analysers.length).toBe(1);
    expect(d.active).toBe(false);
    ctx.analysers[0]!.level = 0.5; // -6 dB
    d.update(0.02);
    expect(d.active).toBe(true);
    expect(d.level).toBe(1);
    ctx.analysers[0]!.level = 0.01; // -40 dB
    d.update(0.02);
    expect(d.active).toBe(false);
  });

  it('does nothing before unlock and starts working after it', async () => {
    const { ctx, audio } = setupEngine();
    const d = createDucker(audio, { trigger: 'ui', target: 'music' });
    d.update(1 / 60);
    expect(d.active).toBe(false);
    await audio.unlock();
    ctx.currentTime = 1;
    d.watch(audio.play(fakeBuffer(1), { bus: 'ui' }));
    d.update(1);
    expect(d.level).toBe(1);
    expect((audio.busNode('music') as unknown as FakeGain).gain.last?.type).toBe('target');
  });

  describe('with pause and background', () => {
    const opts = { trigger: 'ui', target: 'music', amount: 0.5, attack: 0.1 } as const;

    it('paused music stays at 0 while a line is spoken', async () => {
      const { audio } = setupEngine();
      await audio.unlock();
      const music = audio.busNode('music') as unknown as FakeGain;
      const d = createDucker(audio, opts);
      d.update(1 / 60);
      audio.pause();
      expect(music.gain.value).toBe(0);
      const writes = music.gain.events.length;
      // The line is on `ui`, which pause keeps.
      d.watch(audio.play(fakeBuffer(1), { bus: 'ui' }));
      for (let i = 0; i < 10; i++) d.update(0.02);
      expect(d.level).toBe(1);
      expect(music.gain.value).toBe(0);
      expect(music.gain.events.length).toBe(writes);
    });

    it('a boot write after a pause keeps 0', async () => {
      // Paused between unlock and the ducker's first update (the music.spec ?pause order).
      const { audio } = setupEngine();
      const d = createDucker(audio, opts);
      await audio.unlock();
      audio.pause();
      d.update(1 / 60);
      expect((audio.busNode('music') as unknown as FakeGain).gain.value).toBe(0);

      // Paused and ducked before the context exists: the bus is born silent.
      const late = setupEngine().audio;
      const d2 = createDucker(late, opts);
      late.pause();
      d2.update(1 / 60);
      await late.unlock();
      d2.update(1 / 60);
      expect((late.busNode('music') as unknown as FakeGain).gain.value).toBe(0);
    });

    it('resume lands on the ducked gain, not the raw one', async () => {
      const { audio } = setupEngine();
      await audio.unlock();
      const music = audio.busNode('music') as unknown as FakeGain;
      const base = busGain(audio.settings.music);
      const d = createDucker(audio, opts);
      audio.pause();
      d.watch(audio.play(fakeBuffer(1), { bus: 'ui' }));
      d.update(0.2);
      expect(d.gain).toBeCloseTo(0.5);
      audio.unpause();
      expect(music.gain.value).toBeCloseTo(base * 0.5);
      expect(music.gain.last?.type).toBe('linear');
    });

    it('holds bus writes in the background and lands on the ducked gain on return', async () => {
      const { audio } = setupEngine();
      await audio.unlock();
      const music = audio.busNode('music') as unknown as FakeGain;
      const base = busGain(audio.settings.music);
      const d = createDucker(audio, opts);
      d.update(1 / 60);
      audio.background(true);
      const writes = music.gain.events.length;
      d.watch(audio.play(fakeBuffer(1), { bus: 'ui' }));
      d.update(0.2);
      audio.setVolume('music', 0.5);
      expect(music.gain.events.length).toBe(writes);
      audio.background(false);
      expect(music.gain.value).toBeCloseTo(busGain(audio.settings.music) * 0.5);
      expect(busGain(audio.settings.music)).toBeLessThan(base);
    });

    it('unpause in the background waits for the return', async () => {
      const { audio } = setupEngine();
      await audio.unlock();
      const music = audio.busNode('music') as unknown as FakeGain;
      const d = createDucker(audio, opts);
      audio.pause();
      d.watch(audio.play(fakeBuffer(1), { bus: 'ui' }));
      d.update(0.2);
      audio.background(true);
      audio.unpause();
      expect(music.gain.value).toBe(0);
      audio.background(false);
      expect(music.gain.value).toBeCloseTo(busGain(audio.settings.music) * 0.5);
    });
  });
});

describe('AudioEngine.setBusScale', () => {
  it('multiplies the settings gain, composes with setVolume and clamps', async () => {
    const { audio } = setupEngine();
    audio.setBusScale('sfx', 0.5);
    expect(audio.busScale('sfx')).toBe(0.5);
    await audio.unlock();
    const sfx = audio.busNode('sfx') as unknown as FakeGain;
    // Built at the scale set before the context existed.
    expect(sfx.gain.value).toBeCloseTo(busGain(audio.settings.sfx) * 0.5);
    audio.setVolume('sfx', 0.4);
    expect(sfx.gain.value).toBeCloseTo(busGain(audio.settings.sfx) * 0.5);
    audio.setBusScale('sfx', 2);
    expect(audio.busScale('sfx')).toBe(1);
    audio.setBusScale('sfx', Number.NaN);
    expect(audio.busScale('sfx')).toBe(1);
    expect(sfx.gain.value).toBeCloseTo(busGain(audio.settings.sfx));
  });

  it('Voice.doppler is on the interface: 1 on an inert voice', () => {
    const { audio } = setupEngine();
    expect(audio.play(fakeBuffer(1)).doppler).toBe(1);
  });
});
