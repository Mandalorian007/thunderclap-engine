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
});
