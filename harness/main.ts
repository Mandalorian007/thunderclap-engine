/**
 * Engine e2e harness page (D-041 addendum 2). Noun-free: it boots the engine's platform layer
 * and nothing else, so the specs in e2e/ verify platform capability once for every game.
 *
 * Today it covers WebGPU init, the surface (letterbox, DPR, resize, swapchain size), one
 * input action and the web host (host-probe.ts: open, copy, fullscreen, storage). Later
 * workstreams add gesture, layout and lifecycle probes here.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { Input } from '@thunderclap-engine/engine/input';
import { boot } from '@thunderclap-engine/engine/platform';
import { createHostProbe } from './host-probe';
import type { HarnessState } from './state';

const root = document.getElementById('root') as HTMLElement;

const state: HarnessState = {
  ready: false,
  gpu: 'pending',
  format: null,
  embedded: window !== window.top,
  frames: 0,
  resizes: 0,
  rect: { x: 0, y: 0, width: 0, height: 0, scale: 0 },
  container: { width: 0, height: 0 },
  backbuffer: { width: 0, height: 0, pixelRatio: 1 },
  presented: { width: 0, height: 0 },
  taps: [],
};
window.__harness = state;
// The host does not need WebGPU: it is up before boot, and on a failed boot too.
window.__host = createHostProbe();

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine harness' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  state.gpu = 'ok';
  state.format = gpu.format;

  surface.onResize(({ rect, backbuffer }) => {
    state.resizes++;
    state.rect = { ...rect };
    state.backbuffer = { ...backbuffer };
    state.container = { width: root.clientWidth, height: root.clientHeight };
  });

  const input = new Input({ tap: [{ mouse: 0 }] });
  input.attach({ pointerTarget: surface.canvas });
  input.setPointerTransform((x, y) => surface.clientToLogical(x, y));

  const loop = new GameLoop({
    update() {
      input.update();
      if (input.pressed('tap')) {
        state.taps.push({ x: input.pointer.x, y: input.pointer.y, device: input.lastDevice });
      }
    },
    render() {
      const texture = gpu.context.getCurrentTexture();
      const encoder = gpu.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView(),
            clearValue: { r: 0.08, g: 0.1, b: 0.16, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.end();
      gpu.device.queue.submit([encoder.finish()]);
      state.presented = { width: texture.width, height: texture.height };
      state.frames++;
    },
  });
  loop.start();
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
