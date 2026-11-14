/**
 * The stereo page (harness/stereo.html, ws/xr-merge) on every matrix row: a game in an emulated
 * headset (`emulateXr` from `./testing`, the fake WebXR stack on the real GPU), its eyes drawn by
 * the render core.
 *
 * - the session runs: frames go by in XR and nothing logs an error;
 * - each XR frame is one cull dispatch for both eyes (one `union` cull group of two views) and
 *   one core pass per eye;
 * - the eyes sit ipd apart at the head's height;
 * - the mirror shows each eye in its half: the red block straight ahead in both, the clear
 *   colour above the scene.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessStereoState } from '../harness/stereo-state';
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
    await page.goto(`${HARNESS_URL}stereo.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('stereo.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`stereo page: ${s.gpu}`);
      return s?.ready ? Math.min(s.frames, s.mirrored) : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessStereoState> {
  return frame.evaluate(() => {
    const s = window.__harnessStereo?.state;
    if (!s) throw new Error('window.__harnessStereo missing');
    return JSON.parse(JSON.stringify(s)) as HarnessStereoState;
  });
}

/** Average colour of 3×3 CSS px around each point given as fractions of the mirror canvas. */
async function sample(page: Page, points: [number, number][]): Promise<Rgb[]> {
  const box = await frame.locator('#mirror').boundingBox();
  if (!box) throw new Error('no mirror');
  const pts = points.map(([x, y]) => ({ x: box.x + x * box.width, y: box.y + y * box.height }));
  const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
  return page.evaluate(
    async ([b64, ps]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      return ps.map((p) => {
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
    [png.toString('base64'), pts] as const,
  );
}

const isRed = (c: Rgb) => c[0] > c[1] + 60 && c[0] > c[2] + 60;
const isClear = (c: Rgb) => c[0] < 40 && c[1] < 40 && c[2] < 50;

test('an emulated headset: one cull dispatch for both eyes, a core pass per eye', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.active).toBe(true);
  expect(s.gpuErrors).toBe(0);
  expect(s.views).toBe(2);
  expect(s.dispatches).toBe(1);
  expect(s.maxDispatches).toBe(1);
  expect(s.draws).toBe(2);
  const [l, r] = s.eyes as [[number, number, number], [number, number, number]];
  expect(r[0] - l[0]).toBeCloseTo(0.064, 4);
  expect(l[1]).toBeCloseTo(1.6, 4);
  expect(r[1]).toBeCloseTo(1.6, 4);
  expect(s.mirror).toEqual({ width: 640, height: 240 });
  expect(errors).toEqual([]);
});

test('the mirror shows each eye in its half', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const [lCentre, rCentre, lTop, rTop] = await sample(page, [
    [0.25, 0.5],
    [0.75, 0.5],
    [0.25, 0.04],
    [0.75, 0.04],
  ]);
  expect(isRed(lCentre!), `left centre ${lCentre}`).toBe(true);
  expect(isRed(rCentre!), `right centre ${rCentre}`).toBe(true);
  expect(isClear(lTop!), `left top ${lTop}`).toBe(true);
  expect(isClear(rTop!), `right top ${rTop}`).toBe(true);
  expect(errors).toEqual([]);
});
