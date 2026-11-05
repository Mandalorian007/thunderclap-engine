/**
 * The two-views page (harness/views.html) on every matrix row: the stereo seam without WebXR
 * (ws/two-views). One frame, two `render()` calls, two eyes into the two halves of one surface.
 *
 * - the page boots WebGPU, both halves draw the scene with depth on and nothing logs an error;
 * - the two eyes sit ±ipd/2 apart and carry `view_index` 0 and 1;
 * - parallax: the head-locked marker lands at different places in the two halves (pixels
 *   sampled from a screenshot, no golden image);
 * - depth per view: in each half the near block occludes the taller block drawn after it, and
 *   the marker's near depth in one half does not reach the other (the scene shows through where
 *   the other eye's marker was).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessViewsState, ViewsProbe } from '../harness/views-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}
type Rgb = [number, number, number];

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}views.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('views.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`two-views demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessViewsState> {
  return frame.evaluate(() => {
    const s = window.__harnessViews?.state;
    if (!s) throw new Error('window.__harnessViews missing');
    return JSON.parse(JSON.stringify(s)) as HarnessViewsState;
  });
}

/** The canvas box in page CSS px. */
async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** Unit-square canvas fractions to page CSS px. */
async function toPage(p: ViewsProbe): Promise<Pt> {
  const box = await canvasBox();
  return { x: box.x + p.x * box.width, y: box.y + p.y * box.height };
}

/**
 * Average colour of the 3×3 CSS px around each page point, from a screenshot of the page (so
 * what the swapchain presented, after the engine's tonemap), decoded by the browser itself.
 */
async function sample(page: Page, points: Pt[]): Promise<Rgb[]> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      return pts.map((p) => {
        const d = g.getImageData(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3).data;
        const out: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          out[0] += d[i]! / 9;
          out[1] += d[i + 1]! / 9;
          out[2] += d[i + 2]! / 9;
        }
        return out;
      });
    },
    [png.toString('base64'), points] as const,
  );
}

const isRed = (c: Rgb) => c[0] > c[1] + 40 && c[0] > c[2] + 40;
const isBlue = (c: Rgb) => c[2] > c[0] + 40;
const isMagenta = (c: Rgb) => c[0] > c[1] + 40 && c[2] > c[1] + 40;

test('two eyes render one frame into two halves with view_index 0 and 1', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  const [l, r] = s.eyes;
  expect([l.viewIndex, r.viewIndex]).toEqual([0, 1]);
  expect(l.screen).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
  expect(r.screen).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  // The eyes are ipd apart, at the same height.
  const d = Math.hypot(
    r.position[0] - l.position[0],
    r.position[1] - l.position[1],
    r.position[2] - l.position[2],
  );
  expect(d).toBeCloseTo(s.ipd, 4);
  expect(r.position[1]).toBeCloseTo(l.position[1], 4);
  // Six instances recorded once, drawn once per view; both views drew.
  expect(s.stats.instances).toBe(12);
  expect(l.drawCalls).toBeGreaterThan(0);
  expect(r.drawCalls).toBeGreaterThan(0);
  expect(s.stats.drawCalls).toBe(l.drawCalls + r.drawCalls);
  // Every probe of an eye lies inside its half.
  for (const [eye, lo, hi] of [
    [l, 0, 0.5],
    [r, 0.5, 1],
  ] as const) {
    for (const p of Object.values(eye.probes)) {
      expect(p.x).toBeGreaterThan(lo);
      expect(p.x).toBeLessThan(hi);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1);
    }
  }
  expect(errors).toEqual([]);
});

test('both halves draw the scene with depth, and the halves differ by parallax', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  const [l, r] = s.eyes;
  const [lNear, lFar, lGround, lMarker, rNear, rFar, rGround, rMarker] = await sample(page, [
    await toPage(l.probes.near),
    await toPage(l.probes.far),
    await toPage(l.probes.ground),
    await toPage(l.probes.marker),
    await toPage(r.probes.near),
    await toPage(r.probes.far),
    await toPage(r.probes.ground),
    await toPage(r.probes.marker),
  ]);
  // In each half: the near block is red (the taller blue block behind it was drawn later and
  // lost the depth test), the far block shows above it, the ground is lit.
  for (const [near, far, ground, marker, name] of [
    [lNear!, lFar!, lGround!, lMarker!, 'left'],
    [rNear!, rFar!, rGround!, rMarker!, 'right'],
  ] as const) {
    expect(isRed(near), `${name} near ${near}`).toBe(true);
    expect(isBlue(far), `${name} far ${far}`).toBe(true);
    expect(ground[1], `${name} ground ${ground}`).toBeGreaterThan(ground[2]);
    expect(ground[0] + ground[1] + ground[2]).toBeGreaterThan(120);
    expect(isMagenta(marker), `${name} marker ${marker}`).toBe(true);
  }
  // Parallax: the marker, 0.6 m ahead, sits at different places in the two halves (the eyes
  // converge on it from either side); the far scene barely moves.
  const shift = r.probes.marker.x - 0.5 - l.probes.marker.x;
  expect(Math.abs(shift)).toBeGreaterThan(0.02);
  expect(Math.abs(r.probes.far.x - 0.5 - l.probes.far.x)).toBeLessThan(Math.abs(shift) / 4);
  expect(errors).toEqual([]);
});

test('a near object in one eye does not reach the other half, in colour or in depth', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  const [l, r] = s.eyes;
  // Where the left eye sees the marker, the right half (same spot, shifted a half) shows the
  // scene behind: the far block, whose depth test would fail if the left marker's depth had
  // carried over, leaving the clear colour.
  const atRight = (p: ViewsProbe): ViewsProbe => ({ x: p.x + 0.5, y: p.y });
  const atLeft = (p: ViewsProbe): ViewsProbe => ({ x: p.x - 0.5, y: p.y });
  const [lMarker, rBehind, rMarker, lBehind] = await sample(page, [
    await toPage(l.probes.marker),
    await toPage(atRight(l.probes.marker)),
    await toPage(r.probes.marker),
    await toPage(atLeft(r.probes.marker)),
  ]);
  expect(isMagenta(lMarker!), `left marker ${lMarker}`).toBe(true);
  expect(isMagenta(rMarker!), `right marker ${rMarker}`).toBe(true);
  expect(isMagenta(rBehind!), `right half behind left marker ${rBehind}`).toBe(false);
  expect(isMagenta(lBehind!), `left half behind right marker ${lBehind}`).toBe(false);
  expect(isBlue(rBehind!), `right half behind left marker ${rBehind}`).toBe(true);
  expect(isBlue(lBehind!), `left half behind right marker ${lBehind}`).toBe(true);
  expect(errors).toEqual([]);
});
