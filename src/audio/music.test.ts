import { describe, expect, it, vi } from 'vitest';
import { fakeBuffer, setupEngine } from './fake-context.test-util';
import { createMusic, intensityGains } from './music';

// 120 bpm, 4/4: a beat is 0.5 s, a bar 2 s.
async function music(opts: Partial<Parameters<typeof createMusic>[1]> = {}) {
  const { ctx, audio } = setupEngine();
  await audio.unlock();
  ctx.currentTime = 10;
  const m = createMusic(audio, { bpm: 120, ...opts });
  return { ctx, audio, m };
}

describe('intensityGains', () => {
  const ranges = [
    [0, 0.3],
    [0.3, 0.6],
    [0.7, 1],
  ] as const;

  it('sums to 1 at every level, plateaus inside a range, crossfades between', () => {
    const out: number[] = [];
    for (let x = 0; x <= 1.0001; x += 0.05) {
      intensityGains(ranges, x, out);
      expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
    expect(intensityGains(ranges, 0.1, out)).toEqual([1, 0, 0]);
    expect(intensityGains(ranges, 0.45, out)).toEqual([0, 1, 0]);
    expect(intensityGains(ranges, 0.9, out)).toEqual([0, 0, 1]);
    // Touching ranges: a hard switch at the boundary.
    expect(intensityGains(ranges, 0.3, out)).toEqual([0, 1, 0]);
    // A gap between 0.6 and 0.7 crossfades across it.
    intensityGains(ranges, 0.65, out);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(0.5);
  });

  it('handles overlapping ranges, one stem, none, and clamps the level', () => {
    const out: number[] = [];
    const overlap = [
      [0, 0.6],
      [0.4, 1],
    ] as const;
    intensityGains(overlap, 0.5, out);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.5);
    intensityGains(overlap, 0.55, out);
    expect(out[0]).toBeCloseTo(0.25);
    expect(intensityGains([[0.2, 0.8]], 5, out)).toEqual([1]);
    expect(intensityGains([], 0.5, out)).toEqual([]);
    expect(intensityGains(overlap, -1, out)).toEqual([1, 0]);
  });
});

describe('createMusic', () => {
  it('starts a stem on the next bar, offset into the loop so it stays in phase', async () => {
    const { ctx, m } = await music();
    m.add({ name: 'pad', buffer: fakeBuffer(4) });
    // The grid starts at the first play (t = 10); 0.7 s later the next bar is at 12.
    m.play('pad', { at: 'now' });
    ctx.currentTime = 10.7;
    m.add({ name: 'drums', buffer: fakeBuffer(2) });
    m.play('drums');
    const [pad, drums] = ctx.played;
    expect(pad!.startedAt).toBe(10);
    expect(pad!.offset).toBe(0);
    expect(pad!.loop).toBe(true);
    expect(drums!.startedAt).toBe(12);
    // 2 s into the grid, a 2 s loop is back at its head.
    expect(drums!.offset).toBeCloseTo(0);
    ctx.currentTime = 13.2;
    m.add({ name: 'lead', buffer: fakeBuffer(4) });
    m.play('lead', { at: 'beat' });
    const lead = ctx.played[2]!;
    expect(lead.startedAt).toBeCloseTo(13.5);
    expect(lead.offset).toBeCloseTo(3.5);
    expect(m.nextBeatTime()).toBeCloseTo(13.5);
    expect(m.nextBarTime()).toBeCloseTo(14);
    expect(m.playing).toEqual(['pad', 'drums', 'lead']);
  });

  it('advances beat and bar from the clock and fires onBeat once per beat', async () => {
    const { ctx, m } = await music();
    const beats: [number, number][] = [];
    m.onBeat((b, bar) => beats.push([b, bar]));
    m.update(1 / 60);
    expect(m.beat).toBe(0);
    expect(m.bar).toBe(0);
    expect(beats).toEqual([[0, 0]]);
    ctx.currentTime = 10.49;
    m.update(1 / 60);
    expect(beats.length).toBe(1);
    ctx.currentTime = 10.51;
    m.update(1 / 60);
    expect(beats.at(-1)).toEqual([1, 0]);
    // A long frame crosses several beats: every one fires, none twice.
    ctx.currentTime = 12.6;
    m.update(2);
    expect(beats).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(m.beat).toBe(1);
    expect(m.bar).toBe(1);
    expect(m.totalBeats).toBe(5);
    expect(m.beatDuration).toBe(0.5);
  });

  it('crossfades intensity-ranged stems in a layer so the gains sum to 1', async () => {
    const { ctx, m } = await music({ intensityFadeBeats: 2 });
    m.add({ name: 'low', buffer: fakeBuffer(2), layer: 'drums', intensity: [0, 0.5] });
    m.add({ name: 'high', buffer: fakeBuffer(2), layer: 'drums', intensity: [0.5, 1] });
    m.play('low', { at: 'now' });
    m.play('high', { at: 'now' });
    expect(m.gain('low')).toBe(1);
    expect(m.gain('high')).toBe(0);
    m.setIntensity(1);
    expect(m.gain('low')).toBe(0);
    expect(m.gain('high')).toBe(1);
    const [low, high] = ctx.played;
    // Linear ramps over 2 beats = 1 s.
    expect(high!.gainNode.gain.last).toEqual({ type: 'linear', value: 1, time: 11 });
    expect(low!.gainNode.gain.last).toEqual({ type: 'linear', value: 0, time: 11 });
    for (const x of [0.25, 0.5, 0.75]) {
      m.setIntensity(x);
      expect(m.gain('low') + m.gain('high')).toBeCloseTo(1);
    }
    expect(m.intensity).toBe(0.75);
  });

  it("a rangeless stem replaces the layer's other one with a crossfade in beats", async () => {
    const { ctx, m } = await music();
    m.add({ name: 'calm', buffer: fakeBuffer(2), layer: 'theme' });
    m.add({ name: 'tense', buffer: fakeBuffer(2), layer: 'theme' });
    m.play('calm', { at: 'now' });
    ctx.currentTime = 11;
    m.play('tense', { at: 'bar', fadeBeats: 2 });
    const [calm, tense] = ctx.played;
    expect(tense!.startedAt).toBe(12);
    expect(tense!.gainNode.gain.events).toContainEqual({ type: 'set', value: 0, time: 12 });
    expect(tense!.gainNode.gain.last).toEqual({ type: 'linear', value: 1, time: 13 });
    expect(calm!.gainNode.gain.last).toEqual({ type: 'linear', value: 0, time: 13 });
    expect(calm!.stoppedAt).toBe(13);
    expect(m.playing).toEqual(['tense']);
    expect(m.gain('calm')).toBe(0);
  });

  it('stop fades a layer or everything; dispose cuts at once', async () => {
    const { ctx, m } = await music();
    m.add({ name: 'a', buffer: fakeBuffer(2), layer: 'x' });
    m.add({ name: 'b', buffer: fakeBuffer(2), layer: 'y' });
    m.play('a', { at: 'now' });
    m.play('b', { at: 'now' });
    ctx.currentTime = 11;
    m.stop('x', 4);
    const [a, b] = ctx.played;
    expect(a!.stoppedAt).toBe(13);
    expect(b!.stoppedAt).toBeNull();
    expect(m.playing).toEqual(['b']);
    m.dispose();
    expect(b!.stoppedAt).toBe(11);
    expect(m.playing).toEqual([]);
  });

  it('queues plays made before unlock and starts them when the context runs', async () => {
    const { ctx, audio } = setupEngine();
    const m = createMusic(audio, { bpm: 120 });
    m.add({ name: 'pad', buffer: fakeBuffer(2) });
    m.play('pad');
    expect(m.beat).toBe(0);
    m.update(1 / 60);
    expect(ctx.played.length).toBe(0);
    await audio.unlock();
    expect(ctx.played.length).toBe(1);
    expect(ctx.played[0]!.startedAt).toBe(0);
    expect(m.playing).toEqual(['pad']);
  });

  it('warns on an unknown stem and takes a stem object on the fly', async () => {
    const { ctx, m } = await music();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.play('nope');
    expect(warn).toHaveBeenCalledOnce();
    m.play({ name: 'inline', buffer: fakeBuffer(2) }, { at: 'now', gain: 0.5 });
    expect(ctx.played.length).toBe(1);
    expect(m.gain('inline')).toBe(0.5);
    warn.mockRestore();
  });
});
