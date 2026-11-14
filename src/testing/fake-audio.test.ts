// FakeAudioContext's params refuse a non-finite value or time, as a browser's do (ws/actor-post-fit).
import { describe, expect, it } from 'vitest';
import { FakeAudioParam } from './fake-audio';

describe('FakeAudioParam (ws/actor-post-fit)', () => {
  it('refuses NaN and Infinity with a TypeError, and keeps its value', () => {
    const p = new FakeAudioParam(0.5);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => {
        p.value = bad;
      }).toThrow(TypeError);
      expect(() => p.setValueAtTime(bad, 0)).toThrow(TypeError);
      expect(() => p.setValueAtTime(1, bad)).toThrow(TypeError);
      expect(() => p.linearRampToValueAtTime(bad, 1)).toThrow(TypeError);
      expect(() => p.exponentialRampToValueAtTime(bad, 1)).toThrow(TypeError);
      expect(() => p.setTargetAtTime(bad, 1)).toThrow(TypeError);
      expect(() => p.cancelScheduledValues(bad)).toThrow(TypeError);
    }
    expect(() => new FakeAudioParam(Number.NaN)).toThrow(TypeError);
    expect(p.value).toBe(0.5);
    expect(p.events).toEqual([]);
    p.linearRampToValueAtTime(0.25, 2);
    expect(p.value).toBe(0.25);
    expect(p.last).toEqual({ type: 'linear', value: 0.25, time: 2 });
  });
});
