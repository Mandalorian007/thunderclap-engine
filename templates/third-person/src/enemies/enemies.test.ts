import { describe, expect, it } from 'vitest';
import { createGround, groundHeight, HALF } from '../world/ground';
import { createEnemy, ENEMY_RADIUS, pickGoal, stepEnemy } from './enemies';

const ground = createGround();
/** A fixed sequence so the goals are the same every run. */
const seq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('enemy roaming', () => {
  it('walks towards its goal over the ground and stays inside the arena', () => {
    const e = createEnemy('t', 0, 0, ground, seq([0.98, 0.5]));
    const far = new Float32Array([40, 0, 40]);
    const out = new Float32Array(2);
    const start = Math.hypot(e.goal[0]! - e.position[0]!, e.goal[2]! - e.position[2]!);
    for (let i = 0; i < 60; i++) stepEnemy(e, 1 / 60, far, ground, seq([0.1, 0.1]), out);
    const now = Math.hypot(e.goal[0]! - e.position[0]!, e.goal[2]! - e.position[2]!);
    expect(now).toBeLessThan(start - 1);
    expect(Math.abs(e.position[0]!)).toBeLessThanOrEqual(HALF - ENEMY_RADIUS);
    expect(e.position[1]).toBeCloseTo(groundHeight(ground, e.position[0]!, e.position[2]!), 4);
  });

  it('chases a player in range and picks a new goal on arrival', () => {
    const e = createEnemy('t', 0, 0, ground, seq([0.5, 0.5]));
    const near = new Float32Array([3, 0, 0]);
    const out = new Float32Array(2);
    stepEnemy(e, 0.5, near, ground, seq([0.5, 0.5]), out);
    expect(e.position[0]).toBeGreaterThan(0.5);
    // Standing on the goal: the next step re-picks instead of moving.
    const g = new Float32Array(3);
    pickGoal(seq([0.9, 0.2]), g);
    e.goal.set(g);
    e.position[0] = g[0]!;
    e.position[2] = g[2]!;
    const far = new Float32Array([40, 0, 40]);
    stepEnemy(e, 1 / 60, far, ground, seq([0.1, 0.1]), out);
    expect(e.goal[0]).not.toBeCloseTo(g[0]!);
  });

  it('does not move while dying or dead', () => {
    const e = createEnemy('t', 0, 0, ground, seq([0.9, 0.9]));
    e.state = 'dying';
    stepEnemy(e, 1, new Float32Array([3, 0, 0]), ground, seq([0.5]), new Float32Array(2));
    expect(e.position[0]).toBe(0);
  });
});
