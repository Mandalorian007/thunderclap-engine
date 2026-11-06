/**
 * The debug-draw demo (harness/debug.html) on every matrix row: every `DebugDraw` shape in one
 * line-list draw under a perspective camera over the clear colour.
 *
 * - the page boots WebGPU and logs no error (WGSL compiles, no validation errors), appends
 *   segments every frame and uploads once per frame;
 * - a pixel on the +x axis line is red against the clear colour (the brightest pixel of a small
 *   window around the projected point, since the line is 1 px wide and the page may be scaled);
 * - with the shapes skipped, `clear()` then `draw` puts nothing on screen: the window returns
 *   to the clear colour and `segments` reads 0.
 */
import type { Frame, Page } from '@playwright/test';
import type { DebugProbe, HarnessDebugState } from '../harness/debug-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

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
    await page.goto(`${HARNESS_URL}debug.html?still`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('debug.html?still')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`debug demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessDebugState> {
  return frame.evaluate(() => {
    const s = window.__harnessDebug?.state;
    if (!s) throw new Error('window.__harnessDebug missing');
    return JSON.parse(JSON.stringify(s)) as HarnessDebugState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Logical canvas px to page CSS px. */
async function toPage(p: DebugProbe): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/**
 * The 7×7 CSS px around a page point, from a screenshot: the average colour and the pixel
 * farthest from `ref` (the average when no `ref` is given).
 */
async function sample(
  page: Page,
  p: { x: number; y: number },
  ref?: Rgb,
): Promise<{ avg: Rgb; far: Rgb }> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, pt, r]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(Math.round(pt.x) - 3, Math.round(pt.y) - 3, 7, 7).data;
      const n = d.length / 4;
      const avg: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        avg[0] += d[i]! / n;
        avg[1] += d[i + 1]! / n;
        avg[2] += d[i + 2]! / n;
      }
      const base = r ?? avg;
      let far: [number, number, number] = [avg[0], avg[1], avg[2]];
      let best = -1;
      for (let i = 0; i < d.length; i += 4) {
        const dist = Math.max(
          Math.abs(d[i]! - base[0]),
          Math.abs(d[i + 1]! - base[1]),
          Math.abs(d[i + 2]! - base[2]),
        );
        if (dist > best) {
          best = dist;
          far = [d[i]!, d[i + 1]!, d[i + 2]!];
        }
      }
      return { avg, far };
    },
    [png.toString('base64'), p, ref] as const,
  );
}

function diff(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((c, i) => Math.abs(c - b[i]!)));
}

function setShapes(on: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessDebug?.setShapes(v), on);
}

function clear(): Promise<void> {
  return frame.evaluate(() => window.__harnessDebug?.clear());
}

test('boots, appends segments every frame and uploads once per frame with no GPU error', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const a = await read();
  expect(a.segments).toBeGreaterThan(100);
  expect(a.capacity).toBeGreaterThanOrEqual(a.segments);
  await frames(5);
  const b = await read();
  expect(b.segments).toBe(a.segments);
  // One writeBuffer per drawn frame: uploads track frames.
  expect(b.uploads - a.uploads).toBeGreaterThanOrEqual(b.frames - a.frames - 1);
  expect(b.uploads - a.uploads).toBeLessThanOrEqual(b.frames - a.frames + 1);
  expect(b.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('a pixel on the +x axis line is red against the clear colour', async ({ page, wrapper }) => {
  await open(page, wrapper);
  // Nothing but the lines is drawn, so the clear colour is the same everywhere.
  await setShapes(false);
  await frames(3);
  const at = await toPage((await read()).probes.axis);
  const bg = (await sample(page, at)).avg;
  await setShapes(true);
  await expect
    .poll(
      async () => {
        const { far } = await sample(page, at, bg);
        return diff(far, bg) > 24 && far[0] - Math.max(far[1], far[2]) > 16;
      },
      { message: 'a red pixel on the x axis' },
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test('clear() then draw with nothing appended leaves the clear colour', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await setShapes(false);
  await frames(3);
  const at = await toPage((await read()).probes.axis);
  const bg = (await sample(page, at)).avg;
  await setShapes(true);
  await frames(3);
  expect((await read()).segments).toBeGreaterThan(0);
  await setShapes(false);
  await clear();
  await expect.poll(async () => (await read()).segments).toBe(0);
  await frames(2);
  const { far } = await sample(page, at, bg);
  expect(diff(far, bg)).toBeLessThanOrEqual(4);
  expect(errors).toEqual([]);
});
