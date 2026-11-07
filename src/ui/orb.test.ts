// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { h } from './dom';
import { type Meter, themePx } from './hud';
import { type FormFactor, formSize } from './layout';
import { ORB_CSS, TrailClock } from './orb';
import { createOverlay, type Overlay } from './overlay';

describe('orb meter (ws/ui-5)', () => {
  let parent: HTMLElement;
  let ui: Overlay;
  let t: number;
  const now = () => t;
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ui = createOverlay({ parent, caption: { reducedMotion: true } });
    t = 1000;
  });
  afterEach(() => ui.destroy());

  const fillOf = (el: HTMLElement) => Number(el.style.getPropertyValue('--tc-orb-value'));
  const trailOf = (el: HTMLElement) => Number(el.style.getPropertyValue('--tc-orb-trail'));

  it('is a role=meter orb whose fill height is the value over max', () => {
    const orb = ui.meter({
      shape: 'orb',
      label: 'Health',
      max: 200,
      value: 150,
      tone: 'danger',
      size: 96,
    });
    expect(orb.shape).toBe('orb');
    expect(orb.el.classList.contains('tc-orb')).toBe(true);
    expect(orb.el.getAttribute('role')).toBe('meter');
    expect(orb.el.getAttribute('aria-label')).toBe('Health');
    expect(orb.el.getAttribute('aria-valuenow')).toBe('150');
    expect(orb.el.getAttribute('aria-valuemax')).toBe('200');
    expect(orb.el.dataset.tone).toBe('danger');
    expect(orb.el.style.getPropertyValue('--tc-orb-size')).toBe(themePx(96));
    expect(document.getElementById('tc-ui-orb')?.textContent).toBe(ORB_CSS);
    expect(fillOf(orb.el)).toBeCloseTo(0.75, 9);
    // The fill is a full-height layer pushed down by (1 - value): its top edge is the surface.
    expect(ORB_CSS).toContain('translateY(calc((1 - var(--tc-orb-value, 1)) * 100%))');
    expect(orb.el.querySelector('.tc-orb-readout')!.textContent).toBe('150');
    orb.set(-5);
    expect(orb.value).toBe(0);
    expect(fillOf(orb.el)).toBe(0);
    expect(orb.el.hasAttribute('data-empty')).toBe(true);
    orb.set(80, 100);
    expect(fillOf(orb.el)).toBeCloseTo(0.8, 9);
    expect(orb.el.hasAttribute('data-empty')).toBe(false);
    orb.remove();
    expect(orb.el.isConnected).toBe(false);
  });

  it('readout: value, percent, none, format; colour override over the tone token', () => {
    const pct = ui.meter({ shape: 'orb', readout: 'percent', value: 0.333 });
    expect(pct.el.querySelector('.tc-orb-readout')!.textContent).toBe('33%');
    expect(pct.el.getAttribute('aria-valuetext')).toBe('33%');
    const none = ui.meter({ shape: 'orb', readout: 'none' });
    expect(none.el.querySelector('.tc-orb-readout')!.textContent).toBe('');
    const fmt = ui.meter({ shape: 'orb', max: 50, value: 20, format: (v, m) => `${v}/${m}` });
    expect(fmt.el.querySelector('.tc-orb-readout')!.textContent).toBe('20/50');
    const c = ui.meter({ shape: 'orb', color: '#2050ff' });
    expect(c.el.style.getPropertyValue('--tc-meter-color')).toBe('#2050ff');
    expect(ORB_CSS).toContain('--tc-orb-color: var(--tc-meter-color, var(--tc-orb-tone))');
    c.setColor(null);
    expect(c.el.style.getPropertyValue('--tc-meter-color')).toBe('');
  });

  it('the trail holds, then drains to the value and catches up', () => {
    const orb = ui.meter({
      shape: 'orb',
      max: 100,
      trail: { delay: 400, duration: 600 },
      reducedMotion: false,
      now,
    });
    expect(orb.el.querySelector('.tc-orb-trail')).not.toBeNull();
    expect(orb.el.style.getPropertyValue('--tc-orb-trail-delay')).toBe('400ms');
    expect(orb.trail).toBe(100);
    orb.set(40);
    // The CSS target is the value; the transition's delay keeps the band where it was.
    expect(trailOf(orb.el)).toBeCloseTo(0.4, 9);
    expect(orb.trail).toBe(100);
    t += 399;
    expect(orb.trail).toBe(100);
    t += 301; // 300 ms into the 600 ms drain: halfway from 100 to 40
    expect(orb.trail).toBeCloseTo(70, 6);
    // A second hit mid-drain retargets from where the band is.
    orb.set(20);
    expect(orb.trail).toBeCloseTo(70, 6);
    t += 400 + 600;
    expect(orb.trail).toBeCloseTo(20, 6);
    // A heal: the band never sits under the fill.
    orb.set(90);
    expect(orb.trail).toBe(90);
    t += 2000;
    expect(orb.trail).toBe(90);
  });

  it('prefers-reduced-motion disables the trail', () => {
    const win = document.defaultView!;
    const orig = win.matchMedia;
    win.matchMedia = ((q: string) =>
      ({ matches: q.includes('reduce'), media: q }) as MediaQueryList) as typeof win.matchMedia;
    try {
      const orb = ui.meter({ shape: 'orb', trail: true, now });
      expect(orb.el.querySelector('.tc-orb-trail')).toBeNull();
      expect(orb.el.hasAttribute('data-reduced')).toBe(true);
      orb.set(0.2);
      expect(orb.trail).toBe(0.2);
      const bar = ui.meter({ trail: true, now });
      expect(bar.el.querySelector('.tc-meter-trail')).toBeNull();
    } finally {
      win.matchMedia = orig;
    }
    expect(ORB_CSS).toContain('.tc-overlay .tc-orb-trail { display: none; }');
  });

  it('the bar meter takes the same trail; a plain bar is unchanged', () => {
    const plain = ui.meter({ label: 'S' });
    expect(plain.shape).toBe('bar');
    expect(plain.el.querySelector('.tc-meter-trail')).toBeNull();
    expect(plain.el.getAttribute('style')).toBeNull();
    expect(plain.trail).toBe(1);
    const bar = ui.meter({ max: 10, trail: true, reducedMotion: false, now, color: 'red' });
    const el = bar.el.querySelector<HTMLElement>('.tc-meter-trail')!;
    expect(el).not.toBeNull();
    expect(bar.el.hasAttribute('data-color')).toBe(true);
    bar.set(4);
    expect(el.style.getPropertyValue('--tc-meter-trail')).toBe('0.4');
    expect(bar.trail).toBe(10);
    t += 400 + 600;
    expect(bar.trail).toBeCloseTo(4, 9);
  });

  it('TrailClock is linear after the delay', () => {
    let c = 0;
    const tc = new TrailClock(100, 200, () => c);
    tc.reset(1);
    tc.retarget(0);
    expect(tc.at(50)).toBe(1);
    expect(tc.at(200)).toBeCloseTo(0.5, 9);
    expect(tc.at(300)).toBe(0);
    c = 1000;
    expect(tc.at()).toBe(0);
  });

  it('size per form factor: 56 on a phone, 96 on desktop, before the layout measures (ws/ui-10)', () => {
    ui.destroy();
    let ff: FormFactor = 'phone-landscape';
    ui = createOverlay({
      parent,
      caption: { reducedMotion: true },
      layout: { classify: () => ff },
    });
    const orb = ui.meter({ shape: 'orb', size: { phone: 56, default: 96 } });
    const sizeOf = () => orb.el.style.getPropertyValue('--tc-orb-size');
    expect(sizeOf()).toBe(themePx(56));
    ff = 'desktop';
    ui.layout.refresh();
    expect(sizeOf()).toBe(themePx(96));
    ff = 'phone-portrait';
    ui.layout.refresh();
    expect(sizeOf()).toBe(themePx(56));
  });

  it('setSize changes the diameter live and re-lays out once (ws/ui-10)', () => {
    const orb = ui.meter({ shape: 'orb', size: 96 });
    let relayouts = 0;
    ui.layout.onChange(() => relayouts++);
    orb.setSize({ default: 72 });
    expect(orb.el.style.getPropertyValue('--tc-orb-size')).toBe(themePx(72));
    expect(relayouts).toBe(1);
    // The same diameter in this form factor: nothing to lay out.
    orb.setSize(72);
    expect(relayouts).toBe(1);
    // A bar ignores it.
    const bar = ui.meter({ label: 'HP' });
    relayouts = 0;
    bar.setSize(40);
    expect(relayouts).toBe(0);
  });

  it("size: the orb's FormSize as last given, 128 by default; undefined on a bar (ws/ui-11)", () => {
    expect(ui.meter({ shape: 'orb' }).size).toBe(128);
    const orb = ui.meter({ shape: 'orb', size: { phone: 56, default: 96 } });
    expect(orb.size).toEqual({ phone: 56, default: 96 });
    expect(formSize(orb.size!, ui.layout.formFactor)).toBe(96);
    orb.setSize(72);
    expect(orb.size).toBe(72);
    expect(ui.meter({ label: 'HP' }).size).toBeUndefined();
  });

  /** Every element under the overlay's root, and how many are meters. */
  const census = () => ({
    nodes: ui.root.querySelectorAll('*').length,
    meters: ui.root.querySelectorAll('[role="meter"]').length,
  });

  for (const shape of ['orb', 'bar'] as const) {
    it(`setPlace moves a live ${shape} meter: value, trail, tone and colour stay (ws/ui-11)`, () => {
      const m: Meter = ui.meter({
        shape,
        max: 100,
        tone: 'danger',
        color: '#ff0000',
        trail: { delay: 400, duration: 600 },
        reducedMotion: false,
        region: 'bottom',
        now,
      });
      const el = m.el;
      const band = el.querySelector<HTMLElement>(
        shape === 'orb' ? '.tc-orb-trail' : '.tc-meter-trail',
      )!;
      const holder = shape === 'orb' ? el : band;
      const prefix = shape === 'orb' ? 'orb' : 'meter';
      m.set(40);
      t += 700; // 300 ms into the drain: the band is halfway, at 70
      expect(m.trail).toBeCloseTo(70, 6);
      const before = census();
      m.setPlace('right');
      expect(m.region).toBe('right');
      expect(el.parentElement).toBe(ui.layout.region('right'));
      expect(m.el).toBe(el);
      expect(m.value).toBe(40);
      expect(m.trail).toBeCloseTo(70, 6);
      expect(el.dataset.tone).toBe('danger');
      expect(el.style.getPropertyValue('--tc-meter-color')).toBe('#ff0000');
      // The move cancelled the band's transition: it re-runs the rest of the drain from 70.
      expect(el.style.getPropertyValue(`--tc-${prefix}-trail-delay`)).toBe('0ms');
      expect(el.style.getPropertyValue(`--tc-${prefix}-trail-duration`)).toBe('300ms');
      expect(Number(holder.style.getPropertyValue(`--tc-${prefix}-trail`))).toBeCloseTo(0.4, 9);
      expect(band.style.transition).toBe('');
      // No node made or lost.
      expect(census()).toEqual(before);
      m.setPlace({ default: 'left' });
      m.setPlace('bottom');
      expect(census()).toEqual(before);
      t += 300;
      expect(m.trail).toBeCloseTo(40, 6);
      // The next hit runs on the configured timings again.
      m.set(10);
      expect(el.style.getPropertyValue(`--tc-${prefix}-trail-delay`)).toBe('400ms');
      expect(el.style.getPropertyValue(`--tc-${prefix}-trail-duration`)).toBe('600ms');
      m.remove();
      expect(census().meters).toBe(before.meters - 1);
    });
  }

  it('a move during the hold re-arms the rest of the hold and the whole drain (ws/ui-11)', () => {
    const orb = ui.meter({ shape: 'orb', max: 100, trail: true, reducedMotion: false, now });
    orb.set(50);
    t += 150;
    orb.setPlace('top');
    expect(orb.el.style.getPropertyValue('--tc-orb-trail-delay')).toBe('250ms');
    expect(orb.el.style.getPropertyValue('--tc-orb-trail-duration')).toBe('600ms');
    expect(orb.trail).toBe(100);
    // A settled band has nothing to re-run.
    t += 2000;
    const orb2 = ui.meter({ shape: 'orb', max: 100, trail: true, reducedMotion: false, now });
    orb2.setPlace('top');
    expect(orb2.el.style.getPropertyValue('--tc-orb-trail-delay')).toBe('400ms');
  });

  it('place per form factor: the layout moves the live orb when the form changes (ws/ui-11)', () => {
    ui.destroy();
    let ff: FormFactor = 'desktop';
    ui = createOverlay({
      parent,
      caption: { reducedMotion: true },
      layout: { classify: () => ff },
    });
    const orb = ui.meter({
      shape: 'orb',
      max: 100,
      trail: true,
      reducedMotion: false,
      now,
      region: 'top', // `place` wins
      place: { default: 'bottom', 'phone-landscape': 'right' },
    });
    const el = orb.el;
    expect(orb.region).toBe('bottom');
    orb.set(30);
    const before = census();
    ff = 'phone-landscape';
    ui.layout.refresh();
    expect(orb.region).toBe('right');
    expect(orb.el).toBe(el);
    expect(orb.value).toBe(30);
    expect(orb.trail).toBe(100);
    expect(census()).toEqual(before);
    ff = 'desktop';
    ui.layout.refresh();
    expect(orb.region).toBe('bottom');
    // A region name alone is a default.
    expect(ui.meter({ label: 'HP', place: 'left' }).region).toBe('left');
  });
});
