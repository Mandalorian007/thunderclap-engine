// @vitest-environment happy-dom
// The world presenter (ws/ui-world): the same presses through the DOM and through ray aim on a
// world panel say the same events and leave the same model; Tab walks the same focus order; an
// idle frame paints nothing and a changed key repaints only its word; a world modal traps focus
// and Escape closes it; a world HUD places its items by region; the lazy screen stays put inside
// its cone and eases back when the view turns past it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PointerRouter, RoutedPointer } from '../../input/pointer-router';
import { createRay, type Ray } from '../../input/rays';
import { Camera } from '../../render/camera';
import { createFakeDevice, fakeRendererGpu } from '../../render/fake-gpu';
import { Renderer } from '../../render/renderer';
import type { PanelRect } from '../world-panel/layout';
import type { PanelCanvas, PanelContext2D } from '../world-panel/paint';
import { createWorldPanel, worldPanelTarget } from '../world-panel/panel';
import { hud, type SpecHud } from './hud';
import { panel, type SpecPanel } from './panel';
import { presentDom } from './present-dom';
import { presentWorld, type WorldPresenter } from './present-world';
import { b, type PanelEvent, type PanelSpec } from './words';
import { presentWorldHud, presentWorldModal, worldScreen } from './world-screen';

/** A Canvas2D stub that counts calls; `measureText` is 8 px per character. */
function stubCanvas(
  width: number,
  height: number,
): PanelCanvas & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const ctx = {
    font: '',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    save: () => count('save'),
    restore: () => count('restore'),
    beginPath: () => count('beginPath'),
    closePath: () => count('closePath'),
    rect: () => count('rect'),
    moveTo: () => count('moveTo'),
    lineTo: () => count('lineTo'),
    arcTo: () => count('arcTo'),
    arc: () => count('arc'),
    fill: () => count('fill'),
    stroke: () => count('stroke'),
    clip: () => count('clip'),
    clearRect: () => count('clearRect'),
    fillRect: () => count('fillRect'),
    fillText: () => count('fillText'),
    measureText: (t: string) => {
      count('measureText');
      return { width: t.length * 8 };
    },
  } satisfies PanelContext2D;
  return { width, height, getContext: () => ctx, calls };
}

const SPEC: PanelSpec = {
  id: 'kit',
  body: {
    k: 'col',
    gap: 6,
    pad: 8,
    children: [
      { k: 'text', text: b('title'), style: 'head' },
      { k: 'button', id: 'use', text: 'Use', w: 100, h: 40 },
      { k: 'button', id: 'mute', text: 'Mute', press: 'toggle', on: b('mute'), w: 100, h: 40 },
      { k: 'button', id: 'go', text: 'Go', press: 'held', w: 100, h: 40 },
      { k: 'range', id: 'vol', min: 0, max: 10, step: 1, value: b('vol'), w: 160, h: 24 },
      { k: 'field', id: 'say', kind: 'chat', value: b('say'), w: 200, h: 36 },
      { k: 'button', id: 'send', text: 'Send', submits: 'say', w: 100, h: 40 },
      { k: 'tabs', id: 'tab', selected: b('tab'), optionW: 60, h: 32 },
    ],
  },
};

function seed(p: SpecPanel): void {
  p.model.setAll({ title: 'Kit', mute: true, vol: 3, say: '', tab: 'one' });
  p.model.setList('tab', ['one', 'two']);
  p.model.row('tab', 'one').set('label', 'One');
  p.model.row('tab', 'two').set('label', 'Two');
}

function ray(origin: [number, number, number], dir: [number, number, number]): Ray {
  const r = createRay();
  r.origin[0] = origin[0];
  r.origin[1] = origin[1];
  r.origin[2] = origin[2];
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  r.dir[0] = dir[0] / len;
  r.dir[1] = dir[1] / len;
  r.dir[2] = dir[2] / len;
  return r;
}

/** A world panel on a fake GPU, attached to a one-pointer router driven by `aim`/`select`. */
function world(width = 4, height = 4, resolution = 100) {
  const fake = createFakeDevice();
  const renderer = new Renderer(fakeRendererGpu(fake));
  const canvas = stubCanvas(width * resolution, height * resolution);
  const surface = createWorldPanel(renderer, { width, height, resolution, canvas });
  const pointer = {
    source: {},
    key: 1,
    device: 'mouse',
    ray: ray([0, 0, 1], [0, 0, -1]),
    select: false,
    hit: null as unknown,
  } as unknown as RoutedPointer & { select: boolean; hit: unknown; ray: Ray };
  const ticks: (() => void)[] = [];
  const router = { pointers: [pointer], camera: null, addTester: () => () => {} };
  surface.attach({
    pointers: router as unknown as PointerRouter<unknown>,
    onUpdated: (fn: () => void) => {
      ticks.push(fn);
      return () => ticks.splice(ticks.indexOf(fn), 1);
    },
  });
  const tick = () => {
    pointer.hit = worldPanelTarget(surface)(pointer.ray);
    for (const t of ticks) t();
  };
  /** Aims the ray at canvas px (x, y) on the panel. */
  const aim = (x: number, y: number) => {
    pointer.ray = ray([x / resolution - width / 2, height / 2 - y / resolution, 1], [0, 0, -1]);
    tick();
  };
  const press = (r: PanelRect, hold?: () => void) => {
    aim(r.x + r.w / 2, r.y + r.h / 2);
    pointer.select = true;
    tick();
    hold?.();
    pointer.select = false;
    tick();
  };
  return { surface, canvas, aim, press, tick };
}

describe('presentWorld', () => {
  let host: HTMLElement;
  let dp: SpecPanel;
  let wp: SpecPanel;
  let w: ReturnType<typeof world>;
  let wv: WorldPresenter;
  let dEvents: PanelEvent[];
  let wEvents: PanelEvent[];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    dp = panel(SPEC, { schedule: null });
    wp = panel(SPEC, { schedule: null });
    dEvents = [];
    wEvents = [];
    dp.onEvent = (e) => dEvents.push(e);
    wp.onEvent = (e) => wEvents.push(e);
    presentDom(dp, host);
    w = world();
    wv = presentWorld(wp, w.surface);
    for (const p of [dp, wp]) {
      seed(p);
      if (p === dp) p.frame(320, 0);
      p.apply();
    }
    w.surface.repaint();
  });

  afterEach(() => {
    dp.dispose();
    wp.dispose();
    host.remove();
  });

  const el = (id: string) => host.querySelector(`[data-tc-id="kit/${id}"]`) as HTMLElement;
  const rect = (id: string, row: string | null = null) => {
    const r = wv.rectOf(id, row);
    expect(r, id).not.toBeNull();
    return r!;
  };
  const say = (e: PanelEvent) => `${e.id}:${e.row ?? ''}:${e.type}:${e.value}`;

  it('the same presses through the DOM and through rays: the same events and model', () => {
    // DOM.
    el('use').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el('mute').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el('go').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    el('go').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    const tabs = host.querySelectorAll('[role=tab]');
    (tabs[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const vol = el('vol') as HTMLInputElement;
    vol.value = '4';
    vol.dispatchEvent(new Event('input', { bubbles: true }));
    const f = el('say') as HTMLInputElement;
    f.value = 'h';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.value = 'hi';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // Rays and the panel's keys.
    w.press(rect('use'));
    w.press(rect('mute'));
    let mid: string[] = [];
    w.press(rect('go'), () => {
      mid = wEvents.map((e) => e.type);
    });
    expect(mid.at(-1)).toBe('down');
    w.press(rect('tab', 'two'));
    w.press(rect('vol'));
    // The ray's press on the range set it where it aimed: put it back, then step it as the DOM did.
    const before = wEvents.filter((e) => e.id === 'vol');
    wp.model.set('vol', 3);
    wp.apply();
    w.surface.key({ key: 'ArrowRight' });
    w.press(rect('say'));
    w.surface.key({ key: 'h' });
    w.surface.key({ key: 'i' });
    w.surface.key({ key: 'Enter' });

    const keep = (e: PanelEvent) => e.type !== 'focus' && e.type !== 'blur' && e.id !== 'vol';
    expect(wEvents.filter(keep).map(say)).toEqual(dEvents.filter(keep).map(say));
    expect(before.every((e) => e.type === 'change')).toBe(true);
    expect(wEvents.filter((e) => e.id === 'vol').at(-1)).toMatchObject({
      type: 'change',
      value: 4,
    });
    expect(dEvents.filter((e) => e.id === 'vol').at(-1)).toMatchObject({
      type: 'change',
      value: 4,
    });
    expect(dEvents.map(say)).toContain('use::tap:null');
    expect(wEvents.filter((e) => e.type === 'focus').map(say)).toEqual(['say::focus:']);
    for (const k of ['say', 'vol']) expect(wp.model.get(k), k).toEqual(dp.model.get(k));
  });

  it('Tab walks the same order as the DOM and wraps', () => {
    const order = wv.focusOrder().map((f) => `${wp.spec.ids[f.i]}:${f.row ?? ''}`);
    // The DOM's tab stops, in document order (the selected tab only).
    const stops = [...host.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]')]
      .filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled)
      .map((e) => {
        const id = e.closest('[data-tc-id]')!.getAttribute('data-tc-id')!.split('/')[1]!;
        return `${id.split(':')[0]}:${e.getAttribute('data-tcs-row') ?? ''}`;
      });
    expect(order).toEqual(stops);
    wv.focusFirst();
    const seen: string[] = [];
    for (let i = 0; i <= order.length; i++) {
      seen.push(`${wv.focusId.id}:${wv.focusId.row ?? ''}`);
      w.surface.key({ key: 'Tab' });
    }
    expect(seen.slice(0, order.length)).toEqual(order);
    expect(seen.at(-1)).toBe(order[0]);
  });

  it('an idle frame paints nothing; a changed key repaints only its word', () => {
    w.surface.repaint();
    const fills = w.canvas.calls.fillText ?? 0;
    const paints = wv.paints;
    for (let i = 0; i < 10; i++) {
      wp.apply();
      w.surface.repaint();
    }
    expect(wv.paints).toBe(paints);
    expect(w.canvas.calls.fillText ?? 0).toBe(fills);
    wp.model.set('title', 'Pack');
    wp.apply();
    const t = rect('use');
    // Only the title's box (above `use`) is dirty: the repaint clip stops short of the buttons.
    w.surface.repaint();
    expect(w.surface.paintClip.y + w.surface.paintClip.h).toBeLessThanOrEqual(t.y);
    expect(wv.paints).toBe(paints + 1);
  });
});

describe('the world screen', () => {
  function screen() {
    const fake = createFakeDevice();
    const renderer = new Renderer(fakeRendererGpu(fake));
    return worldScreen(renderer, { resolution: 200, canvas: stubCanvas(320, 180) });
  }

  it('lazy: stays put inside its cone, eases back in front once the view turns past it', () => {
    const s = screen();
    const cam = Camera.perspective(1, 1, 0.1, 100);
    cam.lookAt([0, 0, 0], [0, 0, -1]);
    s.update(cam);
    const at = () => {
      const p = s.transform.position;
      return [p.x, p.y, p.z];
    };
    const start = at();
    expect(start[2]).toBeCloseTo(-1.2);
    // A small turn (about 11°): the screen stays.
    cam.lookAt([0, 0, 0], [0.2, 0, -1]);
    s.update(cam);
    expect(at()).toEqual(start);
    expect(s.following).toBe(false);
    // A big one (45°): it follows, a share per update, and settles in front.
    cam.lookAt([0, 0, 0], [1, 0, -1]);
    s.update(cam);
    expect(s.following).toBe(true);
    const one = at();
    expect(one[0]).toBeGreaterThan(0);
    expect(one[0]).toBeLessThan(1.2 * Math.SQRT1_2);
    for (let i = 0; i < 200; i++) s.update(cam);
    const end = at();
    expect(Math.hypot(end[0]!, end[1]!, end[2]!)).toBeCloseTo(1.2);
    expect(Math.atan2(end[0]!, -end[2]!)).toBeGreaterThan(Math.PI / 4 - 0.36);
    expect(s.following).toBe(false);
  });

  it('a world modal: centred, focus kept in it, Escape closes it', () => {
    const s = screen();
    const p = panel(SPEC, { schedule: null });
    seed(p);
    p.frame(0, 0);
    let why = '';
    const m = presentWorldModal(s, p, { onClose: (r) => (why = r) });
    s.repaint();
    const r = m.presenter.widget.layoutRect;
    expect(Math.abs(r.x + r.w / 2 - s.pxWidth / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.y + r.h / 2 - s.pxHeight / 2)).toBeLessThanOrEqual(1);
    const n = m.presenter.focusOrder().length;
    const first = m.presenter.focusId.id;
    for (let i = 0; i < n; i++) s.key({ key: 'Tab' });
    expect(m.presenter.focusId.id).toBe(first);
    s.key({ key: 'Escape' });
    expect(m.open).toBe(false);
    expect(why).toBe('escape');
    p.dispose();
  });

  it('a world hud places its items by region', () => {
    const s = screen();
    const small = (id: string): PanelSpec => ({
      id,
      body: { k: 'button', id: 'b', text: id, w: 80, h: 30 },
    });
    const h: SpecHud = hud(
      {
        items: [
          { spec: small('top'), place: { default: 'top' } },
          { spec: small('bot'), place: { default: 'bottom' } },
          { spec: small('lft'), place: { default: 'left' } },
          { spec: small('rgt'), place: { default: 'right', desktop: 'right' } },
          { spec: small('off'), place: { default: 'hidden' } },
        ],
      },
      { schedule: null },
    );
    const v = presentWorldHud(h, s, { margin: 10 });
    s.repaint();
    expect(v.presenters.length).toBe(4);
    const [top, bot, lft, rgt] = v.presenters.map((p) => p.widget.layoutRect);
    expect(top!.y).toBe(10);
    expect(Math.abs(top!.x + top!.w / 2 - s.pxWidth / 2)).toBeLessThanOrEqual(1);
    expect(bot!.y + bot!.h).toBe(s.pxHeight - 10);
    expect(lft!.x).toBe(10);
    expect(rgt!.x + rgt!.w).toBe(s.pxWidth - 10);
    expect(lft!.y).toBeGreaterThanOrEqual(top!.y + top!.h);
    v.dispose();
  });
});
