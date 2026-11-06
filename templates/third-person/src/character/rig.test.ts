import { parseGltf } from '@thunderclap/engine/assets';
import { describe, expect, it } from 'vitest';
import {
  ATTACK_LUNGE,
  buildCharacterGlb,
  CLIP_DURATIONS,
  CLIP_NAMES,
  J,
  JOINT_COUNT,
  JOINT_NAMES,
  MESH_NODE,
  restPositions,
} from './rig';

const doc = parseGltf(buildCharacterGlb());

describe('character glb', () => {
  it('has one skin over the fourteen joints, parents before children', () => {
    expect(doc.skins).toHaveLength(1);
    const skin = doc.skins[0]!;
    expect(skin.joints).toHaveLength(JOINT_COUNT);
    expect(JOINT_NAMES).toHaveLength(JOINT_COUNT);
    expect(doc.nodes[MESH_NODE]!.mesh).toBe(0);
    for (let j = 0; j < JOINT_COUNT; j++) {
      expect(doc.nodes[j]!.name).toBe(JOINT_NAMES[j]);
      for (const c of doc.nodes[j]!.children ?? []) expect(c).toBeGreaterThan(j);
    }
  });

  it('rests with the soles on the ground and the head above the hips', () => {
    const p = restPositions();
    expect(p[J.hips * 3 + 1]).toBeCloseTo(0.92);
    expect(p[J.footL * 3 + 1]).toBeCloseTo(0.08);
    expect(p[J.head * 3 + 1]).toBeGreaterThan(p[J.hips * 3 + 1]!);
    expect(p[J.handR * 3]).toBeGreaterThan(0);
    expect(p[J.handL * 3]).toBeLessThan(0);
  });

  it('names the five clips with their durations', () => {
    expect(doc.animations.map((a) => a.name)).toEqual([...CLIP_NAMES]);
    for (const clip of doc.animations) {
      expect(clip.duration).toBeCloseTo(
        CLIP_DURATIONS[clip.name as keyof typeof CLIP_DURATIONS],
        4,
      );
      expect(clip.channels.length).toBeGreaterThan(0);
    }
  });

  it('lunges the hips forward in the attack clip', () => {
    const attack = doc.animations.find((a) => a.name === 'attack')!;
    const hips = attack.channels.find((c) => c.node === J.hips && c.path === 'translation')!;
    const n = hips.values.length / 3;
    expect(hips.values[2]).toBeCloseTo(0);
    expect(hips.values[(n - 1) * 3 + 2]).toBeCloseTo(-ATTACK_LUNGE);
  });

  it('skins every vertex with weights that sum to one over valid joints', () => {
    const prim = doc.meshes[0]!.primitives[0]!;
    const joints = prim.joints!;
    const weights = prim.weights!;
    const count = prim.vertexCount;
    expect(joints.length).toBe(count * 4);
    expect(weights.length).toBe(count * 4);
    let blended = 0;
    for (let v = 0; v < count; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = weights[v * 4 + k]!;
        expect(w).toBeGreaterThanOrEqual(0);
        expect(joints[v * 4 + k]).toBeLessThan(JOINT_COUNT);
        sum += w;
      }
      expect(sum).toBeCloseTo(1, 5);
      if (weights[v * 4 + 1]! > 0) blended++;
    }
    expect(blended).toBeGreaterThan(0);
    expect(prim.indices.length % 3).toBe(0);
  });
});
