import { describe, expect, it } from 'vitest';
import { createGround, groundHeight, HALF } from '../world/ground';
import {
  angleDelta,
  BODY_RADIUS,
  createController,
  moveController,
  RUN_SPEED,
  stepController,
  WALK_SPEED,
} from './controller';

const ground = createGround();

describe('controller over the heightfield', () => {
  it('walks forward in the camera frame and follows the ground height', () => {
    const c = createController(0, 0, ground);
    const input = { x: 0, y: 1, cameraYaw: 0, sprint: false };
    for (let i = 0; i < 120; i++) stepController(c, input, 1 / 60, ground);
    // Camera yaw 0 looks down -Z: forward is -Z.
    expect(c.position[2]).toBeLessThan(-2);
    expect(Math.abs(c.position[0]!)).toBeLessThan(1e-3);
    expect(c.speed).toBeCloseTo(WALK_SPEED, 1);
    expect(Math.abs(c.yaw)).toBeLessThan(1e-3);
    expect(c.position[1]).toBeCloseTo(groundHeight(ground, c.position[0]!, c.position[2]!), 4);
  });

  it('sprints faster, strafes right of the camera and turns to face its motion', () => {
    const c = createController(0, 0, ground);
    const input = { x: 1, y: 0, cameraYaw: 0, sprint: true };
    for (let i = 0; i < 120; i++) stepController(c, input, 1 / 60, ground);
    expect(c.position[0]).toBeGreaterThan(5);
    expect(c.speed).toBeCloseTo(RUN_SPEED, 1);
    expect(c.yaw).toBeCloseTo(Math.PI / 2, 2);
  });

  it('turns the camera frame with the camera', () => {
    const c = createController(0, 0, ground);
    const input = { x: 0, y: 1, cameraYaw: Math.PI / 2, sprint: false };
    for (let i = 0; i < 60; i++) stepController(c, input, 1 / 60, ground);
    expect(c.position[0]).toBeGreaterThan(0.5);
    expect(Math.abs(c.position[2]!)).toBeLessThan(1e-3);
  });

  it('slows to a stop and does not turn while locked', () => {
    const c = createController(0, 0, ground);
    const run = { x: 0, y: 1, cameraYaw: 0, sprint: true };
    for (let i = 0; i < 60; i++) stepController(c, run, 1 / 60, ground);
    const yaw = c.yaw;
    const turn = { x: 1, y: 0, cameraYaw: 0, sprint: true };
    for (let i = 0; i < 60; i++) stepController(c, turn, 1 / 60, ground, true);
    expect(c.speed).toBe(0);
    expect(c.yaw).toBe(yaw);
  });

  it('stays inside the arena and slides around blocks', () => {
    const c = createController(0, 0, ground);
    moveController(c, 100, 0, ground);
    expect(c.position[0]).toBeCloseTo(HALF - BODY_RADIUS, 4);
    const block = ground.blocks[0]!;
    const cx = (block.min[0] + block.max[0]) / 2;
    const cz = (block.min[2] + block.max[2]) / 2;
    const d = createController(cx, block.min[2] - 2, ground);
    for (let i = 0; i < 90; i++) moveController(d, 0, 0.05, ground);
    expect(d.position[2]).toBeLessThanOrEqual(block.min[2] - BODY_RADIUS + 1e-6);
    expect(d.position[2]).toBeGreaterThan(cz - 3);
    expect(d.position[1]).toBeCloseTo(groundHeight(ground, d.position[0]!, d.position[2]!), 4);
  });

  it('wraps angle differences', () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(angleDelta(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2);
  });
});
