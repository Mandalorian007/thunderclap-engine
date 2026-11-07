/**
 * The geometry page (harness/geom.html) on every matrix row (ws/geom):
 *
 * - the page boots WebGPU, draws every builder of `@thunderclap-engine/engine/geom` (primitives in
 *   front, the sweep kit behind: ws/geom-2) over a heightfield ground and logs no error;
 * - a probe pixel on each shape is lit: it differs from the clear colour behind the ground;
 * - `computeTangents` over the extruded star is right-handed on every vertex (the handedness
 *   signs sum to the vertex count);
 * - the height the page reads under the camera with `heightAt` is the bump map the ground was
 *   built from, at the point the page sampled (a grid node, so bilinear equals the sample).
 */
import type { Frame, Page } from '@playwright/test';
import {
  ALL_SHAPE_NAMES,
  bumpHeight,
  type GeomProbe,
  type HarnessGeomState,
} from '../harness/geom-state';
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
    await page.goto(`${HARNESS_URL}geom.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('geom.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`geom demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessGeomState> {
  return frame.evaluate(() => {
    const s = window.__harnessGeom?.state;
    if (!s) throw new Error('window.__harnessGeom missing');
    return JSON.parse(JSON.stringify(s)) as HarnessGeomState;
  });
}

/** Logical canvas px to page CSS px. */
async function toPage(p: GeomProbe): Promise<Pt> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/** Average colour of the 3×3 CSS px around each page point, from a screenshot of the page. */
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

test('every builder draws lit over the heightfield ground', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.gpuErrors).toBe(0);
  expect(s.shapes).toBe(ALL_SHAPE_NAMES.length);
  // Twelve shapes and the ground; a perspective camera culls (E-014), so count both sides.
  expect(s.stats.instances + s.stats.culled).toBe(ALL_SHAPE_NAMES.length + 1);
  expect(s.stats.instances).toBeGreaterThanOrEqual(1);
  // The tangent-space probe is computed once at start-up: no polling needed.
  expect(s.tangentVertices).toBeGreaterThan(0);
  expect(s.tangentW).toBe(s.tangentVertices);

  const points = await Promise.all([
    toPage(s.probes.sky),
    ...ALL_SHAPE_NAMES.map((n) => toPage(s.probes[n])),
  ]);
  const [sky, ...shapes] = await sample(page, points);
  const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // The sky probe is the clear colour after the tonemap: dim and blue-leaning.
  expect(sky![0] + sky![1] + sky![2], `sky ${sky}`).toBeLessThan(300);
  expect(sky![2], `sky ${sky}`).toBeGreaterThan(sky![0]);
  for (let i = 0; i < ALL_SHAPE_NAMES.length; i++) {
    const c = shapes[i]!;
    expect(dist(c, sky!), `${ALL_SHAPE_NAMES[i]} ${c} vs sky ${sky}`).toBeGreaterThan(40);
  }
  expect(errors).toEqual([]);
});

test('the height under the camera is the bump map at the sampled point', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  const [x, z] = s.sample;
  const fromPage = await frame.evaluate(([px, pz]) => window.__harnessGeom!.heightAt(px, pz), [
    x,
    z,
  ] as const);
  expect(s.heightUnderCamera).toBe(fromPage);
  // The page stored the map in a Float32Array, so compare to float precision.
  expect(s.heightUnderCamera).toBeCloseTo(bumpHeight(x, z), 5);
  // Off the grid nodes the bilinear value lies between the surrounding samples.
  const mid = await frame.evaluate(
    ([px, pz]) => window.__harnessGeom!.heightAt(px + 0.25, pz + 0.25),
    [x, z] as const,
  );
  const corners = [
    bumpHeight(x, z),
    bumpHeight(x + 0.5, z),
    bumpHeight(x, z + 0.5),
    bumpHeight(x + 0.5, z + 0.5),
  ];
  expect(mid).toBeGreaterThanOrEqual(Math.min(...corners) - 1e-5);
  expect(mid).toBeLessThanOrEqual(Math.max(...corners) + 1e-5);
  expect(errors).toEqual([]);
});
