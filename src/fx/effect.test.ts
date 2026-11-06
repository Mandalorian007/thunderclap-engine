import { describe, expect, it } from 'vitest';
import { createFakeDevice } from '../render/fake-gpu';
import type { Renderer } from '../render/renderer';
import { createEffect, type EffectDesc, validateEffectDesc } from './effect';
import { HIT_SPARK_EFFECT, MAGIC_AURA_EFFECT, SMOKE_PUFF_EFFECT } from './effects';

function fakeRenderer() {
  const fake = createFakeDevice();
  const renderer = {
    device: fake.device,
    globalsLayout: fake.device.createBindGroupLayout({ entries: [] }),
    sceneFormats: ['rgba16float', 'rgba16float'],
    target: { depth: null },
  } as unknown as Renderer;
  return { fake, renderer };
}

function spawnCount(effect: ReturnType<typeof createEffect>, system = 0): number {
  return (effect.systems[system] as unknown as { spawnCount: number }).spawnCount;
}

const ONE: EffectDesc = {
  duration: 1,
  systems: [
    {
      name: 'a',
      options: { capacity: 64 },
      emitters: [{ rate: 60, params: { x: 0, y: 0, colorStart: [1, 1, 1, 1] } }],
    },
  ],
};

describe('validateEffectDesc', () => {
  it('accepts the bundled descriptors', () => {
    expect(validateEffectDesc(HIT_SPARK_EFFECT)).toEqual([]);
    expect(validateEffectDesc(SMOKE_PUFF_EFFECT)).toEqual([]);
    expect(validateEffectDesc(MAGIC_AURA_EFFECT)).toEqual([]);
  });

  it('rejects a bad curve stop count', () => {
    const bad = JSON.parse(JSON.stringify(ONE)) as EffectDesc;
    bad.systems[0]!.emitters[0]!.params.sizeCurve = [1];
    expect(validateEffectDesc(bad).join()).toMatch(/sizeCurve/);
    bad.systems[0]!.emitters[0]!.params.sizeCurve = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(validateEffectDesc(bad).join()).toMatch(/sizeCurve/);
    bad.systems[0]!.emitters[0]!.params.sizeCurve = undefined;
    bad.systems[0]!.emitters[0]!.params.colorCurve = [[1, 1, 1, 1]];
    expect(validateEffectDesc(bad).join()).toMatch(/colorCurve/);
  });

  it('rejects an unknown texture name, and a system with neither rate nor burst', () => {
    const bad = JSON.parse(JSON.stringify(ONE)) as EffectDesc;
    bad.systems[0]!.options = { texture: 'spark' };
    expect(validateEffectDesc(bad, { textures: ['smoke'] }).join()).toMatch(/texture/);
    expect(validateEffectDesc(bad, { textures: ['spark'] })).toEqual([]);
    // Without a texture list the names are not checked (the loader may resolve them later).
    expect(validateEffectDesc(bad)).toEqual([]);
    const idle = JSON.parse(JSON.stringify(ONE)) as EffectDesc;
    idle.systems[0]!.emitters[0] = { params: { x: 0, y: 0, colorStart: [1, 1, 1, 1] } };
    expect(validateEffectDesc(idle).length).toBeGreaterThan(0);
    expect(validateEffectDesc(null)).toEqual(['effect: must be an object']);
    expect(validateEffectDesc({ systems: [] }).length).toBeGreaterThan(0);
  });

  it('createEffect throws a readable error', () => {
    const { renderer } = fakeRenderer();
    expect(() => createEffect(renderer, { systems: [] })).toThrow(/createEffect:/);
  });
});

describe('Effect', () => {
  it('play twice gives two instances; each drives the emitters', () => {
    const { fake, renderer } = fakeRenderer();
    const effect = createEffect(renderer, ONE);
    expect(effect.systems).toHaveLength(1);
    expect(effect.systems[0]!.extended).toBe(true);
    expect(effect.duration).toBe(1);
    const a = effect.play({ x: 1, y: 2 });
    const b = effect.play({ x: 3, y: 4 });
    expect(effect.instances).toHaveLength(2);
    expect(a).not.toBe(b);
    expect(Array.from(a.position)).toEqual([1, 2, 0]);
    effect.update(0.1);
    // 60/s × 0.1 s = 6 per instance, one emit call each.
    expect(spawnCount(effect)).toBe(2);
    effect.update(1);
    // Past `duration` an instance is done; the next update drops it into the pool.
    expect(effect.instances.every((i) => i.done)).toBe(true);
    effect.update(0);
    expect(effect.instances).toHaveLength(0);
    // Finished instances are pooled and reused.
    const c = effect.play();
    expect(c === a || c === b).toBe(true);
    expect(c.time).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('stop ends emission; the systems keep updating', () => {
    const { renderer } = fakeRenderer();
    const effect = createEffect(renderer, ONE);
    effect.play();
    effect.update(0.1);
    const before = spawnCount(effect);
    expect(before).toBe(1);
    effect.stop();
    effect.update(0.1);
    expect(effect.instances).toHaveLength(0);
    expect(spawnCount(effect)).toBe(before);
    const pending = (effect.systems[0] as unknown as { pendingDt: number }).pendingDt;
    expect(pending).toBeCloseTo(0.2);
  });

  it('attach follows a point; a looping effect re-arms its bursts', () => {
    const { renderer } = fakeRenderer();
    const effect = createEffect(renderer, HIT_SPARK_EFFECT);
    expect(effect.duration).toBe(0.4);
    let x = 5;
    const inst = effect.attach((out) => {
      out[0] = x;
      out[1] = 1;
    });
    expect(inst.position[0]).toBe(5);
    x = 7;
    effect.update(0.01);
    expect(inst.position[0]).toBe(7);
    expect(spawnCount(effect, 0)).toBe(1);
    expect(spawnCount(effect, 1)).toBe(1);
    effect.update(0.01);
    expect(spawnCount(effect, 0)).toBe(1); // a burst fires once
    inst.stop();
    effect.update(0.01);
    expect(effect.instances).toHaveLength(0);

    const aura = createEffect(renderer, MAGIC_AURA_EFFECT);
    expect(aura.loop).toBe(true);
    const a = aura.play();
    aura.update(1.5);
    expect(aura.instances).toHaveLength(1);
    expect(a.time).toBeCloseTo(0.5);
    aura.destroy();
    expect(aura.instances).toHaveLength(0);
  });
});
