/**
 * Kit page (ws/kit): a 2D toy on the lean kit, `composeGame` with no services at all (no
 * overlay, input, audio, post or particles): a ring of squares orbiting the centre, drawn with
 * `frame.sprite` through the renderer's built-in present.
 *
 * - default: the loop runs on the host's frames (`ctx.loop.start()`).
 * - `?client`: client mode, `loop.frames: 'external'`; the page owns the frames and calls
 *   `ctx.frame(now)` from its own `requestAnimationFrame`, as a networked client's tick would.
 *
 * Nothing here is engine code beyond `@thunderclap-engine/engine/kit` and the 2D renderer.
 */
import { composeGame } from '@thunderclap-engine/engine/kit';
import { type DrawParams, gpuDiagnostics } from '@thunderclap-engine/engine/render';
import type { HarnessKitState } from './kit-state';

const root = document.getElementById('root') as HTMLElement;
const client = new URLSearchParams(location.search).has('client');
const DESIGN = { width: 1280, height: 720 };
const COUNT = 12;

const state: HarnessKitState = {
  mode: client ? 'client' : 'host',
  ready: false,
  gpu: 'pending',
  fields: [],
  postNull: false,
  frames: 0,
  updates: 0,
  driven: 0,
  clockMs: 0,
  gpuErrors: 0,
};
window.__harnessKit = { state };

const squares: DrawParams[] = [];
for (let i = 0; i < COUNT; i++) {
  const hue = i / COUNT;
  squares.push({
    x: 0,
    y: 0,
    w: 36,
    h: 36,
    tint: [0.4 + 0.6 * hue, 0.85 - 0.5 * hue, 0.35 + 0.4 * Math.sin(hue * Math.PI), 1],
  });
}
const hub: DrawParams = {
  x: DESIGN.width / 2,
  y: DESIGN.height / 2,
  w: 64,
  h: 64,
  tint: [0.95, 0.9, 0.8, 1],
};

const core = { root, title: 'Kit', design: DESIGN } as const;
const sim = { step: 1 / 60 };

/** The game, and in client mode the page's way to run a frame (`ctx.frame`). */
async function boot() {
  if (client) {
    const ctx = await composeGame({ ...core, loop: { sim, frames: 'external' } });
    return { ctx, drive: ctx ? (now: number) => ctx.frame(now) : null };
  }
  return { ctx: await composeGame({ ...core, loop: { sim } }), drive: null };
}

try {
  const { ctx, drive } = await boot();
  if (!ctx) {
    state.gpu = 'unsupported';
  } else {
    state.gpu = 'ok';
    state.fields = Object.keys(ctx).sort();
    state.postNull = ctx.renderer.post === null;
    let angle = 0;
    ctx.hooks.update = (dt) => {
      angle += dt * 0.8;
      state.updates++;
      state.clockMs = ctx.clock.now();
    };
    ctx.stack.push({
      name: 'orbit',
      render(frame) {
        frame.sprite(null, hub);
        for (let i = 0; i < COUNT; i++) {
          const a = angle + (i / COUNT) * Math.PI * 2;
          const s = squares[i]!;
          s.x = DESIGN.width / 2 + Math.cos(a) * 240;
          s.y = DESIGN.height / 2 + Math.sin(a) * 240;
          s.rotation = a;
          frame.sprite(null, s);
        }
        state.frames++;
        state.gpuErrors = gpuDiagnostics.errorCount;
      },
    });
    ctx.loop.start();
    if (drive) {
      // Client mode: the page's own frames. `ctx.frame` ignores calls while the loop is stopped.
      const tick = (now: number) => {
        state.driven++;
        drive(now);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }
} catch (err) {
  state.gpu = err instanceof Error ? err.message : String(err);
}
state.ready = true;
