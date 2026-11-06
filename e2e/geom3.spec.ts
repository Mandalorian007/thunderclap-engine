/**
 * The geometry-pipeline page (harness/geom3.html, ws/geom-3) on every matrix row:
 *
 * - `?lod`: four rocks at rising distances draw at rising levels of their LOD chain, and fewer
 *   triangles than four full rocks;
 * - `?hull`: the torus's convex hull is drawn and far smaller than the torus;
 * - `?slice`: every plane position caps both halves and leaves them closed, while it sweeps;
 * - `?tiles`: the box lands on the moving platform and is carried by it.
 *
 * Every mode boots without GPU or console errors.
 */
import type { Frame, Page } from '@playwright/test';
import { type HarnessGeom3State, LOD_DISTANCES } from '../harness/geom3-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `geom3.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${url}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(url)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`geom3 demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessGeom3State> {
  return frame.evaluate(() => {
    const s = window.__harnessGeom3?.state;
    if (!s) throw new Error('window.__harnessGeom3 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessGeom3State;
  });
}

test('lod: farther rocks draw coarser levels', async ({ page, wrapper }) => {
  await open(page, wrapper, 'lod&still');
  const s = await read();
  expect(s.mode).toBe('lod');
  expect(s.chainTriangles).toHaveLength(4);
  for (let i = 1; i < 4; i++) expect(s.chainTriangles[i]!).toBeLessThan(s.chainTriangles[i - 1]!);
  expect(s.levels).toEqual([0, 1, 2, 3]);
  expect(s.levels).toHaveLength(LOD_DISTANCES.length);
  expect(s.triangles).toBeLessThan(2 * s.chainTriangles[0]!);
  expect(s.stats.instances + s.stats.culled).toBe(4);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('hull: the torus beside its convex hull', async ({ page, wrapper }) => {
  await open(page, wrapper, 'hull');
  const s = await read();
  expect(s.hullTriangles).toBeGreaterThan(20);
  expect(s.hullTriangles).toBeLessThan(s.sourceTriangles);
  expect(s.stats.instances + s.stats.culled).toBe(2);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('slice: the sweeping cut caps both halves closed', async ({ page, wrapper }) => {
  await open(page, wrapper, 'slice');
  const first = (await read()).sliceD;
  const seen = new Set<number>();
  await expect
    .poll(async () => {
      const s = await read();
      expect(s.capTriangles).toBeGreaterThanOrEqual(4);
      expect(s.closed).toBe(true);
      seen.add(s.sliceD);
      return seen.size;
    })
    .toBeGreaterThanOrEqual(2);
  expect([...seen].some((d) => d !== first)).toBe(true);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('tiles: the box lands on the moving platform and rides it', async ({ page, wrapper }) => {
  await open(page, wrapper, 'tiles');
  await expect
    .poll(async () => {
      const s = await read();
      return s.onGround && s.riding ? s.carried : 0;
    })
    .toBeGreaterThan(0.5);
  const s = await read();
  expect(s.onGround).toBe(true);
  // Standing on the platform's top (y 5, box 0.8 tall).
  expect(s.boxY).toBeCloseTo(5 - 0.8, 6);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
