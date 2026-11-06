/**
 * The PBR demo (harness/pbr.html) on every matrix row: the standard material (E-015, ws/pbr).
 *
 * - the page boots WebGPU, draws the sphere grid, the tile and the ground through three
 *   standard materials under the sun, a point light, shadows and fog, and logs no error;
 * - GGX: the sun's highlight on a metal sphere is brighter than the centre of the rough
 *   dielectric sphere (pixels sampled from a screenshot, no golden image);
 * - normal mapping: two points on the flat tile, equal in everything but the bump's slope under
 *   them, differ in luminance.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessPbrState, PbrProbe } from '../harness/pbr-state';
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
    await page.goto(`${HARNESS_URL}pbr.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('pbr.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`pbr demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessPbrState> {
  return frame.evaluate(() => {
    const s = window.__harnessPbr?.state;
    if (!s) throw new Error('window.__harnessPbr missing');
    return JSON.parse(JSON.stringify(s)) as HarnessPbrState;
  });
}

/** The canvas box in page CSS px. */
async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** Logical canvas px to page CSS px. */
async function toPage(p: PbrProbe): Promise<Pt> {
  const box = await canvasBox();
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

test('boots the sphere grid under the lights, and a metal highlight beats a rough centre', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.grid).toEqual({ cols: 5, rows: 5 });
  expect(s.materials).toBe(3);
  // 25 spheres, the tile and the ground.
  expect(s.stats.instances).toBe(27);
  // The spheres share one material and one mesh: the grid is a few instanced draws at most.
  expect(s.stats.drawCalls).toBeLessThanOrEqual(12);
  expect(s.gpuErrors).toBe(0);
  expect(s.lights).toEqual({ sun: true, points: 1, shadow: true, fog: true });

  const [rough, highlight] = await sample(page, [
    await toPage(s.probes.rough),
    await toPage(s.probes.highlight),
  ]);
  // The rough dielectric shows its tint: red, not the sky.
  expect(rough![0], `rough ${rough}`).toBeGreaterThan(rough![2] + 20);
  // The specular lobe on the metal sphere is far brighter than the diffuse centre.
  expect(sum(highlight!), `highlight ${highlight} rough ${rough}`).toBeGreaterThan(
    sum(rough!) + 60,
  );
  expect(errors).toEqual([]);
});

test('the normal map lights the two slopes of a bump differently on a flat tile', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  const [lit, dark] = await sample(page, [
    await toPage(s.probes.tileLit),
    await toPage(s.probes.tileDark),
  ]);
  // Same quad, same normal, same tint, a hand's width apart: only the normal map differs.
  expect(sum(lit!), `lit ${lit} dark ${dark}`).toBeGreaterThan(sum(dark!) + 30);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
