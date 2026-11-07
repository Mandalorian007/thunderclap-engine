import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRandom } from '../core/random';
import { createFakeDevice, fakeSceneTargets } from '../render/fake-gpu';
import type { Renderer } from '../render/renderer';
import { createEffect, type EffectDesc } from './effect';
import { HIT_SPARK_EFFECT, MAGIC_AURA_EFFECT } from './effects';
import { ParticleEmitter, ParticleSystem } from './particles';
import { SPAWN_SEED_MAX } from './random';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** A fake renderer whose queue keeps a copy of every byte written, in order. */
function recorder() {
  const fake = createFakeDevice();
  const log: { label: string | undefined; offset: number; bytes: number[] }[] = [];
  const queue = fake.device.queue as unknown as {
    writeBuffer: (
      b: GPUBuffer,
      o: number,
      d: ArrayBuffer | ArrayBufferView,
      dO?: number,
      s?: number,
    ) => void;
  };
  const write = queue.writeBuffer.bind(queue);
  queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset)
        : new Uint8Array(data.buffer, data.byteOffset + dataOffset, size ?? data.byteLength);
    log.push({ label: buffer.label, offset, bytes: Array.from(bytes) });
    write(buffer, offset, data, dataOffset, size);
  };
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    sceneTargets: fakeSceneTargets,
    target: { depth: null, auxKey: 0 },
  } as unknown as Renderer;
  return { fake, renderer, log };
}

/** The bundled spark and aura systems together: bursts, rates and sub-emitters. */
const DESC: EffectDesc = {
  duration: 2,
  loop: true,
  systems: [
    ...HIT_SPARK_EFFECT.systems,
    ...MAGIC_AURA_EFFECT.systems.map((s) => ({ ...s, name: `aura-${s.name}` })),
  ],
};

/** Every buffer write of 120 fixed steps of an effect seeded with `seed`. */
function run(seed: number | string) {
  const { fake, renderer, log } = recorder();
  const effect = createEffect(renderer, DESC, { random: createRandom(seed) });
  for (let step = 0; step < 120; step++) {
    if (step % 30 === 0) effect.play({ x: step, y: 1 });
    effect.update(1 / 60);
    const enc = fake.device.createCommandEncoder();
    for (const s of effect.systems) s.prepare(enc);
  }
  expect(fake.errors).toEqual([]);
  return log;
}

describe('seeded fx (ws/fx-4)', () => {
  it('no Math.random in src/fx: every draw goes through a Random', () => {
    const hits: string[] = [];
    for (const file of sources(__dirname)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/Math\.random\b/.test(line)) hits.push(`${file}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('two effects with the same seed write identical particle buffers over 120 steps', () => {
    const a = run(42);
    const b = run(42);
    const spawns = a.filter((w) => w.label === 'particle-spawns');
    expect(spawns.length).toBeGreaterThan(10);
    expect(b).toEqual(a);
    // Another seed changes the spawn records (their seeds), not the schedule.
    const c = run(43);
    expect(c.length).toBe(a.length);
    expect(c.filter((w) => w.label === 'particle-spawns')).not.toEqual(spawns);
  });

  it('a system and an emitter take their own stream; the default forks the module seed', () => {
    const { renderer } = recorder();
    const params = { x: 0, y: 0, colorStart: [1, 1, 1, 1] as [number, number, number, number] };
    const sys = new ParticleSystem(renderer, { capacity: 16, random: createRandom(1) });
    const spawnData = (sys as unknown as { spawnData: Float32Array }).spawnData;
    sys.emit(params, 1);
    const seeds = spawnData.slice();
    expect(Array.from(seeds)).toContain(createRandom(1).int(0, SPAWN_SEED_MAX));
    const em = new ParticleEmitter(sys, params, 0, createRandom(9));
    expect(em.random).not.toBe(sys.random);
    expect(new ParticleEmitter(sys, params).random).toBeNull();
    const plain = new ParticleSystem(renderer, { capacity: 16 });
    const other = new ParticleSystem(renderer, { capacity: 16 });
    expect(plain.random.next()).not.toBe(other.random.next());
  });
});
