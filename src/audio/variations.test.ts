import { describe, expect, it } from 'vitest';
import { fakeBuffer, setupEngine } from './fake-context.test-util';
import { createVariations } from './variations';

const buffers = [fakeBuffer(0.2), fakeBuffer(0.3), fakeBuffer(0.4)];

/** A deterministic sequence in [0, 1). */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('createVariations', () => {
  it('never plays the same buffer twice in a row and stays uniform over the rest', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    // A random source that would pick index 0 every time if repeats were allowed.
    const v = createVariations(audio, buffers, { random: () => 0 });
    expect(v.last).toBe(-1);
    expect(v.count).toBe(3);
    v.play();
    expect(v.last).toBe(0);
    v.play();
    expect(v.last).toBe(1);
    v.play();
    expect(v.last).toBe(0);
    // Many plays with a pseudo-random source: no immediate repeat, every index reached.
    let x = 7;
    const lcg = () => {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      return x / 2 ** 31;
    };
    const w = createVariations(audio, buffers, { random: lcg });
    const seen = new Set<number>();
    let prev = -1;
    for (let i = 0; i < 200; i++) {
      w.play();
      expect(w.last).not.toBe(prev);
      prev = w.last;
      seen.add(w.last);
    }
    expect(seen.size).toBe(3);
    expect(ctx.played.length).toBe(203);
    expect(ctx.played[0]!.buffer).toBe(buffers[0]);
    expect(ctx.played[1]!.buffer).toBe(buffers[1]);
  });

  it('noRepeat false allows repeats; one buffer always plays', async () => {
    const { audio } = setupEngine();
    await audio.unlock();
    const v = createVariations(audio, buffers, { random: () => 0, noRepeat: false });
    v.play();
    v.play();
    expect(v.last).toBe(0);
    const one = createVariations(audio, [buffers[0]!], { random: () => 0.99 });
    one.play();
    one.play();
    expect(one.last).toBe(0);
  });

  it("applies pitch jitter in semitones and gain jitter in dB, on top of the caller's", async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    // pick → 0 (index 0), pitch → 1 (+12 st), gain → 0 (-6 dB).
    const v = createVariations(audio, buffers, {
      pitchJitter: 12,
      gainJitter: 6,
      random: seq([0, 1, 0]),
    });
    const voice = v.play({ rate: 0.5, gain: 2 });
    expect(voice.playing).toBe(true);
    const src = ctx.played[0]!;
    expect(src.playbackRate.value).toBeCloseTo(1);
    expect(src.gainNode.gain.value).toBeCloseTo(2 * 10 ** (-6 / 20));
    // Default bus is sfx; the caller's bus wins.
    expect(src.gainNode.outputs[0]).toBe(audio.busNode('sfx'));
    v.play({ bus: 'ui' });
    expect(ctx.played[1]!.gainNode.outputs[0]).toBe(audio.busNode('ui'));
  });

  it('is inert while the mixer is locked or with no buffers', () => {
    const { ctx, audio } = setupEngine();
    const v = createVariations(audio, buffers);
    expect(v.play().playing).toBe(false);
    expect(ctx.played.length).toBe(0);
    const none = createVariations(audio, []);
    expect(none.play().playing).toBe(false);
    expect(none.last).toBe(-1);
  });
});
