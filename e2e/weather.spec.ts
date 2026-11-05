/**
 * The weather demo (harness/weather.html) on every matrix row: world-space particles over a
 * perspective scene with depth.
 *
 * - the page boots WebGPU and logs no error (WGSL compiles, no validation errors);
 * - both particle systems report live particles (`ParticleSystem.alive`, counted on the GPU);
 * - a pixel in the dense rain column differs from the clear sky behind it (sampled from a
 *   screenshot with the particles drawn, then skipped; no golden image).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessWeatherState, WeatherProbe } from '../harness/weather-state';
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
    await page.goto(`${HARNESS_URL}weather.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('weather.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`weather demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessWeatherState> {
  return frame.evaluate(() => {
    const s = window.__harnessWeather?.state;
    if (!s) throw new Error('window.__harnessWeather missing');
    return JSON.parse(JSON.stringify(s)) as HarnessWeatherState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** Logical canvas px to page CSS px. */
async function toPage(p: WeatherProbe): Promise<{ x: number; y: number }> {
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

function setParticles(visible: boolean): Promise<void> {
  return frame.evaluate((v) => window.__harnessWeather?.setParticles(v), visible);
}

test('boots world-space particles with no GPU error, and both systems are alive', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await expect
    .poll(async () => {
      const { alive } = await read();
      return Math.min(alive.rain, alive.motes);
    })
    .toBeGreaterThan(0);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('a pixel in the rain column differs from the clear sky', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const at = await toPage((await read()).probes.rain);
  // The sky alone first, then the rain: the column refills from its emitter down past the
  // probe within a fraction of a second of being drawn again.
  await setParticles(false);
  await frames(3);
  const sky = await sample(page, at);
  await setParticles(true);
  await expect
    .poll(
      async () => {
        const rain = await sample(page, at);
        return Math.max(...rain.map((c, i) => Math.abs(c - sky[i]!)));
      },
      { message: 'rain column vs clear sky' },
    )
    .toBeGreaterThan(8);
  // Behind the probe is the blue clear sky, not geometry.
  expect(sky[2]).toBeGreaterThan(sky[0] + 10);
  expect(errors).toEqual([]);
});
