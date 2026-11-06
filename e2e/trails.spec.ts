/**
 * The trails demo (harness/trails.html) on every matrix row: two ribbon trails under a
 * perspective camera over the clear colour.
 *
 * - the page boots WebGPU and logs no error (WGSL compiles, no validation errors), and both
 *   trails hold points;
 * - a pixel at the arm trail's middle differs from the clear colour behind it (sampled from a
 *   screenshot with the trails skipped, then drawn; no golden image);
 * - stopping the swing and calling `clear()` empties both trails and the pixel returns to the
 *   clear colour.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessTrailsState, TrailProbe } from '../harness/trails-state';
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
    await page.goto(`${HARNESS_URL}trails.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('trails.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`trails demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessTrailsState> {
  return frame.evaluate(() => {
    const s = window.__harnessTrails?.state;
    if (!s) throw new Error('window.__harnessTrails missing');
    return JSON.parse(JSON.stringify(s)) as HarnessTrailsState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Logical canvas px to page CSS px. */
async function toPage(p: TrailProbe): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/** Average colour of the 5×5 CSS px around a page point, from a screenshot of the page. */
async function sample(page: Page, p: { x: number; y: number }): Promise<Rgb> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, pt]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(Math.round(pt.x) - 2, Math.round(pt.y) - 2, 5, 5).data;
      const out: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        out[0] += d[i]! / 25;
        out[1] += d[i + 1]! / 25;
        out[2] += d[i + 2]! / 25;
      }
      return out;
    },
    [png.toString('base64'), p] as const,
  );
}

function diff(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((c, i) => Math.abs(c - b[i]!)));
}

function setTrails(visible: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessTrails?.setTrails(v), visible);
}

function setSwinging(on: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessTrails?.setSwinging(v), on);
}

function clear(): Promise<void> {
  return frame.evaluate(() => window.__harnessTrails?.clear());
}

test('boots two ribbon trails with no GPU error, both holding points', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await expect
    .poll(async () => {
      const { counts } = await read();
      return Math.min(counts.arm, counts.orbit);
    })
    .toBeGreaterThan(1);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('a pixel at the arm trail’s middle differs from the clear colour', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  // Nothing but the trails is drawn, so the clear colour is the same everywhere.
  await setTrails(false);
  await frames(3);
  const bg = await sample(page, await toPage((await read()).probes.arm));
  await setTrails(true);
  await expect
    .poll(
      async () => {
        const at = await toPage((await read()).probes.arm);
        return diff(await sample(page, at), bg);
      },
      { message: 'trail middle vs clear colour' },
    )
    .toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test('clear() empties both trails and the pixel returns to the clear colour', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await setTrails(false);
  await frames(3);
  const bg = await sample(page, await toPage((await read()).probes.arm));
  await setTrails(true);
  await frames(3);
  await setSwinging(false);
  await clear();
  await expect
    .poll(async () => {
      const { counts } = await read();
      return counts.arm + counts.orbit;
    })
    .toBe(0);
  await frames(2);
  const after = await sample(page, await toPage((await read()).probes.arm));
  expect(diff(after, bg)).toBeLessThanOrEqual(4);
  expect(errors).toEqual([]);
});
