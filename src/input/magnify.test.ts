import { describe, expect, it } from 'vitest';
import { loupeLeader } from '../ui/loupe';
import { type GestureOptions, Gestures } from './gestures';
import {
  loupeClear,
  loupeSpot,
  type MagnifyOptions,
  magnifySize,
  type Rect,
  snapToGrid,
} from './magnify';

// A 4×3 grid, pitch 20, cell (i, j) centred at (10 + 20i, 10 + 20j).
const G = { left: 0, top: 0, pitch: 20, cols: 4, rows: 3 };
const not =
  (...bad: [number, number][]) =>
  (i: number, j: number) =>
    !bad.some(([x, y]) => x === i && y === j);

describe('snapToGrid: the nearest accepted cell within half a pitch', () => {
  it('takes the cell under the point', () => {
    expect(snapToGrid(G, 31, 12)).toEqual({ x: 1, y: 0 });
  });
  it('steps off a refused cell to the nearest accepted one', () => {
    expect(snapToGrid(G, 37, 30, not([1, 1]))).toEqual({ x: 2, y: 1 });
    expect(snapToGrid(G, 30, 22, not([1, 1]))).toEqual({ x: 1, y: 0 });
  });
  it('snaps onto an edge cell from just off the grid, not from far off', () => {
    expect(snapToGrid(G, -6, 10)).toEqual({ x: 0, y: 0 });
    expect(snapToGrid(G, -11, 10)).toBeNull();
  });
  it('gives nothing when every nearby cell is refused', () => {
    expect(snapToGrid(G, 30, 30, () => false)).toBeNull();
  });
  it('honours the grid origin', () => {
    expect(snapToGrid({ ...G, left: 100, top: 50 }, 111, 61)).toEqual({ x: 0, y: 0 });
  });
});

describe('loupeSpot', () => {
  const view = { width: 800, height: 400 };
  it('sits beside the finger towards the middle, above the aim point', () => {
    const a = loupeSpot({ x: 100, y: 300 }, { x: 100, y: 300 }, 128, view);
    expect(a.x).toBe(100 + 64 + 28);
    expect(a.y).toBeCloseTo(300 - 64 * 0.6);
    const b = loupeSpot({ x: 700, y: 300 }, { x: 700, y: 300 }, 128, view);
    expect(b.x).toBe(700 - 64 - 28);
  });
  it('stays 4 px inside the view', () => {
    const a = loupeSpot({ x: 10, y: 10 }, { x: 10, y: 10 }, 128, view);
    expect(a.y).toBe(68);
    const b = loupeSpot({ x: 790, y: 399 }, { x: 790, y: 399 }, 128, view);
    expect(b.x).toBeLessThanOrEqual(800 - 68);
    expect(b.y).toBe(400 - 68);
  });
});

describe('loupeClear: the loupe leaves the kept area in sight', () => {
  const view = { width: 800, height: 400 };
  const disc = (c: { x: number; y: number }, q: Rect, half: number) =>
    Math.hypot(Math.max(q.l - c.x, 0, c.x - q.r), Math.max(q.t - c.y, 0, c.y - q.b)) >= half;
  it('never covers a kept rect or the fingertip, and stays on screen', () => {
    for (const [fx, fy] of [
      [60, 380],
      [400, 300],
      [760, 200],
      [400, 120],
      [200, 390],
    ] as const) {
      const aim = { x: fx, y: fy - 56 };
      const keep = [{ l: aim.x - 45, t: aim.y - 45, r: aim.x + 45, b: aim.y + 45 }];
      const c = loupeClear({ x: fx, y: fy }, aim, 128, view, keep);
      expect(disc(c, keep[0]!, 64), `${fx},${fy}`).toBe(true);
      expect(Math.hypot(c.x - fx, c.y - fy)).toBeGreaterThanOrEqual(64 + 22);
      expect(c.x - 64).toBeGreaterThanOrEqual(4);
      expect(c.x + 64).toBeLessThanOrEqual(796);
      expect(c.y - 64).toBeGreaterThanOrEqual(4);
      expect(c.y + 64).toBeLessThanOrEqual(396);
      expect(c.y).toBeLessThanOrEqual(fy);
    }
  });
  it('takes the nearest free side, and covers an avoided rect only when it must', () => {
    const aim = { x: 300, y: 200 };
    const keep = [{ l: 255, t: 155, r: 345, b: 245 }];
    const near = loupeClear({ x: 300, y: 256 }, aim, 128, view, keep);
    expect(Math.hypot(near.x - aim.x, near.y - aim.y)).toBeLessThan(64 + 45 + 6 + 2 + 32);
    const right = { l: 340, t: 0, r: 800, b: 400 };
    const off = loupeClear({ x: 300, y: 256 }, aim, 128, view, keep, [right]);
    expect(disc(off, right, 64)).toBe(true);
  });
  it('leaves spared rects in sight when it can, ranked below keep and above avoid', () => {
    const aim = { x: 300, y: 200 };
    const finger = { x: 300, y: 256 };
    const keep = [{ l: 255, t: 155, r: 345, b: 245 }];
    // A label right of the kept area and one above it: the loupe finds a spot clear of both.
    const labels = [
      { l: 350, t: 150, r: 450, b: 250 },
      { l: 200, t: 20, r: 400, b: 150 },
    ];
    const c = loupeClear(finger, aim, 128, view, keep, [], labels);
    for (const q of labels) expect(disc(c, q, 64)).toBe(true);
    expect(disc(c, keep[0]!, 64)).toBe(true);
    // Covering a spared rect beats covering an avoided one.
    const left = { l: 0, t: 0, r: 254, b: 400 };
    const rest = { l: 346, t: 0, r: 800, b: 400 };
    const pick = loupeClear(finger, aim, 128, view, keep, [rest], [left]);
    expect(disc(pick, left, 64)).toBe(true);
    // Spared rects never win over the kept area or the fingertip.
    const all = { l: 0, t: 0, r: 800, b: 400 };
    const forced = loupeClear(finger, aim, 128, view, keep, [], [all]);
    expect(disc(forced, keep[0]!, 64)).toBe(true);
    expect(Math.hypot(forced.x - finger.x, forced.y - finger.y)).toBeGreaterThanOrEqual(64 + 22);
  });
});

/** Gestures with magnify on a fake clock, over the 4×3 grid (game space = client px). */
function setup(m: Partial<MagnifyOptions> = {}, opts: GestureOptions = {}) {
  let t = 1000;
  let pitch = 20;
  const magnify: MagnifyOptions = {
    pitch: () => pitch,
    snap: (x, y) => {
      const c = snapToGrid(G, x, y);
      return c ? { x: 10 + 20 * c.x, y: 10 + 20 * c.y, r: 10 } : null;
    },
    ...m,
  };
  const g = new Gestures({ now: () => t, magnify, ...opts });
  return {
    g,
    setPitch(p: number) {
      pitch = p;
    },
    tick(ms = 16) {
      t += ms;
      g.update();
    },
  };
}

describe('Gestures magnify: aim, lift, snap and loupe', () => {
  it('a held finger aims where it is, snapped, with the loupe below 44 px of pitch', () => {
    const { g, tick } = setup();
    g.pointerDown(1, 31, 12);
    tick();
    expect(g.aim).toMatchObject({ x: 31, y: 12, lifted: false, loupe: true, ended: false });
    expect(g.aim?.target).toEqual({ x: 30, y: 10, r: 10 });
  });

  it('a dragging finger aims `lift` CSS px above itself', () => {
    const { g, tick } = setup({ lift: 40 });
    g.pointerDown(1, 30, 100);
    g.pointerMove(1, 30, 70);
    tick();
    expect(g.drag?.phase).toBe('start');
    expect(g.aim).toMatchObject({ x: 30, y: 30, lifted: true });
    expect(g.aim?.finger).toEqual({ x: 30, y: 70 });
    expect(g.aim?.target).toEqual({ x: 30, y: 30, r: 10 });
  });

  it('reports the aim it lifted at once, with the drag end', () => {
    const { g, tick } = setup({ lift: 40 });
    g.pointerDown(1, 30, 100);
    g.pointerMove(1, 30, 70);
    tick();
    g.pointerUp(1, 50, 70);
    tick();
    // The last move gets its own tick, still aiming (not ended), then the end.
    expect(g.drag?.phase).toBe('move');
    expect(g.aim).toMatchObject({ x: 50, y: 30, ended: false });
    tick();
    expect(g.drag?.phase).toBe('end');
    expect(g.aim).toMatchObject({ x: 50, y: 30, ended: true });
    expect(g.aim?.target).toEqual({ x: 50, y: 30, r: 10 });
    tick();
    expect(g.aim).toBeNull();
  });

  it('no loupe at or above `below` px of pitch, and none off the targets', () => {
    const { g, tick, setPitch } = setup();
    setPitch(44);
    g.pointerDown(1, 31, 12);
    tick();
    expect(g.aim?.loupe).toBe(false);
    setPitch(30);
    tick();
    expect(g.aim?.loupe).toBe(true);
    g.pointerMove(1, 300, 300);
    tick();
    expect(g.aim?.target).toBeNull();
    expect(g.aim?.loupe).toBe(false);
  });

  it('`over` widens where the loupe shows (a refused cell still magnifies)', () => {
    const { g, tick } = setup({ snap: () => null, over: (x, y) => x < 80 && y < 60 });
    g.pointerDown(1, 31, 12);
    tick();
    expect(g.aim).toMatchObject({ target: null, loupe: true });
  });

  it('mouse and pen never aim; `when` false never aims', () => {
    const a = setup();
    a.g.pointerDown(1, 31, 12, 'mouse');
    a.tick();
    expect(a.g.aim).toBeNull();
    a.g.pointerUp(1, 31, 12);
    a.g.pointerDown(2, 31, 12, 'pen');
    a.tick();
    expect(a.g.aim).toBeNull();
    const b = setup({ when: () => false });
    b.g.pointerDown(1, 31, 12);
    b.tick();
    expect(b.g.aim).toBeNull();
  });

  it('a second finger, blocked, or a cancel ends the aim', () => {
    const a = setup();
    a.g.pointerDown(1, 31, 12);
    a.tick();
    expect(a.g.aim).not.toBeNull();
    a.g.pointerDown(2, 60, 40);
    a.tick();
    expect(a.g.aim).toBeNull();

    let blocked = false;
    const b = setup({}, { blocked: () => blocked });
    b.g.pointerDown(1, 31, 12);
    b.tick();
    blocked = true;
    b.tick();
    expect(b.g.aim).toBeNull();

    const c = setup();
    c.g.pointerDown(1, 31, 12);
    c.tick();
    c.g.pointerCancel(1);
    c.tick();
    expect(c.g.aim).toBeNull();
  });

  it('aims through the pointer transform; outside the game rect it is not inside', () => {
    const { g, tick } = setup();
    g.setPointerTransform((x, y) => (x < 0 ? null : { x: x / 2, y: y / 2 }));
    g.pointerDown(1, 62, 24);
    tick();
    expect(g.aim).toMatchObject({ x: 31, y: 12, inside: true, client: { x: 62, y: 24 } });
    g.pointerMove(1, -40, 24);
    tick();
    expect(g.aim).toMatchObject({ inside: false, target: null, loupe: false });
  });

  it('without magnify there is never an aim', () => {
    const g = new Gestures({ now: () => 0 });
    g.pointerDown(1, 10, 10);
    g.update();
    expect(g.aim).toBeNull();
  });
});

describe('magnifySize and loupeLeader (dense-board-4)', () => {
  it('reads a fixed or a live loupe size, defaulting to 128', () => {
    expect(magnifySize({})).toBe(128);
    expect(magnifySize({ size: 100 })).toBe(100);
    let s = 96;
    const m = { size: () => s };
    expect(magnifySize(m)).toBe(96);
    s = 120;
    expect(magnifySize(m)).toBe(120);
  });

  it('runs a leader from the rim to just short of the spot', () => {
    const seg = loupeLeader({ x: 0, y: 0 }, 100, { x: 100, y: 0, r: 10 })!;
    expect(seg.x0).toBeCloseTo(51);
    expect(seg.x1).toBeCloseTo(88);
    expect(seg.y0).toBe(0);
    expect(seg.y1).toBe(0);
  });

  it('draws no leader when the spot touches or sits under the loupe', () => {
    expect(loupeLeader({ x: 0, y: 0 }, 100, { x: 60, y: 0, r: 10 })).toBeNull();
    expect(loupeLeader({ x: 0, y: 0 }, 100, { x: 0, y: 0, r: 10 })).toBeNull();
  });
});
