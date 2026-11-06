import { describe, expect, it } from 'vitest';
import { HAZARD, parseLevel, TILE } from '../levels/format';
import { createBody, type MoverBox, moveBody, touchesKind } from './body';
import {
  COYOTE_TIME,
  createPlayer,
  type Intent,
  JUMP_BUFFER,
  JUMP_SPEED,
  PLAYER_H,
  PLAYER_W,
  stepPlayer,
} from './player';

const DT = 1 / 120;

// A 12x6 room: floor at row 5, a one-way shelf at row 3 cols 4-6, a wall at col 9, spikes at col 11
// row 4. The right-most floor tile (col 10) is air so a body can drop out.
const room = parseLevel('room', 'Room', [
  '            ',
  '            ',
  'p        # x',
  '    ---  #  ',
  '         # ^',
  '########## #',
]);

const noMovers: MoverBox[] = [];
const idle: Intent = { move: 0, jumpPressed: false, jumpHeld: false, dashPressed: false };
const intent = (over: Partial<Intent>): Intent => ({ ...idle, ...over });

function settle(p: ReturnType<typeof createPlayer>, steps = 120): void {
  for (let i = 0; i < steps; i++) stepPlayer(p, idle, room, noMovers, DT);
}

describe('moveBody', () => {
  it('lands on the floor and stops, sub-stepping fast falls', () => {
    const b = createBody(TILE, TILE, PLAYER_W, PLAYER_H);
    b.vy = 4000; // 33 px per step at 120 Hz: more than half a tile, so it sub-steps
    moveBody(b, room, noMovers, 1 / 10); // 400 px, well past the floor
    expect(b.y).toBeCloseTo(5 * TILE - PLAYER_H);
    expect(b.vy).toBe(0);
    expect(b.grounded).toBe(true);
  });

  it('stops at walls and keeps falling', () => {
    const b = createBody(7 * TILE, 5 * TILE - PLAYER_H, PLAYER_W, PLAYER_H);
    b.vx = 2000;
    moveBody(b, room, noMovers, 0.1);
    expect(b.x).toBeCloseTo(9 * TILE - PLAYER_W);
    expect(b.hitWall).toBe(true);
    expect(b.vx).toBe(0);
    expect(b.grounded).toBe(true);
  });

  it('passes up through a one-way platform and lands on it from above', () => {
    const b = createBody(5 * TILE, 4 * TILE, PLAYER_W, PLAYER_H);
    b.vy = -1400;
    moveBody(b, room, noMovers, 0.1); // 140 px up, through row 3
    expect(b.y).toBeLessThan(3 * TILE - PLAYER_H);
    expect(b.hitCeiling).toBe(false);
    // Now fall back onto it.
    b.vy = 900;
    for (let i = 0; i < 30 && !b.grounded; i++) moveBody(b, room, noMovers, DT);
    expect(b.grounded).toBe(true);
    expect(b.y).toBeCloseTo(3 * TILE - PLAYER_H);
  });

  it('does not land on a one-way platform when already below its top', () => {
    const b = createBody(5 * TILE, 3 * TILE - PLAYER_H + 10, PLAYER_W, PLAYER_H);
    b.vy = 300;
    moveBody(b, room, noMovers, DT);
    expect(b.grounded).toBe(false);
  });

  it('is carried by a moving platform it stands on', () => {
    const mover: MoverBox = { x: 2 * TILE, y: 3 * TILE, w: 2 * TILE, h: TILE / 2, dx: 0, dy: 0 };
    const b = createBody(2 * TILE + 20, 2 * TILE, PLAYER_W, PLAYER_H);
    b.vy = 600;
    for (let i = 0; i < 60 && !b.grounded; i++) moveBody(b, room, [mover], DT);
    expect(b.grounded).toBe(true);
    expect(b.riding).toBe(0);
    expect(b.y).toBeCloseTo(3 * TILE - PLAYER_H);
    // The platform moves 3 px right and 1 px up this tick: the body goes with it.
    const x0 = b.x;
    mover.x += 3;
    mover.y -= 1;
    mover.dx = 3;
    mover.dy = -1;
    moveBody(b, room, [mover], DT);
    expect(b.x).toBeCloseTo(x0 + 3);
    expect(b.y).toBeCloseTo(3 * TILE - 1 - PLAYER_H);
    expect(b.riding).toBe(0);
    expect(b.grounded).toBe(true);
  });

  it('reports hazards under the feet', () => {
    const b = createBody(11 * TILE + 12, 4 * TILE, PLAYER_W, PLAYER_H);
    expect(touchesKind(b, room, HAZARD)).toBe(true);
    b.x = 2 * TILE;
    expect(touchesKind(b, room, HAZARD)).toBe(false);
  });
});

describe('stepPlayer', () => {
  it('runs right and stops, with facing', () => {
    const p = createPlayer(TILE, 5 * TILE - PLAYER_H);
    settle(p, 2);
    for (let i = 0; i < 60; i++) stepPlayer(p, intent({ move: 1 }), room, noMovers, DT);
    expect(p.body.vx).toBeGreaterThan(400);
    expect(p.facing).toBe(1);
    expect(p.state).toBe('run');
    for (let i = 0; i < 60; i++) stepPlayer(p, idle, room, noMovers, DT);
    expect(p.body.vx).toBe(0);
    expect(p.state).toBe('idle');
  });

  it('jumps from the ground and reads jump/fall/land states', () => {
    const p = createPlayer(TILE, 5 * TILE - PLAYER_H);
    settle(p, 2);
    stepPlayer(p, intent({ jumpPressed: true, jumpHeld: true }), room, noMovers, DT);
    expect(p.jumped).toBe(true);
    expect(p.state).toBe('jump');
    expect(p.body.vy).toBeLessThan(0);
    let sawFall = false;
    for (let i = 0; i < 240 && !p.body.grounded; i++) {
      stepPlayer(p, intent({ jumpHeld: true }), room, noMovers, DT);
      if (p.state === 'fall') sawFall = true;
    }
    expect(sawFall).toBe(true);
    expect(p.landed).toBe(true);
    expect(p.state).toBe('land');
  });

  it('a released button cuts the jump short (variable height)', () => {
    const apex = (held: boolean): number => {
      const p = createPlayer(TILE, 5 * TILE - PLAYER_H);
      settle(p, 2);
      stepPlayer(p, intent({ jumpPressed: true, jumpHeld: true }), room, noMovers, DT);
      let top = p.body.y;
      for (let i = 0; i < 240 && !p.body.grounded; i++) {
        stepPlayer(p, intent({ jumpHeld: held }), room, noMovers, DT);
        top = Math.min(top, p.body.y);
      }
      return 5 * TILE - PLAYER_H - top;
    };
    const full = apex(true);
    const short = apex(false);
    expect(full).toBeGreaterThan(2.5 * TILE);
    expect(short).toBeLessThan(full * 0.6);
  });

  it('coyote time: a jump just after walking off an edge still fires', () => {
    // Walk off the open floor tile at col 10 (the one before the spikes): start right at its edge.
    const p = createPlayer(10 * TILE - PLAYER_W - 2, 5 * TILE - PLAYER_H);
    settle(p, 2);
    expect(p.body.grounded).toBe(true);
    p.body.vx = 400;
    // Step until the body leaves the ground.
    let n = 0;
    while (p.body.grounded && n++ < 60) stepPlayer(p, intent({ move: 1 }), room, noMovers, DT);
    expect(p.body.grounded).toBe(false);
    // Half the coyote window later, press jump.
    const steps = Math.floor(COYOTE_TIME / 2 / DT);
    for (let i = 0; i < steps; i++) stepPlayer(p, intent({ move: 1 }), room, noMovers, DT);
    stepPlayer(p, intent({ move: 1, jumpPressed: true, jumpHeld: true }), room, noMovers, DT);
    expect(p.jumped).toBe(true);
    expect(p.body.vy).toBeLessThan(-JUMP_SPEED * 0.9);
  });

  it('coyote time expires', () => {
    const p = createPlayer(10 * TILE - PLAYER_W - 2, 5 * TILE - PLAYER_H);
    settle(p, 2);
    p.body.vx = 400;
    let n = 0;
    while (p.body.grounded && n++ < 60) stepPlayer(p, intent({ move: 1 }), room, noMovers, DT);
    const steps = Math.ceil((COYOTE_TIME * 1.5) / DT);
    for (let i = 0; i < steps; i++) stepPlayer(p, intent({ move: 1 }), room, noMovers, DT);
    stepPlayer(p, intent({ move: 1, jumpPressed: true, jumpHeld: true }), room, noMovers, DT);
    expect(p.jumped).toBe(false);
  });

  it('jump buffering: a press shortly before landing jumps on touchdown', () => {
    const p = createPlayer(TILE, 3 * TILE);
    // Fall; press jump when the feet are a little above the floor.
    let pressed = false;
    let jumpedOnLanding = false;
    for (let i = 0; i < 240 && !jumpedOnLanding; i++) {
      const feetGap = 5 * TILE - (p.body.y + PLAYER_H);
      const press = !pressed && feetGap < p.body.vy * JUMP_BUFFER * 0.5 && feetGap > 10;
      if (press) pressed = true;
      stepPlayer(p, intent({ jumpPressed: press, jumpHeld: pressed }), room, noMovers, DT);
      if (p.jumped) jumpedOnLanding = true;
    }
    expect(pressed).toBe(true);
    expect(jumpedOnLanding).toBe(true);
  });

  it('a stale buffered press does not fire', () => {
    const p = createPlayer(TILE, TILE);
    stepPlayer(p, intent({ jumpPressed: true }), room, noMovers, DT); // high in the air
    for (let i = 0; i < 240 && !p.body.grounded; i++) stepPlayer(p, idle, room, noMovers, DT);
    expect(p.body.grounded).toBe(true);
    expect(p.jumped).toBe(false);
  });

  it('rides a moving platform through stepPlayer', () => {
    const mover: MoverBox = { x: 2 * TILE, y: 3 * TILE, w: 2 * TILE, h: TILE / 2, dx: 0, dy: 0 };
    const p = createPlayer(2 * TILE + 20, 2 * TILE);
    for (let i = 0; i < 120 && !p.body.grounded; i++) stepPlayer(p, idle, room, [mover], DT);
    expect(p.body.riding).toBe(0);
    const x0 = p.body.x;
    for (let i = 0; i < 10; i++) {
      mover.x += 2;
      mover.dx = 2;
      stepPlayer(p, idle, room, [mover], DT);
    }
    expect(p.body.x).toBeCloseTo(x0 + 20);
    expect(p.body.grounded).toBe(true);
    expect(p.state).toBe('idle');
  });

  it('dashes in the facing direction and cools down', () => {
    const p = createPlayer(TILE, 5 * TILE - PLAYER_H);
    settle(p, 2);
    stepPlayer(p, intent({ dashPressed: true }), room, noMovers, DT);
    expect(p.dashed).toBe(true);
    expect(p.state).toBe('dash');
    expect(p.body.vx).toBeGreaterThan(1000);
    for (let i = 0; i < 30; i++) stepPlayer(p, idle, room, noMovers, DT);
    expect(p.state).not.toBe('dash');
    expect(p.dashCooldown).toBeGreaterThan(0);
    stepPlayer(p, intent({ dashPressed: true }), room, noMovers, DT);
    expect(p.dashed).toBe(false);
  });
});
