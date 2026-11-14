/**
 * Kit page (ws/kit): a 2D toy on the lean kit, `composeGame` with no services at all (no
 * overlay, input, audio, post or particles): a ring of squares orbiting the centre, drawn with
 * `frame.sprite` through the renderer's built-in present.
 *
 * - default: the loop runs on the host's frames (`ctx.loop.start()`).
 * - `?client`: client mode, `loop.frames: 'external'`; the page owns the frames and calls
 *   `ctx.frame(now)` from its own `requestAnimationFrame`, as a networked client's tick would.
 *
 * - `?own` (ws/kit-fit): the page's own renderer (`KitOptions.renderer`, a `KitRenderer` that
 *   clears the canvas with raw WebGPU); `?none`: `renderer: null`, the page draws the same in
 *   `hooks.render`. Either way the kit still runs the loop, the lifecycle and device loss.
 * - `&fill`: the surface's `fit: 'fill'`, the whole window with no design size and no bars.
 *
 * Nothing here is engine code beyond `@thunderclap-engine/engine/kit` and the 2D renderer.
 */
import { composeGame, type KitRenderer } from '@thunderclap-engine/engine/kit';
import type { GpuContext } from '@thunderclap-engine/engine/platform';
import { type DrawParams, gpuDiagnostics } from '@thunderclap-engine/engine/render';
import type { HarnessKitState } from './kit-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const client = params.has('client');
const rendererMode = params.has('own') ? 'own' : params.has('none') ? 'none' : 'engine';
const fill = params.has('fill');
/** What the page's own renderer clears to: a teal, unlike the page background and the 2D toy. */
const CLEAR = [0.1, 0.55, 0.45];
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
  renderer: rendererMode,
  fill,
  ownFrames: 0,
  resized: [],
  rendererNull: false,
  clear: CLEAR.map((c) => Math.round(c * 255)),
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

/** The page's own renderer: one cleared pass per frame, straight on the canvas's context. */
function clearFrame(gpu: GpuContext): void {
  const enc = gpu.device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [
      {
        view: gpu.context.getCurrentTexture().createView(),
        clearValue: { r: CLEAR[0]!, g: CLEAR[1]!, b: CLEAR[2]!, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });
  pass.end();
  gpu.device.queue.submit([enc.finish()]);
  state.ownFrames++;
  state.frames++;
}

function ownRenderer(gpu: GpuContext): KitRenderer {
  return {
    resize(w, h) {
      state.resized = [w, h];
    },
    render() {
      clearFrame(gpu);
    },
  };
}

const core = {
  root,
  title: 'Kit',
  design: DESIGN,
  ...(fill ? { surface: { fit: 'fill' as const } } : {}),
};
const sim = { step: 1 / 60 };

/** The game, and in client mode the page's way to run a frame (`ctx.frame`). */
async function boot() {
  if (rendererMode !== 'engine') {
    const ctx = await composeGame({
      ...core,
      loop: { sim },
      renderer: rendererMode === 'own' ? ownRenderer : null,
    });
    if (ctx && rendererMode === 'none') {
      state.rendererNull = ctx.renderer === null;
      ctx.hooks.render = () => clearFrame(ctx.gpu);
    }
    return { ctx, drive: null, own: true as const };
  }
  if (client) {
    const ctx = await composeGame({ ...core, loop: { sim, frames: 'external' } });
    return { ctx, drive: ctx ? (now: number) => ctx.frame(now) : null, own: false as const };
  }
  return { ctx: await composeGame({ ...core, loop: { sim } }), drive: null, own: false as const };
}

try {
  const { ctx, drive, own } = await boot();
  if (!ctx) {
    state.gpu = 'unsupported';
  } else if (own) {
    // The page draws (its own renderer or `hooks.render`); the kit runs the loop.
    state.gpu = 'ok';
    state.fields = Object.keys(ctx).sort();
    ctx.hooks.update = () => {
      state.updates++;
      state.clockMs = ctx.clock.now();
    };
    ctx.loop.start();
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
