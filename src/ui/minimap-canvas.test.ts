// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { h } from './dom';
import { themePx } from './hud';
import { CANVAS_MINIMAP_CSS, createCanvasMinimap, type MinimapMarker } from './minimap-canvas';
import { createOverlay, type Overlay } from './overlay';

const WORLD = { minX: -50, minZ: -50, maxX: 50, maxZ: 50 };

describe('canvas minimap (ws/ui-5)', () => {
  let parent: HTMLElement;
  let ov: Overlay;
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    parent = h('div');
    document.body.append(parent);
    ov = createOverlay({ parent, caption: { reducedMotion: true } });
  });
  afterEach(() => ov.destroy());

  it('north-up: the world maps onto the map, centred on the player; zoom scales it', () => {
    const map = createCanvasMinimap(ov, { size: 200, world: WORLD, shape: 'square' });
    expect(document.getElementById('tc-ui-cminimap')?.textContent).toBe(CANVAS_MINIMAP_CSS);
    expect(map.el.dataset.shape).toBe('square');
    expect(map.el.style.getPropertyValue('--tc-cminimap-size')).toBe(themePx(200));
    expect(map.canvas.tagName).toBe('CANVAS');
    const p = { x: 0, y: 0 };
    // Centred on the world's middle until a player is set; 100 world units span 200 px.
    expect(map.toMap(0, 0, p)).toEqual({ x: 100, y: 100 });
    map.toMap(50, -50, p);
    expect(p).toEqual({ x: 200, y: 0 });
    map.setPlayer(10, 20, 1.2); // yaw does not turn a north-up map
    map.toMap(10, 20, p);
    expect(p).toEqual({ x: 100, y: 100 });
    map.toMap(20, 10, p); // 10 east, 10 north
    expect(p.x).toBeCloseTo(120, 9);
    expect(p.y).toBeCloseTo(80, 9);
    map.zoom = 2;
    map.toMap(20, 10, p);
    expect(p.x).toBeCloseTo(140, 9);
    expect(p.y).toBeCloseTo(60, 9);
  });

  it('player-up: the heading points up; toWorld inverts toMap in both modes', () => {
    const map = createCanvasMinimap(ov, { size: 160, world: WORLD, rotate: 'player' });
    expect(map.el.dataset.rotate).toBe('player');
    const p = { x: 0, y: 0 };
    // Facing east (yaw π/2): a point straight ahead (east) is straight up on the map.
    map.setPlayer(5, 5, Math.PI / 2);
    map.toMap(15, 5, p);
    expect(p.x).toBeCloseTo(80, 9);
    expect(p.y).toBeCloseTo(80 - 16, 9);
    // North is then to the left.
    map.toMap(5, -5, p);
    expect(p.x).toBeCloseTo(80 - 16, 9);
    expect(p.y).toBeCloseTo(80, 9);
    const w = { x: 0, y: 0 };
    for (const yaw of [0, 0.7, -2.1, Math.PI]) {
      map.setPlayer(-12, 31, yaw);
      for (const [x, z] of [
        [0, 0],
        [-40, 12],
        [33, -7],
      ] as const) {
        map.toMap(x, z, p);
        map.toWorld(p.x, p.y, w);
        expect(w.x).toBeCloseTo(x, 9);
        expect(w.y).toBeCloseTo(z, 9);
      }
    }
    const north = createCanvasMinimap(ov, { size: 160, world: WORLD, zoom: 3 });
    north.setPlayer(7, -3, 1);
    north.toMap(-20, 44, p);
    north.toWorld(p.x, p.y, w);
    expect(w.x).toBeCloseTo(-20, 9);
    expect(w.y).toBeCloseTo(44, 9);
  });

  it('redraws once per change and never when nothing changed', async () => {
    const map = createCanvasMinimap(ov, { world: WORLD });
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    await frame();
    expect(map.redraws).toBe(1);
    const list: MinimapMarker[] = [
      { id: 'a', x: 1, z: 2, kind: 'enemy' },
      { id: 'b', x: -9, z: 4, kind: 'objective', color: '#0f0' },
    ];
    map.setMarkers(list);
    map.setPlayer(1, 1, 0);
    map.setPlayer(2, 1, 0);
    await frame();
    expect(map.redraws).toBe(2);
    expect(map.markers).toBe(2);
    // The same values again: nothing to draw.
    map.setMarkers(list.map((m) => ({ ...m })));
    map.setPlayer(2, 1, 0);
    map.zoom = 1;
    map.setBackground(null);
    await frame();
    await frame();
    expect(map.redraws).toBe(2);
    map.setMarkers([list[0]!, { ...list[1]!, x: -8 }]);
    map.flush();
    expect(map.redraws).toBe(3);
    await frame();
    expect(map.redraws).toBe(3);
    map.setMarkers([]);
    map.flush();
    expect(map.redraws).toBe(4);
    expect(map.markers).toBe(0);
    map.remove();
    expect(map.el.isConnected).toBe(false);
  });

  it('a click picks the world point under it; off a round disc it is ignored', () => {
    const picks: [number, number][] = [];
    const map = createCanvasMinimap(ov, {
      size: 200,
      world: WORLD,
      rotate: 'player',
      onPick: (x, z) => picks.push([x, z]),
    });
    expect(map.el.classList.contains('tc-interactive')).toBe(true);
    map.setPlayer(10, -10, 0.9);
    // Lay the canvas at (100, 50), drawn at twice the design size.
    map.canvas.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 400, height: 400, right: 500, bottom: 450 }) as DOMRect;
    const down = (cx: number, cy: number) =>
      map.el.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: cx,
          clientY: cy,
          button: 0,
          isPrimary: true,
          bubbles: true,
        }),
      );
    down(100 + 2 * 130, 50 + 2 * 70);
    expect(picks.length).toBe(1);
    const want = map.toWorld(130, 70, { x: 0, y: 0 });
    expect(picks[0]![0]).toBeCloseTo(want.x, 9);
    expect(picks[0]![1]).toBeCloseTo(want.y, 9);
    const back = map.toMap(picks[0]![0], picks[0]![1], { x: 0, y: 0 });
    expect(back.x).toBeCloseTo(130, 9);
    expect(back.y).toBeCloseTo(70, 9);
    down(100 + 2 * 100, 50 + 2 * 100);
    expect(picks[1]![0]).toBeCloseTo(10, 9);
    expect(picks[1]![1]).toBeCloseTo(-10, 9);
    down(102, 52); // the corner, outside the disc
    expect(picks.length).toBe(2);
    const plain = createCanvasMinimap(ov, { world: WORLD });
    expect(plain.el.classList.contains('tc-interactive')).toBe(false);
  });
});
