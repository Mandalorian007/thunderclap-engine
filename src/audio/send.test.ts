import { describe, expect, it } from 'vitest';
import { impulseResponse, reverbImpulse } from './dsp';
import { FakeContext, type FakeGain, type FakeNode, setupEngine } from './fake-context.test-util';
import { createSend } from './send';

describe('impulseResponse', () => {
  it('builds a stereo buffer on the context from reverbImpulse', () => {
    const ctx = new FakeContext();
    const buf = impulseResponse(ctx as unknown as AudioContext, {
      seconds: 0.5,
      decay: 2,
      seed: 3,
    });
    const b = buf as unknown as { length: number; numberOfChannels: number; data: Float32Array[] };
    expect(b.numberOfChannels).toBe(2);
    expect(b.length).toBe(24000);
    const ref = reverbImpulse(48000, 0.5, 2, 3);
    expect(b.data[0]).toEqual(ref[0]);
    expect(b.data[1]).toEqual(ref[1]);
    expect(b.data[0]!.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('createSend', () => {
  it('reverb: bus → amount gain → convolver → master, in parallel with the dry path', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    const send = createSend(audio, { kind: 'reverb', bus: 'sfx', amount: 0.3, seconds: 0.25 });
    const sfx = audio.busNode('sfx') as unknown as FakeNode;
    const master = audio.busNode('master') as unknown as FakeNode;
    expect(send.kind).toBe('reverb');
    expect(send.input).not.toBeNull();
    expect(send.node).toBe(ctx.convolvers[0]);
    expect(ctx.convolvers[0]!.normalize).toBe(true);
    expect((ctx.convolvers[0]!.buffer as { length: number }).length).toBe(12000);
    // Dry path still goes to master; the send is a second output of the bus.
    expect(sfx.outputs[0]).toBe(master);
    expect(sfx.outputs).toContain(send.input);
    expect((send.input as unknown as FakeGain).gain.value).toBe(0.3);
    expect((send.input as unknown as FakeNode).outputs[0]).toBe(send.node);
    const ret = (send.node as unknown as FakeNode).outputs[0] as FakeGain;
    expect(ret.outputs[0]).toBe(master);
    expect(send.cutoff).toBeUndefined();
    send.cutoff = 500;
    expect(send.cutoff).toBeUndefined();

    ctx.currentTime = 3;
    send.amount = 0.8;
    expect(send.amount).toBe(0.8);
    expect((send.input as unknown as FakeGain).gain.last).toEqual({
      type: 'target',
      value: 0.8,
      time: 3,
    });
    send.amount = 7;
    expect(send.amount).toBe(1);

    send.dispose();
    expect(sfx.outputs).not.toContain(send.input);
    expect(send.node).toBeNull();
  });

  it('lowpass: a biquad whose cutoff the game drives', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    const send = createSend(audio, { kind: 'lowpass', amount: 1, cutoff: 1200, q: 2 });
    const f = ctx.biquads[0]!;
    expect(send.node).toBe(f);
    expect(f.type).toBe('lowpass');
    expect(f.frequency.value).toBe(1200);
    expect(f.Q.value).toBe(2);
    expect(send.cutoff).toBe(1200);
    ctx.currentTime = 1;
    send.cutoff = 300;
    expect(send.cutoff).toBe(300);
    expect(f.frequency.last).toEqual({ type: 'target', value: 300, time: 1 });
    send.cutoff = Number.NaN;
    expect(send.cutoff).toBe(300);
  });

  it('is built on unlock when created before it, remembering amount and cutoff', async () => {
    const { ctx, audio } = setupEngine();
    const send = createSend(audio, { kind: 'lowpass', amount: 0.2 });
    expect(send.node).toBeNull();
    send.amount = 0.5;
    send.cutoff = 400;
    expect(send.amount).toBe(0.5);
    await audio.unlock();
    expect(send.node).toBe(ctx.biquads[0]);
    expect((send.input as unknown as FakeGain).gain.value).toBe(0.5);
    expect(ctx.biquads[0]!.frequency.value).toBe(400);
  });

  it('is a no-op where the context lacks the node', async () => {
    const { ctx, audio } = setupEngine();
    (ctx as unknown as { createConvolver: unknown }).createConvolver = undefined;
    await audio.unlock();
    const send = createSend(audio, { kind: 'reverb' });
    expect(send.node).toBeNull();
    send.amount = 0.5;
    expect(send.amount).toBe(0.5);
    send.dispose();
  });
});
