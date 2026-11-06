/**
 * The bench page (harness/bench.html) on `desktop-1280` only (ws/bench): one tiny rung
 * (`?rung=tiny`: 100 instances, 30 frames) completes and reports numbers, with no GPU error.
 * The full ladder is `pnpm bench` (scripts/bench.mjs), not a spec, so the matrix stays fast.
 */
import type { HarnessBenchState } from '../harness/bench-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

test.describe('bench', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'desktop-1280', 'desktop-1280 only');
  });

  test('the tiny rung completes and reports numbers', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`${HARNESS_URL}bench.html?rung=tiny`);
    const read = (): Promise<HarnessBenchState> =>
      page.evaluate(() => {
        const s = window.__harnessBench?.state;
        if (!s) throw new Error('window.__harnessBench missing');
        return JSON.parse(JSON.stringify(s)) as HarnessBenchState;
      });
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
    expect(s.results).toHaveLength(1);
    const r = s.results[0]!;
    expect(r.id).toBe('tiny');
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
});
