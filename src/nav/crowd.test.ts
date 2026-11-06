import { describe, expect, it } from 'vitest';
import { createCrowd } from './crowd';

describe('createCrowd', () => {
  it('two agents head-on sidestep and never overlap', () => {
    const crowd = createCrowd({ maxAgents: 2 });
    const a = crowd.add({ x: -5, z: 0, radius: 0.5, maxSpeed: 1.5, prefVelocity: { x: 1, z: 0 } });
    const b = crowd.add({ x: 5, z: 0, radius: 0.5, maxSpeed: 1.5, prefVelocity: { x: -1, z: 0 } });
    expect(a).toBe(0);
    expect(b).toBe(1);
    let minDist = Number.POSITIVE_INFINITY;
    let maxSide = 0;
    for (let i = 0; i < 60 * 12; i++) {
      crowd.update(1 / 60);
      const pa = crowd.agents[a]!;
      const pb = crowd.agents[b]!;
      minDist = Math.min(minDist, Math.hypot(pa.x - pb.x, pa.z - pb.z));
      maxSide = Math.max(maxSide, Math.abs(pa.z), Math.abs(pb.z));
    }
    expect(minDist).toBeGreaterThanOrEqual(1 - 1e-3);
    expect(maxSide).toBeGreaterThan(0.1);
    // Both got past each other.
    expect(crowd.agents[a]!.x).toBeGreaterThan(crowd.agents[b]!.x);
  });

  it('add reuses removed slots and reports a full crowd', () => {
    const crowd = createCrowd({ maxAgents: 2 });
    expect(crowd.add({ x: 0, z: 0, radius: 0.5, maxSpeed: 1 })).toBe(0);
    expect(crowd.add({ x: 1, z: 0, radius: 0.5, maxSpeed: 1 })).toBe(1);
    expect(crowd.add({ x: 2, z: 0, radius: 0.5, maxSpeed: 1 })).toBe(-1);
    crowd.remove(0);
    expect(crowd.agents[0]!.active).toBe(false);
    expect(crowd.add({ x: 2, z: 0, radius: 0.5, maxSpeed: 1 })).toBe(0);
    crowd.setPrefVelocity(0, 1, 0);
    crowd.setPosition(0, 3, 4);
    expect(crowd.agents[0]!.prefX).toBe(1);
    expect(crowd.agents[0]!.x).toBe(3);
    crowd.update(1 / 60);
    expect(crowd.agents[0]!.x).toBeGreaterThan(3);
  });

  it('update on 64 agents allocates nothing after the first call', () => {
    const crowd = createCrowd({ maxAgents: 64 });
    for (let i = 0; i < 64; i++) {
      const ang = (i / 64) * Math.PI * 2;
      crowd.add({
        x: Math.cos(ang) * 10,
        z: Math.sin(ang) * 10,
        radius: 0.4,
        maxSpeed: 2,
        prefVelocity: { x: -Math.cos(ang) * 2, z: -Math.sin(ang) * 2 },
      });
    }
    crowd.update(1 / 60);
    const agents = crowd.agents;
    const objects = agents.slice();
    for (let i = 0; i < 300; i++) crowd.update(1 / 60);
    expect(crowd.agents).toBe(agents);
    for (let i = 0; i < 64; i++) expect(crowd.agents[i]).toBe(objects[i]);
    // Converging on the centre, none pass through another.
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 64; i++) {
      for (let j = i + 1; j < 64; j++) {
        const a = agents[i]!;
        const b = agents[j]!;
        minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    expect(minDist).toBeGreaterThan(0.8 - 0.05);
  });
});
