/**
 * The render 5 page (harness/render5.html, ws/render-5) on every matrix row, one mode per
 * flag. Every number is read from the page's published state and polled (E-017):
 *
 * - ktx2: the in-page BC1 file uploads with its seven mips when the device has BC, else the
 *   typed error names the format and the caps (the caps say which);
 * - lod: 200 instances of one `MeshLod` (the culled ones aside) spread over every level, one
 *   draw per non-empty level;
 * - dissolve: the amount set from the test is the amount drawn, with no GPU error (the
 *   material's shadow pipeline compiles and runs);
 * - still: the dissolve holds at 0.5.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessRender5State } from '../harness/render5-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string, flag: string): Promise<HarnessRender5State> {
  errors.length = 0;
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const file = `render5.html?${flag}`;
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`render5: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return read();
}

function read(): Promise<HarnessRender5State> {
  return frame.evaluate(() => {
    const s = window.__harnessRender5?.state;
    if (!s) throw new Error('window.__harnessRender5 missing');
    return JSON.parse(JSON.stringify(s)) as HarnessRender5State;
  });
}

test('ktx2: the BC1 file uploads with its mips, or the typed error names format and caps', async ({
  page,
  wrapper,
}) => {
  const s = await open(page, wrapper, 'ktx2');
  expect(s.mode).toBe('ktx2');
  if (s.caps.bc) {
    expect(s.uploaded).toBe(true);
    expect(s.format).toBe('bc1-rgba-unorm-srgb');
    expect(s.mipLevels).toBe(7);
    expect(s.error).toBeNull();
  } else {
    expect(s.uploaded).toBe(false);
    expect(s.format).toBe('bc1-rgba-unorm-srgb');
    expect(s.error).toContain('texture-compression-bc');
    expect(s.error).toContain('compressed caps:');
  }
  expect(s.drawCalls).toBe(1);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('lod: 200 instances of one MeshLod spread over the levels, one draw per level', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'lod');
  expect(s0.mode).toBe('lod');
  await expect.poll(async () => (await read()).lodCounts.length).toBe(3);
  const s = await read();
  // Frustum culling drops the few at the grid's near corners (more on a narrow screen): every
  // instance drawn is counted at exactly one level.
  expect(s.lodCounts.reduce((a, b) => a + b, 0)).toBe(s.instances);
  expect(s.instances).toBeGreaterThan(100);
  expect(s.instances).toBeLessThanOrEqual(200);
  for (const n of s.lodCounts) expect(n).toBeGreaterThan(0);
  expect(s.drawCalls).toBe(s.lodCounts.filter((n) => n > 0).length);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('dissolve: the amount set is the amount drawn, shadow and scene without GPU errors', async ({
  page,
  wrapper,
}) => {
  const s0 = await open(page, wrapper, 'dissolve');
  expect(s0.mode).toBe('dissolve');
  for (const amount of [0, 0.6, 1]) {
    const at = await frame.evaluate((a) => {
      window.__harnessRender5!.setAmount(a);
      return window.__harnessRender5!.state.frames;
    }, amount);
    await expect
      .poll(async () => {
        const s = await read();
        return s.frames > at + 1 ? s.amount : -1;
      })
      .toBeCloseTo(amount, 5);
  }
  const s = await read();
  // Ground and sphere, even fully dissolved (the discard is per pixel).
  expect(s.instances).toBe(2);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('still: the dissolve holds at half', async ({ page, wrapper }) => {
  const s0 = await open(page, wrapper, 'dissolve&still');
  expect(s0.still).toBe(true);
  const at = s0.frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThan(at + 3);
  const s = await read();
  expect(s.amount).toBe(0.5);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
