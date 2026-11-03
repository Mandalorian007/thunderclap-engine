import { describe, expect, it } from 'vitest';
import {
  fillCrackle,
  fillNoise,
  foldLoop,
  loopSafeFreq,
  midiToHz,
  normalize,
  peakOf,
  reverbImpulse,
  rng,
  volumeToGain,
} from './dsp';
import {
  type Envelope,
  EXP_FLOOR,
  envelopeSegments,
  envelopeValueAt,
  type ParamLike,
  pluck,
  scheduleEnvelope,
} from './envelope';

const lin: Envelope = { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.4, curve: 'linear' };

describe('envelope math', () => {
  it('follows linear ADSR', () => {
    const gate = 1;
    expect(envelopeValueAt(lin, -0.1, gate)).toBe(0);
    expect(envelopeValueAt(lin, 0, gate)).toBe(0);
    expect(envelopeValueAt(lin, 0.05, gate)).toBeCloseTo(0.5);
    expect(envelopeValueAt(lin, 0.1, gate)).toBeCloseTo(1);
    expect(envelopeValueAt(lin, 0.2, gate)).toBeCloseTo(0.75);
    expect(envelopeValueAt(lin, 0.3, gate)).toBeCloseTo(0.5);
    expect(envelopeValueAt(lin, 0.9, gate)).toBeCloseTo(0.5);
    expect(envelopeValueAt(lin, 1.2, gate)).toBeCloseTo(0.25);
    expect(envelopeValueAt(lin, 1.4, gate)).toBe(0);
    expect(envelopeValueAt(lin, 5, gate)).toBe(0);
  });

  it('scales by peak', () => {
    expect(envelopeValueAt(lin, 0.1, 1, 0.3)).toBeCloseTo(0.3);
    expect(envelopeValueAt(lin, 0.5, 1, 0.3)).toBeCloseTo(0.15);
  });

  it('releases from the current level if the gate closes during attack', () => {
    const gate = 0.05;
    expect(envelopeValueAt(lin, 0.05, gate)).toBeCloseTo(0.5);
    expect(envelopeValueAt(lin, 0.25, gate)).toBeCloseTo(0.25);
    expect(envelopeValueAt(lin, 0.45, gate)).toBe(0);
    // Never exceeds the gate-time level afterwards.
    for (let t = 0.05; t < 0.5; t += 0.01)
      expect(envelopeValueAt(lin, t, gate)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('exponential decay is monotonic and ends at exactly 0', () => {
    const env = pluck(0.5);
    const segs = envelopeSegments(env, 0.5);
    expect(segs[segs.length - 1]!.v).toBe(0);
    let prev = Infinity;
    for (let t = 0.002; t <= 0.51; t += 0.01) {
      const v = envelopeValueAt(env, t, 0.5);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    // Halfway through an exp decay to the floor is the geometric mean.
    expect(envelopeValueAt(env, 0.002 + 0.25, 0.5)).toBeCloseTo(Math.sqrt(EXP_FLOOR), 4);
  });

  it('zero attack starts at peak; hold keeps it', () => {
    const env: Envelope = {
      attack: 0,
      hold: 0.1,
      decay: 0.1,
      sustain: 0,
      release: 0.01,
      curve: 'linear',
    };
    expect(envelopeValueAt(env, 0, 1)).toBe(1);
    expect(envelopeValueAt(env, 0.05, 1)).toBe(1);
    expect(envelopeValueAt(env, 0.15, 1)).toBeCloseTo(0.5);
  });

  it('scheduleEnvelope writes matching automation', () => {
    const calls: [string, number, number][] = [];
    const param: ParamLike = {
      value: 0,
      setValueAtTime: (v, t) => calls.push(['set', v, t]),
      linearRampToValueAtTime: (v, t) => calls.push(['lin', v, t]),
      exponentialRampToValueAtTime: (v, t) => calls.push(['exp', v, t]),
      cancelScheduledValues: (t) => calls.push(['cancel', 0, t]),
    };
    const end = scheduleEnvelope(param, lin, 10, 1);
    expect(end).toBeCloseTo(11.4);
    expect(calls[0]).toEqual(['cancel', 0, 10]);
    expect(calls[1]).toEqual(['set', 0, 10]);
    expect(calls[2]![0]).toBe('lin');
    expect(calls[2]![1]).toBeCloseTo(1);
    expect(calls[2]![2]).toBeCloseTo(10.1);
    expect(calls.at(-1)).toEqual(['lin', 0, 11.4]);
    // Exponential ramps never target 0.
    calls.length = 0;
    scheduleEnvelope(param, pluck(0.3), 0, 0.3);
    for (const [kind, v] of calls) if (kind === 'exp') expect(v).toBeGreaterThan(0);
  });
});

describe('dsp', () => {
  it('rng is deterministic and in range', () => {
    const a = rng(42);
    const b = rng(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(rng(1)()).not.toBe(rng(2)());
  });

  it('noise colours are bounded and roughly zero-mean; brown is darker than white', () => {
    const n = 44100;
    const diffEnergy = (x: Float32Array) => {
      let e = 0;
      for (let i = 1; i < x.length; i++) e += (x[i]! - x[i - 1]!) ** 2;
      return e / peakOf([x]) ** 2;
    };
    const white = fillNoise(new Float32Array(n), 'white', 3);
    const pink = fillNoise(new Float32Array(n), 'pink', 3);
    const brown = fillNoise(new Float32Array(n), 'brown', 3);
    for (const x of [white, pink, brown]) {
      expect(peakOf([x])).toBeLessThan(1.5);
      expect(peakOf([x])).toBeGreaterThan(0.05);
      let mean = 0;
      for (const v of x) mean += v;
      expect(Math.abs(mean / n)).toBeLessThan(0.1);
    }
    expect(diffEnergy(brown)).toBeLessThan(diffEnergy(pink));
    expect(diffEnergy(pink)).toBeLessThan(diffEnergy(white));
    expect(fillNoise(new Float32Array(8), 'white', 9)).toEqual(
      fillNoise(new Float32Array(8), 'white', 9),
    );
  });

  it('crackle density is approximately right', () => {
    const sr = 8000;
    const x = fillCrackle(new Float32Array(sr * 10), sr, 20, 1, 0.001);
    let onsets = 0;
    let quiet = true;
    for (const v of x) {
      if (Math.abs(v) > 0.05 && quiet) onsets++;
      quiet = Math.abs(v) < 1e-4;
    }
    expect(onsets).toBeGreaterThan(120);
    expect(onsets).toBeLessThan(280);
  });

  it('foldLoop makes the wrap continuous', () => {
    // A ramp that would jump at the wrap without folding.
    const loopLen = 1000;
    const fade = 100;
    const data = new Float32Array(loopLen + fade).map((_, i) => Math.sin(i * 0.0137) + i * 0.001);
    const out = foldLoop(data, loopLen, fade);
    expect(out.length).toBe(loopLen);
    const wrapJump = Math.abs(out[0]! - out[loopLen - 1]!);
    const typicalStep = Math.abs(out[loopLen - 1]! - out[loopLen - 2]!);
    expect(wrapJump).toBeLessThan(typicalStep * 3);
    expect(Math.abs(data[0]! - data[loopLen - 1]!)).toBeGreaterThan(0.5);
    expect(() => foldLoop(data, loopLen, fade + 1)).toThrow(RangeError);
  });

  it('normalize, loopSafeFreq, conversions', () => {
    const ch = [new Float32Array([0.1, -0.4]), new Float32Array([0.2, 0])];
    normalize(ch, 0.8);
    expect(peakOf(ch)).toBeCloseTo(0.8);
    expect(ch[0]![0]).toBeCloseTo(0.2);
    expect(normalize([new Float32Array(4)])).toBe(1);

    const f = loopSafeFreq(441.3, 8);
    expect((f * 8) % 1).toBeCloseTo(0);
    expect(Math.abs(f - 441.3)).toBeLessThanOrEqual(1 / 16);

    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBeCloseTo(880);
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBe(1);
    expect(volumeToGain(0.5)).toBeCloseTo(0.25);
    expect(volumeToGain(2)).toBe(1);
    expect(volumeToGain(Number.NaN)).toBe(0);
  });
});

describe('reverbImpulse', () => {
  it('is deterministic, stereo-decorrelated and decays to silence', () => {
    const a = reverbImpulse(8000, 1, 3, 7);
    const b = reverbImpulse(8000, 1, 3, 7);
    expect(a).toHaveLength(2);
    expect(a[0]!.length).toBe(8000);
    expect(a[0]).toEqual(b[0]);
    expect(a[0]).not.toEqual(a[1]);
    expect(reverbImpulse(8000, 1, 3, 8)[0]).not.toEqual(a[0]);
    const energy = (ch: Float32Array, from: number, to: number) => {
      let e = 0;
      for (let i = from; i < to; i++) e += ch[i]! ** 2;
      return e;
    };
    const ch = a[0]!;
    expect(energy(ch, 0, 2000)).toBeGreaterThan(10 * energy(ch, 6000, 8000));
    expect(Math.abs(ch[0]!)).toBeLessThan(0.1); // soft onset
    expect(Math.abs(ch[7999]!)).toBeLessThan(1e-6);
    expect(peakOf(a)).toBeLessThanOrEqual(1);
  });

  it('a higher decay gives a shorter tail', () => {
    const tail = (d: number) => {
      const [ch] = reverbImpulse(8000, 1, d, 1, 1);
      let e = 0;
      for (let i = 4000; i < 8000; i++) e += ch![i]! ** 2;
      return e;
    };
    expect(tail(6)).toBeLessThan(tail(2));
  });
});
