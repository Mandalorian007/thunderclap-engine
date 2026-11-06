/**
 * The render 4 page (harness/render4.html, ws/render-4) on every matrix row, one mode per
 * flag. Every number is read from the page's published state and polled (E-017):
 *
 * - jitter: with a post processor that wants it, the two-sample sequence moves the quad's
 *   projected centre √0.5 target px between frames and `PostInputs.view.jitter` carries it;
 * - aux: the rough-metal attachment reads the gradient's roughness at the probe, and the
 *   moving cube writes a non-zero velocity, both through the page's debug blit;
 * - ranges: three index ranges of one mesh are three draw calls;
 * - depth-test-off: the panel inside the cube shows through it.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessRender4State } from '../harness/render4-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, flag: string): Promise<HarnessRender4State> {
  errors.length = 0;
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const file = `render4.html?${flag}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`render4: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return read();
}

function read(): Promise<HarnessRender4State> {
  return frame.evaluate(() => {
    const s = window.__harnessRender4?.state;
    if (!s) throw new Error('window.__harnessRender4 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessRender4State;
  });
}

test('jitter: the sequence shifts the projected quad by the pixel amount each frame', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'jitter');
  expect(s0.mode).toBe('jitter');
  // ±0.25 px on both axes, alternating: √(0.5² + 0.5²) between consecutive frames.
  await expect.poll(async () => (await read()).shiftPx).toBeGreaterThan(0.6);
  const s = await read();
  expect(s.shiftPx).toBeLessThan(0.8);
  expect(Math.abs(s.jitter[0])).toBeCloseTo(0.25, 5);
  expect(Math.abs(s.jitter[1])).toBeCloseTo(0.25, 5);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('aux: the rough-metal target holds the gradient and the moving cube writes velocity', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'aux');
  expect(s0.mode).toBe('aux');
  await expect.poll(async () => (await read()).readbacks).toBeGreaterThanOrEqual(2);
  // The gradient quad: roughness 0.75 at the probe, metalness 0 (rg8unorm, ±1/255 and the
  // texel the probe lands on).
  await expect.poll(async () => (await read()).roughSample?.[0] ?? -1).toBeGreaterThan(0.65);
  const s = await read();
  expect(s.roughSample![0]).toBeLessThan(0.85);
  expect(s.roughSample![1]).toBeLessThan(0.05);
  // The cube slides 1.6 units either way: its centre moves on screen every frame but the
  // turning ones, so the peak |velocity| (uv per frame) is well above zero.
  await expect.poll(async () => (await read()).velocityPeak).toBeGreaterThan(1e-3);
  expect(s.instances).toBe(2);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('ranges: three index ranges of one mesh are three draw calls', async ({ page, wrapper }) => {
  const s = await open(page, wrapper, 'ranges');
  expect(s.mode).toBe('ranges');
  expect(s.drawCalls).toBe(3);
  expect(s.instances).toBe(3);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('depth-test-off: a panel with depthTest false shows through the cube around it', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'depth-test-off');
  expect(s0.mode).toBe('depth-test-off');
  await expect.poll(async () => (await read()).panelVisible).toBe(true);
  const s = await read();
  expect(s.instances).toBe(2);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
