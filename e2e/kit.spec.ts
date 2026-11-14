/**
 * The kit page (harness/kit.html) on every matrix row: `composeGame` with no services boots the
 * core alone and draws through the built-in present; `?client` runs the loop on the page's own
 * frames (`loop.frames: 'external'`, `ctx.frame(now)`).
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessKitState } from '../harness/kit-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `kit.html${query}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${url}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(url)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`kit demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(3);
}

function read(): Promise<HarnessKitState> {
  return frame.evaluate(() => {
    const s = window.__harnessKit?.state;
    if (!s) throw new Error('window.__harnessKit missing');
    return JSON.parse(JSON.stringify(s)) as HarnessKitState;
  });
}

/** The ctx a kit with no services has: the core, nothing else. */
const CORE_FIELDS = [
  'camera',
  'clock',
  'design',
  'gpu',
  'hooks',
  'host',
  'loop',
  'onDeviceLost',
  'renderer',
  'save',
  'setCamera',
  'stack',
  'surface',
];

test('lean kit: the core alone boots, steps and draws through the built-in present', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '');
  const s = await read();
  expect(s.mode).toBe('host');
  expect(s.fields).toEqual(CORE_FIELDS);
  expect(s.postNull).toBe(true);
  await expect.poll(async () => (await read()).updates).toBeGreaterThan(10);
  expect((await read()).clockMs).toBeGreaterThan(0);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('client mode: the page drives every frame with ctx.frame(now)', async ({ page, wrapper }) => {
  await open(page, wrapper, '?client');
  const s = await read();
  expect(s.mode).toBe('client');
  expect(s.fields).toEqual([...CORE_FIELDS, 'frame'].sort());
  await expect.poll(async () => (await read()).updates).toBeGreaterThan(10);
  const t = await read();
  // One render per page frame, never more (the engine schedules no frames of its own).
  expect(t.frames).toBeLessThanOrEqual(t.driven);
  expect(t.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

/** The canvas: its CSS box against the window, its drawing buffer, the page's DPR. */
function canvasBox() {
  return frame.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#root canvas');
    if (!c) throw new Error('no canvas');
    const r = c.getBoundingClientRect();
    return {
      css: [r.left, r.top, r.width, r.height],
      win: [window.innerWidth, window.innerHeight],
      buffer: [c.width, c.height],
      dpr: window.devicePixelRatio,
    };
  });
}

/** RGB at fractions of the canvas (its own screenshot, CSS px), each a 3×3 average. */
async function sampleCanvas(page: Page, points: [number, number][]): Promise<number[][]> {
  const png = await frame.locator('#root canvas').screenshot({ scale: 'css' });
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      return pts.map(([fx, fy]) => {
        const x = Math.min(bmp.width - 2, Math.max(1, Math.round(fx * bmp.width)));
        const y = Math.min(bmp.height - 2, Math.max(1, Math.round(fy * bmp.height)));
        const d = g.getImageData(x - 1, y - 1, 3, 3).data;
        const out = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          out[0]! += d[i]! / 9;
          out[1]! += d[i + 1]! / 9;
          out[2]! += d[i + 2]! / 9;
        }
        return out.map(Math.round);
      });
    },
    [png.toString('base64'), points] as const,
  );
}

function near(got: number[], want: number[]): boolean {
  return got.every((v, i) => Math.abs(v - want[i]!) <= 6);
}

const CORNERS: [number, number][] = [
  [0.01, 0.01],
  [0.99, 0.01],
  [0.5, 0.5],
  [0.01, 0.99],
  [0.99, 0.99],
];

test("own renderer on a fill surface: the kit's loop drives the game's renderer over the whole window", async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?own&fill');
  const s = await read();
  expect(s.renderer).toBe('own');
  expect(s.fields).toEqual(CORE_FIELDS);
  await expect.poll(async () => (await read()).ownFrames).toBeGreaterThan(5);
  await expect.poll(async () => (await read()).updates).toBeGreaterThan(10);
  const box = await canvasBox();
  // Fill: the canvas is the window (no letterbox), its buffer the CSS size at the DPR cap of 2.
  expect(box.css).toEqual([0, 0, box.win[0], box.win[1]]);
  const ratio = Math.min(box.dpr, 2);
  expect(box.buffer).toEqual([Math.round(box.win[0]! * ratio), Math.round(box.win[1]! * ratio)]);
  // The kit handed the game's renderer the buffer size.
  expect((await read()).resized).toEqual(box.buffer);
  // ctx.design follows the fill surface (CSS px).
  expect((await read()).design).toEqual(box.win);
  // Every corner is the game's clear colour: no bars.
  for (const px of await sampleCanvas(page, CORNERS)) expect(near(px, s.clear), `${px}`).toBe(true);
  expect(errors).toEqual([]);
});

test('renderer: null: the page draws in hooks.render on the letterboxed surface', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?none');
  const s = await read();
  expect(s.renderer).toBe('none');
  expect(s.rendererNull).toBe(true);
  await expect.poll(async () => (await read()).ownFrames).toBeGreaterThan(5);
  // Letterboxed to the 16:9 design (the window is rarely exactly 16:9; the box is).
  const box = await canvasBox();
  expect(Math.abs(box.css[2]! / box.css[3]! - 16 / 9)).toBeLessThan(0.01);
  const [center] = await sampleCanvas(page, [[0.5, 0.5]]);
  expect(near(center!, s.clear), `${center}`).toBe(true);
  expect(errors).toEqual([]);
});

test("fill with the engine's renderer: ctx.design and the renderer's 2D frame follow the window", async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?fill');
  await expect.poll(async () => (await read()).frames).toBeGreaterThan(5);
  const box = await canvasBox();
  expect(box.css).toEqual([0, 0, box.win[0], box.win[1]]);
  const s = await read();
  expect(s.design).toEqual(box.win);
  expect(s.logical).toEqual(box.win);
  // The hub is drawn at the middle of the logical frame, so the window's middle.
  const [center] = await sampleCanvas(page, [[0.5, 0.5]]);
  // The hub tint (0.95, 0.9, 0.8) after the tonemap.
  expect(near(center!, [184, 182, 176]), `${center}`).toBe(true);
  expect(errors).toEqual([]);
});
