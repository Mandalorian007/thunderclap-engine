/**
 * The decals demo (harness/decals.html) on every matrix row, in both implementations
 * (`?mode=box`, the depth-projected box, and `?mode=quad`, the surface quad):
 *
 * - the page boots WebGPU and logs no error, and the mode asked for is the one drawn;
 * - `add` on the floor: the pixel at the decal's centre differs from a bare floor pixel lit the
 *   same way (sampled from a screenshot; no golden image), and `remove` restores it;
 * - a short-lifetime decal expires on its own and the floor comes back;
 * - adding past `capacity` wraps: the count stays at capacity and the oldest handle is gone.
 *
 * Every assertion on a moving value polls.
 */
import type { Frame, Page } from '@playwright/test';
import type { DecalProbe, HarnessDecalsState } from '../harness/decals-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

type Rgb = [number, number, number];
type Mode = 'box' | 'quad';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const path = `decals.html?${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${path}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(path)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`decals demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessDecalsState> {
  return frame.evaluate(() => {
    const s = window.__harnessDecals?.state;
    if (!s) throw new Error('window.__harnessDecals missing');
    return JSON.parse(JSON.stringify(s)) as HarnessDecalsState;
  });
}

/**
 * Average colour of the 3×3 CSS px around each page point, from one screenshot clipped to the
 * points (a full-page capture costs hundreds of ms on a loaded machine; the decal fades meanwhile).
 */
async function sample(page: Page, points: { x: number; y: number }[]): Promise<Rgb[]> {
  const xs = points.map((p) => Math.round(p.x));
  const ys = points.map((p) => Math.round(p.y));
  const clip = {
    x: Math.min(...xs) - 2,
    y: Math.min(...ys) - 2,
    width: Math.max(...xs) - Math.min(...xs) + 5,
    height: Math.max(...ys) - Math.min(...ys) + 5,
  };
  const png = await page.screenshot({ clip, scale: 'css', animations: 'disabled' });
  const local = points.map((_, i) => ({ x: xs[i]! - clip.x, y: ys[i]! - clip.y }));
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      return pts.map((p) => {
        const d = g.getImageData(p.x - 1, p.y - 1, 3, 3).data;
        const out: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          out[0] += d[i]! / 9;
          out[1] += d[i + 1]! / 9;
          out[2] += d[i + 2]! / 9;
        }
        return out;
      });
    },
    [png.toString('base64'), local] as const,
  );
}

function diff(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((c, i) => Math.abs(c - b[i]!)));
}

/** How far the decal probe is from the bare floor probe, in the same screenshot. */
async function contrast(page: Page): Promise<number> {
  const [s, box] = await Promise.all([read(), frame.locator('canvas').first().boundingBox()]);
  if (!box) throw new Error('no canvas');
  // Logical canvas px to page CSS px.
  const toPage = (p: DecalProbe) => ({
    x: box.x + (p.x / s.logical.width) * box.width,
    y: box.y + (p.y / s.logical.height) * box.height,
  });
  const [decal, floor] = await sample(page, [toPage(s.decalPixel), toPage(s.floorPixel)]);
  return diff(decal!, floor!);
}

/** The spec's floor decal: a solid red square tile at a bare floor spot. */
const SPOT = { x: 1.5, z: 3 };
const RED: [number, number, number, number] = [0.95, 0.1, 0.1, 1];

function add(x: number, z: number, lifetime?: number): Promise<number> {
  return frame.evaluate(
    ([x, z, red, life]) => window.__harnessDecals!.add(x, 0, z, 0, 1, 0, 2, 3, red, life),
    [x, z, RED, lifetime] as const,
  );
}

function remove(handle: number): Promise<boolean> {
  return frame.evaluate((h) => window.__harnessDecals!.remove(h), handle);
}

function has(handle: number): Promise<boolean> {
  return frame.evaluate((h) => window.__harnessDecals!.has(h), handle);
}

for (const mode of ['box', 'quad'] as Mode[]) {
  test(`${mode}: a floor decal shows at its centre and remove restores the floor`, async ({
    page,
    wrapper,
  }) => {
    await open(page, wrapper, `mode=${mode}`);
    await expect.poll(async () => (await read()).mode).toBe(mode);
    const handle = await add(SPOT.x, SPOT.z);
    await expect.poll(async () => (await read()).count).toBe(1);
    await expect.poll(() => contrast(page)).toBeGreaterThan(40);
    expect(await remove(handle)).toBe(true);
    await expect.poll(async () => (await read()).count).toBe(0);
    await expect.poll(() => contrast(page)).toBeLessThan(12);
    expect((await read()).gpuErrors).toBe(0);
    expect(errors).toEqual([]);
  });
}

test('a short-lived decal ages, expires and leaves the floor bare', async ({ page, wrapper }) => {
  // The 10 s life and its 14 s budget take 24 s of the default 30; probes cost 1.3 s at load 50.
  test.setTimeout(45_000);
  await open(page, wrapper, '');
  // Ten seconds, fading linearly: contrast stays above 40 for about 6 s. At load 50 a contrast
  // probe took 1.3 s (measured worst case) and a 4 s life read 26 on the first one.
  const handle = await add(SPOT.x, SPOT.z, 10);
  await expect.poll(() => contrast(page)).toBeGreaterThan(40);
  const age = (await read()).ages[0] ?? -1;
  expect(age).toBeGreaterThan(0);
  await expect.poll(async () => (await read()).ages[0] ?? -1).toBeGreaterThan(age);
  // What is left of the 10 s life, plus the 1.3 s probe and slow frames under load 50.
  await expect.poll(async () => (await read()).count, { timeout: 14_000 }).toBe(0);
  expect(await has(handle)).toBe(false);
  await expect.poll(() => contrast(page)).toBeLessThan(12);
  expect(errors).toEqual([]);
});

test('adding past capacity wraps onto the oldest decal', async ({ page, wrapper }) => {
  await open(page, wrapper, 'capacity=6');
  const { capacity } = await read();
  expect(capacity).toBe(6);
  const handles: number[] = [];
  for (let i = 0; i <= capacity; i++) handles.push(await add(-6 + i * 2, -4));
  await expect.poll(async () => (await read()).count).toBe(capacity);
  expect(await has(handles[0]!)).toBe(false);
  expect(await has(handles[1]!)).toBe(true);
  expect(await has(handles[capacity]!)).toBe(true);
  expect((await read()).ages).toHaveLength(capacity);
  expect(errors).toEqual([]);
});
