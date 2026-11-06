/**
 * The lights demo (harness/lights.html) on every matrix row (ws/spot-lights):
 *
 * - the page boots WebGPU, draws three lit instances and logs no error; the spot's aim point
 *   moves between frames while it sweeps;
 * - the spot cone: ground under the spot's aim is brighter than ground outside the cone;
 * - layer masks: the cube on the point light's layer is brighter than the identical cube on
 *   another layer, which the light's mask excludes.
 * Pixels are sampled from a screenshot (no golden image) with the sweep paused.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessLightsState, LightsProbe } from '../harness/lights-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}
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
    await page.goto(`${HARNESS_URL}lights.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('lights.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`lights demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessLightsState> {
  return frame.evaluate(() => {
    const s = window.__harnessLights?.state;
    if (!s) throw new Error('window.__harnessLights missing');
    return JSON.parse(JSON.stringify(s)) as HarnessLightsState;
  });
}

function setSweep(on: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessLights?.setSweep(v), on);
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Logical canvas px to page CSS px. */
async function toPage(p: LightsProbe): Promise<Pt> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/**
 * Average colour of the 3×3 CSS px around each page point, from a screenshot of the page (so
 * what the swapchain presented, after the engine's tonemap), decoded by the browser itself.
 */
async function sample(page: Page, points: Pt[]): Promise<Rgb[]> {
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      return pts.map((p) => {
        const d = g.getImageData(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3).data;
        const out: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          out[0] += d[i]! / 9;
          out[1] += d[i + 1]! / 9;
          out[2] += d[i + 2]! / 9;
        }
        return out;
      });
    },
    [png.toString('base64'), points] as const,
  );
}

const sum = (c: Rgb) => c[0] + c[1] + c[2];

test('boots with a sweeping spot and a masked point light, and the spot moves', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.stats.instances).toBe(3);
  expect(s.gpuErrors).toBe(0);
  expect(s.lights).toEqual({ points: 1, spots: 1, lampLayers: 1, cubeLayers: [1, 2] });
  expect(s.sweeping).toBe(true);
  await frames(3);
  const later = await read();
  expect(later.spotAim).not.toEqual(s.spotAim);
  expect(errors).toEqual([]);
});

test('ground under the spot is brighter than ground outside its cone', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await setSweep(false);
  await frames(2);
  const s = await read();
  expect(s.sweeping).toBe(false);
  const [inside, outside] = await sample(page, [
    await toPage(s.probes.spotIn),
    await toPage(s.probes.spotOut),
  ]);
  expect(sum(inside!), `in ${inside} out ${outside}`).toBeGreaterThan(sum(outside!) + 90);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('a point light masked to one layer lights that cube and skips the other', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await setSweep(false);
  await frames(2);
  const s = await read();
  const [lit, masked] = await sample(page, [
    await toPage(s.probes.litCube),
    await toPage(s.probes.maskedCube),
  ]);
  // Same mesh, same tint, same distance from the light: only the mask differs.
  expect(sum(lit!), `lit ${lit} masked ${masked}`).toBeGreaterThan(sum(masked!) + 90);
  // The masked cube still shows the ambient, not the clear colour.
  expect(sum(masked!)).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});
