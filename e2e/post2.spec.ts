/**
 * The finishing post page (harness/post2.html, ws/post-2) on every matrix row: the baseline
 * (`?pass=none`) records the composite alone, and each `?pass=` changes what one measure of a
 * device-px screenshot reads, against that baseline:
 *
 * - fxaa: the sharpest step across the cube's diagonal silhouette softens (`edgeContrast` down);
 * - sharpen: it steepens (`edgeContrast` up);
 * - lut (red and blue swapped): the yellow face's red-minus-blue flips sign (`lutShift`);
 * - grain: the flat face gains luma variance (`grainVariance`);
 * - aberration: red and blue cross the silhouette at different columns (`aberrationSplit`);
 * - outline: dark pixels appear along the silhouette (`outlineHits`), and the outline pass ran.
 *
 * Pixels are sampled from screenshots (no golden image); the scene is still, so values are
 * compared across page loads, polled for readiness per E-017.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessPost2State, Post2Point } from '../harness/post2-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

type Rgb = [number, number, number];

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, pass = 'none'): Promise<HarnessPost2State> {
  errors.length = 0;
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const file = `post2.html?pass=${pass}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`post2: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return read();
}

function read(): Promise<HarnessPost2State> {
  return frame.evaluate(() => {
    const s = window.__harnessPost2?.state;
    if (!s) throw new Error('window.__harnessPost2 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessPost2State;
  });
}

/** The part of a device-px screenshot the measures read, and the mapping into it. */
interface Shot {
  /** Device px of the window's top-left corner, its size, and its RGB bytes row by row. */
  x: number;
  y: number;
  w: number;
  h: number;
  data: number[];
  /** Logical px → device px. */
  map: (p: Post2Point) => Post2Point;
  /** Device px per logical px. */
  scale: number;
}

/** Half the width of an edge row, device px. */
const EDGE_HALF = 24;

/** Grab the window around the silhouette rows and the face patch from a device-px screenshot. */
async function shoot(page: Page, s: HarnessPost2State): Promise<Shot> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const scale = (box.width / s.logical.width) * dpr;
  const map = (p: Post2Point): Post2Point => ({
    x: (box.x + (p.x / s.logical.width) * box.width) * dpr,
    y: (box.y + (p.y / s.logical.height) * box.height) * dpr,
  });
  const top = map(s.probes.edge.top);
  const bottom = map(s.probes.edge.bottom);
  const face = map(s.probes.face);
  const half = Math.max(4, Math.floor(s.probes.faceHalf * scale)) + 2;
  const x0 = Math.floor(Math.min(top.x, bottom.x, face.x - half) - EDGE_HALF - 2);
  const x1 = Math.ceil(Math.max(top.x, bottom.x, face.x + half) + EDGE_HALF + 2);
  const y0 = Math.floor(Math.min(top.y, bottom.y, face.y - half) - 2);
  const y1 = Math.ceil(Math.max(top.y, bottom.y, face.y + half) + 2);
  const png = await page.screenshot({ scale: 'device', animations: 'disabled' });
  const grab = await page.evaluate(
    async ([b64, rx, ry, rw, rh]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(rx, ry, rw, rh).data;
      const out: number[] = [];
      for (let i = 0; i < d.length; i += 4) out.push(d[i]!, d[i + 1]!, d[i + 2]!);
      return out;
    },
    [png.toString('base64'), x0, y0, x1 - x0, y1 - y0] as const,
  );
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, data: grab, map, scale };
}

const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Rows across the silhouette: `n` rows between 20% and 80% of the edge, `EDGE_HALF` px each side. */
function edgeRows(
  shot: Shot,
  s: HarnessPost2State,
  n = 9,
): { y: number; x0: number; x1: number }[] {
  const top = shot.map(s.probes.edge.top);
  const bottom = shot.map(s.probes.edge.bottom);
  const out: { y: number; x0: number; x1: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = 0.2 + (0.6 * i) / (n - 1);
    const y = Math.round(top.y + (bottom.y - top.y) * t);
    const x = top.x + (bottom.x - top.x) * t;
    out.push({ y, x0: Math.round(x - EDGE_HALF), x1: Math.round(x + EDGE_HALF) });
  }
  return out;
}

function px(shot: Shot, x: number, y: number): Rgb {
  const lx = x - shot.x;
  const ly = y - shot.y;
  if (lx < 0 || ly < 0 || lx >= shot.w || ly >= shot.h) {
    throw new Error(`(${x}, ${y}) outside the grabbed window`);
  }
  const i = (ly * shot.w + lx) * 3;
  return [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
}

/** Mean over the rows of the steepest luma step between neighbouring columns. */
function edgeContrast(shot: Shot, s: HarnessPost2State): number {
  let total = 0;
  const rows = edgeRows(shot, s);
  for (const { y, x0, x1 } of rows) {
    let peak = 0;
    for (let x = x0; x < x1; x++) {
      peak = Math.max(peak, Math.abs(luma(px(shot, x + 1, y)) - luma(px(shot, x, y))));
    }
    total += peak;
  }
  return total / rows.length;
}

/** The column where `channel` crosses the midpoint of its two ends, by linear interpolation. */
function crossing(shot: Shot, y: number, x0: number, x1: number, channel: number): number {
  const a = px(shot, x0, y)[channel]!;
  const b = px(shot, x1, y)[channel]!;
  const mid = (a + b) / 2;
  const rising = b > a;
  for (let x = x0; x < x1; x++) {
    const v0 = px(shot, x, y)[channel]!;
    const v1 = px(shot, x + 1, y)[channel]!;
    if (rising ? v0 <= mid && v1 > mid : v0 >= mid && v1 < mid) {
      return x + (mid - v0) / (v1 - v0 || 1);
    }
  }
  return (x0 + x1) / 2;
}

/** Mean over the rows of |red crossing − blue crossing|, in device px. */
function aberrationSplit(shot: Shot, s: HarnessPost2State): number {
  let total = 0;
  const rows = edgeRows(shot, s);
  for (const { y, x0, x1 } of rows) {
    total += Math.abs(crossing(shot, y, x0, x1, 0) - crossing(shot, y, x0, x1, 2));
  }
  return total / rows.length;
}

/** Pixels across the rows darker than `dark` (8-bit luma). */
function outlineHits(shot: Shot, s: HarnessPost2State, dark = 50): number {
  let hits = 0;
  for (const { y, x0, x1 } of edgeRows(shot, s)) {
    for (let x = x0; x <= x1; x++) if (luma(px(shot, x, y)) < dark) hits++;
  }
  return hits;
}

/** The face patch: mean colour and luma variance over a square inside the brighter face. */
function face(shot: Shot, s: HarnessPost2State): { mean: Rgb; variance: number } {
  const c = shot.map(s.probes.face);
  const half = Math.max(4, Math.floor(s.probes.faceHalf * shot.scale));
  const mean: Rgb = [0, 0, 0];
  const lumas: number[] = [];
  for (let y = Math.round(c.y - half); y <= Math.round(c.y + half); y += 2) {
    for (let x = Math.round(c.x - half); x <= Math.round(c.x + half); x += 2) {
      const p = px(shot, x, y);
      mean[0] += p[0];
      mean[1] += p[1];
      mean[2] += p[2];
      lumas.push(luma(p));
    }
  }
  const n = lumas.length;
  mean[0] /= n;
  mean[1] /= n;
  mean[2] /= n;
  const avg = lumas.reduce((a, b) => a + b, 0) / n;
  const variance = lumas.reduce((a, l) => a + (l - avg) * (l - avg), 0) / n;
  return { mean, variance };
}

test('the baseline records the composite alone; fxaa and outline add their passes', async ({
  page,
  wrapper,
}) => {
  const base = await open(page, wrapper);
  expect(base.depth).toBe(true);
  expect(base.passes).toEqual(['post-composite']);
  expect(base.gpuErrors).toBe(0);
  for (const pass of ['lut', 'grain', 'aberration', 'sharpen']) {
    const s = await open(page, wrapper, pass);
    expect(s.passes, pass).toEqual(['post-composite']);
    expect(s.gpuErrors, pass).toBe(0);
  }
  const fxaa = await open(page, wrapper, 'fxaa');
  expect(fxaa.passes).toEqual(['post-composite', 'post-fxaa']);
  const outline = await open(page, wrapper, 'outline');
  expect(outline.passes).toEqual(['post-outline', 'post-composite']);
  expect(outline.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('fxaa softens the silhouette step', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const baseContrast = edgeContrast(await shoot(page, base), base);
  expect(baseContrast, 'baseline step').toBeGreaterThan(40);
  const fx = await open(page, wrapper, 'fxaa');
  const fxContrast = edgeContrast(await shoot(page, fx), fx);
  expect(fxContrast, `fxaa ${fxContrast} base ${baseContrast}`).toBeLessThan(baseContrast * 0.93);
  expect(errors).toEqual([]);
});

test('sharpen steepens the silhouette step', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const baseContrast = edgeContrast(await shoot(page, base), base);
  expect(baseContrast, 'baseline step').toBeGreaterThan(40);
  const sh = await open(page, wrapper, 'sharpen');
  const shContrast = edgeContrast(await shoot(page, sh), sh);
  expect(shContrast, `sharpen ${shContrast} base ${baseContrast}`).toBeGreaterThan(
    baseContrast * 1.15,
  );
  expect(errors).toEqual([]);
});

test('the LUT swaps the face from yellow to blue', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const b = face(await shoot(page, base), base).mean;
  const lut = await open(page, wrapper, 'lut');
  const l = face(await shoot(page, lut), lut).mean;
  expect(b[0] - b[2], `base face ${b}`).toBeGreaterThan(60);
  expect(l[2] - l[0], `lut face ${l}`).toBeGreaterThan(60);
  expect(Math.abs(l[1] - b[1]), `green base ${b} lut ${l}`).toBeLessThan(24);
  expect(errors).toEqual([]);
});

test('grain adds luma variance to the flat face', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const bv = face(await shoot(page, base), base).variance;
  const grain = await open(page, wrapper, 'grain');
  const gv = face(await shoot(page, grain), grain).variance;
  expect(bv, 'baseline variance').toBeLessThan(12);
  expect(gv, `grain ${gv} base ${bv}`).toBeGreaterThan(bv + 100);
  expect(errors).toEqual([]);
});

test('aberration splits red from blue across the silhouette', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const bs = aberrationSplit(await shoot(page, base), base);
  const ab = await open(page, wrapper, 'aberration');
  const shot = await shoot(page, ab);
  const as = aberrationSplit(shot, ab);
  expect(bs, 'baseline split').toBeLessThan(1.5 * shot.scale + 1);
  expect(as, `aberration ${as} base ${bs}`).toBeGreaterThan(bs + 3 * shot.scale);
  expect(errors).toEqual([]);
});

test('the outline draws dark pixels along the silhouette', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const bh = outlineHits(await shoot(page, base), base);
  const ol = await open(page, wrapper, 'outline');
  const oh = outlineHits(await shoot(page, ol), ol);
  expect(bh, 'baseline dark pixels').toBe(0);
  expect(oh, `outline dark pixels ${oh}`).toBeGreaterThanOrEqual(9);
  expect(errors).toEqual([]);
});
