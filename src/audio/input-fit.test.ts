// ws/ui-input-fit (Forge's D5b asks): the public fake follows iOS's gesture rule, a layered sound's
// parts cut their envelopes from its one shape, and voices carry their sound's name.
import { describe, expect, it } from 'vitest';
import { createFakeAudioContext } from '../testing/fake-audio';
import { AudioEngine } from './audio';
import { type Envelope, envelopeValueAt, envelopeWindow } from './envelope';

const BUF = { duration: 1, length: 48000, sampleRate: 48000 } as unknown as AudioBuffer;

describe('the fake context on iOS', () => {
  it('refuses resume outside a gesture; the first gesture unlocks, with the silent buffer', async () => {
    const ctx = createFakeAudioContext({ ios: true });
    const audio = new AudioEngine({ createContext: () => ctx.asAudioContext() });
    // A timer's unlock (no gesture): refused, still locked.
    expect(await audio.unlock()).toBe(false);
    expect(ctx.refused).toBe(1);
    expect(ctx.silentStarts).toBe(0);
    expect(audio.play(BUF).playing).toBe(false);
    // A tap: resume is called inside the handler, so it takes.
    const ok = await ctx.inGesture(() => audio.unlock());
    expect(ok).toBe(true);
    expect(ctx.state).toBe('running');
    expect(ctx.silentStarts).toBe(1);
    expect(audio.play(BUF).playing).toBe(true);
    // A call takes the audio away; outside a gesture it can't come back.
    ctx.setState('interrupted');
    await audio.unlock();
    expect(ctx.state).toBe('interrupted');
    await ctx.inGesture(() => audio.unlock());
    expect(ctx.state).toBe('running');
  });

  it('is unchanged without `ios`: resume always takes', async () => {
    const ctx = createFakeAudioContext();
    const audio = new AudioEngine({ createContext: () => ctx.asAudioContext() });
    expect(await audio.unlock()).toBe(true);
    expect(ctx.refused).toBe(0);
    expect(ctx.resumes).toBe(1);
  });
});

describe('envelopeWindow', () => {
  const env: Envelope = { attack: 0.01, decay: 0.2, sustain: 0.25, release: 0.1, curve: 'exp' };
  const shape = { env, gate: 0.5, peak: 0.8 };

  it('a part from the start for the whole sound is the shape itself', () => {
    const w = envelopeWindow(shape, 0, 1);
    expect(w.level).toBe(0.8);
    expect(w.gate).toBe(0.5);
    expect(w.env).toMatchObject({ attack: 0.01, decay: 0.2, sustain: 0.25, release: 0.1 });
  });

  it('a part entering mid-decay starts at the shape’s level and falls to its sustain on time', () => {
    const w = envelopeWindow(shape, 0.11, 1);
    const at = envelopeValueAt(env, 0.11, 0.5) * 0.8;
    expect(w.level).toBeCloseTo(at, 6);
    expect(w.env.decay).toBeCloseTo(0.1, 9);
    expect(w.level * w.env.sustain).toBeCloseTo(0.25 * 0.8, 6);
    expect(w.gate).toBeCloseTo(0.39, 9);
    // Where the shape is, the part is (the 1 ms attack aside).
    for (const t of [0.05, 0.08, 0.2, 0.3]) {
      const part = envelopeValueAt(w.env, t, w.gate) * w.level;
      expect(part).toBeCloseTo(envelopeValueAt(env, 0.11 + t, 0.5) * 0.8, 2);
    }
  });

  it('a part closing before the gate stops quickly; one after it plays the rest of the release', () => {
    const early = envelopeWindow(shape, 0, 0.05);
    expect(early.gate).toBe(0.05);
    expect(early.env.release).toBe(0.006);
    const late = envelopeWindow(shape, 0.55, 1);
    expect(late.level).toBeCloseTo(envelopeValueAt(env, 0.55, 0.5) * 0.8, 6);
    expect(late.env.release).toBeCloseTo(0.05, 9);
    expect(late.gate).toBe(0.001);
  });

  it('`at` moves the shape into the sound', () => {
    const a = envelopeWindow({ ...shape, at: 0.1 }, 0.21, 1);
    const b = envelopeWindow(shape, 0.11, 1);
    expect(a.level).toBeCloseTo(b.level, 9);
    expect(a.gate).toBeCloseTo(b.gate, 9);
    expect(a.env.decay).toBeCloseTo(b.env.decay, 9);
    expect(a.env.sustain).toBeCloseTo(b.env.sustain, 9);
  });
});

describe('a voice’s sound name', () => {
  it('names its voices and hushes one sound’s (a sheet’s clips with it)', async () => {
    const ctx = createFakeAudioContext();
    const audio = new AudioEngine({ createContext: () => ctx.asAudioContext() });
    await audio.unlock();
    audio.define('creak', async () => BUF);
    audio.define('step', async () => BUF);
    audio.defineSprites('ui', { buffer: BUF, sprites: { click: [0, 100], pop: [200, 100] } });
    const a = audio.play('creak');
    const b = audio.play('creak');
    const c = audio.play('step');
    const d = audio.play('ui#click');
    const e = audio.play(BUF);
    expect([a.sound, c.sound, d.sound, e.sound]).toEqual(['creak', 'step', 'ui#click', null]);
    expect(audio.stopSound('creak', 0.05)).toBe(2);
    expect([a.playing, b.playing, c.playing]).toEqual([false, false, true]);
    expect(audio.stopSound('cre')).toBe(0);
    expect(audio.stopSound('ui')).toBe(1);
    expect(d.playing).toBe(false);
    expect(audio.voices().length).toBe(2);
  });
});
