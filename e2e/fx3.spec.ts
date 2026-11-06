/**
 * The fx-3 demo (harness/fx3.html) on every matrix row: the extended particle kernel in world
 * space. One page load per mode, each proving its feature through a number the page publishes
 * and, where the picture is the proof, a pixel sampled with the particles drawn and skipped
 * (no golden image).
 *
 * - `?sheet`: the sheet is sampled (the parked sprite's pixel differs from the sky) and the tile
 *   advances (the sampled colour changes while `tileSeen` walks 5..15);
 * - `?forces`: `meanRadius` (the CPU shadow of the same forces) shrinks, and the attractor's
 *   pixel fills in as the GPU particles arrive;
 * - `?collide`: rain over a slab stays on it (`belowSlab` stays near 0 while `alive` grows);
 * - `?sub`: particles are alive after every parent has died;
 * - `?effect`: the attached effect has one instance and live particles;
 * - every mode boots with no GPU error.
 */
import type { Frame, Page } from '@playwright/test';
import type { Fx3Mode, Fx3Probe, HarnessFx3State } from '../harness/fx3-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

type Rgb = [number, number, number];

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, mode: Fx3Mode, still = false): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const target = `fx3.html?${mode}${still ? '&still' : ''}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`fx-3 demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  expect((await read()).mode).toBe(mode);
}

function read(): Promise<HarnessFx3State> {
  return frame.evaluate(() => {
    const s = window.__harnessFx3?.state;
    if (!s) throw new Error('window.__harnessFx3 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessFx3State;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Logical canvas px to page CSS px. */
async function toPage(p: Fx3Probe): Promise<{ x: number; y: number }> {
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

function maxDelta(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((c, i) => Math.abs(c - b[i]!)));
}

function setParticles(visible: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessFx3?.setParticles(v), visible);
}

test('sheet: the sprite sheet is sampled and its tile advances', async ({ page, wrapper }) => {
  await open(page, wrapper, 'sheet', true);
  await expect.poll(async () => (await read()).alive).toBeGreaterThan(0);
  const at = await toPage((await read()).probe);
  await setParticles(false);
  await frames(3);
  const sky = await sample(page, at);
  await setParticles(true);
  await frames(3);
  let first: Rgb = sky;
  await expect
    .poll(
      async () => {
        first = await sample(page, at);
        return maxDelta(first, sky);
      },
      { message: 'parked sprite vs clear sky' },
    )
    .toBeGreaterThan(8);
  // Tiles 5..15 are distinct hues at 2 fps: the sampled colour moves on within a second or so.
  await expect
    .poll(async () => maxDelta(await sample(page, at), first), { message: 'tile advances' })
    .toBeGreaterThan(8);
  const s = await read();
  expect(s.tileSeen).toBeGreaterThanOrEqual(5);
  expect(s.tileSeen).toBeLessThanOrEqual(15);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('forces: the attractor pulls the shell in', async ({ page, wrapper }) => {
  await open(page, wrapper, 'forces', true);
  await expect.poll(async () => (await read()).alive).toBeGreaterThan(0);
  const start = (await read()).meanRadius;
  expect(start).toBeGreaterThan(2);
  await expect
    .poll(async () => (await read()).meanRadius, { message: 'mean radius shrinks' })
    .toBeLessThan(start * 0.7);
  // The GPU particles converge on the same point: its pixel fills in.
  const at = await toPage((await read()).probe);
  await setParticles(false);
  await frames(3);
  const sky = await sample(page, at);
  await setParticles(true);
  await expect
    .poll(async () => maxDelta(await sample(page, at), sky), { message: 'attractor vs sky' })
    .toBeGreaterThan(8);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('collide: rain over the slab stays on it', async ({ page, wrapper }) => {
  await open(page, wrapper, 'collide', true);
  await expect.poll(async () => (await read()).alive).toBeGreaterThan(400);
  // Free fall from 5 units up takes about a second; after that a leak would show.
  await expect.poll(async () => (await read()).time).toBeGreaterThan(2.5);
  const s = await read();
  expect(s.belowSlab).toBeGreaterThanOrEqual(0);
  expect(s.belowSlab).toBeLessThan(s.alive * 0.05);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('sub: children outlive their parents', async ({ page, wrapper }) => {
  await open(page, wrapper, 'sub', true);
  await expect
    .poll(async () => (await read()).aliveAfterParents, { message: 'alive after parents' })
    .toBeGreaterThan(0);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('effect: the attached aura plays with live particles', async ({ page, wrapper }) => {
  await open(page, wrapper, 'effect');
  await expect.poll(async () => (await read()).effectAlive).toBeGreaterThan(0);
  const s = await read();
  expect(s.effectInstances).toBe(1);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
