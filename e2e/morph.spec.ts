/**
 * The morph targets demo (harness/morph.html) on every matrix row: a generated `.gltf` sphere
 * with two targets plays its `weights` clip; the weights move over time, `apply()` keeps
 * uploading, the mesh bounds follow the bulge, and a pixel just above the resting silhouette is
 * background in the squash phase and lit sphere in the bulge phase.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessMorphState } from '../harness/morph-state';
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
    await page.goto(`${HARNESS_URL}morph.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('morph.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`morph demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessMorphState> {
  return frame.evaluate(() => {
    const s = window.__harnessMorph?.state;
    if (!s) throw new Error('window.__harnessMorph missing');
    return JSON.parse(JSON.stringify(s)) as HarnessMorphState;
  });
}

/** Logical canvas px to page CSS px. */
async function toPage(p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/** Average colour of the 3×3 CSS px around each page point, from one screenshot. */
async function sample(page: Page, points: { x: number; y: number }[]): Promise<Rgb[]> {
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

const sum = (c: Rgb): number => c[0] + c[1] + c[2];

const inPhase = (s: HarnessMorphState, target: number): boolean =>
  s.weights[target]! > 0.75 && s.weights[1 - target]! < 0.1;

/**
 * Wait for the clip to hold `target` (weight above 0.75, the other below 0.1), sample the probe
 * and confirm the phase still held afterwards; retry when the phase slipped during the capture.
 */
async function sampleInPhase(
  page: Page,
  target: number,
): Promise<{ rgb: Rgb; background: Rgb; state: HarnessMorphState }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await expect.poll(async () => inPhase(await read(), target), { timeout: 15_000 }).toBe(true);
    const before = await read();
    const [rgb, background] = await sample(page, [
      await toPage(before.probe),
      await toPage({ x: 6, y: 6 }),
    ]);
    const after = await read();
    if (inPhase(after, target)) return { rgb: rgb!, background: background!, state: after };
  }
  throw new Error(`morph demo never held target ${target} through a capture`);
}

test.slow();

test('plays the weights clip: weights move, uploads grow, the silhouette follows', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s0 = await read();
  expect(s0.targetCount).toBe(2);
  expect(s0.weights).toHaveLength(2);
  expect(s0.duration).toBeCloseTo(9, 3);
  expect(s0.gpuErrors).toBe(0);
  expect(s0.probe.x).toBeGreaterThan(2);
  expect(s0.probe.x).toBeLessThan(s0.logical.width - 2);
  expect(s0.probe.y).toBeGreaterThan(2);
  expect(s0.probe.y).toBeLessThan(s0.logical.height - 2);

  // The weights change over time (E-017: poll a moving value), and every change uploads.
  await expect
    .poll(async () => {
      const s = await read();
      return Math.abs(s.weights[0]! - s0.weights[0]!) + Math.abs(s.weights[1]! - s0.weights[1]!);
    })
    .toBeGreaterThan(0.05);
  const applied0 = (await read()).applied;
  await expect.poll(async () => (await read()).applied).toBeGreaterThan(applied0);

  // Squash: the sphere is 0.4 tall at the probe's column, the probe sees the background (the
  // clear colour, sampled from a corner of the same screenshot since the swap chain encodes it)
  // and the bounds radius stays at the sphere's.
  const squash = await sampleInPhase(page, 0);
  expect(Math.abs(sum(squash.rgb) - sum(squash.background)), `squash ${squash.rgb}`).toBeLessThan(
    24,
  );
  expect(squash.state.bounds.radius).toBeLessThan(1.1);
  // Bulge: the sphere grows to 1.5, covers the probe (lit, warm) and the bounds grow with it.
  const bulge = await sampleInPhase(page, 1);
  expect(sum(bulge.rgb), `bulge ${bulge.rgb}`).toBeGreaterThan(sum(bulge.background) + 100);
  expect(bulge.rgb[0], `bulge ${bulge.rgb}`).toBeGreaterThan(bulge.rgb[2] + 30);
  expect(sum(bulge.rgb) - sum(squash.rgb)).toBeGreaterThan(100);
  expect(bulge.state.bounds.radius).toBeGreaterThan(1.3);
  expect(bulge.state.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
