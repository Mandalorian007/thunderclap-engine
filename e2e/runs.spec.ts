/**
 * The merged-runs page (harness/runs.html, ws/core-immediate): distinct meshes drawn with
 * `frame.mesh` merge into runs on the renderer's mesh pool. The device reports no error at 1,500
 * and 6,000 meshes, the scene draws as merged runs, and the pixels match the per-mesh path
 * (`?split`, a material per mesh so nothing merges) exactly.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessRunsState } from '../harness/runs-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<HarnessRunsState> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `runs.html?${query}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`runs page: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(10);
  return read();
}

function read(): Promise<HarnessRunsState> {
  return frame.evaluate(() => {
    const s = window.__harnessRuns?.state;
    if (!s) throw new Error('window.__harnessRuns missing');
    return JSON.parse(JSON.stringify(s)) as HarnessRunsState;
  });
}

test('distinct meshes draw as merged runs without a device error', async ({ page, wrapper }) => {
  for (const n of [1500, 6000]) {
    const s = await open(page, wrapper, `n=${n}`);
    expect(s.meshes).toBe(n);
    expect(s.gpuErrors).toBe(0);
    expect(s.runs).toBeGreaterThanOrEqual(1);
    expect(s.drawCalls).toBeGreaterThan(0);
    expect(s.drawCalls + s.culled).toBe(n);
  }
  expect(errors).toEqual([]);
});

test('merged runs draw the same pixels as the per-mesh path', async ({ page, wrapper }, info) => {
  test.skip(wrapper !== 'top' || info.project.name !== 'desktop-1280', 'one project is enough');
  const merged = await open(page, wrapper, 'n=120&still');
  expect(merged.runs).toBeGreaterThanOrEqual(1);
  const a = await page.screenshot();
  const split = await open(page, wrapper, 'n=120&still&split');
  expect(split.runs).toBe(0);
  const b = await page.screenshot();
  expect(split.gpuErrors + merged.gpuErrors).toBe(0);
  expect(Buffer.compare(a, b)).toBe(0);
  expect(errors).toEqual([]);
});
