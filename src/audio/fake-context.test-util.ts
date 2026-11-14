/**
 * The engine's own audio tests' fake: the public one from `src/testing/fake-audio.ts` under the
 * short names these tests use, plus `setupEngine`. Not a test file (Vitest only picks `*.test.ts`).
 */
import {
  FakeAudioAnalyser as FakeAnalyser,
  FakeAudioBiquad as FakeBiquad,
  FakeAudioContext as FakeContext,
  FakeAudioConvolver as FakeConvolver,
  FakeAudioGain as FakeGain,
  FakeAudioMediaElement as FakeMediaElement,
  FakeAudioMediaSource as FakeMediaSource,
  FakeAudioNode as FakeNode,
  FakeAudioPanner as FakePanner,
  FakeAudioParam as FakeParam,
  FakeAudioSource as FakeSource,
  FakeAudioSpatialContext as FakeSpatialContext,
  type FakeAudioParamEvent as ParamEvent,
} from '../testing/fake-audio';
import { AudioEngine } from './audio';

export {
  FakeAnalyser,
  FakeBiquad,
  FakeContext,
  FakeConvolver,
  FakeGain,
  FakeMediaElement,
  FakeMediaSource,
  FakeNode,
  FakePanner,
  FakeParam,
  FakeSource,
  FakeSpatialContext,
  type ParamEvent,
};

/** A buffer of `seconds` at the fake's rate (duration is what music scheduling reads). */
export function fakeBuffer(seconds: number): AudioBuffer {
  return {
    duration: seconds,
    length: Math.round(seconds * 48000),
    sampleRate: 48000,
  } as unknown as AudioBuffer;
}

/** A fake context and an engine on it. `unlock()` to get buses. */
export function setupEngine(settings?: unknown) {
  const ctx = new FakeContext();
  const audio = new AudioEngine({
    createContext: () => ctx as unknown as AudioContext,
    settings,
  });
  return { ctx, audio };
}

/** Like `setupEngine`, on a `FakeSpatialContext`. */
export function setupSpatialEngine(settings?: unknown) {
  const ctx = new FakeSpatialContext();
  const audio = new AudioEngine({
    createContext: () => ctx as unknown as AudioContext,
    settings,
  });
  return { ctx, audio };
}
