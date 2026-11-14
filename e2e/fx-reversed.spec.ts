/**
 * The reversed-Z effects page (harness/fx-reversed.html, ws/fx-fit B9) on every matrix row:
 * every core effect on a reversed-Z core, told nothing but by its pass.
 *
 * - the page boots WebGPU, the five drawables and the sky pass join the core, nothing logs an
 *   error and the sky draws;
 * - with everything paused, taking each effect off (water, the particle fountain, lit-box
 *   debris, rain with splashes, a lightning bolt) changes pixels: none is depth-tested away by
 *   a standard compare against the reversed depth buffer; put back, the picture returns;
 * - the sky's game shade hook runs: its tint parameter changes the sky and nothing else;
 * - `?standard` draws the same scene on a standard core, also without an error.
 */
import type { Frame, Page } from '@playwright/test';
import type {
  FxReversedEffect,
  FxReversedSet,
  HarnessFxReversedState,
} from '../harness/fx-reversed-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = ''): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `fx-reversed.html${query}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`reversed-Z effects demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessFxReversedState> {
  return frame.evaluate(() => {
    const s = window.__harnessFxReversed?.state;
    if (!s) throw new Error('window.__harnessFxReversed missing');
    return JSON.parse(JSON.stringify(s)) as HarnessFxReversedState;
  });
}

async function set(o: FxReversedSet): Promise<void> {
  await frame.evaluate((o) => window.__harnessFxReversed!.set(o), o);
  await frames(4);
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

const shot = async (page: Page) =>
  (await page.screenshot({ scale: 'css', animations: 'disabled' })).toString('base64');

/** Fractions of the canvas whose pixels differ by more than 24 (any channel), top and bottom half. */
async function changed(page: Page, a: string, b: string): Promise<[number, number]> {
  const c = await canvasBox();
  return page.evaluate(
    async ([a, b, c]) => {
      const load = async (b64: string) => {
        const bmp = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${b64}`)).blob(),
        );
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const g = cv.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return g;
      };
      const ga = await load(a);
      const gb = await load(b);
      const x = Math.round(c.x);
      const y = Math.round(c.y);
      const w = Math.max(1, Math.round(c.width));
      const h = Math.max(2, Math.round(c.height));
      const half = (y0: number, hh: number) => {
        const da = ga.getImageData(x, y0, w, hh).data;
        const db = gb.getImageData(x, y0, w, hh).data;
        let n = 0;
        for (let i = 0; i < da.length; i += 4) {
          const d = Math.max(
            Math.abs(da[i]! - db[i]!),
            Math.abs(da[i + 1]! - db[i + 1]!),
            Math.abs(da[i + 2]! - db[i + 2]!),
          );
          if (d > 24) n++;
        }
        return n / (da.length / 4);
      };
      const top = Math.floor(h / 2);
      return [half(y, top), half(y + top, h - top)] as [number, number];
    },
    [a, b, c] as const,
  );
}

test('every effect and the sky join a reversed-Z core without an error', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await frames(10);
  const s = await read();
  expect(s.reversedZ).toBe(true);
  expect(s.gpuErrors).toBe(0);
  expect(s.drawables).toBe(5);
  expect(s.skyDraws).toBeGreaterThan(0);
  expect(s.weatherInstances).toBeGreaterThan(0);
  expect(s.horizon.every((v) => v > 0)).toBe(true);
  expect(errors).toEqual([]);
});

test('each effect draws under reversed-Z: taking it off changes the picture', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await frames(60);
  await set({ paused: true });
  const all = await shot(page);
  const effects: FxReversedEffect[] = ['water', 'particles', 'boxes', 'weather', 'lightning'];
  for (const k of effects) {
    await set({ show: { [k]: false } });
    const off = await shot(page);
    const [top, bottom] = await changed(page, all, off);
    expect(top + bottom, `${k} off`).toBeGreaterThan(0.0004);
    await set({ show: { [k]: true } });
  }
  // Back on and still: the same picture.
  const again = await shot(page);
  const [top, bottom] = await changed(page, all, again);
  expect(top + bottom).toBeLessThan(0.0004);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test("the sky's game shade hook tints the sky (top half), not the ground", async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await set({ paused: true, show: { weather: false, particles: false, lightning: false } });
  const plain = await shot(page);
  await set({ skyTint: [4, 0, 0] });
  const tinted = await shot(page);
  const [top, bottom] = await changed(page, plain, tinted);
  expect(top).toBeGreaterThan(0.1);
  expect(bottom).toBeLessThan(top);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?standard: the same scene on a standard core', async ({ page, wrapper }) => {
  await open(page, wrapper, '?standard');
  await frames(10);
  const s = await read();
  expect(s.reversedZ).toBe(false);
  expect(s.gpuErrors).toBe(0);
  expect(s.drawables).toBe(5);
  expect(s.skyDraws).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

// ws/fx-fit: the same scene as a game fitting its renderer builds it.
test('?fit: the sky in the opaque pass with no SkyLook; particles in a game pass', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  await frames(10);
  const own = (await read()).passes;
  await open(page, wrapper, '?fit');
  await frames(10);
  await expect.poll(async () => (await read()).skyDraws).toBeGreaterThan(5);
  const s = await read();
  expect(s.fit).toBe(true);
  // No sky pass; one for the game's `late` (the fountain's): as many render passes as before.
  expect(s.passOrder).not.toContain('sky');
  expect(s.passOrder).toContain('late');
  expect(s.passes).toBe(own);
  expect(s.weatherLayers).toBe(8);
  expect(s.weatherInstances).toBeGreaterThan(0);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('?fit: each effect draws; the hook tints the sky; dead particles draw nothing', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper, '?fit');
  await frames(60);
  await set({ paused: true });
  const all = await shot(page);
  for (const k of ['particles', 'boxes', 'weather'] as FxReversedEffect[]) {
    await set({ show: { [k]: false } });
    const [top, bottom] = await changed(page, all, await shot(page));
    expect(top + bottom, `${k} off`).toBeGreaterThan(0.0004);
    await set({ show: { [k]: true } });
  }
  await set({ show: { weather: false, particles: false, lightning: false } });
  const plain = await shot(page);
  await set({ skyTint: [4, 0, 0] });
  const [top, bottom] = await changed(page, plain, await shot(page));
  expect(top).toBeGreaterThan(0.1);
  expect(bottom).toBeLessThan(top);
  // Cleared and paused: nothing alive, nothing drawn; resumed, they draw again.
  await set({ clear: true, show: { particles: true } });
  await expect.poll(async () => (await read()).particleDraws).toBe(0);
  expect((await read()).boxDraws).toBe(0);
  await set({ paused: false });
  await expect.poll(async () => (await read()).particleDraws).toBeGreaterThan(0);
  expect((await read()).gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
