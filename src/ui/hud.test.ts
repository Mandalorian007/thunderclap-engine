// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from './dom';
import { headingOffset, themePx, wrapDegrees } from './hud';
import { createOverlay, type Overlay } from './overlay';
import { button } from './widgets';

describe('hud widgets', () => {
  let parent: HTMLElement;
  let ui: Overlay;
  beforeEach(() => {
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ui = createOverlay({ parent, caption: { reducedMotion: true } });
  });
  afterEach(() => ui.destroy());

  const modal = () => ui.stack.push({ title: 'Pause', content: button('OK', () => {}) });

  describe('reticle', () => {
    it('sits centred on the hud layer, injects the HUD sheet once, and switches style', () => {
      const r = ui.reticle({ style: 'cross', size: 32, gap: 8, color: '#f00' });
      expect(r.el.parentElement).toBe(ui.layers.hud);
      expect(r.el.classList.contains('tc-reticle')).toBe(true);
      expect(r.el.dataset.style).toBe('cross');
      expect(r.el.style.getPropertyValue('--tc-reticle-size')).toBe(themePx(32));
      expect(r.el.style.getPropertyValue('--tc-reticle-gap')).toBe(themePx(8));
      expect(r.el.style.getPropertyValue('--tc-reticle-color')).toBe('#f00');
      expect(r.el.getAttribute('aria-hidden')).toBe('true');
      ui.reticle();
      expect(document.querySelectorAll('#tc-ui-hud').length).toBe(1);
      const sheet = document.getElementById('tc-ui-hud')?.textContent ?? '';
      expect(sheet).toContain('.tc-overlay .tc-reticle { position: absolute; left: 50%; top: 50%;');
      // Colours are tokens only (the `#000` in mask gradients is alpha, not a colour).
      expect(sheet.replace(/mask: [^;]*;/g, '')).not.toMatch(/#[0-9a-f]{3,6}\b/i);
      r.setStyle('circle');
      expect(r.style).toBe('circle');
      expect(r.el.dataset.style).toBe('circle');
    });

    it('show and hide toggle hidden; a modal hides it with data-modal and the layer goes inert', () => {
      const r = ui.reticle();
      expect(r.visible).toBe(true);
      r.hide();
      expect(r.el.hidden).toBe(true);
      expect(r.visible).toBe(false);
      r.show();
      expect(r.el.hidden).toBe(false);
      expect(r.el.hasAttribute('data-modal')).toBe(false);
      const p = modal();
      expect(ui.stack.hasModal).toBe(true);
      expect(r.el.hasAttribute('data-modal')).toBe(true);
      expect(ui.layers.hud.hasAttribute('inert')).toBe(true);
      p.close();
      expect(r.el.hasAttribute('data-modal')).toBe(false);
      // Built while a modal is open: hidden from the start.
      const p2 = modal();
      const r2 = ui.reticle();
      expect(r2.el.hasAttribute('data-modal')).toBe(true);
      p2.close();
      expect(r2.el.hasAttribute('data-modal')).toBe(false);
      r.remove();
      r2.remove();
      expect(ui.layers.hud.querySelector('.tc-reticle')).toBeNull();
    });

    it('pulse adds the class and removes it on animationend or after the fallback timeout', () => {
      vi.useFakeTimers();
      try {
        const r = ui.reticle();
        r.pulse();
        expect(r.el.classList.contains('tc-reticle-pulse')).toBe(true);
        r.el.dispatchEvent(new Event('animationend'));
        expect(r.el.classList.contains('tc-reticle-pulse')).toBe(false);
        r.pulse();
        expect(r.el.classList.contains('tc-reticle-pulse')).toBe(true);
        vi.advanceTimersByTime(500);
        expect(r.el.classList.contains('tc-reticle-pulse')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('meter', () => {
    it('has role meter with aria values, lands in its region, and clamps set()', () => {
      const m = ui.meter({ label: 'Stamina', max: 100, value: 40, region: 'left', order: 2 });
      expect(m.el.getAttribute('role')).toBe('meter');
      expect(m.el.getAttribute('aria-label')).toBe('Stamina');
      expect(m.el.getAttribute('aria-valuemin')).toBe('0');
      expect(m.el.getAttribute('aria-valuemax')).toBe('100');
      expect(m.el.getAttribute('aria-valuenow')).toBe('40');
      expect(m.el.closest('.tc-region')?.getAttribute('data-region')).toBe('left');
      expect(m.el.style.order).toBe('2');
      const fill = m.el.querySelector<HTMLElement>('.tc-meter-fill')!;
      expect(fill.style.getPropertyValue('--tc-meter-value')).toBe('0.4');
      m.set(150);
      expect(m.value).toBe(100);
      expect(m.el.getAttribute('aria-valuenow')).toBe('100');
      expect(fill.style.getPropertyValue('--tc-meter-value')).toBe('1');
      m.set(-5);
      expect(m.value).toBe(0);
      expect(fill.style.getPropertyValue('--tc-meter-value')).toBe('0');
      m.set(30, 60);
      expect(m.max).toBe(60);
      expect(m.el.getAttribute('aria-valuemax')).toBe('60');
      expect(fill.style.getPropertyValue('--tc-meter-value')).toBe('0.5');
      m.set(50, 40);
      expect(m.value).toBe(40);
    });

    it('defaults: bottom region, full, accent tone; tone and format follow', () => {
      const m = ui.meter({ format: (v, max) => `${v} of ${max}` });
      expect(m.el.closest('.tc-region')?.getAttribute('data-region')).toBe('bottom');
      expect(m.value).toBe(1);
      expect(m.max).toBe(1);
      expect(m.el.dataset.tone).toBe('accent');
      expect(m.el.getAttribute('aria-valuetext')).toBe('1 of 1');
      expect(m.el.querySelector('.tc-meter-readout')?.textContent).toBe('1 of 1');
      m.setTone('danger');
      expect(m.el.dataset.tone).toBe('danger');
      m.remove();
      expect(m.el.isConnected).toBe(false);
    });
  });

  describe('slots', () => {
    it('builds count options with hints, selects with wrap, and sets content', () => {
      const s = ui.slots({ count: 4, hints: ['1', '2', '3', '4'], region: 'right' });
      expect(s.el.getAttribute('role')).toBe('listbox');
      expect(s.el.getAttribute('aria-label')).toBe('Slots');
      expect(s.el.closest('.tc-region')?.getAttribute('data-region')).toBe('right');
      const items = s.el.querySelectorAll<HTMLElement>('.tc-slot');
      expect(items.length).toBe(4);
      expect(s.count).toBe(4);
      expect(items[0]!.getAttribute('role')).toBe('option');
      expect(items[2]!.querySelector('.tc-slot-hint')?.textContent).toBe('3');
      expect(s.selected).toBe(0);
      expect(items[0]!.hasAttribute('data-selected')).toBe(true);
      expect(items[0]!.getAttribute('aria-selected')).toBe('true');
      s.select(2);
      expect(s.selected).toBe(2);
      expect(items[0]!.hasAttribute('data-selected')).toBe(false);
      expect(items[0]!.getAttribute('aria-selected')).toBe('false');
      expect(items[2]!.hasAttribute('data-selected')).toBe(true);
      // Wraps both ways.
      s.select(4);
      expect(s.selected).toBe(0);
      s.select(-1);
      expect(s.selected).toBe(3);
      expect(s.el.querySelectorAll('[data-selected]').length).toBe(1);
      s.setContent(1, 'Ax');
      expect(items[1]!.querySelector('.tc-slot-content')?.textContent).toBe('Ax');
      const img = h('canvas');
      s.setContent(1, img);
      expect(items[1]!.querySelector('.tc-slot-content')?.firstChild).toBe(img);
      s.setContent(1, '');
      expect(items[1]!.querySelector('.tc-slot-content')?.childNodes.length).toBe(0);
      s.setHint(1, 'Q');
      expect(items[1]!.querySelector('.tc-slot-hint')?.textContent).toBe('Q');
      s.setContent(9, 'ignored');
      s.remove();
      expect(s.el.isConnected).toBe(false);
    });

    it('an empty strip selects nothing', () => {
      const s = ui.slots({ count: 0 });
      expect(s.selected).toBe(-1);
      s.select(3);
      expect(s.selected).toBe(-1);
    });
  });

  describe('heading', () => {
    it('is a labelled strip of ticks and cardinals in the top region by default', () => {
      const hd = ui.heading();
      expect(hd.el.closest('.tc-region')?.getAttribute('data-region')).toBe('top');
      expect(hd.el.getAttribute('role')).toBe('img');
      expect(hd.el.getAttribute('aria-label')).toBe('Heading 0°');
      expect(hd.el.style.getPropertyValue('--tc-heading-width')).toBe(themePx(480));
      const labels = [...hd.strip.querySelectorAll('.tc-heading-label')].map((l) => l.textContent);
      // Two turns, −180° to 540°: W N E S W N E S W.
      expect(labels).toEqual(['S', 'W', 'N', 'E', 'S', 'W', 'N', 'E', 'S']);
      // Ticks every 15° over 720°, inclusive.
      expect(hd.strip.querySelectorAll('.tc-heading-tick').length).toBe(49);
      expect(hd.strip.querySelectorAll('.tc-heading-tick[data-major]').length).toBe(9);
      expect(hd.el.querySelector('.tc-heading-mark')).not.toBeNull();
    });

    it('slides the strip for yaw 0, π/2 and −π', () => {
      const hd = ui.heading({ width: 360, span: 90 });
      const ppd = 360 / 90;
      const tx = (deg: number) => `translate3d(${themePx(180 - deg * ppd)}, 0, 0)`;
      hd.setYaw(0);
      expect(hd.offset).toBe(180);
      expect(hd.strip.style.transform).toBe(tx(0));
      hd.setYaw(Math.PI / 2);
      expect(hd.offset).toBeCloseTo(180 - 90 * ppd, 9);
      expect(hd.strip.style.transform).toBe(tx(90));
      expect(hd.el.getAttribute('aria-label')).toBe('Heading 90°');
      hd.setYaw(-Math.PI);
      expect(hd.yaw).toBe(-Math.PI);
      expect(hd.offset).toBeCloseTo(180 - 180 * ppd, 9);
      expect(hd.strip.style.transform).toBe(tx(180));
      expect(hd.el.getAttribute('aria-label')).toBe('Heading 180°');
      // A full turn lands back where it started.
      hd.setYaw(2 * Math.PI);
      expect(hd.offset).toBeCloseTo(180, 9);
    });

    it('pure helpers wrap degrees and compute the offset', () => {
      expect(wrapDegrees(-90)).toBe(270);
      expect(wrapDegrees(360)).toBe(0);
      expect(wrapDegrees(725)).toBe(5);
      expect(headingOffset(0, 480, 90)).toBe(240);
      expect(headingOffset(Math.PI, 480, 90)).toBeCloseTo(240 - 180 * (480 / 90), 9);
      expect(themePx(24)).toBe('calc(24 * var(--tc-space-1) / 4)');
    });
  });
});
