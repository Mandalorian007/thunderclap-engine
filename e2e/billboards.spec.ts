/**
 * The billboards demo (harness/billboards.html) on every matrix row: six lit capsules with name
 * plates, health bars and rising damage numbers from one `Billboards` batch.
 *
 * - the page boots WebGPU and logs no error (WGSL compiles, no validation errors), holds the
 *   plates and bars, and issues at most two draw calls for the whole batch;
 * - pixels at capsule 0's plate and bar differ from the scene behind them (sampled from a
 *   screenshot with the billboards skipped, then drawn; no golden image);
 * - with the page paused, a damage number's anchor rises between two `advance` calls and the
 *   number removes itself once its `life` has passed.
 */
import type { Frame, Page } from '@playwright/test';
import {
  type BillboardProbe,
  DAMAGE_LIFE,
  type HarnessBillboardsState,
} from '../harness/billboards-state';
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
    await page.goto(`${HARNESS_URL}billboards.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('billboards.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`billboards demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessBillboardsState> {
  return frame.evaluate(() => {
    const s = window.__harnessBillboards?.state;
    if (!s) throw new Error('window.__harnessBillboards missing');
    return JSON.parse(JSON.stringify(s)) as HarnessBillboardsState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Logical canvas px to page CSS px. */
async function toPage(p: BillboardProbe): Promise<{ x: number; y: number }> {
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

function setVisible(visible: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessBillboards?.setVisible(v), visible);
}

function setPaused(on: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessBillboards?.setPaused(v), on);
}

function advance(dt: number): Promise<void> {
  return frame.evaluate((d) => window.__harnessBillboards?.advance(d), dt);
}

function spawnDamage(): Promise<number> {
  return frame.evaluate(() => window.__harnessBillboards?.spawnDamage() ?? -1);
}

test('boots six plated capsules with no GPU error, drawn in at most two calls', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  // Six backings, six plates and six bars, plus whatever damage numbers are up.
  expect(s.count).toBeGreaterThanOrEqual(18);
  expect(s.atlasUsed).toBeGreaterThan(0);
  expect(s.draws).toBeGreaterThanOrEqual(1);
  expect(s.draws).toBeLessThanOrEqual(2);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('pixels at capsule 0’s plate and bar differ from the scene behind them', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  // Park the scene: nothing else moves, so the background sample stays valid.
  await setPaused(true);
  await setVisible(false);
  await frames(3);
  const { probes } = await read();
  const plateBg = await sample(page, await toPage(probes.plate));
  const barBg = await sample(page, await toPage(probes.bar));
  await setVisible(true);
  await expect
    .poll(
      async () => {
        const p = (await read()).probes;
        const plate = diff(await sample(page, await toPage(p.plate)), plateBg);
        const bar = diff(await sample(page, await toPage(p.bar)), barBg);
        return Math.min(plate, bar);
      },
      { message: 'plate and bar vs the scene behind them' },
    )
    .toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test('a damage number rises between two advance calls and removes itself after its life', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await setPaused(true);
  // Let the ones already up die off, then spawn one under our control.
  await advance(DAMAGE_LIFE + 0.1);
  await expect.poll(async () => (await read()).damageAlive).toBe(0);
  const before = await read();
  expect(await spawnDamage()).toBe(1);
  await advance(0.1);
  await expect.poll(async () => (await read()).damageAlive).toBe(1);
  await expect.poll(async () => (await read()).count).toBe(before.count + 1);
  await frames(1);
  const y0 = (await read()).probes.damage.y;
  await advance(0.3);
  await expect
    .poll(async () => (await read()).probes.damage.y, { message: 'damage number rises on screen' })
    .toBeLessThan(y0 - 2);
  await advance(DAMAGE_LIFE);
  await expect.poll(async () => (await read()).damageAlive).toBe(0);
  await expect.poll(async () => (await read()).count).toBe(before.count);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
