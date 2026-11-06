/**
 * The glTF demo (harness/gltf.html) on every matrix row: a GLB built in the page is parsed and
 * loaded through `@thunderclap/engine/assets`, the counts match the file (two draws, two meshes,
 * one texture, two materials), the textured cube renders at its probe (not the clear colour,
 * and the checker's warm tones show), and the plane renders mossy green.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessGltfState } from '../harness/gltf-state';
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
    await page.goto(`${HARNESS_URL}gltf.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('gltf.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`gltf demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessGltfState> {
  return frame.evaluate(() => {
    const s = window.__harnessGltf?.state;
    if (!s) throw new Error('window.__harnessGltf missing');
    return JSON.parse(JSON.stringify(s)) as HarnessGltfState;
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

/** Average colour of the 3×3 CSS px around each page point, from a screenshot. */
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

test('loads a generated GLB: counts match and the textured cube renders', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.counts).toEqual({ nodes: 2, meshes: 2, textures: 1, materials: 2, transforms: 2 });
  expect(s.warnings).toEqual([]);
  expect(s.externalUris).toEqual([]);
  expect(s.stats.instances).toBe(2);
  expect(s.gpuErrors).toBe(0);
  // The plane is 8 wide and the cube 1.5 tall at y 0.75: bounds reach x ±4, y 0..1.5.
  expect(s.bounds.radius).toBeGreaterThan(5);
  expect(s.bounds.radius).toBeLessThan(6);
  expect(s.bounds.center[1]).toBeCloseTo(0.75, 3);

  for (const p of [s.probes.cube, s.probes.ground]) {
    expect(p.x).toBeGreaterThan(2);
    expect(p.x).toBeLessThan(s.logical.width - 2);
    expect(p.y).toBeGreaterThan(2);
    expect(p.y).toBeLessThan(s.logical.height - 2);
  }
  const [cube, ground] = await sample(page, [
    await toPage(s.probes.cube),
    await toPage(s.probes.ground),
  ]);
  // The clear is a dark blue; the checkered cube (orange and cream) is bright and warm.
  const clearSum = s.clear.reduce((a, b) => a + b, 0) * 255;
  expect(cube![0] + cube![1] + cube![2], `cube ${cube}`).toBeGreaterThan(clearSum + 150);
  expect(cube![0], `cube ${cube}`).toBeGreaterThan(cube![2] + 30);
  // The plane is lit mossy green: green leads, and it is not the sky.
  expect(ground![1], `ground ${ground}`).toBeGreaterThan(ground![0]);
  expect(ground![1], `ground ${ground}`).toBeGreaterThan(ground![2]);
  expect(ground![0] + ground![1] + ground![2]).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});
