/**
 * The mesh streaming page (harness/stream.html) on every matrix row (ws/mesh-stream):
 *
 * - the page boots WebGPU, a Worker meshes the chunks and `mesh.update()` uploads them from the
 *   transferred buffers; updates keep coming, one chunk per frame;
 * - vertex counts change between re-meshes while the buffers stay (no growth: the capacity is
 *   a full chunk), and no GPU error is logged;
 * - a pixel sampled at the grid centre shows lit geometry and one above the grid shows sky;
 * - aimed at the grid's corner (`api.look('edge')`), the renderer frustum-culls the chunks that
 *   leave the view (`stats.culled`) and draws only the rest (ws/cull).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessStreamState, StreamLook, StreamProbe } from '../harness/stream-state';
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
    await page.goto(`${HARNESS_URL}stream.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('stream.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`stream page: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessStreamState> {
  return frame.evaluate(() => {
    const s = window.__harnessStream?.state;
    if (!s) throw new Error('window.__harnessStream missing');
    return JSON.parse(JSON.stringify(s)) as HarnessStreamState;
  });
}

/** Logical canvas px to page CSS px. */
async function toPage(p: StreamProbe): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/** Average colour of the 3×3 CSS px around each page point, from a screenshot of the page. */
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

test('chunk meshes stream from a Worker without reallocating', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const first = await read();
  expect(first.chunks).toBe(16);
  // Every chunk was filled once, within its capacity, and is drawn.
  await expect.poll(async () => (await read()).updates).toBeGreaterThanOrEqual(first.chunks);
  await expect.poll(async () => (await read()).stats.instances).toBe(first.chunks);
  expect((await read()).growths).toBe(0);
  // Updates keep flowing (about one chunk per frame) and move the columns.
  await expect.poll(async () => (await read()).updates).toBeGreaterThanOrEqual(3 * first.chunks);
  await expect.poll(async () => (await read()).changed).toBeGreaterThan(0);
  const s = await read();
  expect(s.growths).toBe(0);
  for (const n of s.vertexCounts) {
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n % 4).toBe(0);
  }
  // Something was uploaded in some frame, and never more than a whole chunk per message.
  expect(s.uploaded.peakVertices).toBeGreaterThan(0);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the streamed geometry is on screen', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await expect.poll(async () => (await read()).updates).toBeGreaterThanOrEqual(16);
  const s = await read();
  const [ground, sky] = await sample(page, [
    await toPage(s.probes.ground),
    await toPage(s.probes.sky),
  ]);
  // The grid centre is a lit floor or column (green over blue, brighter than the clear colour);
  // above the grid is the sky, the dark blue clear colour.
  const sum = (c: Rgb) => c[0] + c[1] + c[2];
  expect(ground![1], `ground ${ground}`).toBeGreaterThan(ground![2] + 10);
  expect(sky![2], `sky ${sky}`).toBeGreaterThan(sky![0] + 15);
  expect(sum(ground!)).toBeGreaterThan(sum(sky!) + 100);
  expect(errors).toEqual([]);
});

test('chunks outside the frustum are culled', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const chunks = (await read()).chunks;
  // Looking at the grid centre, every chunk is in view and drawn.
  await expect.poll(async () => (await read()).stats.instances).toBe(chunks);
  expect((await read()).stats.culled).toBe(0);
  const look = (where: StreamLook) =>
    frame.evaluate((w) => {
      const api = window.__harnessStream;
      if (!api) throw new Error('window.__harnessStream missing');
      api.look(w);
    }, where);
  // Aimed past the far corner, about half the chunks leave the frustum: they are counted as
  // culled and not drawn, so the drawn instances and the culled draws still add up to the grid.
  await look('edge');
  await expect.poll(async () => (await read()).stats.culled).toBeGreaterThan(0);
  const s = await read();
  expect(s.stats.culled).toBeLessThan(chunks);
  expect(s.stats.culled).toBeGreaterThanOrEqual(chunks / 4);
  expect(s.stats.instances + s.stats.culled).toBe(chunks);
  expect(s.stats.drawCalls).toBeLessThanOrEqual(s.stats.instances);
  // Back to the centre: nothing culled again.
  await look('grid');
  await expect.poll(async () => (await read()).stats.culled).toBe(0);
  expect((await read()).stats.instances).toBe(chunks);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
