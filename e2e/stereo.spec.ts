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
 *   colour above the scene;
 * - with `?passes=1` (ws/core-passes): the sun's shadow is one core shadow pass a frame for both
 *   eyes and post resolves each eye on its own, the red block still red in both halves;
 * - with `?passes=1&targets=1` (ws/core-targets): the core's extra targets per eye, the red
 *   block's emissive glowing through each eye's bloom.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessStereoState } from '../harness/stereo-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

type Rgb = [number, number, number];
let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = ''): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}stereo.html${query}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(`stereo.html${query}`)}`);
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

test('the core passes per eye: one sun shadow for both eyes, post per eye', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?passes=1');
  const s = await read();
  expect(s.passes).toBe(true);
  expect(s.gpuErrors).toBe(0);
  expect(s.views).toBe(2);
  expect(s.draws).toBe(2);
  expect(s.shadowPasses).toBe(1);
  expect(s.resolves).toBe(2);
  // The eyes' group and the sun's: one cull dispatch, or one per group.
  expect(s.dispatches).toBeLessThanOrEqual(2);
  const [lCentre, rCentre] = await sample(page, [
    [0.25, 0.5],
    [0.75, 0.5],
  ]);
  expect(isRed(lCentre!), `left centre ${lCentre}`).toBe(true);
  expect(isRed(rCentre!), `right centre ${rCentre}`).toBe(true);
  expect(errors).toEqual([]);
});

test('the core targets per eye: the red block’s emissive blooms in both eyes', async ({
  page,
  wrapper,
}) => {
  // Points from the block's centre up into the clear colour above it, in each eye.
  const ys = [0.5, 0.42, 0.36, 0.3, 0.24, 0.18, 0.12];
  const points: [number, number][] = [
    ...ys.map((y): [number, number] => [0.25, y]),
    ...ys.map((y): [number, number] => [0.75, y]),
  ];
  // Red over green above the block (not its centre, which burns white), summed per eye.
  const redness = (cs: Rgb[]) =>
    [0, 1].map((e) =>
      cs.slice(e * ys.length + 1, (e + 1) * ys.length).reduce((a, c) => a + c[0] - c[1], 0),
    );
  await open(page, wrapper, '?passes=1');
  const plain = redness(await sample(page, points));
  await open(page, wrapper, '?passes=1&targets=1');
  const s = await read();
  expect(s.targets).toBe(7);
  expect(s.gpuErrors).toBe(0);
  expect(s.draws).toBe(2);
  expect(s.resolves).toBe(2);
  const lit = await sample(page, points);
  // The glowing block burns bright, warm towards white.
  for (const c of [lit[0]!, lit[ys.length]!]) {
    expect(c[0] > 200 && c[0] >= c[1] && c[1] >= c[2], `centre ${c}`).toBe(true);
  }
  const glow = redness(lit);
  expect(glow[0]!, `left ${glow[0]} vs ${plain[0]}`).toBeGreaterThan(plain[0]! + 40);
  expect(glow[1]!, `right ${glow[1]} vs ${plain[1]}`).toBeGreaterThan(plain[1]! + 40);
  expect(errors).toEqual([]);
});
