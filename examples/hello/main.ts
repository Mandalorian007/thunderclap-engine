/**
 * The smallest ThunderClap game: one scene, one glowing square that spins, and a click (or tap)
 * that makes it flare. Run it with `pnpm example`.
 */
import { createGame } from '@thunderclap-engine/engine';
import type { Scene } from '@thunderclap-engine/engine/core';
import { type DrawParams, type Frame, hex } from '@thunderclap-engine/engine/render';
import { createSaveStore, s } from '@thunderclap-engine/engine/save';

const ctx = await createGame({
  root: document.getElementById('app')!,
  title: 'Hello ThunderClap',
  save: (host) =>
    createSaveStore({
      game: 'hello',
      slot: 'main',
      version: 1,
      defaults: () => ({ flares: 0 }),
      schema: s.object({ flares: s.number() }),
      host,
    }),
  input: { bindings: { flare: [{ mouse: 0 }, { key: 'Space' }] } },
});

if (ctx) {
  const square: DrawParams = { x: 960, y: 540, w: 240, h: 240, rotation: 0, emissive: 1 };
  let glow = 1;

  const hello: Scene<typeof ctx, Frame> = {
    name: 'hello',
    update(dt) {
      square.rotation = (square.rotation ?? 0) + dt;
      if (ctx.input.pressed('flare')) {
        glow = 4;
        ctx.save.update((d) => ({ flares: d.flares + 1 }));
      }
      glow += (1 - glow) * Math.min(1, dt * 3);
    },
    render(frame) {
      frame.clear(0.02, 0.02, 0.04);
      square.tint = hex('#3fe0ff', glow);
      frame.sprite(null, square);
    },
  };

  ctx.stack.push(hello);
  ctx.loop.start();
}
