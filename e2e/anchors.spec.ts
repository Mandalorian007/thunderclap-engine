/**
 * The anchors demo (harness/anchors.html) on every matrix row: DOM that follows world points
 * (ws/anchors), booted through `createGame`, which updates `ui.anchors` after every frame.
 *
 * - each cube's label sits within a few px of the cube's projected point, computed here from the
 *   camera's `viewProjection` and the canvas box (not from the engine's own projection code);
 * - a label at a point behind the camera is hidden;
 * - the clamped marker stays inside the canvas when its cube leaves the view, and is back on the
 *   cube when the camera turns back.
 */
import type { Frame, Page } from '@playwright/test';
import type { AnchorsBox, AnchorsLabel, HarnessAnchorsState } from '../harness/anchors-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}anchors.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('anchors.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`anchors demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessAnchorsState> {
  return frame.evaluate(() => {
    const api = window.__harnessAnchors;
    if (!api) throw new Error('window.__harnessAnchors missing');
    return JSON.parse(JSON.stringify(api.state())) as HarnessAnchorsState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

type V3 = [number, number, number];

async function aim(eye: V3, target: V3): Promise<void> {
  await frame.evaluate(([e, t]) => window.__harnessAnchors?.aim(e, t), [eye, target] as const);
  await frames(2);
}

/** World point → client px through the state's matrix and canvas box; null behind the camera. */
function project(s: HarnessAnchorsState, w: number[]): { x: number; y: number } | null {
  const m = s.viewProjection;
  const c = [0, 1, 2, 3].map(
    (r) => m[r]! * w[0]! + m[4 + r]! * w[1]! + m[8 + r]! * w[2]! + m[12 + r]!,
  );
  const cw = c[3]!;
  if (cw <= 0) return null;
  const sx = s.screen.x + ((c[0]! / cw + 1) / 2) * s.screen.width;
  const sy = s.screen.y + ((1 - c[1]! / cw) / 2) * s.screen.height;
  return {
    x: s.canvas.x + (sx / s.logical.width) * s.canvas.width,
    y: s.canvas.y + (sy / s.logical.height) * s.canvas.height,
  };
}

const centre = (r: AnchorsBox) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

function byId(s: HarnessAnchorsState, id: string): AnchorsLabel {
  const l = s.labels.find((x) => x.id === id);
  if (!l) throw new Error(`no label ${id}`);
  return l;
}

/** The element's centre is within 3 CSS px of the world point's projection. */
function expectOn(s: HarnessAnchorsState, l: AnchorsLabel): void {
  const p = project(s, l.world);
  expect(p, l.id).not.toBeNull();
  const c = centre(l.rect);
  expect(Math.abs(c.x - (p?.x ?? Number.NaN)), `${l.id} x`).toBeLessThan(3);
  expect(Math.abs(c.y - (p?.y ?? Number.NaN)), `${l.id} y`).toBeLessThan(3);
}

/** `r` lies inside `c` (half a px of rounding allowed) and is not empty. */
function inside(r: AnchorsBox, c: AnchorsBox): boolean {
  return (
    r.width > 0 &&
    r.x >= c.x - 0.5 &&
    r.y >= c.y - 0.5 &&
    r.x + r.width <= c.x + c.width + 0.5 &&
    r.y + r.height <= c.y + c.height + 0.5
  );
}

test('each label sits on its cube, and a label behind the camera is hidden', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await frames(2);
  const s = await read();
  const cubes = s.labels.filter((l) => l.id.startsWith('label-'));
  expect(cubes).toHaveLength(9);
  for (const l of cubes) {
    expect(l.hidden, l.id).toBe(false);
    expectOn(s, l);
  }
  const behind = byId(s, 'behind');
  expect(project(s, behind.world)).toBeNull();
  expect(behind.hidden).toBe(true);
  expect(behind.rect.width).toBe(0);
  // The marker's cube is in view at first: on its point, not clamped.
  const marker = byId(s, 'marker');
  expect(marker.clamped).toBe(false);
  expectOn(s, marker);
  expect(errors).toEqual([]);
});

test('the clamped marker stays inside the view when its cube leaves it', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);

  // Look left: the far cube (at +x, -z) is off the right edge, in front of the camera.
  await aim([0, 6, 12], [-30, 0, 12]);
  let s = await read();
  let m = byId(s, 'marker');
  expect(m.hidden).toBe(false);
  expect(m.clamped).toBe(true);
  expect(inside(m.rect, s.canvas), JSON.stringify([m.rect, s.canvas])).toBe(true);
  // Unclamped labels that left the view are hidden.
  expect(s.labels.some((l) => l.id.startsWith('label-') && l.hidden)).toBe(true);

  // Look away: the cube is behind the camera, and the marker stays on screen.
  await aim([0, 6, 12], [0, 6, 40]);
  s = await read();
  m = byId(s, 'marker');
  expect(project(s, m.world)).toBeNull();
  expect(m.hidden).toBe(false);
  expect(m.clamped).toBe(true);
  expect(inside(m.rect, s.canvas), JSON.stringify([m.rect, s.canvas])).toBe(true);

  // Back: on the cube again.
  await aim([0, 6, 12], [0, 0, 0]);
  s = await read();
  m = byId(s, 'marker');
  expect(m.clamped).toBe(false);
  expectOn(s, m);
  expect(errors).toEqual([]);
});
