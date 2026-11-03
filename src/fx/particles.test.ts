import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeBuffer, type FakeDevice } from '../render/fake-gpu';
import type { Renderer } from '../render/renderer';
import { ParticleSystem } from './particles';

function makeSystem(capacity = 256): { fake: FakeDevice; ps: ParticleSystem } {
  const fake = createFakeDevice();
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
  } as unknown as Renderer;
  return { fake, ps: new ParticleSystem(renderer, { capacity }) };
}

function encoder(fake: FakeDevice) {
  const cleared: FakeBuffer[] = [];
  const enc = fake.device.createCommandEncoder();
  const clearBuffer = enc.clearBuffer.bind(enc);
  enc.clearBuffer = (b: GPUBuffer) => {
    cleared.push(b as unknown as FakeBuffer);
    clearBuffer(b);
  };
  return { enc, cleared };
}

describe('ParticleSystem.clear', () => {
  it('creates the particle buffer with COPY_DST', () => {
    const { fake } = makeSystem();
    const buf = fake.buffers.find((b) => b.label === 'particles')!;
    expect(buf.usage & GPUBufferUsage.COPY_DST).toBeTruthy();
    expect(buf.usage & GPUBufferUsage.STORAGE).toBeTruthy();
  });

  it('zeroes the buffer on the GPU at the next prepare, without validation errors', () => {
    const { fake, ps } = makeSystem();
    ps.emit({ x: 0, y: 0, colorStart: [1, 1, 1, 1] }, 10);
    ps.clear();
    expect(fake.writes.some((w) => w.buffer.label === 'particles')).toBe(false);
    const { enc, cleared } = encoder(fake);
    ps.update(1 / 60);
    ps.prepare(enc);
    expect(cleared.map((b) => b.label)).toEqual(['particles']);
    expect(fake.errors).toEqual([]);
    // The queued emit was dropped: no spawn dispatch, only the update dispatch.
    const compute = fake.passes.at(-1)!;
    expect(compute.commands.filter((c) => c.op === 'dispatch')).toHaveLength(1);
    // Only once.
    const second = encoder(fake);
    ps.prepare(second.enc);
    expect(second.cleared).toHaveLength(0);
  });

  it('keeps particles emitted after clear()', () => {
    const { fake, ps } = makeSystem();
    ps.clear();
    ps.emit({ x: 0, y: 0, colorStart: [1, 1, 1, 1] }, 10);
    const { enc } = encoder(fake);
    ps.update(1 / 60);
    ps.prepare(enc);
    const dispatches = fake.passes.at(-1)!.commands.filter((c) => c.op === 'dispatch');
    expect(dispatches).toHaveLength(2); // spawn + update
    expect(fake.errors).toEqual([]);
  });
});
