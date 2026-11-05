// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceMode } from '../platform/device-mode';
import { h } from './dom';
import {
  classifyFormFactor,
  defaultForms,
  effectiveInsets,
  FORM_FACTORS,
  type FormFactor,
  formSpec,
  type Insets,
  type LayoutSpec,
  parseAreas,
  placementFor,
  type RegionName,
  resolveLayout,
  resolveTracks,
} from './layout';
import { createOverlay, type Overlay, type Rect } from './overlay';
import { applyTextScale, CSS_FONT_PX, textScaleTokens } from './text-scale';

const overlaps = (a: Rect, b: Rect) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.01 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.01;

const GRID: RegionName[] = ['top', 'left', 'right', 'bottom', 'cardLane', 'captionLane', 'fill'];
const ALL = new Set<RegionName>(GRID);

/** The engine matrix (packages/engine/playwright.config.ts) plus the portrait rows. */
const ROWS: {
  name: string;
  w: number;
  h: number;
  coarse: boolean;
  ff: FormFactor;
  inset?: Insets;
}[] = [
  { name: 'desktop-1280', w: 1280, h: 720, coarse: false, ff: 'desktop' },
  { name: 'desktop-1920', w: 1920, h: 1080, coarse: false, ff: 'desktop' },
  { name: 'ipad', w: 1180, h: 820, coarse: true, ff: 'tablet' },
  { name: 'ipad-port', w: 820, h: 1180, coarse: true, ff: 'tablet' },
  { name: 'phone-se', w: 667, h: 320, coarse: true, ff: 'phone-landscape' },
  {
    name: 'phone-iphone',
    w: 844,
    h: 340,
    coarse: true,
    ff: 'phone-landscape',
    inset: { top: 0, right: 47, bottom: 21, left: 47 },
  },
  {
    name: 'phone-promax',
    w: 932,
    h: 380,
    coarse: true,
    ff: 'phone-landscape',
    inset: { top: 0, right: 59, bottom: 21, left: 59 },
  },
  { name: 'phone-android', w: 915, h: 360, coarse: true, ff: 'phone-landscape' },
  {
    name: 'phone-port',
    w: 390,
    h: 844,
    coarse: true,
    ff: 'phone-portrait',
    inset: { top: 47, right: 0, bottom: 34, left: 0 },
  },
];

describe('classifyFormFactor', () => {
  for (const r of ROWS) {
    it(`${r.name} → ${r.ff}`, () => {
      const shortSide = Math.min(r.w, r.h);
      expect(
        classifyFormFactor({ width: r.w, height: r.h, coarsePointer: r.coarse, shortSide }),
      ).toBe(r.ff);
    });
  }
  it('a tiny desktop window gets phone chrome; a portrait desktop window stays desktop', () => {
    const fine = { coarsePointer: false, shortSide: 1080 };
    expect(classifyFormFactor({ width: 600, height: 400, ...fine })).toBe('phone-landscape');
    expect(classifyFormFactor({ width: 400, height: 700, ...fine })).toBe('phone-portrait');
    expect(classifyFormFactor({ width: 900, height: 1000, ...fine })).toBe('desktop');
  });
});

describe('resolveTracks', () => {
  it('fixed, fractional (clamped) and fill tracks', () => {
    expect(resolveTracks([100, 'fill', { frac: 0.1, min: 50, max: 80 }], 1000)).toEqual([
      100, 820, 80,
    ]);
    expect(resolveTracks([100, 'fill', { frac: 0.1, min: 50 }], 300)).toEqual([100, 150, 50]);
  });
  it('fill tracks share what is left', () => {
    expect(resolveTracks(['fill', 40, 'fill'], 240)).toEqual([100, 40, 100]);
  });
  it('fractional tracks shrink toward min before fill reaches 0', () => {
    const t = resolveTracks([{ frac: 0.5, min: 40 }, 'fill', { frac: 0.5, min: 40 }], 200);
    expect(t[1]).toBeCloseTo(120 - 120, 5);
    expect(t[0]! + t[1]! + t[2]!).toBeLessThanOrEqual(200);
    expect(resolveTracks([{ frac: 0.4, min: 40 }, 'fill', 100], 200)).toEqual([80, 20, 100]);
    expect(resolveTracks([{ frac: 0.4, min: 40 }, 'fill', 100], 150)).toEqual([50, 0, 100]);
  });
  it('collapsed tracks are 0 and give their space to fill', () => {
    expect(resolveTracks([56, 'fill', 56], 400, [true, false, false])).toEqual([0, 344, 56]);
  });
});

describe('parseAreas', () => {
  it('rejects ragged rows, unknown names, modal and non-rectangles', () => {
    expect(() => parseAreas(['top top', 'fill'])).toThrow(/ragged/);
    expect(() => parseAreas(['top nope'])).toThrow(/unknown/);
    expect(() => parseAreas(['modal fill'])).toThrow(/unknown/);
    expect(() => parseAreas(['left top', 'left left', 'top fill'])).toThrow(/rectangle/);
    expect(parseAreas(['top top', '. fill'])).toEqual([
      ['top', 'top'],
      ['.', 'fill'],
    ]);
  });
  it('every default form parses and matches its tracks', () => {
    for (const ff of FORM_FACTORS) {
      const f = defaultForms[ff];
      const cells = parseAreas(f.areas);
      expect(cells.length, ff).toBe(f.rows.length);
      expect(cells[0]!.length, ff).toBe(f.columns.length);
    }
  });
});

describe('effectiveInsets', () => {
  it('keeps the insets the rect touches and drops the ones a letterbox bar already clears', () => {
    const vp = { width: 844, height: 340 };
    const ins = { top: 0, right: 47, bottom: 21, left: 47 };
    expect(effectiveInsets({ x: 0, y: 0, width: 844, height: 340 }, vp, ins)).toEqual(ins);
    // A 604 px wide letterboxed canvas, 120 px bars: the side insets fall inside the bars.
    expect(effectiveInsets({ x: 120, y: 0, width: 604, height: 340 }, vp, ins)).toEqual({
      top: 0,
      right: 0,
      bottom: 21,
      left: 0,
    });
    expect(effectiveInsets({ x: 30, y: 0, width: 784, height: 330 }, vp, ins)).toEqual({
      top: 0,
      right: 17,
      bottom: 11,
      left: 17,
    });
  });
});

describe('resolveLayout: region assignment per form factor', () => {
  for (const r of ROWS) {
    it(`${r.name}: all regions present, inside the safe area, no grid overlap`, () => {
      const inset = r.inset ?? { top: 0, right: 0, bottom: 0, left: 0 };
      const s = resolveLayout(r.ff, formSpec(r.ff), r.w, r.h, inset, ALL);
      expect(s.formFactor).toBe(r.ff);
      for (const n of GRID) {
        const a = s.regions[n];
        expect(a, n).not.toBeNull();
        if (!a) continue;
        expect(a.width, n).toBeGreaterThan(0);
        expect(a.height, n).toBeGreaterThan(0);
        expect(a.x, n).toBeGreaterThanOrEqual(inset.left - 0.01);
        expect(a.y, n).toBeGreaterThanOrEqual(inset.top - 0.01);
        expect(a.x + a.width, n).toBeLessThanOrEqual(r.w - inset.right + 0.01);
        expect(a.y + a.height, n).toBeLessThanOrEqual(r.h - inset.bottom + 0.01);
        for (const m of GRID) {
          const b = s.regions[m];
          if (m !== n && b) expect(overlaps(a, b), `${n} × ${m}`).toBe(false);
        }
      }
      // Regions tile the safe area exactly.
      const area = GRID.reduce((t, n) => t + s.regions[n]!.width * s.regions[n]!.height, 0);
      const safe = (r.w - inset.left - inset.right) * (r.h - inset.top - inset.bottom);
      expect(area).toBeCloseTo(safe, 0);
      // Rails on touch hold a 44 px target with padding.
      const f = formSpec(r.ff);
      if (r.coarse) expect(f.tapMin).toBe(44);
      if (r.ff.startsWith('phone')) {
        expect(s.regions.left!.width - 2 * f.pad).toBeGreaterThanOrEqual(44);
        expect(s.regions.top!.height - 2 * f.pad).toBeGreaterThanOrEqual(44);
        expect(s.regions.bottom!.height - 2 * f.pad).toBeGreaterThanOrEqual(44);
      }
      // The modal plane is the safe area less its margin.
      expect(s.regions.modal).toEqual({
        x: inset.left + f.modalMargin,
        y: inset.top + f.modalMargin,
        width: r.w - inset.left - inset.right - 2 * f.modalMargin,
        height: r.h - inset.top - inset.bottom - 2 * f.modalMargin,
      });
    });
  }

  it('phone-landscape: side rails run the full height; phone-portrait: lanes are full-width strips', () => {
    const l = resolveLayout(
      'phone-landscape',
      formSpec('phone-landscape'),
      844,
      340,
      undefined,
      ALL,
    );
    expect(l.regions.left).toMatchObject({ x: 0, y: 0, height: 340, width: 56 });
    expect(l.regions.right).toMatchObject({ x: 844 - 56, height: 340 });
    const p = resolveLayout('phone-portrait', formSpec('phone-portrait'), 390, 844, undefined, ALL);
    expect(p.regions.cardLane).toMatchObject({ x: 0, width: 390 });
    expect(p.regions.captionLane).toMatchObject({ x: 0, width: 390 });
    expect(p.regions.captionLane!.y).toBeGreaterThan(p.regions.fill!.y);
  });

  it('freeRect is the fill region and grows as empty tracks collapse', () => {
    const ff = 'phone-landscape';
    const full = resolveLayout(ff, formSpec(ff), 844, 340, undefined, ALL);
    expect(full.freeRect).toEqual(full.regions.fill);
    const none = resolveLayout(ff, formSpec(ff), 844, 340, undefined, new Set());
    expect(none.freeRect).toEqual({ x: 0, y: 0, width: 844, height: 340 });
    const rails = resolveLayout(ff, formSpec(ff), 844, 340, undefined, new Set(['left', 'right']));
    expect(rails.freeRect).toEqual({ x: 56, y: 0, width: 844 - 112, height: 340 });
    // A full-width bar never holds a side rail open.
    const top = resolveLayout(
      'desktop',
      formSpec('desktop'),
      1280,
      720,
      undefined,
      new Set(['top']),
    );
    expect(top.freeRect).toEqual({ x: 0, y: 64, width: 1280, height: 656 });
    // With insets, freeRect stays inside the safe area.
    const ins = { top: 0, right: 47, bottom: 21, left: 47 };
    const s = resolveLayout(ff, formSpec(ff), 844, 340, ins, new Set(['left']));
    expect(s.freeRect).toEqual({ x: 47 + 56, y: 0, width: 844 - 94 - 56, height: 340 - 21 });
  });

  it('an occupied region spanning only collapsible tracks still gets space', () => {
    // cardLane spans rows 1-2 in the wide form; with fill's row kept it keeps row 1.
    const s = resolveLayout(
      'desktop',
      formSpec('desktop'),
      1280,
      720,
      undefined,
      new Set(['cardLane']),
    );
    expect(s.regions.cardLane!.width).toBeGreaterThan(0);
    expect(s.regions.cardLane!.height).toBe(720);
  });

  it('spec.forms overrides one field and keeps the rest', () => {
    const f = formSpec('desktop', { forms: { desktop: { tapMin: 40 } } });
    expect(f.tapMin).toBe(40);
    expect(f.areas).toBe(defaultForms.desktop.areas);
  });

  it('placementFor: per form factor, then default, then hidden', () => {
    expect(placementFor({ 'phone-portrait': 'bottom', default: 'left' }, 'phone-portrait')).toBe(
      'bottom',
    );
    expect(placementFor({ 'phone-portrait': 'bottom', default: 'left' }, 'desktop')).toBe('left');
    expect(placementFor({ desktop: 'top' }, 'tablet')).toBe('hidden');
  });
});

/** A parent of `size` CSS px (happy-dom has no layout, so its client size is stubbed). */
function sizedParent(size: { w: number; h: number }): HTMLElement {
  const parent = h('div');
  Object.defineProperty(parent, 'clientWidth', { get: () => size.w });
  Object.defineProperty(parent, 'clientHeight', { get: () => size.h });
  document.body.append(parent);
  return parent;
}

describe('overlay.layout (DOM)', () => {
  let parent: HTMLElement;
  let ov: Overlay | null = null;
  let ff: FormFactor;
  const size = { w: 844, h: 340 };
  const classify = () => ff;
  /** The overlay over the whole parent, its frame the 16:9 canvas centred in it. */
  const frameOf = (w: number, h: number): Rect => {
    const s = Math.min(w / 1920, h / 1080);
    return { x: (w - 1920 * s) / 2, y: (h - 1080 * s) / 2, width: 1920 * s, height: 1080 * s };
  };
  const make = (spec: LayoutSpec = {}) => {
    ov = createOverlay({ parent, caption: { reducedMotion: true }, layout: spec });
    ov!.setFrame(frameOf(size.w, size.h));
    return ov!.layout;
  };
  const resize = (w: number, h: number) => {
    size.w = w;
    size.h = h;
    ov!.setFrame(frameOf(w, h));
  };
  beforeEach(() => {
    document.body.innerHTML = '';
    // The viewport the safe-area insets are relative to.
    (window as unknown as { happyDOM: { setViewport(v: object): void } }).happyDOM.setViewport({
      width: 844,
      height: 340,
    });
    size.w = 844;
    size.h = 340;
    parent = sizedParent(size);
    ff = 'phone-landscape';
  });
  afterEach(() => {
    ov?.destroy();
    ov = null;
  });

  it('regions cover the whole overlay in its layout layer; the phone is in css units', () => {
    const layout = make({ classify });
    expect(layout.element.parentElement).toBe(ov!.layers.layout);
    expect(layout.state.units).toBe('css');
    expect(ov!.units).toBe('css');
    expect(ov!.root.dataset.units).toBe('css');
    expect(ov!.root.style.getPropertyValue('--tc-font-size-m')).toBe('16px');
    // The frame is still there for world-anchored DOM: 844x340 letterboxes 16:9 at ~0.3148.
    expect(ov!.scale).toBeCloseTo(340 / 1080, 6);
    expect(ov!.rect).toEqual({ x: 0, y: 0, width: 844, height: 340 });
  });

  it('desktop is in frame units; a resize to a phone switches units and keeps overrides', () => {
    ff = 'desktop';
    const layout = make({ classify });
    ov!.setTheme({ fontDisplay: 'serif' });
    expect(layout.state.units).toBe('frame');
    expect(ov!.root.style.getPropertyValue('--tc-font-size-m')).toBe(
      'calc(30 * var(--tc-unit, 1px))',
    );
    ff = 'phone-landscape';
    resize(844, 340);
    expect(ov!.units).toBe('css');
    expect(ov!.root.style.getPropertyValue('--tc-font-size-m')).toBe('16px');
    expect(ov!.root.style.getPropertyValue('--tc-font-display')).toBe('serif');
    // The text scale keeps its CSS-px tokens across the switch.
    applyTextScale(ov!.root, 1.5, (t) => ov!.setTheme(t));
    expect(ov!.root.style.getPropertyValue('--tc-font-size-m')).toBe(
      textScaleTokens(1.5, CSS_FONT_PX).fontSizeM,
    );
    expect(textScaleTokens(1.5, CSS_FONT_PX).fontSizeM).toBe('max(24px, var(--tc-text-min, 0px))');
    ff = 'desktop';
    resize(1280, 720);
    expect(ov!.units).toBe('frame');
    expect(ov!.root.style.getPropertyValue('--tc-font-size-m')).toContain('var(--tc-unit, 1px)');
  });

  it('places widgets in their regions and sets the density tokens', () => {
    const layout = make({
      classify,
      safeArea: { top: 0, right: 47, bottom: 21, left: 47 },
    });
    const back = h('button', { id: 'back' });
    const hd = layout.add(back, { place: { default: 'left' } });
    expect(back.parentElement).toBe(layout.region('left'));
    expect(hd.region).toBe('left');
    expect(ov!.root.dataset.formFactor).toBe('phone-landscape');
    expect(ov!.root.style.getPropertyValue('--tc-tap-min')).toBe('44px');
    expect(ov!.root.style.getPropertyValue('--tc-text-min')).toBe('12px');
    expect(layout.safeArea).toEqual({ top: 0, right: 47, bottom: 21, left: 47 });
    expect(layout.element.style.padding).toBe('0px 47px 21px');
    expect(layout.element.style.gridTemplateColumns).toBe('56px 694px 0px 0px');
    expect(layout.freeRect).toEqual({ x: 47 + 56, y: 0, width: 694, height: 319 });
    layout.destroy();
  });

  it('moves widgets on an orientation change and reports the new freeRect', () => {
    const layout = make({ classify });
    const btn = h('button');
    const card = h('div');
    layout.add(btn, { place: { 'phone-landscape': 'right', 'phone-portrait': 'bottom' } });
    layout.add(card, { place: { default: 'cardLane' } });
    const seen: FormFactor[] = [];
    layout.onChange((s) => seen.push(s.formFactor));
    expect(btn.parentElement).toBe(layout.region('right'));
    const before = layout.freeRect;
    ff = 'phone-portrait';
    resize(340, 844);
    expect(seen).toEqual(['phone-portrait']);
    expect(layout.formFactor).toBe('phone-portrait');
    expect(btn.parentElement).toBe(layout.region('bottom'));
    expect(card.parentElement).toBe(layout.region('cardLane'));
    expect(layout.freeRect).not.toEqual(before);
    expect(layout.freeRect.width).toBe(340);
    layout.destroy();
  });

  it("setForms: a scene's own tracks over the spec's, field by field, until cleared", () => {
    const layout = make({ classify });
    layout.add(h('button'), { place: { default: 'left' } });
    layout.add(h('div'), { place: { default: 'cardLane' } });
    const seen: number[] = [];
    layout.onChange((s) => seen.push(s.columns.length));
    const spec = layout.element.style.gridTemplateColumns;
    layout.setForms({ 'phone-landscape': { columns: [50, 'fill', 200, 58] } });
    expect(seen).toEqual([4]);
    expect(layout.element.style.gridTemplateColumns).toBe('50px 594px 200px 0px');
    expect(layout.freeRect).toMatchObject({ x: 50, width: 594 });
    // Other form factors keep the spec's (portrait: the 56 px left rail, then fill).
    ff = 'phone-portrait';
    resize(340, 844);
    expect(layout.freeRect).toMatchObject({ x: 56, width: 284 });
    ff = 'phone-landscape';
    resize(844, 340);
    layout.setForms(null);
    expect(layout.element.style.gridTemplateColumns).toBe(spec);
    layout.destroy();
  });

  it('hidden, missing regions and remove()', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layout = make({
      classify,
      forms: { 'phone-landscape': { columns: ['fill'], rows: ['fill'], areas: ['fill'] } },
    });
    const a = h('div');
    const hd = layout.add(a, { place: { desktop: 'top' } });
    expect(hd.region).toBe('hidden');
    expect(a.hasAttribute('data-tc-layout-hidden')).toBe(true);
    hd.setPlace({ default: 'left' });
    expect(warn).toHaveBeenCalled();
    expect(hd.region).toBe('hidden');
    hd.setPlace({ default: 'fill' });
    expect(a.parentElement).toBe(layout.region('fill'));
    expect(a.hasAttribute('data-tc-layout-hidden')).toBe(false);
    hd.remove();
    expect(a.isConnected).toBe(false);
    warn.mockRestore();
    layout.destroy();
  });

  it('remove() returns an element to where it was before add()', () => {
    const layout = make({
      classify,
      forms: { 'phone-landscape': { columns: ['fill'], rows: ['fill'], areas: ['fill'] } },
    });
    const home = h('div');
    const a = h('div');
    const b = h('div');
    home.append(a, b);
    const hd = layout.add(a, { place: { default: 'fill' } });
    expect(a.parentElement).toBe(layout.region('fill'));
    hd.remove();
    expect(a.parentElement).toBe(home);
    expect(a.nextSibling).toBe(b);
    // A sibling that has gone since: it goes last.
    const hd2 = layout.add(a, { place: { default: 'fill' } });
    b.remove();
    hd2.remove();
    expect(home.lastChild).toBe(a);
    // destroy() sends every widget home too.
    layout.add(a, { place: { default: 'fill' } });
    layout.destroy();
    expect(a.parentElement).toBe(home);
  });

  it("the 'free' escape hatch: an explicit CSS-px rect, logged once and listed", () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const layout = make({ classify });
    const el = h('div');
    layout.add(el, {
      id: 'probe',
      place: {
        default: { region: 'free', rect: (s) => ({ ...s.freeRect, height: 20 }), reason: 'test' },
      },
    });
    expect(el.style.position).toBe('absolute');
    expect(el.style.height).toBe('20px');
    expect(layout.freeUses).toEqual([{ id: 'probe', reason: 'test' }]);
    layout.refresh();
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
    layout.destroy();
  });

  it('docks the caption in captionLane, where onPlace no longer applies', async () => {
    const layout = make({ classify });
    const placed = vi.fn();
    ov!.caption.onPlace(placed);
    layout.dockCaption();
    expect(ov!.caption.docked).toBe(layout.region('captionLane'));
    expect(ov!.caption.element.parentElement).toBe(layout.region('captionLane'));
    expect(ov!.caption.element.hasAttribute('data-docked')).toBe(true);
    const said = ov!.caption.say('Hello.', { hold: 0 });
    expect(placed).not.toHaveBeenCalled();
    // The caption lane holds space (a registered widget), so it is not collapsed.
    expect(layout.state.regions.captionLane!.height).toBeGreaterThan(0);
    ov!.caption.clear();
    await said;
    layout.destroy();
    // Undocked: back in the captions layer, in its corner on the frame.
    expect(ov!.caption.element.parentElement).toBe(ov!.layers.captions);
    expect(ov!.caption.docked).toBeNull();
  });

  it('device mode leaves the density tokens to the layout', () => {
    make({ classify });
    const dm = createDeviceMode(ov!.root);
    dm.setScale(1);
    dm.setScale(0.3);
    expect(ov!.root.style.getPropertyValue('--tc-tap-min')).toBe('44px');
    dm.destroy();
  });
});
