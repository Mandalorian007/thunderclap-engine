import { describe, expect, it } from 'vitest';
import type { FakeBiquad } from './fake-context.test-util';
import { fakeBuffer, setupSpatialEngine } from './fake-context.test-util';
import {
  DEFAULT_OCCLUSION,
  type OccludableVoice,
  OcclusionScheduler,
  occlusionCutoff,
  occlusionGain,
} from './occlusion';

function voice(x: number): OccludableVoice & { applied: number[] } {
  return {
    position: new Float64Array([x, 0, 0]),
    occlusionProbedAt: Number.NEGATIVE_INFINITY,
    applied: [],
    applyOcclusion(amount) {
      this.applied.push(amount);
    },
  };
}

describe('occlusion curves and scheduler', () => {
  it('cutoff sweeps log-wise from open to closed and gain linearly to closedGain', () => {
    expect(occlusionCutoff(0, 20000, 600)).toBe(20000);
    expect(occlusionCutoff(1, 20000, 600)).toBeCloseTo(600);
    expect(occlusionCutoff(0.5, 20000, 600)).toBeCloseTo(Math.sqrt(20000 * 600));
    expect(occlusionGain(0, 0.4)).toBe(1);
    expect(occlusionGain(1, 0.4)).toBeCloseTo(0.4);
    expect(occlusionGain(0.5, 0.4)).toBeCloseTo(0.7);
  });

  it('probes round-robin within the budget and skips voices probed less than interval ago', () => {
    const s = new OcclusionScheduler();
    const voices = [voice(0), voice(1), voice(2), voice(3), voice(4)];
    const seen: number[] = [];
    const opts = {
      probe: (_l: ArrayLike<number>, e: ArrayLike<number>, out: { amount: number }) => {
        seen.push(e[0]!);
        out.amount = e[0]! / 4;
      },
      budget: 2,
      interval: 0.1,
    };
    const l = new Float64Array(3);
    expect(s.run(opts, l, voices, 0)).toBe(2);
    expect(seen).toEqual([0, 1]);
    expect(s.run(opts, l, voices, 0)).toBe(2);
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(s.run(opts, l, voices, 0)).toBe(1); // only 4 is due
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(s.run(opts, l, voices, 0.05)).toBe(0);
    expect(s.run(opts, l, voices, 0.1)).toBe(2);
    expect(seen.slice(5)).toEqual([0, 1]);
    expect(voices[4]!.applied).toEqual([1]);
    expect(voices[0]!.occlusionProbedAt).toBe(0.1);
  });

  it('clamps the answer and treats a NaN as clear', () => {
    const s = new OcclusionScheduler();
    const voices = [voice(0), voice(1), voice(2)];
    const answers = [5, -1, Number.NaN];
    let i = 0;
    s.run(
      {
        probe: (_l, _e, out) => {
          out.amount = answers[i++]!;
        },
      },
      [0, 0, 0],
      voices,
      0,
    );
    expect(voices.map((v) => v.applied[0])).toEqual([1, 0, 0]);
  });
});

describe('AudioEngine occlusion', () => {
  it('a probe answering 1 ramps the voice lowpass to closedCutoff over interval and dips the gain', async () => {
    const { ctx, audio } = setupSpatialEngine();
    await audio.unlock();
    ctx.currentTime = 5;
    const before = ctx.biquads.length;
    const v = audio.loop(fakeBuffer(1), { at: [3, 0, 0] });
    audio.occlusion = {
      probe: (_l, _e, out) => {
        out.amount = 1;
      },
      interval: 0.2,
    };
    expect(audio.occludedVoiceCount).toBe(1);
    audio.update(1 / 60);
    expect(ctx.biquads.length).toBe(before + 1);
    const f = ctx.biquads.at(-1)!;
    expect(f.type).toBe('lowpass');
    expect(f.frequency.last).toEqual({
      type: 'linear',
      value: DEFAULT_OCCLUSION.closedCutoff,
      time: 5.2,
    });
    expect(v.occlusion).toBe(1);
    const src = ctx.played[0]!;
    expect(src.gainNode.gain.last).toMatchObject({ type: 'target', value: 0.4 });
    // Chain: gain → lowpass → panner → bus.
    expect(src.gainNode.outputs[0]).toBe(f);
    expect(f.outputs[0]).toBe(ctx.panners[0]);
    // setGain keeps the occlusion dip.
    v.setGain(0.5);
    expect(src.gainNode.gain.last).toMatchObject({ type: 'target', value: 0.2 });
    // Clear again: back to the open cutoff; the pool gets the node back when the voice ends.
    audio.occlusion = {
      probe: (_l, _e, out) => {
        out.amount = 0;
      },
      interval: 0.2,
    };
    ctx.currentTime = 5.3;
    audio.update(1 / 60);
    expect(f.frequency.last).toMatchObject({ type: 'linear', value: 20000 });
    expect(v.occlusion).toBe(0);
    v.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.pooledFilters).toBe(1);
    expect(audio.occludedVoiceCount).toBe(0);
  });

  it('probes past the budget wait for the next update; opted-out voices never probe', async () => {
    const { ctx, audio } = setupSpatialEngine();
    await audio.unlock();
    const probed: number[] = [];
    audio.occlusion = {
      probe: (_l, e, out) => {
        probed.push(e[0]!);
        out.amount = 0.5;
      },
      budget: 2,
    };
    for (let i = 0; i < 5; i++) {
      audio.loop(fakeBuffer(1), { at: [i, 0, 0], spatial: { occlude: i !== 4 } });
    }
    expect(audio.occludedVoiceCount).toBe(4);
    audio.update(1 / 60);
    expect(probed).toEqual([0, 1]);
    audio.update(1 / 60);
    expect(probed).toEqual([0, 1, 2, 3]);
    audio.update(1 / 60);
    expect(probed).toEqual([0, 1, 2, 3]);
    ctx.currentTime = 0.1;
    audio.update(1 / 60);
    expect(probed).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it('creates no filter node without a probe', async () => {
    const { ctx, audio } = setupSpatialEngine();
    await audio.unlock();
    const before = ctx.biquads.length;
    const v = audio.loop(fakeBuffer(1), { at: [3, 0, 0] });
    for (let i = 0; i < 5; i++) audio.update(1 / 60);
    expect(ctx.biquads.length).toBe(before);
    expect(v.occlusion).toBe(0);
    const src = ctx.played[0]!;
    expect(src.gainNode.outputs[0]).toBe(ctx.panners[0]);
    expect((ctx.biquads as FakeBiquad[]).length).toBe(before);
  });
});
