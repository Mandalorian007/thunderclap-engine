// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { h } from './dom';
import { themePx } from './hud';
import { createOverlay, type Overlay } from './overlay';

describe('minimap (ws/ui-4)', () => {
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

  it('places markers north-up, clamps one past worldRadius to the rim, pools nodes', () => {
    const m = ui.minimap({ size: 200, worldRadius: 50 });
    expect(m.el.getAttribute('role')).toBe('img');
    expect(m.el.style.getPropertyValue('--tc-minimap-size')).toBe(themePx(200));
    m.setMarker('n', 0, -25, { kind: 'ally' });
    expect(m.markerAt('n')).toEqual({ x: 0, y: -50, outside: false });
    m.setMarker('far', 100, 0, { kind: 'enemy', icon: '!' });
    const far = m.markerAt('far')!;
    expect(far.outside).toBe(true);
    expect(far.x).toBeCloseTo(100, 6);
    expect(far.y).toBeCloseTo(0, 6);
    const el = m.el.querySelector<HTMLElement>('[data-kind="enemy"]')!;
    expect(el.classList.contains('tc-minimap-outside')).toBe(true);
    expect(el.textContent).toBe('!');
    expect(el.style.transform).toContain(`translate3d(${themePx(100)}, ${themePx(0)}, 0)`);
    m.setCenter(60, 0);
    expect(m.markerAt('far')!.outside).toBe(false);
    expect(m.markerAt('far')!.x).toBeCloseTo(80, 6);
    expect(el.classList.contains('tc-minimap-outside')).toBe(false);
    m.removeMarker('far');
    expect(m.markerAt('far')).toBeNull();
    expect(el.hidden).toBe(true);
    m.setMarker('new', 0, 0);
    expect(m.el.querySelectorAll('.tc-minimap-marker').length).toBe(2); // the node was reused
    expect(el.hidden).toBe(false);
    expect(el.dataset.kind).toBe('info');
    m.clear();
    expect(m.markerAt('n')).toBeNull();
    const all = Array.from(m.el.querySelectorAll<HTMLElement>('.tc-minimap-marker'));
    expect(all.every((e) => e.hidden)).toBe(true);
    m.remove();
    expect(m.el.isConnected).toBe(false);
  });

  it('rotate: a marker at bearing 90 turns to the top when the heading is 90', () => {
    const canvas = document.createElement('canvas');
    const m = ui.minimap({ size: 200, worldRadius: 50, rotate: true, background: canvas });
    expect(canvas.parentElement?.classList.contains('tc-minimap-ground')).toBe(true);
    m.setMarker('e', 25, 0);
    expect(m.markerAt('e')).toEqual({ x: 50, y: 0, outside: false });
    m.setCenter(0, 0, 90);
    const e = m.markerAt('e')!;
    expect(e.x).toBeCloseTo(0, 6);
    expect(e.y).toBeCloseTo(-50, 6);
    const ground = m.el.querySelector<HTMLElement>('.tc-minimap-ground')!;
    expect(ground.style.transform).toContain('rotate(-90deg)');
    m.setCenter(10, 0, 90);
    expect(ground.style.transform).toContain(`translate3d(${themePx(-20)}, ${themePx(0)}, 0)`);
    m.remove();
  });
});
