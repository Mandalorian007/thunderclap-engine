/**
 * The character as the arena runs it, without a browser: the renderer sits on the engine's fake
 * GPU and a fixed clock paces the updates, so every run takes the same steps. It checks the game
 * rules that live in `character.ts` (the attack locks the character, connects once, and its root
 * motion carries the body forward) and that each update poses the skin (one `skinPose` call).
 */
import { Renderer } from '@thunderclap-engine/engine/render';
import {
  createFakeDevice,
  createFixedClock,
  fakeRendererGpu,
} from '@thunderclap-engine/engine/testing';
import { describe, expect, it } from 'vitest';
import { createGround } from '../world/ground';
import { createCharacter } from './character';

/** A character on a fake renderer, updated in fixed 60 Hz steps. */
function setup() {
  const fake = createFakeDevice();
  const renderer = new Renderer(fakeRendererGpu(fake));
  const ground = createGround();
  const character = createCharacter(renderer, ground, 0, 4);
  const clock = createFixedClock(1000 / 60);
  const dt = clock.stepMs / 1000;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.step();
      character.update(dt, ground);
    }
  };
  return { fake, renderer, ground, character, clock, tick };
}

describe('character', () => {
  it('poses the skeleton every update: the joint world matrices follow the idle clip', () => {
    const { fake, character, tick } = setup();
    tick();
    const first = character.world.slice();
    expect(first.some((v) => v !== 0)).toBe(true);
    tick(30);
    expect(character.world).not.toEqual(first);
    expect(fake.errors).toEqual([]);
  });

  it('an attack locks the character, connects exactly once and moves it by root motion', () => {
    const { character, clock, tick } = setup();
    tick(10);
    const startZ = character.controller.position[2]!;
    expect(character.attack()).toBe(true);
    tick();
    expect(character.graph.state).toBe('attack');
    // `locked` reads the state as an update begins, so it holds from the next one.
    tick();
    expect(character.locked).toBe(true);
    // A second attack while the first plays is refused.
    expect(character.attack()).toBe(false);

    let swings = 0;
    let swungAt = -1;
    for (let i = 0; i < 180 && character.locked; i++) {
      tick();
      if (character.swung) {
        swings++;
        swungAt = clock.ticks;
      }
    }
    expect(swings).toBe(1);
    expect(swungAt).toBeGreaterThan(12);
    expect(character.locked).toBe(false);
    // The attack lunges forward: facing yaw 0 is -Z, so z shrinks.
    expect(character.controller.position[2]!).toBeLessThan(startZ - 0.05);
  });

  it('renders the body and three cosmetics with no device errors', () => {
    const { fake, renderer, character, tick } = setup();
    tick(5);
    const frame = renderer.beginFrame(0, 1 / 60);
    character.render(frame);
    renderer.endFrame();
    expect(fake.errors).toEqual([]);
    expect(renderer.stats.drawCalls).toBeGreaterThanOrEqual(4);
  });
});
