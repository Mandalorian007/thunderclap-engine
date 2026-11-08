/**
 * Cover-fit harness page (#1): `createGame({ surface: { fit } })` with the band a 16:9 game keeps
 * on a phone (the middle 1920×720) and `belowScale: PHONE_SCALE`, so phones cover and larger
 * screens letterbox. One empty scene and one `tap` action. Probed by e2e/cover.spec.ts: the
 * canvas covers a phone with no bars, the visible rect stays within the band, a tap lands on
 * the right logical point, the overlay frame and `Camera.fitFreeRect` follow the covered canvas,
 * and a game's select rule beats the engine's zoomed-select rules (#3).
 */
import { createGame } from '@thunderclap-engine/engine';
import { PHONE_SCALE } from '@thunderclap-engine/engine/platform';
import { Camera } from '@thunderclap-engine/engine/render';
import { select } from '@thunderclap-engine/engine/ui';
import type { HarnessCoverState } from './cover-state';

const root = document.getElementById('root') as HTMLElement;
const BAND = 720;
const zero = () => ({ x: 0, y: 0, width: 0, height: 0 });

const state: HarnessCoverState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  band: BAND,
  rect: { ...zero(), scale: 0 },
  fitRect: { ...zero(), scale: 0 },
  visible: zero(),
  container: { width: 0, height: 0 },
  canvasBox: zero(),
  hudBox: zero(),
  fitCorners: { left: 0, top: 0, right: 0, bottom: 0 },
  freeRect: zero(),
  formFactor: null,
  taps: [],
  selects: { gamePadding: '', enginePadding: '', engineExpected: '' },
};
let sync = () => {};
window.__harnessCover = () => {
  sync();
  return state;
};

function box(el: Element): HarnessCoverState['canvasBox'] {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

async function main(): Promise<void> {
  const ctx = await createGame({
    root,
    title: 'Engine harness',
    sim: false,
    surface: { fit: { minVisibleHeight: BAND, belowScale: PHONE_SCALE } },
    input: { bindings: { tap: [{ mouse: 0 }] } },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  state.gpu = 'ok';
  const { surface, ui, input } = ctx;

  // The select probe: a raw select under a game class, and the engine's widget.
  const probe = document.createElement('div');
  probe.className = 'cover-probe';
  probe.style.cssText = 'position:absolute;left:40%;top:45%;pointer-events:none';
  const raw = document.createElement('select');
  raw.append(new Option('raw', 'raw'));
  // The reference: what the engine's widget drew before #3, set inline in the same context.
  const ref = document.createElement('select');
  ref.append(new Option('ref', 'ref'));
  ref.style.paddingTop = 'calc(var(--tc-space-2) / var(--tc-zoom, 1))';
  probe.append(raw, ref);
  const widget = select('Engine', [{ value: 'a', label: 'A' }], 'a', () => {});
  widget.element.style.cssText = 'position:absolute;left:40%;top:55%;pointer-events:none';
  ui.layers.hud.append(probe, widget.element);

  const cam = Camera.ortho2d(surface.logicalWidth, surface.logicalHeight);
  const design = { x: 0, y: 0, width: surface.logicalWidth, height: surface.logicalHeight };
  sync = () => {
    state.rect = { ...surface.rect };
    state.fitRect = { ...surface.fitRect };
    state.visible = { ...(surface.visibleRect ?? zero()) };
    state.container = { width: root.clientWidth, height: root.clientHeight };
    state.canvasBox = box(surface.canvas);
    state.hudBox = box(ui.layers.hud);
    const free = ui.layout.freeRect;
    state.freeRect = { x: free.x, y: free.y, width: free.width, height: free.height };
    cam.fitFreeRect(design, free, surface);
    const tl = cam.worldToScreen(0, 0, 0);
    const a = surface.logicalToClient(tl.x, tl.y);
    const corners = { left: a.x, top: a.y, right: 0, bottom: 0 };
    const br = cam.worldToScreen(design.width, design.height, 0);
    const b = surface.logicalToClient(br.x, br.y);
    corners.right = b.x;
    corners.bottom = b.y;
    state.fitCorners = corners;
    state.formFactor = ui.root.getAttribute('data-form-factor');
    state.selects = {
      gamePadding: getComputedStyle(raw).paddingTop,
      enginePadding: getComputedStyle(widget.select).paddingTop,
      engineExpected: getComputedStyle(ref).paddingTop,
    };
  };
  ctx.hooks.frame = () => {
    if (input.pressed('tap')) state.taps.push({ x: input.pointer.x, y: input.pointer.y });
  };
  ctx.hooks.afterRender = () => {
    state.frames++;
  };
  ctx.stack.push({});
  ctx.loop.start();
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
