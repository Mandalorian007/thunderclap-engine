import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeBuffer } from '../render/fake-gpu';
import type { Renderer } from '../render/renderer';
import {
  applyForces,
  type ParticleForce,
  ParticleSystem,
  type ParticleSystemOptions,
} from './particles';
import { FX_PARTICLE_FLOATS } from './particles-wgsl';

interface Staging {
  mapAsync: (mode: number) => Promise<void>;
  getMappedRange: (offset?: number, size?: number) => ArrayBuffer;
  unmap: () => void;
}

/** A system on the fake GPU whose staging buffer maps `contents` (filled by the test). */
function makeSystem(opts: ParticleSystemOptions) {
  (globalThis as Record<string, unknown>).GPUMapMode ??= { READ: 1, WRITE: 2 };
  const fake = createFakeDevice();
  const copies: { src: FakeBuffer; dst: FakeBuffer; size: number }[] = [];
  let submits = 0;
  const create = fake.device.createCommandEncoder.bind(fake.device);
  (fake.device as unknown as { createCommandEncoder: unknown }).createCommandEncoder = (
    desc?: GPUCommandEncoderDescriptor,
  ) => {
    const e = create(desc);
    e.copyBufferToBuffer = ((
      src: FakeBuffer,
      _so: number,
      dst: FakeBuffer,
      _do: number,
      size: number,
    ) => copies.push({ src, dst, size })) as never;
    return e;
  };
  const submit = fake.device.queue.submit.bind(fake.device.queue);
  (fake.device.queue as unknown as { submit: unknown }).submit = (b: GPUCommandBuffer[]) => {
    submits++;
    submit(b);
  };
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    target: { depth: null },
  } as unknown as Renderer;
  const ps = new ParticleSystem(renderer, { capacity: 256, ...opts });
  const staging = fake.buffers.find((b) => b.label === 'particles-debug-read') as
    | (FakeBuffer & Staging)
    | undefined;
  let contents: Float32Array = new Float32Array(staging ? staging.size / 4 : 0);
  let maps = 0;
  let unmaps = 0;
  if (staging) {
    staging.mapAsync = () => {
      maps++;
      return Promise.resolve();
    };
    staging.getMappedRange = () => contents.buffer as ArrayBuffer;
    staging.unmap = () => {
      unmaps++;
    };
  }
  return {
    fake,
    ps,
    staging,
    copies,
    get contents() {
      return contents;
    },
    set contents(c: Float32Array) {
      contents = c;
    },
    counts: () => ({ maps, unmaps, submits }),
  };
}

const ATTRACTOR = [0, 6.5, -4] as const;
// The fx3?forces force list (ws/fx-5).
const FORCES: ParticleForce[] = [
  { kind: 'attract', x: 0, y: 6.5, z: -4, strength: 4, falloff: 'linear' },
  { kind: 'vortex', axis: [0, 1, 0], x: 0, y: 6.5, z: -4, strength: 0.35, radius: 6 },
  { kind: 'drag', amount: 3 },
];

describe('ParticleSystem.debugReadback', () => {
  it('is opt-in: without `debug` there is no staging buffer, no COPY_SRC, and it rejects', async () => {
    const t = makeSystem({ space: 'world' });
    expect(t.staging).toBeUndefined();
    const particles = t.fake.buffers.find((b) => b.label === 'particles')!;
    expect(particles.usage & GPUBufferUsage.COPY_SRC).toBe(0);
    await expect(t.ps.debugReadback()).rejects.toThrow(/debug: true/);
    expect(t.copies).toEqual([]);
  });

  it('never runs on its own: frames record no copy and map nothing', () => {
    const t = makeSystem({ space: 'world', debug: true });
    for (let i = 0; i < 4; i++) {
      t.ps.update(1 / 60);
      t.ps.prepare(t.fake.device.createCommandEncoder());
    }
    expect(t.copies).toEqual([]);
    expect(t.counts().maps).toBe(0);
  });

  it('reads back the CPU shadow of the fx3 shell: live particles, positions, velocities', async () => {
    const t = makeSystem({ space: 'world', debug: true, forces: FORCES });
    const particles = t.fake.buffers.find((b) => b.label === 'particles')!;
    expect(particles.usage & GPUBufferUsage.COPY_SRC).toBeTruthy();
    expect(t.staging!.size).toBe(particles.size);
    expect(t.staging!.size).toBe(256 * FX_PARTICLE_FLOATS * 4);

    // The CPU shadow path: 64 particles on the shell of radius 3, 2 s of `applyForces` at 60 Hz.
    const pos: number[][] = [];
    const vel: number[][] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const b = ((i % 8) / 8 - 0.5) * Math.PI;
      pos.push([
        ATTRACTOR[0] + 3 * Math.cos(a) * Math.cos(b),
        ATTRACTOR[1] + 3 * Math.sin(b),
        ATTRACTOR[2] + 3 * Math.sin(a) * Math.cos(b),
      ]);
      vel.push([0, 0, 0]);
    }
    for (let f = 0; f < 120; f++) {
      for (let i = 0; i < 64; i++) {
        applyForces(t.ps.forces, pos[i]!, vel[i]!, 1 / 60);
        for (let k = 0; k < 3; k++) pos[i]![k]! += vel[i]![k]! / 60;
      }
    }
    // Packed as the kernel lays them out (pos at 0, vel at 4, life at 16) in every third slot;
    // the slots between hold dead particles (age past lifetime) that must not come back.
    const d = new Float32Array(t.staging!.size / 4);
    for (let i = 0; i < 64; i++) {
      const o = i * 3 * FX_PARTICLE_FLOATS;
      d.set(pos[i]!, o);
      d.set(vel[i]!, o + 4);
      d[o + 16] = 2;
      d[o + 17] = 7;
      const dead = o + FX_PARTICLE_FLOATS;
      d.set([99, 99, 99], dead);
      d[dead + 16] = 8;
      d[dead + 17] = 7;
    }
    t.contents = d;

    t.ps.update(0.05);
    t.ps.prepare(t.fake.device.createCommandEncoder());
    const r = await t.ps.debugReadback();
    expect(t.copies).toHaveLength(1);
    expect(t.copies[0]!.src.label).toBe('particles');
    expect(t.copies[0]!.dst.label).toBe('particles-debug-read');
    expect(t.copies[0]!.size).toBe(particles.size);
    expect(t.counts()).toEqual({ maps: 1, unmaps: 1, submits: 1 });
    expect(r.alive).toBe(64);
    expect(r.time).toBeCloseTo(0.05, 6);
    expect(r.positions).toHaveLength(64 * 3);
    expect(r.velocities).toHaveLength(64 * 3);
    expect(Array.from(r.slots.subarray(0, 3))).toEqual([0, 3, 6]);
    let shadow = 0;
    let read = 0;
    for (let i = 0; i < 64; i++) {
      for (let k = 0; k < 3; k++) {
        expect(r.positions[i * 3 + k]).toBeCloseTo(pos[i]![k]!, 5);
        expect(r.velocities[i * 3 + k]).toBeCloseTo(vel[i]![k]!, 5);
      }
      shadow += Math.hypot(...pos[i]!.map((v, k) => v - ATTRACTOR[k]!));
      read += Math.hypot(
        r.positions[i * 3]! - ATTRACTOR[0],
        r.positions[i * 3 + 1]! - ATTRACTOR[1],
        r.positions[i * 3 + 2]! - ATTRACTOR[2],
      );
    }
    // The measurement the fx3 harness makes: the shell has gathered (ws/fx-5 measured 0.08 at 2 s).
    expect(read / 64).toBeCloseTo(shadow / 64, 5);
    expect(read / 64).toBeLessThan(0.3);
    expect(t.fake.errors).toEqual([]);
  });

  it('shares one copy between overlapping calls and allows another once it resolves', async () => {
    const t = makeSystem({ space: 'world', debug: true });
    const a = t.ps.debugReadback();
    const b = t.ps.debugReadback();
    expect(b).toBe(a);
    expect((await a).alive).toBe(0);
    expect(t.copies).toHaveLength(1);
    await t.ps.debugReadback();
    expect(t.copies).toHaveLength(2);
  });

  it('reads the original 2D layout (posVel, life at 12) with z 0', async () => {
    const t = makeSystem({ debug: true });
    expect(t.ps.extended).toBe(false);
    const d = new Float32Array(t.staging!.size / 4);
    d.set([10, 20, 30, -40], 5 * 20);
    d[5 * 20 + 12] = 0.1;
    d[5 * 20 + 13] = 1;
    t.contents = d;
    const r = await t.ps.debugReadback();
    expect(r.alive).toBe(1);
    expect(Array.from(r.positions)).toEqual([10, 20, 0]);
    expect(Array.from(r.velocities)).toEqual([30, -40, 0]);
    expect(Array.from(r.slots)).toEqual([5]);
  });

  it('destroys the staging buffer with the system', () => {
    const t = makeSystem({ space: 'world', debug: true });
    t.ps.destroy();
    expect(t.staging!.destroyed).toBe(true);
  });
});
