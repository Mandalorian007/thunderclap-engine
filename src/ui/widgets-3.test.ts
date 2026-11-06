// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { h } from './dom';
import { themePx } from './hud';
import { createOverlay, type Overlay } from './overlay';
import { bearingOffset } from './widgets-3';

describe('ring and compass (ws/ui-4)', () => {
  let parent: HTMLElement;
  let ui: Overlay;
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ui = createOverlay({ parent, caption: { reducedMotion: true } });
  });
  afterEach(() => ui.destroy());

  it('ring: a progressbar whose aria-valuenow and fill follow set(), clamped', () => {
    const r = ui.ring({ radius: 40, thickness: 6, value: 0.25, label: 'Cast' });
    expect(r.el.getAttribute('role')).toBe('progressbar');
    expect(r.el.getAttribute('aria-valuenow')).toBe('0.25');
    expect(r.el.getAttribute('aria-label')).toBe('Cast');
    expect(r.el.style.getPropertyValue('--tc-ring-size')).toBe(themePx(80));
    expect(r.el.style.getPropertyValue('--tc-ring-thickness')).toBe(themePx(6));
    const fill = r.el.querySelector<HTMLElement>('.tc-ring-fill')!;
    expect(fill.style.getPropertyValue('--tc-ring-value')).toBe('0.25');
    r.set(2);
    expect(r.value).toBe(1);
    expect(r.el.getAttribute('aria-valuenow')).toBe('1');
    r.setLabel('Done');
    expect(r.el.querySelector('.tc-ring-label')?.textContent).toBe('Done');
    expect(document.querySelectorAll('#tc-ui-widgets-3').length).toBe(1);
    ui.ring();
    expect(document.querySelectorAll('#tc-ui-widgets-3').length).toBe(1);
    r.remove();
    expect(r.el.isConnected).toBe(false);
  });

  it('compass: a marker at +90° sits right of centre by width/4 at a 180° FOV, and wraps', () => {
    const c = ui.compass({
      width: 480,
      headingDeg: 0,
      markers: [
        { name: 'camp', bearingDeg: 90 },
        { name: 'cave', bearingDeg: 180, icon: '*' },
      ],
    });
    expect(c.el.getAttribute('role')).toBe('img');
    expect(c.offsetOf('camp')).toBeCloseTo(120, 6);
    const camp = c.el.querySelector<HTMLElement>('[data-name="camp"]')!;
    expect(camp.hidden).toBe(false);
    expect(camp.style.transform).toContain(`translate3d(${themePx(120)}, 0, 0)`);
    expect(camp.textContent).toBe('c');
    const cave = c.el.querySelector<HTMLElement>('[data-name="cave"]')!;
    expect(cave.hidden).toBe(false); // 180° off: at the strip's edge with the whole circle shown
    expect(c.offsetOf('cave')).toBeCloseTo(240, 6);
    expect(cave.textContent).toBe('*');
    c.setHeading(350);
    expect(c.heading).toBe(350);
    expect(c.offsetOf('camp')).toBeCloseTo(100 * (480 / 360), 6); // 90 − 350 wraps to +100
    c.setHeading(-90); // west: the cave is a quarter turn left
    expect(c.heading).toBe(270);
    expect(c.offsetOf('cave')).toBeCloseTo(-120, 6);
    expect(c.offsetOf('nowhere')).toBeNull();
    c.setMarkers([{ name: 'camp', bearingDeg: 270 }]);
    expect(c.el.querySelectorAll('.tc-compass-marker').length).toBe(1);
    expect(c.offsetOf('camp')).toBe(0);
    c.remove();
  });

  it('compass: a narrower fov scales the strip and hides markers off it', () => {
    const c = ui.compass({ width: 400, fov: 90, markers: [{ name: 'camp', bearingDeg: 90 }] });
    const camp = c.el.querySelector<HTMLElement>('[data-name="camp"]')!;
    expect(c.offsetOf('camp')).toBeCloseTo(200, 6); // at the edge
    expect(camp.hidden).toBe(false);
    c.setHeading(270); // straight behind
    expect(camp.hidden).toBe(true);
    c.setHeading(45);
    expect(camp.hidden).toBe(false);
    expect(c.offsetOf('camp')).toBeCloseTo(100, 6);
    c.remove();
  });

  it('bearingOffset is the signed, wrapped difference', () => {
    expect(bearingOffset(90, 0)).toBe(90);
    expect(bearingOffset(10, 350)).toBe(20);
    expect(bearingOffset(350, 10)).toBe(-20);
    expect(bearingOffset(180, 0)).toBe(180);
  });
});
