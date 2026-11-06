import { describe, expect, it } from 'vitest';
import { COSMETICS, nextOption, SLOT_NAMES } from './cosmetics';
import { JOINT_COUNT } from './rig';

describe('cosmetics table', () => {
  it('has three slots with two options each, on real joints', () => {
    expect(COSMETICS.map((s) => s.slot)).toEqual([...SLOT_NAMES]);
    for (const slot of COSMETICS) {
      expect(slot.options).toHaveLength(2);
      expect(slot.joint).toBeGreaterThanOrEqual(0);
      expect(slot.joint).toBeLessThan(JOINT_COUNT);
      const names = slot.options.map((o) => o.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('builds every option into a non-empty 3D geometry with bounded surfaces', () => {
    for (const slot of COSMETICS) {
      for (const o of slot.options) {
        const g = o.build();
        expect(g.vertices.length).toBeGreaterThan(0);
        expect(g.indices.length % 3).toBe(0);
        expect(g.bounds.radius).toBeGreaterThan(0);
        expect(g.bounds.radius).toBeLessThan(1);
        expect(o.metallic).toBeGreaterThanOrEqual(0);
        expect(o.metallic).toBeLessThanOrEqual(1);
        expect(o.roughness).toBeGreaterThan(0);
        expect(o.roughness).toBeLessThanOrEqual(1);
      }
    }
  });

  it('cycles options and wraps', () => {
    const slot = COSMETICS[0]!;
    expect(nextOption(slot, 0)).toBe(1);
    expect(nextOption(slot, 1)).toBe(0);
  });
});
