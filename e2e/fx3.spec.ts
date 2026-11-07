/**
 * The fx-3 demo (harness/fx3.html) on every matrix row: the extended particle kernel in world
 * space. One page load per mode, each proving its feature through a number the page publishes
 * and, where the picture is the proof, a pixel sampled with the particles drawn and skipped
 * (no golden image).
 *
 * - `?sheet`: the sheet is sampled (the parked sprite's pixel differs from the sky) and the tile
 *   advances (the sampled colour changes while `tileSeen` walks 5..15);
 * - `?forces`: the GPU particles, read back every 500 ms (`debugReadback`), gather within 0.3
 *   of the attractor within 3 s (`radiusSettledAt`); `shadowRadius` (the CPU shadow of the same
 *   forces) shrinks, and the attractor's pixel lights (sampled every 50 ms);
 * - `?collide`: rain over a slab stays on it (`belowSlab` stays under 0.5% of `alive`), and the
 *   drops resting on it do not creep (`meanDriftPerSec`, from the readbacks, under 0.05);
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

/**
 * Average colour of the 5×5 CSS px around a page point. The screenshot is clipped to that
 * window, so one sample costs tens of ms rather than a full-page capture (common.md: clip to
 * the probe window).
 */
async function sample(page: Page, p: { x: number; y: number }): Promise<Rgb> {
  const clip = { x: Math.round(p.x) - 2, y: Math.round(p.y) - 2, width: 5, height: 5 };
  const png = await page.screenshot({ scale: 'css', animations: 'disabled', clip });
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const n = d.length / 4;
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      out[0] += d[i]! / n;
      out[1] += d[i + 1]! / n;
      out[2] += d[i + 2]! / n;
    }
    return out;
  }, png.toString('base64'));
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
  // The shadow is born on the shell at radius 3 (and reset there each burst): half that proves
  // the pull. `meanRadius` moves every frame, so it is only ever polled.
  await expect
    .poll(async () => (await read()).shadowRadius, { message: 'shadow radius shrinks' })
    .toBeLessThan(1.5);
  // Measured on the GPU (ws/fx-6): the page reads the particles back every 500 ms and records
  // the first shell's age at the first readback with a mean radius under 0.3 (page state, so a
  // slow poll cannot miss it). Measured: settled at 1.57 s (0.19), then 0.06..0.11 to 6 s; the
  // CPU shadow predicts 0.92 at 1 s and 0.08 at 2 s.
  await expect
    .poll(async () => (await read()).radiusSettledAt, { message: 'shell settles' })
    .toBeGreaterThan(0);
  const settled = await read();
  expect(settled.radiusSettledAt).toBeLessThanOrEqual(3);
  // The GPU particles gather into a blob on the same point (a linear pull under drag 3, ws/fx-5):
  // after the first second the 5×5 centre was lit in every 50 ms sample over 6 s on all eight
  // rows (1423 of 1423, meanRadius 0.07..0.15). Before, a constant pull swung them through it
  // (lit about 0.3 s of each ~1.8 s pass, ws/e2e-harden-2), which is why the poll samples every
  // 50 ms; that cadence stays, so the poll still lands in a lit stretch if the blob ever swings.
  const at = await toPage((await read()).probe);
  await setParticles(false);
  await frames(3);
  const sky = await sample(page, at);
  await setParticles(true);
  await expect
    .poll(async () => maxDelta(await sample(page, at), sky), {
      message: 'attractor vs sky',
      intervals: [50],
    })
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
  // The rain is born over the slab's middle half, so no drop misses it. The 2.4..6.2% that
  // e2e-harden-2 measured was resting drops creeping off the front edge: the collide pushed them
  // back along the view ray, toward the camera, every frame (drops born 3 units from the edge got
  // off in about 1.8 s). With the push along the surface normal (ws/fx-5) the leak measured 0 in
  // 40 runs (every matrix row × 4 at load ~23, and 4 rows × 2 under 20× CPU throttling), with
  // 3750..4141 alive. 0.5% (about 20 drops) leaves room for a stray at a silhouette edge and
  // still fails the old creep, let alone a broken collide (near 75%).
  expect(s.belowSlab).toBeLessThan(s.alive * 0.005);
  // Measured on the GPU (ws/fx-6): drops within 0.1 of the slab top in two readbacks 500 ms
  // apart, matched slot by slot, moved hypot(dx, dz) over the simulated time between. Measured
  // 0.13 units/s (+x 0.075) before the collide normal came from pixel centres, 0.0008..0.0009
  // after, over about 2000 resting drops per sample.
  await expect
    .poll(async () => (await read()).restingDrops, { message: 'resting drops measured' })
    .toBeGreaterThan(100);
  const rest = await read();
  expect(rest.meanDriftPerSec).toBeGreaterThanOrEqual(0);
  expect(rest.meanDriftPerSec).toBeLessThan(0.05);
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
