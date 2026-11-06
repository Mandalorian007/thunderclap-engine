/**
 * The bench page (harness/bench.html) on `desktop-1280` only (ws/bench): one tiny rung
 * (`?rung=tiny`: 100 instances, 30 frames) completes and reports numbers, with no GPU error.
 * The full ladder is `pnpm bench` (scripts/bench.mjs), not a spec, so the matrix stays fast.
 *
 * ws/batch-submit: the three submission paths (`frame.mesh`, `frame.meshes`, `frame.list`;
 * `?mode=`) draw the same instance count and the same pixels, sampled at the view's centre and
 * on a cube (`state.probe`) with `?still`.
 */
import type { Page } from '@playwright/test';
import type { BenchMode, HarnessBenchState } from '../harness/bench-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

type Pt = { x: number; y: number };
type Rgb = [number, number, number];

const errors: string[] = [];
let page: Page;

test.describe('bench', () => {
  test.beforeEach(({ page: p }) => {
    test.skip(test.info().project.name !== 'desktop-1280', 'desktop-1280 only');
    page = p;
    errors.length = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
  });

  test('the tiny rung completes and reports numbers', async () => {
    await page.goto(`${HARNESS_URL}bench.html?rung=tiny`);
    const s = await done();
    expect(s.results).toHaveLength(1);
    const r = s.results[0]!;
    expect(r.id).toBe('tiny');
    expect(r.mode).toBe('mesh');
    expect(r.frames).toBe(10);
    expect(r.instances).toBeGreaterThan(0);
    expect(r.instances + r.culled).toBe(100);
    expect(r.cpuMs).toBeGreaterThan(0);
    if (s.timestamps) {
      expect(r.gpuMs).not.toBeNull();
      expect(r.gpuMs ?? 0).toBeGreaterThan(0);
    } else {
      expect(r.gpuMs).toBeNull();
    }
    expect(r.shadowDraws).toBe(0);
    expect(s.userAgent).toContain('Chrome');
    expect(errors).toEqual([]);
  });

  test('mesh, batch and list draw the same instances and the same pixels', async () => {
    const seen: { mode: BenchMode; instances: number; drawCalls: number; rgb: Rgb[] }[] = [];
    for (const mode of ['mesh', 'batch', 'list'] as const) {
      await page.goto(`${HARNESS_URL}bench.html?rung=tiny&mode=${mode}&cull=0&still`);
      const s = await done();
      const r = s.results[0]!;
      expect(r.mode).toBe(mode);
      expect(r.culled).toBe(0);
      expect(s.probe).not.toBeNull();
      const box = await page.locator('canvas').first().boundingBox();
      if (!box) throw new Error('no canvas');
      const toPage = (p: Pt): Pt => ({
        x: box.x + (p.x / s.logical.width) * box.width,
        y: box.y + (p.y / s.logical.height) * box.height,
      });
      // A frame of the held scene has been presented since `done`.
      const frames = s.frames;
      await expect.poll(async () => (await read()).frames).toBeGreaterThan(frames + 1);
      const rgb = await sample(page, [
        toPage({ x: s.logical.width / 2, y: s.logical.height / 2 }),
        toPage(s.probe!),
      ]);
      seen.push({ mode, instances: r.instances, drawCalls: r.drawCalls, rgb });
    }
    const [mesh, batch, list] = seen as [(typeof seen)[0], (typeof seen)[0], (typeof seen)[0]];
    expect(mesh.instances).toBe(100);
    expect(batch.instances).toBe(100);
    expect(list.instances).toBe(100);
    // One mesh and one material: a single draw call in every mode.
    expect(batch.drawCalls).toBe(1);
    expect(list.drawCalls).toBe(1);
    // The cube is lit, so the probe is not the sky.
    expect(Math.max(...mesh.rgb[1]!)).toBeGreaterThan(Math.max(...mesh.rgb[0]!) + 20);
    for (const other of [batch, list]) {
      for (let p = 0; p < 2; p++) {
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(other.rgb[p]![c]! - mesh.rgb[p]![c]!)).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(errors).toEqual([]);
  });
});

function read(): Promise<HarnessBenchState> {
  return page.evaluate(() => {
    const s = window.__harnessBench?.state;
    if (!s) throw new Error('window.__harnessBench missing');
    return JSON.parse(JSON.stringify(s)) as HarnessBenchState;
  });
}

/** Wait for the page to finish its rungs; returns the final state after the usual checks. */
async function done(): Promise<HarnessBenchState> {
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`bench: ${s.gpu}`);
      return s?.done ?? false;
    })
    .toBe(true);
  const s = await read();
  expect(s.error).toBeNull();
  expect(s.gpuErrors).toBe(0);
  return s;
}

/**
 * Average colour of the 3×3 CSS px around each page point, from a screenshot of the page (what
 * the swapchain presented), decoded by the browser itself.
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
