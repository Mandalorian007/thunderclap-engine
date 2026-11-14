/**
 * The render-core page (harness/core.html, ws/core-retained): a block of boxes in one static,
 * GPU-culled draw set of the retained core. A held frame costs the same GPU calls at 1,500 and at
 * 6,000 meshes (one view write, one cull dispatch, one `executeBundles`), the bundle is recorded
 * once, and the device reports no error.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessCoreState } from '../harness/core-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query: string): Promise<HarnessCoreState> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const url = `core.html?${query}`;
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
      if (s?.ready && s.gpu !== 'ok') throw new Error(`core page: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(10);
  return read();
}

function read(): Promise<HarnessCoreState> {
  return frame.evaluate(() => {
    const s = window.__harnessCore?.state;
    if (!s) throw new Error('window.__harnessCore missing');
    return JSON.parse(JSON.stringify(s)) as HarnessCoreState;
  });
}

test('a held scene costs the same GPU calls at 1,500 and 6,000 meshes', async ({
  page,
  wrapper,
}) => {
  const small = await open(page, wrapper, 'sets=1500');
  const large = await open(page, wrapper, 'sets=6000');
  for (const s of [small, large]) {
    expect(s.gpuErrors).toBe(0);
    // `boot` does not ask for multi-draw, so the set draws as one bundle.
    expect(s.bundles).toBe(1);
    expect(s.dispatches).toBe(1);
    expect(s.visible).toBeGreaterThan(0);
    expect(s.visible).toBeLessThanOrEqual(s.sets);
  }
  expect(small.sets).toBe(1500);
  expect(large.sets).toBe(6000);
  expect(large.calls).toBe(small.calls);
  expect(large.maxCalls).toBe(small.maxCalls);
  // The camera circles, but the bundle is recorded once for the one target.
  expect(large.bundleBuilds).toBe(1);
  expect(errors).toEqual([]);
});

/** A PNG screenshot of the canvas. */
async function shot(): Promise<Buffer> {
  return frame.locator('canvas').first().screenshot({ animations: 'disabled' });
}

/**
 * The share of pixels whose largest channel difference exceeds `tol`, between two same-size
 * PNGs, decoded by the browser itself.
 */
function offShare(page: Page, a: Buffer, b: Buffer, tol: number): Promise<number> {
  return page.evaluate(
    async ([pa, pb, t]) => {
      const decode = async (b64: string) => {
        const bmp = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${b64}`)).blob(),
        );
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, bmp.width, bmp.height);
      };
      const x = await decode(pa);
      const y = await decode(pb);
      if (x.width !== y.width || x.height !== y.height) return 1;
      let off = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        const d = Math.max(
          Math.abs(x.data[i]! - y.data[i]!),
          Math.abs(x.data[i + 1]! - y.data[i + 1]!),
          Math.abs(x.data[i + 2]! - y.data[i + 2]!),
        );
        if (d > t) off++;
      }
      return off / (x.data.length / 4);
    },
    [a.toString('base64'), b.toString('base64'), tol] as const,
  );
}

test('10,000 km from the origin, the camera-relative core draws the same picture', async ({
  page,
  wrapper,
}) => {
  // At 1e7 m a float32 world position steps by a metre; the core's frame origin (D1 §3.8)
  // keeps every vertex and the view relative to the eye, so the far page matches the near one.
  const near = await open(page, wrapper, 'sets=400&still');
  const nearShot = await shot();
  const far = await open(page, wrapper, 'sets=400&still&far=10000000');
  const farShot = await shot();
  expect(near.gpuErrors + far.gpuErrors).toBe(0);
  expect(far.far).toBe(10000000);
  // The frame origin is the eye snapped to the 1024 m grid, within a cell of the scene.
  expect(Math.abs(far.origin[0] - 10000000)).toBeLessThan(2048);
  expect(Math.abs(far.origin[2] - 10000000)).toBeLessThan(2048);
  expect(far.visible).toBe(near.visible);
  // Edges may move by a rounding step; the scene must not shake apart.
  expect(await offShare(page, nearShot, farShot, 24)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('after device.destroy() the core is restored on a new device and draws the same picture', async ({
  page,
  wrapper,
}) => {
  // ws/core-passes: the core's rebuild list (arenas, sets, bundles, the cull) on a new device,
  // and one `onDeviceRestored` event, in which the page writes its boxes' bytes again.
  const before = await open(page, wrapper, 'sets=400&still');
  const beforeShot = await shot();
  await frame.evaluate(() => window.__harnessCore!.lose());
  await expect
    .poll(async () => (await read()).frames, { timeout: 15_000 })
    .toBeGreaterThan(before.frames + 10);
  const after = await read();
  expect(after.restores).toBe(1);
  expect(after.restoredEvents).toBe(1);
  expect(after.gpuErrors).toBe(0);
  expect(after.bundles).toBe(1);
  expect(await offShare(page, beforeShot, await shot(), 24)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
