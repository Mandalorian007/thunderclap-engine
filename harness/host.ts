/**
 * Host-facets harness page (ws/host-mobile): `createGame` over the web host with a widget in the
 * `top` and `bottom` layout regions, so e2e/host.spec.ts can check that the host's safe area
 * pads the layout and that the host's lifecycle stops and resumes frames. Noun-free.
 *
 * `?safe=top,right,bottom,left` replaces the host's `safeArea` with fixed CSS-px insets (a
 * notch and a home indicator, simulated); without it the page's `env()` values are used.
 */
import { createGame } from '@thunderclap-engine/engine';
import { createWebHost, type Host, type HostInsets } from '@thunderclap-engine/engine/host';
import { h } from '@thunderclap-engine/engine/ui';
import type { HarnessHostState } from './host-state';

const root = document.getElementById('root') as HTMLElement;

const state: HarnessHostState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  loopRunning: false,
  lifecycle: 'active',
  lifecycleEvents: [],
  hapticsAvailable: false,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  layoutSafeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  regionsTop: null,
  regionsBottom: null,
  overlay: { x: 0, y: 0, width: 0, height: 0 },
  viewport: { width: innerWidth, height: innerHeight },
};
window.__harnessHost = { state: () => state };

/** The web host, its `safeArea` replaced by the `?safe=` insets when given. */
function harnessHost(): Host {
  const web = createWebHost();
  const safe = new URLSearchParams(location.search).get('safe');
  if (!safe) return web;
  const [top = 0, right = 0, bottom = 0, left = 0] = safe.split(',').map((v) => Number(v) || 0);
  const insets: HostInsets = { top, right, bottom, left };
  return {
    ...web,
    get embed() {
      return web.embed;
    },
    safeArea: { insets: () => insets, watch: () => () => {} },
  };
}

async function main(): Promise<void> {
  const host = harnessHost();
  const ctx = await createGame({
    root,
    title: 'Engine harness',
    host,
    sim: false,
    input: { bindings: { tap: [{ mouse: 0 }] } },
  });
  if (!ctx) {
    state.gpu = 'unsupported';
    state.ready = true;
    return;
  }
  state.gpu = 'ok';
  const { ui, loop, hooks } = ctx;
  const bar = (id: string, text: string) =>
    h('div', { id, style: { padding: '4px 8px', color: '#fff', font: '14px sans-serif' } }, text);
  ui.layout.add(bar('w-top', 'Top'), { place: { default: 'top' } });
  ui.layout.add(bar('w-bottom', 'Bottom'), { place: { default: 'bottom' } });

  const sync = () => {
    state.loopRunning = loop.isRunning;
    state.lifecycle = host.lifecycle?.state ?? 'active';
    state.hapticsAvailable = host.haptics?.available() ?? false;
    state.safeArea = { ...(host.safeArea?.insets() ?? state.safeArea) };
    const s = ui.layout.state;
    state.layoutSafeArea = { ...s.safeArea };
    state.regionsTop = s.regions.top ? { ...s.regions.top } : null;
    state.regionsBottom = s.regions.bottom ? { ...s.regions.bottom } : null;
    const r = ui.root.getBoundingClientRect();
    state.overlay = { x: r.left, y: r.top, width: r.width, height: r.height };
    state.viewport = { width: innerWidth, height: innerHeight };
  };
  hooks.afterRender = () => {
    state.frames++;
    sync();
  };
  hooks.lifecycle = (s) => {
    state.lifecycleEvents.push(s);
    sync();
  };
  ui.layout.onChange(sync);
  ctx.stack.push({});
  loop.start();
  sync();
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
