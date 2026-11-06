// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Camera, type CameraPoint } from '../render/camera';
import { type AnchorSurface, Anchors } from './anchor';
import { createOverlay } from './overlay';

const LW = 1920;
const LH = 1080;
/** The canvas at half size, letterboxed 100 px down. */
const surface: AnchorSurface = {
  rect: { x: 0, y: 100, width: 960, height: 540 },
  logicalWidth: LW,
  logicalHeight: LH,
};

function perspective(): Camera {
  const cam = Camera.perspective(Math.PI / 3, LW / LH, 0.1, 100);
  Object.assign(cam.screen, { x: 0, y: 0, width: LW, height: LH });
  cam.lookAt([0, 0, 10], [0, 0, 0]);
  return cam;
}

/** Where `worldToScreen` puts a point, in frame CSS px. */
function expected(cam: Camera, x: number, y: number, z: number): { x: number; y: number } {
  const p: CameraPoint = cam.worldToScreen(x, y, z);
  return { x: (p.x / LW) * surface.rect.width, y: (p.y / LH) * surface.rect.height };
}

describe('Anchors', () => {
  let root: HTMLElement;
  let cam: Camera;
  let anchors: Anchors;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    cam = perspective();
    anchors = new Anchors({ root, surface, camera: () => cam });
  });
  afterEach(() => root.remove());

  it('places an element at the projected point, in frame CSS px', () => {
    const el = document.createElement('span');
    const h = anchors.add(el, [1, 2, 0]);
    expect(el.parentElement).toBe(root);
    expect(el.style.position).toBe('absolute');
    anchors.update();
    const e = expected(cam, 1, 2, 0);
    expect(h.visible).toBe(true);
    expect(h.x).toBeCloseTo(e.x, 3);
    expect(h.y).toBeCloseTo(e.y, 3);
    expect(el.hidden).toBe(false);
    expect(el.style.transform).toContain(`translate3d(${h.x}px, ${h.y}px, 0)`);
    expect(el.style.transform).toContain('translate(-50%, -50%)');
  });

  it('follows set() and the camera, and adds the offset', () => {
    const el = document.createElement('span');
    const h = anchors.add(el, [0, 0, 0], { offset: [5, -10], align: [0.5, 1] });
    anchors.update();
    expect(h.x).toBeCloseTo(480 + 5, 3);
    expect(h.y).toBeCloseTo(270 - 10, 3);
    expect(el.style.transform).toContain('translate(-50%, -100%)');
    h.set([2, 0, 0]);
    cam.lookAt([0, 0, 5], [0, 0, 0]);
    anchors.update();
    const e = expected(cam, 2, 0, 0);
    expect(h.x).toBeCloseTo(e.x + 5, 3);
  });

  it('hides a point behind the camera or outside clip, and shows it again', () => {
    const el = document.createElement('span');
    const h = anchors.add(el, [0, 0, 20]);
    anchors.update();
    expect(h.visible).toBe(false);
    expect(el.hidden).toBe(true);
    h.set([100, 0, 0]); // in front, far off to the side
    anchors.update();
    expect(el.hidden).toBe(true);
    h.set([0, 0, 0]);
    anchors.update();
    expect(el.hidden).toBe(false);
  });

  it('hideBehind: false keeps an off-screen element shown', () => {
    const el = document.createElement('span');
    const h = anchors.add(el, [100, 0, 0], { hideBehind: false });
    anchors.update();
    expect(h.visible).toBe(true);
    expect(h.x).toBeGreaterThan(surface.rect.width);
  });

  it('clamp keeps an off-screen or behind point inside the viewport, toward its side', () => {
    const right = document.createElement('span');
    const r = anchors.add(right, [100, 0, 0], { clamp: true, margin: 20 });
    const behind = document.createElement('span');
    const b = anchors.add(behind, [-3, 0, 30], { clamp: true });
    const onScreen = document.createElement('span');
    const o = anchors.add(onScreen, [0, 0, 0], { clamp: true });
    anchors.update();
    expect(r.visible).toBe(true);
    expect(r.clamped).toBe(true);
    expect(right.hasAttribute('data-anchor-clamped')).toBe(true);
    expect(r.x).toBeCloseTo(960 - 20, 3);
    expect(r.y).toBeCloseTo(270, 3);
    // Behind the eye and to the left: pinned to the left edge, not mirrored to the right.
    expect(b.visible).toBe(true);
    expect(b.clamped).toBe(true);
    expect(b.x).toBeCloseTo(16, 3);
    expect(o.clamped).toBe(false);
    expect(onScreen.hasAttribute('data-anchor-clamped')).toBe(false);
  });

  it('scale: distance shrinks with depth within min..max', () => {
    const el = document.createElement('span');
    const h = anchors.add(el, [0, 0, 0], { scale: 'distance', distance: 5, min: 0.2, max: 3 });
    anchors.update();
    expect(h.scale).toBeCloseTo(0.5, 5); // depth 10
    cam.lookAt([0, 0, 1], [0, 0, 0]);
    anchors.update();
    expect(h.scale).toBe(3);
    cam.lookAt([0, 0, 90], [0, 0, 0]);
    anchors.update();
    expect(h.scale).toBe(0.2);
    expect(el.style.transform).toContain('scale(0.2)');
  });

  it('maps a unit-square screen as a fraction of the canvas (split screen)', () => {
    Object.assign(cam.screen, { x: 0.5, y: 0, width: 0.5, height: 1 });
    const el = document.createElement('span');
    const h = anchors.add(el, [0, 0, 0], { clamp: true, margin: 0 });
    anchors.update();
    expect(h.x).toBeCloseTo(720, 3); // centre of the right half of 960
    expect(h.y).toBeCloseTo(270, 3);
    h.set([-1000, 0, 0]);
    anchors.update();
    expect(h.x).toBeCloseTo(480, 3); // the right half's left edge
  });

  it('projects through an ortho2d camera in design px', () => {
    const c2 = Camera.ortho2d(LW, LH);
    anchors.setCamera(() => c2);
    const h = anchors.add(document.createElement('span'), [960, 540, 0]);
    anchors.update();
    expect(h.x).toBeCloseTo(480, 3);
    expect(h.y).toBeCloseTo(270, 3);
    c2.x = 100;
    anchors.update();
    expect(h.x).toBeCloseTo(430, 3);
  });

  it('remove() and clear() take elements out', () => {
    const a = document.createElement('span');
    const b = document.createElement('span');
    const ha = anchors.add(a, [0, 0, 0]);
    anchors.add(b, [0, 0, 0]);
    expect(anchors.size).toBe(2);
    ha.remove();
    ha.remove();
    expect(anchors.size).toBe(1);
    expect(a.isConnected).toBe(false);
    anchors.clear();
    expect(anchors.size).toBe(0);
    expect(b.isConnected).toBe(false);
  });

  it('leaves the DOM alone when nothing moved', () => {
    const el = document.createElement('span');
    anchors.add(el, [0, 0, 0]);
    anchors.update();
    el.style.transform = 'none';
    anchors.update();
    expect(el.style.transform).toBe('none');
  });
});

describe('overlay.anchors', () => {
  it('is one Anchors on the hud layer over the frame, updated by updateAnchors', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const ov = createOverlay({ parent });
    ov.updateAnchors(); // nothing built: a no-op
    expect(() => ov.anchors()).toThrow();
    ov.setFrame({ x: 40, y: 0, width: 960, height: 540 });
    const cam = Camera.ortho2d(1920, 1080);
    const a = ov.anchors(() => cam);
    expect(ov.anchors()).toBe(a);
    const el = document.createElement('span');
    const h = a.add(el, [1600, 540, 0]);
    expect(el.parentElement).toBe(ov.layers.hud);
    const inLayout = document.createElement('span');
    const hl = a.add(inLayout, [0, 0, 0], { layer: 'layout' });
    expect(inLayout.parentElement).toBe(ov.layers.layout);
    ov.updateAnchors();
    expect(h.x).toBeCloseTo(800, 3);
    expect(hl.x).toBeCloseTo(40, 3); // the layout layer covers the parent: the frame's x is added
    ov.destroy();
    expect(el.isConnected).toBe(false);
    parent.remove();
  });
});
