/**
 * The post 3 page (harness/post3.html, ws/post-3) on every matrix row. The scene is parked
 * (`?still`) so values compare across page loads; each flag changes one measure of a device-px
 * screenshot against the page without it:
 *
 * - taa: the steepest luma step across the block's silhouette softens, read over 3 frames;
 * - ssr: the mirror floor under the sky patch brightens;
 * - autoexp: the published EV leaves 0 within 2 s and settles;
 * - wb=3200: the grey block's red-to-blue ratio rises;
 * - dirt: the bloom halo beside the sky patch changes;
 * - every flag: the passes run in the documented order, TAA standing in for FXAA.
 *
 * Pixels are sampled from screenshots (no golden image), polled for readiness per E-017.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessPost3State, Post3Point } from '../harness/post3-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

type Rgb = [number, number, number];

let frame: Frame;
const errors: string[] = [];

/** Open the page with `flags` (`still` is always on) and wait for `frames` presented frames. */
async function open(
  page: Page,
  wrapper: string,
  flags = '',
  frames = 5,
): Promise<HarnessPost3State> {
  errors.length = 0;
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const file = `post3.html?still${flags ? `&${flags}` : ''}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`post3: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(frames);
  return read();
}

function read(): Promise<HarnessPost3State> {
  return frame.evaluate(() => {
    const s = window.__harnessPost3?.state;
    if (!s) throw new Error('window.__harnessPost3 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessPost3State;
  });
}

/** A device-px screenshot window and the mapping into it. */
interface Shot {
  x: number;
  y: number;
  w: number;
  h: number;
  /** RGB bytes row by row. */
  data: Uint8Array;
  /** Logical px → device px. */
  map: (p: Post3Point) => Post3Point;
  /** Device px per logical px. */
  scale: number;
}

/** Half the width of an edge row, device px. */
const EDGE_HALF = 24;
/** Half side of the floor patch, logical px. */
const FLOOR_HALF = 14;

/** The window a measure reads: the silhouette rows, or a square patch around a probe. */
type Region = { edge: true } | { at: Post3Point; half: number };

/** Grab the window around `region` from a device-px screenshot. */
async function shoot(page: Page, s: HarnessPost3State, region: Region): Promise<Shot> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const scale = (box.width / s.logical.width) * dpr;
  const map = (p: Post3Point): Post3Point => ({
    x: (box.x + (p.x / s.logical.width) * box.width) * dpr,
    y: (box.y + (p.y / s.logical.height) * box.height) * dpr,
  });
  let pts: Post3Point[];
  let pad: number;
  if ('edge' in region) {
    pts = [map(s.probes.edge.top), map(s.probes.edge.bottom)];
    pad = EDGE_HALF + 2;
  } else {
    pts = [map(region.at)];
    pad = Math.max(4, Math.floor(region.half * scale)) + 2;
  }
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - pad));
  const x1 = Math.ceil(Math.max(...pts.map((p) => p.x)) + pad);
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - pad));
  const y1 = Math.ceil(Math.max(...pts.map((p) => p.y)) + pad);
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
      let out = '';
      for (let i = 0; i < d.length; i += 4) {
        out += String.fromCharCode(d[i]!, d[i + 1]!, d[i + 2]!);
      }
      return btoa(out);
    },
    [png.toString('base64'), x0, y0, x1 - x0, y1 - y0] as const,
  );
  const data = new Uint8Array(Buffer.from(grab, 'base64'));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, data, map, scale };
}

const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function px(shot: Shot, x: number, y: number): Rgb {
  const lx = x - shot.x;
  const ly = y - shot.y;
  if (lx < 0 || ly < 0 || lx >= shot.w || ly >= shot.h) {
    throw new Error(`(${x}, ${y}) outside the grabbed window`);
  }
  const i = (ly * shot.w + lx) * 3;
  return [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
}

/** Mean over rows across the silhouette of the steepest luma step between neighbouring columns. */
function edgeContrast(shot: Shot, s: HarnessPost3State, n = 9): number {
  const top = shot.map(s.probes.edge.top);
  const bottom = shot.map(s.probes.edge.bottom);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t = 0.2 + (0.6 * i) / (n - 1);
    const y = Math.round(top.y + (bottom.y - top.y) * t);
    const x = top.x + (bottom.x - top.x) * t;
    let peak = 0;
    for (let c = Math.round(x - EDGE_HALF); c < Math.round(x + EDGE_HALF); c++) {
      peak = Math.max(peak, Math.abs(luma(px(shot, c + 1, y)) - luma(px(shot, c, y))));
    }
    total += peak;
  }
  return total / n;
}

/** Mean colour over a square patch (`half` logical px) around a probe. */
function patch(shot: Shot, p: Post3Point, half: number): Rgb {
  const c = shot.map(p);
  const h = Math.max(3, Math.floor(half * shot.scale));
  const mean: Rgb = [0, 0, 0];
  let n = 0;
  for (let y = Math.round(c.y - h); y <= Math.round(c.y + h); y += 2) {
    for (let x = Math.round(c.x - h); x <= Math.round(c.x + h); x += 2) {
      const v = px(shot, x, y);
      mean[0] += v[0];
      mean[1] += v[1];
      mean[2] += v[2];
      n++;
    }
  }
  return [mean[0] / n, mean[1] / n, mean[2] / n];
}

/**
 * Mean and peak absolute luma difference per pixel between two shots of the same window (the
 * scene is parked, so a pass that changes nothing reads 0).
 */
function patchDiff(a: Shot, b: Shot, p: Post3Point, half: number): { mean: number; peak: number } {
  const c = a.map(p);
  const h = Math.max(3, Math.floor(half * a.scale));
  let total = 0;
  let peak = 0;
  let n = 0;
  for (let y = Math.round(c.y - h); y <= Math.round(c.y + h); y += 2) {
    for (let x = Math.round(c.x - h); x <= Math.round(c.x + h); x += 2) {
      const d = Math.abs(luma(px(a, x, y)) - luma(px(b, x, y)));
      total += d;
      peak = Math.max(peak, d);
      n++;
    }
  }
  return { mean: total / n, peak };
}

/** `edgeContrast` averaged over three frames. */
async function edgeOverFrames(page: Page, s: HarnessPost3State): Promise<number> {
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const before = (await read()).frames;
    await expect.poll(async () => (await read()).frames).toBeGreaterThan(before);
    total += edgeContrast(await shoot(page, s, { edge: true }), s);
  }
  return total / 3;
}

const POST3 = ['post-taa', 'post-motion-blur', 'post-ssr', 'post-exposure-histogram'];

test('the passes run in the documented order; TAA stands in for FXAA', async ({
  page,
  wrapper,
}) => {
  const base = await open(page, wrapper);
  expect(base.passes).toContain('post-composite');
  expect(base.passes).toContain('post-bloom-prefilter');
  for (const label of POST3) expect(base.passes, label).not.toContain(label);
  expect(base.taaActive).toBe(false);
  expect(base.exposure).toBe(0);
  const all = await open(page, wrapper, 'taa&ssr&autoexp&mblur&dirt&fxaa');
  const order = [
    'post-taa',
    'post-motion-blur',
    'post-ssr',
    'post-exposure-histogram',
    'post-exposure-average',
    'post-bloom-prefilter',
    'post-composite',
  ];
  let at = -1;
  for (const label of order) {
    const i = all.passes.indexOf(label);
    expect(i, `${label} in ${all.passes}`).toBeGreaterThan(at);
    at = i;
  }
  expect(all.passes).not.toContain('post-fxaa');
  expect(all.taaActive).toBe(true);
  expect(all.ssrActive).toBe(true);
  expect(all.historyResets).toBeGreaterThanOrEqual(1);
  expect(all.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('taa softens the silhouette step over three frames', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const baseStep = await edgeOverFrames(page, base);
  expect(baseStep, 'baseline step').toBeGreaterThan(30);
  // Past one jitter cycle, so the history has converged.
  const taa = await open(page, wrapper, 'taa', 20);
  expect(taa.taaActive).toBe(true);
  const taaStep = await edgeOverFrames(page, taa);
  expect(taaStep, `taa ${taaStep} base ${baseStep}`).toBeLessThan(baseStep * 0.9);
  expect(errors).toEqual([]);
});

test('ssr brightens the mirror floor under the sky patch', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const floor = (s: HarnessPost3State) => ({ at: s.probes.floor, half: FLOOR_HALF });
  const b = luma(patch(await shoot(page, base, floor(base)), base.probes.floor, FLOOR_HALF));
  const ssr = await open(page, wrapper, 'ssr');
  expect(ssr.ssrActive).toBe(true);
  const r = luma(patch(await shoot(page, ssr, floor(ssr)), ssr.probes.floor, FLOOR_HALF));
  expect(r, `ssr floor ${r} base ${b}`).toBeGreaterThan(b + 12);
  expect(ssr.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('auto exposure moves the EV within 2 s and settles', async ({ page, wrapper }) => {
  await open(page, wrapper, 'autoexp');
  await expect
    .poll(async () => Math.abs((await read()).exposure), { timeout: 2000 })
    .toBeGreaterThan(0.1);
  await expect
    .poll(
      async () => {
        const a = (await read()).exposure;
        await page.waitForTimeout(400);
        return Math.abs((await read()).exposure - a);
      },
      { timeout: 5000 },
    )
    .toBeLessThan(0.02);
  const s = await read();
  expect(s.exposure).toBeGreaterThanOrEqual(-4);
  expect(s.exposure).toBeLessThanOrEqual(4);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('white balance at 3200 K warms the grey block', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const grey = (s: HarnessPost3State) => ({ at: s.probes.grey, half: s.probes.greyHalf });
  const b = patch(await shoot(page, base, grey(base)), base.probes.grey, base.probes.greyHalf);
  const wb = await open(page, wrapper, 'wb=3200');
  const w = patch(await shoot(page, wb, grey(wb)), wb.probes.grey, wb.probes.greyHalf);
  expect(b[0] / b[2], `base grey ${b}`).toBeLessThan(1.2);
  expect(w[0] / w[2], `wb grey ${w} base ${b}`).toBeGreaterThan((b[0] / b[2]) * 1.2);
  expect(errors).toEqual([]);
});

test('lens dirt puts spots in the bloom halo beside the sky patch', async ({ page, wrapper }) => {
  const base = await open(page, wrapper);
  const halo = (s: HarnessPost3State) => ({ at: s.probes.bloom, half: s.probes.bloomHalf });
  const bs = await shoot(page, base, halo(base));
  expect(luma(patch(bs, base.probes.bloom, base.probes.bloomHalf)), 'halo').toBeGreaterThan(8);
  const dirt = await open(page, wrapper, 'dirt');
  const ds = await shoot(page, dirt, halo(dirt));
  const diff = patchDiff(bs, ds, dirt.probes.bloom, dirt.probes.bloomHalf);
  expect(diff.peak, `dirt peak ${diff.peak} mean ${diff.mean}`).toBeGreaterThan(15);
  expect(diff.mean, `dirt mean ${diff.mean}`).toBeGreaterThan(1.5);
  expect(dirt.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
