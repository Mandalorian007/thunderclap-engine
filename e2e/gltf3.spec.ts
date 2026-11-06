/**
 * The glTF extensions page (harness/gltf3.html, ws/assets-3) on every matrix row: a quantized
 * cube matches its float twin, a meshopt rock decodes to its uncompressed twin, a scene lit by
 * its own punctual lights shows them on the ground, a figure cycles its material variants (and
 * `?still` holds one), and ten assets through a small asset-cache budget leave four resident.
 * Moving values poll (E-017).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessGltf3State } from '../harness/gltf3-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

type Rgb = [number, number, number];

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<HarnessGltf3State> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}gltf3.html${query}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(`gltf3.html${query}`)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`gltf3 demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return read();
}

function read(): Promise<HarnessGltf3State> {
  return frame.evaluate(() => {
    const s = window.__harnessGltf3?.state;
    if (!s) throw new Error('window.__harnessGltf3 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessGltf3State;
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

/** Average colour of the 3×3 CSS px around each named probe, from one screenshot. */
async function sample(page: Page, s: HarnessGltf3State, names: string[]): Promise<Rgb[]> {
  for (const n of names) {
    const p = s.probes[n];
    expect(p, `probe ${n}`).toBeDefined();
    expect(p!.x).toBeGreaterThan(2);
    expect(p!.x).toBeLessThan(s.logical.width - 2);
    expect(p!.y).toBeGreaterThan(2);
    expect(p!.y).toBeLessThan(s.logical.height - 2);
  }
  const points = await Promise.all(names.map((n) => toPage(s.probes[n]!)));
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
const dist = (a: Rgb, b: Rgb) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

test('?quant: a quantized cube matches its float twin', async ({ page, wrapper }) => {
  const s = await open(page, wrapper, '?quant');
  expect(s.warnings).toEqual([]);
  expect(s.maxError).toBeGreaterThanOrEqual(0);
  expect(s.maxError).toBeLessThan(1e-4);
  const [q, f] = await sample(page, s, ['quantized', 'float']);
  // Both cubes render (orange clay, not the dark clear) and shade alike.
  expect(q![0], `quantized ${q}`).toBeGreaterThan(q![2] + 40);
  expect(dist(q!, f!), `quantized ${q} float ${f}`).toBeLessThan(24);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?meshopt: the compressed rock decodes to its twin and renders', async ({ page, wrapper }) => {
  const s = await open(page, wrapper, '?meshopt');
  expect(s.warnings).toEqual([]);
  expect(s.match).toBe(true);
  expect(s.triangles).toBe(1280);
  expect(s.bytes.packed).toBeLessThan(s.bytes.plain);
  const [rock, beside] = await sample(page, s, ['rock', 'beside']);
  expect(dist(rock!, beside!), `rock ${rock} beside ${beside}`).toBeGreaterThan(60);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?lights: the file lights its own scene through its own camera', async ({ page, wrapper }) => {
  const s = await open(page, wrapper, '?lights');
  expect(s.warnings).toEqual([]);
  expect(s.lights).toEqual({ directional: 1, points: 1, spots: 1, camera: true });
  const [point, spot, far] = await sample(page, s, ['underPoint', 'underSpot', 'far']);
  // Red pools under the point light, blue under the spot; the rest has only the dim sky.
  expect(point![0], `point ${point}`).toBeGreaterThan(point![2] + 30);
  expect(spot![2], `spot ${spot}`).toBeGreaterThan(spot![0] + 30);
  expect(sum(point!), `point ${point} far ${far}`).toBeGreaterThan(sum(far!) + 30);
  expect(sum(spot!), `spot ${spot} far ${far}`).toBeGreaterThan(sum(far!) + 30);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?variants: the figure cycles its three variants', async ({ page, wrapper }) => {
  const s = await open(page, wrapper, '?variants');
  expect(s.variants).toEqual(['ember', 'moss', 'tide']);
  await expect.poll(async () => (await read()).seen.length, { timeout: 15_000 }).toBe(3);
  const now = await read();
  expect(now.variant).not.toBeNull();
  expect(now.materialId).toBe(now.variants.indexOf(now.variant!) + 1);
  expect(now.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?variants&still: a parked variant draws its material', async ({ page, wrapper }) => {
  const s = await open(page, wrapper, '?variants&still');
  expect(s.still).toBe(true);
  expect(s.variant).toBe('moss');
  expect(s.materialId).toBe(2);
  expect(s.seen).toEqual(['moss']);
  const [torso] = await sample(page, s, ['torso']);
  expect(torso![1], `torso ${torso}`).toBeGreaterThan(torso![0] + 30);
  expect(torso![1], `torso ${torso}`).toBeGreaterThan(torso![2] + 20);
  expect(errors).toEqual([]);
});

test('?cache: ten assets into a budget of four leave the pinned and held ones', async ({
  page,
  wrapper,
}) => {
  const s = await open(page, wrapper, '?cache');
  expect(s.warnings).toEqual([]);
  expect(s.reads).toBe(10);
  expect(s.stats).toMatchObject({ entries: 4, hits: 1, misses: 10, evictions: 6 });
  expect(s.stats.bytes).toBeLessThanOrEqual(s.budget);
  expect(s.resident).toEqual(['asset-0', 'asset-7', 'asset-8', 'asset-9']);
  expect(s.evicted).toEqual(['asset-1', 'asset-2', 'asset-3', 'asset-4', 'asset-5', 'asset-6']);
  const [kept, pinned, gone, bg] = await sample(page, s, [
    'asset-8',
    'asset-0',
    'asset-4',
    'background',
  ]);
  expect(dist(kept!, bg!), `kept ${kept} bg ${bg}`).toBeGreaterThan(60);
  expect(dist(pinned!, bg!), `pinned ${pinned} bg ${bg}`).toBeGreaterThan(60);
  expect(dist(gone!, bg!), `evicted ${gone} bg ${bg}`).toBeLessThan(20);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
