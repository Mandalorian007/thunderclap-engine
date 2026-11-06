/**
 * The perf overlay (ws/perf-overlay) on the mesh demo with `?perf`: the DOM readout is visible,
 * the monitor's numbers come from the renderer (`counts.draws` is `renderer.stats.drawCalls`)
 * and its frame-time ring fills. Without `?perf` the pages draw no overlay (the goldens hold).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessMeshState } from '../harness/mesh-state';
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
  const target = `mesh.html${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${target}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(target)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`mesh demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessMeshState> {
  return frame.evaluate(() => {
    const s = window.__harnessMesh?.state;
    if (!s) throw new Error('window.__harnessMesh missing');
    return JSON.parse(JSON.stringify(s)) as HarnessMeshState;
  });
}

test('?perf shows the overlay and exposes the renderer numbers; the ring fills', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?perf');
  const overlay = frame.locator('.tc-perf');
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute('aria-hidden', 'true');
  expect(await overlay.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  await expect(overlay.locator('canvas.tc-perf-graph')).toHaveCount(1);

  const s = await read();
  const perf = s.perf;
  expect(perf).not.toBeNull();
  expect(perf!.frame.avg).toBeGreaterThan(0);
  expect(perf!.frame.last).toBeGreaterThanOrEqual(0);
  expect(perf!.frame.fps).toBeGreaterThan(0);
  expect(perf!.frame.p95).toBeGreaterThanOrEqual(perf!.frame.avg * 0.5);
  expect(perf!.frame.max).toBeGreaterThanOrEqual(perf!.frame.p95);
  expect(perf!.counts.draws).toBe(s.stats.drawCalls);
  expect(perf!.counts.drawCalls).toBe(s.stats.drawCalls);
  expect(perf!.counts.instances).toBe(s.stats.instances);
  expect(typeof perf!.counts.culled).toBe('number');
  expect(perf!.resolutionScale).toBeCloseTo(1, 5);
  expect(perf!.window).toBe(120);

  // The overlay prints the counters it read.
  await expect(overlay).toContainText('fps');
  await expect(overlay).toContainText(`instances ${s.stats.instances}`);

  // After 130 frames the 120-slot history is full.
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(130);
  const later = await read();
  expect(later.perf!.samples).toBeGreaterThanOrEqual(130);
  expect(later.perf!.filled).toBe(120);
  // GPU time arrives once the renderer resolves a sample: the monitor switched `timingEvery` on,
  // so by now the queue (or timestamp) timing has landed.
  expect(later.perf!.gpu).not.toBeNull();
  expect(later.perf!.gpu!.total).toBeGreaterThan(0);
  expect(later.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('without ?perf the page samples but draws no overlay', async ({ page, wrapper }) => {
  await open(page, wrapper, '');
  await expect(frame.locator('.tc-perf')).toHaveCount(0);
  const s = await read();
  expect(s.perf).not.toBeNull();
  expect(s.perf!.counts.draws).toBe(s.stats.drawCalls);
  expect(errors).toEqual([]);
});
