import { describe, expect, it } from 'vitest';
import type { PointerRouter, RoutedPointer } from '../../input/pointer-router';
import { createRay, type Ray } from '../../input/rays';
import { Camera } from '../../render/camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from '../../render/fake-gpu';
import type { Frame } from '../../render/frame';
import { Renderer } from '../../render/renderer';
import { flowLayout, type PanelRect } from './layout';
import type { PanelCanvas, PanelContext2D } from './paint';
import {
  createWorldPanel,
  type WorldPanel,
  type WorldPanelOptions,
  worldPanelTarget,
} from './panel';
import { button, label, list, progress, slider, toggle } from './widgets';

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

function make(opts: Partial<WorldPanelOptions> = {}) {
  const fake = createFakeDevice();
  const renderer = new Renderer(fakeRendererGpu(fake));
  const width = opts.width ?? 2;
  const height = opts.height ?? 1;
  const resolution = opts.resolution ?? 100;
  const canvas = stubCanvas(width * resolution, height * resolution);
  const panel = createWorldPanel(renderer, { width, height, resolution, canvas, ...opts });
  return { fake, renderer, panel, canvas };
}

function prepare(
  fake: FakeDevice,
  panel: WorldPanel,
  depth: GPUTextureFormat | null = 'depth24plus',
) {
  const frame = { depthFormat: depth } as Frame;
  const enc = fake.device.createCommandEncoder();
  panel.prepare(enc, frame);
  const pass = enc.beginRenderPass({ colorAttachments: [] });
  panel.draw(pass, frame);
  pass.end();
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

const centre = (r: PanelRect) => [r.x + r.w / 2, r.y + r.h / 2] as const;

describe('flow layout', () => {
  it('stacks widgets top to bottom with padding and gap, and leaves explicit rects alone', () => {
    const { panel } = make();
    const a = panel.add(label({ text: 'a' }));
    const b = panel.add(button({ text: 'b' }));
    const c = panel.add(progress({ value: 0.5, rect: { x: 5, y: 7, w: 20, h: 4 } }));
    const d = panel.add(toggle({ text: 'd', value: false }));
    panel.repaint();
    const t = panel.theme;
    expect(a.layoutRect.x).toBe(t.space3);
    expect(a.layoutRect.y).toBe(t.space3);
    expect(a.layoutRect.w).toBe(panel.pxWidth - t.space3 * 2);
    expect(b.layoutRect.y).toBe(a.layoutRect.y + a.layoutRect.h + t.space2);
    expect(c.layoutRect).toEqual({ x: 5, y: 7, w: 20, h: 4 });
    // The explicit-rect widget takes no row: d follows b.
    expect(d.layoutRect.y).toBe(b.layoutRect.y + b.layoutRect.h + t.space2);
    expect(panel.widgets).toEqual([a, b, c, d]);
  });

  it('flowLayout returns the content height and handles an empty list', () => {
    const items = [
      { rect: null, measure: () => 10, layoutRect: { x: 0, y: 0, w: 0, h: 0 } },
      { rect: null, measure: () => 20, layoutRect: { x: 0, y: 0, w: 0, h: 0 } },
    ];
    expect(flowLayout(items, { width: 100, padding: 4, gap: 2 })).toBe(4 + 10 + 2 + 20 + 4);
    expect(items[1]!.layoutRect).toEqual({ x: 4, y: 16, w: 92, h: 20 });
    expect(flowLayout([], { width: 100, padding: 4, gap: 2 })).toBe(8);
  });
});

describe('dirty tracking and uploads', () => {
  it('a same-value set is not dirty; a changed value is', () => {
    const { fake, panel } = make();
    const b = panel.add(button({ text: 'Go' }));
    const s = panel.add(slider({ min: 0, max: 1, value: 0.5 }));
    prepare(fake, panel);
    expect(panel.dirty).toBe(false);
    expect(b.set({ text: 'Go' })).toBe(false);
    expect(s.set({ value: 0.5, min: 0 })).toBe(false);
    expect(panel.dirty).toBe(false);
    expect(b.set({ text: 'Stop' })).toBe(true);
    expect(panel.dirty).toBe(true);
  });

  it('uploads once per prepare while dirty and not at all after', () => {
    const { fake, panel } = make();
    panel.add(label({ text: 'hi' }));
    expect(panel.stats.uploads).toBe(0);
    prepare(fake, panel);
    expect(panel.stats.uploads).toBe(1);
    expect(panel.stats.repaints).toBe(1);
    expect(panel.stats.bytes).toBe(panel.pxWidth * panel.pxHeight * 4);
    for (let i = 0; i < 5; i++) prepare(fake, panel);
    expect(panel.stats.uploads).toBe(1);
    expect(panel.stats.repaints).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('repaints only the dirty widget rect and uploads that rect', () => {
    const { fake, panel, canvas } = make();
    // The label sits well below the button's focus-ring margin, so the button's rect misses it.
    panel.add(label({ text: 'a', rect: { x: 10, y: 80, w: 100, h: 16 } }));
    const b = panel.add(button({ text: 'b' }));
    prepare(fake, panel);
    const before = panel.stats.bytes;
    const texts = canvas.calls.fillText ?? 0;
    expect(texts).toBe(2);
    b.set({ text: 'c' });
    // Two sets in one frame: still one repaint and one upload.
    b.set({ text: 'd' });
    prepare(fake, panel);
    expect(panel.stats.uploads).toBe(2);
    expect(panel.stats.repaints).toBe(2);
    const ring = panel.theme.focusRing + 1;
    const r = b.layoutRect;
    expect(panel.stats.bytes - before).toBe((r.w + ring * 2) * (r.h + ring * 2) * 4);
    // The label was not painted again: one text, the button's.
    expect((canvas.calls.fillText ?? 0) - texts).toBe(1);
  });

  it('draws one quad with the depth pipeline, or the flat one without depth', () => {
    const { fake, panel } = make();
    panel.add(label({ text: 'x' }));
    prepare(fake, panel, 'depth24plus');
    expect(panel.draws).toBe(1);
    const cmds = fake.passes.at(-1)!.commands.map((c) => c.op);
    expect(cmds).toContain('setPipeline');
    expect(cmds).toContain('draw');
    prepare(fake, panel, null);
    expect(panel.draws).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('dispose destroys the texture and the uniform buffer', () => {
    const { fake, panel } = make();
    prepare(fake, panel);
    const tex = fake.textures.find((t) => t.label === 'world-panel-texture')!;
    expect(tex.destroyed).toBe(false);
    panel.dispose();
    expect(tex.destroyed).toBe(true);
    expect(fake.buffers.find((b) => b.label === 'world-panel-uniform')!.destroyed).toBe(true);
    prepare(fake, panel);
    expect(panel.draws).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('a head-locked panel defaults to no depth test; depthTest overrides', () => {
    const a = make({ headLocked: { distance: 2 } }).panel;
    expect(a.depthTest).toBe(false);
    const b = make({ headLocked: { distance: 2 }, depthTest: true }).panel;
    expect(b.depthTest).toBe(true);
    expect(make().panel.depthTest).toBe(true);
  });
});

describe('widgets', () => {
  it('a button fires onPress on the release, not the press, and not when released outside', () => {
    const { panel } = make();
    let presses = 0;
    const b = panel.add(
      button({
        text: 'Go',
        onPress: () => {
          presses++;
        },
      }),
    );
    panel.repaint();
    const [x, y] = centre(b.layoutRect);
    panel.pointerDown(x, y);
    expect(presses).toBe(0);
    expect(b.pressed).toBe(true);
    expect(panel.focused).toBe(b);
    panel.pointerUp(x, y);
    expect(presses).toBe(1);
    expect(b.pressed).toBe(false);
    panel.pointerDown(x, y);
    panel.pointerUp(x, 1000);
    expect(presses).toBe(1);
    b.set({ disabled: true });
    panel.pointerDown(x, y);
    panel.pointerUp(x, y);
    expect(presses).toBe(1);
  });

  it('a toggle flips on release and on activate, reporting onChange', () => {
    const { panel } = make();
    const seen: boolean[] = [];
    const t = panel.add(toggle({ text: 'Sound', value: false, onChange: (v) => seen.push(v) }));
    panel.repaint();
    const [x, y] = centre(t.layoutRect);
    panel.pointerDown(x, y);
    panel.pointerUp(x, y);
    expect(t.options.value).toBe(true);
    panel.activate();
    expect(t.options.value).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('a slider follows a drag by the dragged fraction of its track, snapped to step', () => {
    const { panel } = make({ width: 4, height: 1, resolution: 100 });
    const seen: number[] = [];
    const s = panel.add(
      slider({ min: 0, max: 100, value: 50, step: 5, onChange: (v) => seen.push(v) }),
    );
    panel.repaint();
    const r = s.layoutRect;
    const inset = panel.theme.space3;
    const track = r.w - inset * 2;
    const y = r.y + r.h / 2;
    const x0 = r.x + inset + track * 0.5;
    panel.pointerDown(x0, y);
    expect(s.options.value).toBe(50);
    panel.pointerMove(x0 + track * 0.25, y);
    expect(s.options.value).toBe(75);
    panel.pointerMove(x0 + track, y);
    expect(s.options.value).toBe(100);
    panel.pointerUp(x0 - track * 0.3, y);
    expect(s.options.value).toBe(20);
    expect(seen).toEqual([75, 100, 20]);
    // Keys step by `step`.
    expect(panel.key({ key: 'ArrowRight' })).toBe(true);
    expect(s.options.value).toBe(25);
    expect(panel.key({ key: 'ArrowLeft' })).toBe(true);
    expect(s.options.value).toBe(20);
  });

  it('a list scrolls by wheel and drag, clamped to its rows, and selects on tap', () => {
    const { panel } = make({ width: 2, height: 2 });
    const items = Array.from({ length: 10 }, (_, i) => `item ${i}`);
    const selected: number[] = [];
    const l = panel.add(list({ items, visibleRows: 4, onSelect: (i) => selected.push(i) }));
    panel.repaint();
    const rh = l.rowHeight;
    expect(l.maxScroll).toBe(6 * rh);
    const r = l.layoutRect;
    const [cx] = centre(r);
    expect(panel.wheel(cx, r.y + 1, 10_000)).toBe(true);
    expect(l.scroll).toBe(6 * rh);
    panel.wheel(cx, r.y + 1, -10_000);
    expect(l.scroll).toBe(0);
    // A drag of a row and a half scrolls, and selects nothing.
    panel.pointerDown(cx, r.y + rh * 3);
    panel.pointerMove(cx, r.y + rh * 1.5);
    expect(l.scroll).toBe(rh * 1.5);
    panel.pointerUp(cx, r.y + rh * 1.5);
    expect(selected).toEqual([]);
    expect(l.options.selected).toBe(-1);
    // A tap on the third visible row selects, through the scroll.
    const tapY = r.y + panel.theme.borderWidth + rh * 2.5;
    panel.pointerDown(cx, tapY);
    panel.pointerUp(cx, tapY);
    expect(l.options.selected).toBe(l.rowAt(tapY));
    expect(selected).toEqual([l.options.selected]);
    // Arrow keys move the selection and keep it visible.
    l.select(0);
    l.setScroll(0);
    for (let i = 0; i < 5; i++) panel.key({ key: 'ArrowDown' });
    expect(l.options.selected).toBe(5);
    expect(l.scroll).toBe(2 * rh);
    // Shrinking the items clamps the scroll.
    l.set({ items: items.slice(0, 5) });
    expect(l.scroll).toBeLessThanOrEqual(l.maxScroll);
  });

  it('focusNext/focusPrev skip labels, wrap, and Tab/Enter drive them', () => {
    const { panel } = make();
    let pressed = 0;
    panel.add(label({ text: 'title' }));
    const b1 = panel.add(
      button({
        text: 'one',
        onPress: () => {
          pressed++;
        },
      }),
    );
    panel.add(progress({ value: 0.2 }));
    const b2 = panel.add(button({ text: 'two', disabled: true }));
    const t = panel.add(toggle({ text: 'three', value: false }));
    expect(panel.focusNext()).toBe(b1);
    expect(panel.focusNext()).toBe(t);
    expect(panel.focusNext()).toBe(b1);
    expect(panel.focusPrev()).toBe(t);
    expect(panel.key({ key: 'Tab', shiftKey: true })).toBe(true);
    expect(panel.focused).toBe(b1);
    expect(panel.key({ key: 'Enter' })).toBe(true);
    expect(pressed).toBe(1);
    panel.focus(b2);
    expect(panel.focused).toBe(b1);
    panel.remove(b1);
    expect(panel.focused).toBeNull();
    expect(panel.key({ key: 'Enter' })).toBe(false);
  });

  it('hover follows the pointer and leaves', () => {
    const { panel } = make();
    const b = panel.add(button({ text: 'x' }));
    panel.repaint();
    const [x, y] = centre(b.layoutRect);
    panel.pointerMove(x, y);
    expect(panel.hovered).toBe(b);
    expect(b.hover).toBe(true);
    expect(panel.dirty).toBe(true);
    panel.pointerMove(x, 1000);
    expect(panel.hovered).toBeNull();
    panel.pointerMove(x, y);
    panel.pointerLeave();
    expect(b.hover).toBe(false);
  });
});

describe('hit testing', () => {
  it('maps a ray onto panel px for a placed, scaled panel and misses beside it', () => {
    const { panel } = make({ width: 2, height: 1, resolution: 100 });
    panel.transform.setPosition(0, 0, -5);
    // A ray straight at the panel's upper-right quarter: local (0.5, 0.25).
    let h = panel.hitTest(ray([0.5, 0.25, 0], [0, 0, -1]));
    expect(h).not.toBeNull();
    expect(h!.x).toBeCloseTo(150);
    expect(h!.y).toBeCloseTo(25);
    expect(h!.distance).toBeCloseTo(5);
    expect(h!.widget).toBeNull();
    // Beside it, behind it, and parallel to it: misses.
    expect(panel.hitTest(ray([1.5, 0, 0], [0, 0, -1]))).toBeNull();
    expect(panel.hitTest(ray([0, 0, -8], [0, 0, -1]))).toBeNull();
    expect(panel.hitTest(ray([0, 0, 0], [1, 0, 0]))).toBeNull();
    // Scaled twice: world x 1.5 is local 0.75 → px 175.
    panel.transform.setScale(2, 2, 1);
    h = panel.hitTest(ray([1.5, -0.5, 0], [0, 0, -1]));
    expect(h!.x).toBeCloseTo(175);
    expect(h!.y).toBeCloseTo(75);
    // Turned to face +x: hit from the side, distance in world units.
    panel.transform.setScale(1, 1, 1);
    panel.transform.setAxisAngle(0, 1, 0, Math.PI / 2);
    h = panel.hitTest(ray([3, 0, -5], [-1, 0, 0]));
    expect(h).not.toBeNull();
    expect(h!.distance).toBeCloseTo(3);
    expect(h!.x).toBeCloseTo(100);
    expect(h!.y).toBeCloseTo(50);
  });

  it('names the widget under the hit', () => {
    const { panel } = make();
    const b = panel.add(button({ text: 'x' }));
    panel.repaint();
    const [px, py] = centre(b.layoutRect);
    const lx = px / panel.resolution - panel.width / 2;
    const ly = panel.height / 2 - py / panel.resolution;
    const h = panel.hitTest(ray([lx, ly, 1], [0, 0, -1]));
    expect(h?.widget).toBe(b);
  });

  it('worldPanelTarget gives the router a hit with point, facing normal and distance', () => {
    const { panel } = make();
    panel.transform.setPosition(0, 0, -5);
    const tester = worldPanelTarget(panel);
    const hit = tester(ray([0.5, 0, 0], [0, 0, -1]));
    expect(hit).not.toBeNull();
    expect(hit!.target).toBe(panel);
    expect(hit!.distance).toBeCloseTo(5);
    expect(Array.from(hit!.point)).toEqual([0.5, 0, -5]);
    expect(Array.from(hit!.normal!)).toEqual([0, 0, 1]);
    // From behind, the normal faces the ray too.
    const back = tester(ray([0, 0, -9], [0, 0, 1]));
    expect(Array.from(back!.normal!).map((v) => v + 0)).toEqual([0, 0, -1]);
    expect(tester(ray([5, 0, 0], [0, 0, -1]))).toBeNull();
  });

  it('poll drives press and release from the router pointers', () => {
    const { panel } = make();
    let presses = 0;
    const b = panel.add(
      button({
        text: 'x',
        onPress: () => {
          presses++;
        },
      }),
    );
    panel.repaint();
    panel.transform.setPosition(0, 0, -5);
    const [px, py] = centre(b.layoutRect);
    const lx = px / panel.resolution - panel.width / 2;
    const ly = panel.height / 2 - py / panel.resolution;
    const source = {};
    const hit = worldPanelTarget(panel)(ray([lx, ly, 0], [0, 0, -1]));
    const p = {
      source,
      key: 1,
      device: 'mouse',
      ray: ray([lx, ly, 0], [0, 0, -1]),
      select: false,
      hit,
    } as unknown as RoutedPointer & { select: boolean; hit: unknown; ray: Ray };
    panel.poll([p]);
    expect(panel.hovered).toBe(b);
    p.select = true;
    panel.poll([p]);
    expect(b.pressed).toBe(true);
    expect(presses).toBe(0);
    p.select = false;
    panel.poll([p]);
    expect(presses).toBe(1);
    expect(b.pressed).toBe(false);
    // Press, then the pointer leaves the panel (a touch lifting elsewhere): released outside.
    p.select = true;
    panel.poll([p]);
    p.hit = null;
    p.ray = ray([lx + 10, ly, 0], [0, 0, -1]);
    panel.poll([p]);
    expect(b.pressed).toBe(true);
    p.select = false;
    panel.poll([p]);
    expect(presses).toBe(1);
    expect(b.pressed).toBe(false);
    expect(panel.hovered).toBeNull();
    // A pointer that vanishes while pressed (a tap within one tick) releases where it was.
    p.hit = hit;
    p.ray = ray([lx, ly, 0], [0, 0, -1]);
    p.select = true;
    panel.poll([p]);
    expect(b.pressed).toBe(true);
    panel.poll([]);
    expect(b.pressed).toBe(false);
    expect(presses).toBe(2);
    expect(panel.hovered).toBeNull();
  });

  it('a drag that starts on a slider keeps going past the panel edge', () => {
    const { panel } = make({ width: 4, height: 1, resolution: 100 });
    const s = panel.add(slider({ min: 0, max: 100, value: 50 }));
    panel.repaint();
    const [px, py] = centre(s.layoutRect);
    const lx = px / panel.resolution - panel.width / 2;
    const ly = panel.height / 2 - py / panel.resolution;
    const tester = worldPanelTarget(panel);
    const p = {
      source: {},
      key: 1,
      device: 'touch',
      ray: ray([lx, ly, 1], [0, 0, -1]),
      select: true,
      hit: null as unknown,
    } as unknown as RoutedPointer & { select: boolean; hit: unknown; ray: Ray };
    p.hit = tester(p.ray);
    panel.poll([p]);
    expect(s.pressed).toBe(true);
    // Off the right edge of the quad: the router has no hit, the slider still follows.
    p.ray = ray([lx + 5, ly, 1], [0, 0, -1]);
    p.hit = tester(p.ray);
    expect(p.hit).toBeNull();
    panel.poll([p]);
    expect(s.options.value).toBe(100);
    p.select = false;
    panel.poll([p]);
    expect(s.options.value).toBe(100);
    expect(s.pressed).toBe(false);
    expect(panel.pressing).toBe(false);
  });
});

describe('head-locked and billboard', () => {
  it('a head-locked panel sits distance ahead of the camera with the view offset, facing it', () => {
    const { panel } = make({ headLocked: { distance: 2, offset: [0.5, -0.25] } });
    const camera = Camera.perspective(1, 1, 0.1, 100);
    camera.lookAt([0, 1, 10], [0, 1, 0]);
    panel.update(camera);
    const p = panel.transform.position;
    expect(p.x).toBeCloseTo(0.5);
    expect(p.y).toBeCloseTo(0.75);
    expect(p.z).toBeCloseTo(8);
    // The panel's +z (its facing) points back at the eye.
    const m = panel.transform.world;
    expect(m[2]).toBeCloseTo(0);
    expect(m[6]).toBeCloseTo(0);
    expect(m[10]).toBeCloseTo(1);
    // Move the camera: the panel follows.
    camera.lookAt([10, 1, 0], [0, 1, 0]);
    panel.update(camera);
    expect(panel.transform.position.x).toBeCloseTo(8);
    expect(panel.transform.position.z).toBeCloseTo(-0.5);
    expect(panel.transform.world[2]).toBeCloseTo(1);
  });

  it('a billboard keeps its position and turns to the camera', () => {
    const { panel } = make({ billboard: true });
    panel.transform.setPosition(3, 0, 0);
    const camera = Camera.perspective(1, 1, 0.1, 100);
    camera.lookAt([3, 0, 10], [3, 0, 0]);
    panel.update(camera);
    expect(panel.transform.position.x).toBe(3);
    expect(panel.transform.world[10]).toBeCloseTo(1);
    camera.lookAt([3, 0, -10], [3, 0, 0]);
    panel.update(camera);
    expect(panel.transform.position.x).toBe(3);
    expect(panel.transform.world[10]).toBeCloseTo(-1);
  });

  it('a plain panel ignores update', () => {
    const { panel } = make();
    panel.transform.setPosition(1, 2, 3);
    const camera = Camera.perspective(1, 1, 0.1, 100);
    camera.lookAt([5, 5, 5], [0, 0, 0]);
    panel.update(camera);
    expect(panel.transform.world[10]).toBe(1);
    expect(panel.transform.position.x).toBe(1);
  });
});

describe('text and theme', () => {
  it('measures each string once per font and refreshes after the font loads', async () => {
    const { fake, panel, canvas } = make();
    expect(panel.painter.measure('abc', '10px x')).toBe(24);
    expect(panel.painter.measure('abc', '10px x')).toBe(24);
    expect(canvas.calls.measureText).toBe(1);
    panel.painter.clearMeasures();
    panel.painter.measure('abc', '10px x');
    expect(canvas.calls.measureText).toBe(2);
    await panel.fontLoaded;
    prepare(fake, panel);
    expect(fake.errors).toEqual([]);
  });

  it('reads theme overrides by value', () => {
    const { panel } = make({ theme: { colorAccent: '#123456', space3: '20px' } });
    expect(panel.theme.tokens.colorAccent).toBe('#123456');
    expect(panel.theme.space3).toBe(20);
    expect(panel.theme.fontSizeM).toBe(16);
  });
});

describe('attach (ws/ui-4)', () => {
  it('a press reaches the panel on the input tick without the page calling poll', () => {
    const { panel } = make();
    let presses = 0;
    const b = panel.add(button({ text: 'x', onPress: () => presses++ }));
    panel.repaint();
    panel.transform.setPosition(0, 0, -5);
    const [px, py] = centre(b.layoutRect);
    const lx = px / panel.resolution - panel.width / 2;
    const ly = panel.height / 2 - py / panel.resolution;
    const p = {
      source: {},
      key: 1,
      device: 'mouse',
      ray: ray([lx, ly, 0], [0, 0, -1]),
      select: false,
      hit: null as unknown,
    } as unknown as RoutedPointer & { select: boolean; hit: unknown };
    let testers = 0;
    const ticks: (() => void)[] = [];
    const router = {
      pointers: [p],
      camera: null,
      addTester: () => {
        testers++;
        return () => testers--;
      },
    };
    const input = {
      getPointers: () => router as unknown as PointerRouter<unknown>,
      onUpdated: (fn: () => void) => {
        ticks.push(fn);
        return () => ticks.splice(ticks.indexOf(fn), 1);
      },
    };
    panel.attach(input);
    expect(testers).toBe(1);
    expect(ticks.length).toBe(1);
    const tick = () => {
      p.hit = worldPanelTarget(panel)(p.ray);
      for (const t of ticks) t();
    };
    tick();
    expect(panel.hovered).toBe(b);
    p.select = true;
    tick();
    expect(b.pressed).toBe(true);
    p.select = false;
    tick();
    expect(presses).toBe(1);
    panel.detach();
    expect(testers).toBe(0);
    expect(ticks.length).toBe(0);
    panel.attach(input);
    panel.dispose();
    expect(testers).toBe(0);
    expect(ticks.length).toBe(0);
  });

  it('attach needs a pointer router', () => {
    const { panel } = make();
    expect(() => panel.attach({ getPointers: () => null, onUpdated: () => () => {} })).toThrow();
  });
});
