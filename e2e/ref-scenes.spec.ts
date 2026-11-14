/**
 * The reference scenes (E-041 A4) on `desktop-1280` only: every `REF_RUNGS` rung opens its page,
 * measures its frames with no GPU or page error, and (the `ref-*` pages) draws frame
 * `REF_STATS_FRAME` with exactly the `renderer.stats` its counted budget test pinned on the fake
 * device (src/<module>/ref-<scene>.budget.json), so the timed scene and the counted one are the
 * same scene. The idle HUD writes and reads nothing in the DOM in a held frame.
 *
 * `TC_REF_TIMES=<file>` writes each rung's timings to `<file>` (JSON) for docs/BENCH.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { REF_RUNGS, type RefRungDef } from '../harness/bench-state';
import type { HarnessCoreState } from '../harness/core-state';
import type { HarnessRefState } from '../harness/ref-state';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

/** Each `ref-*` rung's kept budget JSON and row name. */
const KEPT: Record<string, { json: string; row: string }> = {
  'ref-board': { json: 'src/render/ref-board.budget.json', row: 'ref-board' },
  'ref-characters': { json: 'src/anim/ref-characters.budget.json', row: 'ref-characters-64' },
  'ref-characters-256': { json: 'src/anim/ref-characters.budget.json', row: 'ref-characters-256' },
  'ref-arena': { json: 'src/render/ref-arena.budget.json', row: 'ref-arena' },
  'ref-voxel': { json: 'src/voxel/ref-voxel.budget.json', row: 'ref-voxel-8' },
  'ref-voxel-16': { json: 'src/voxel/ref-voxel.budget.json', row: 'ref-voxel-16' },
  'ref-stereo': { json: 'src/render/ref-stereo.budget.json', row: 'ref-stereo' },
  'ref-hud': { json: 'src/ui/ref-hud.budget.json', row: 'ref-hud' },
};

interface Timing {
  id: string;
  cpuMs: number;
  cpuP95Ms: number | null;
  gpuMs: number | null;
  frames: number;
  adapter: string;
}

const times: Timing[] = [];
const errors: string[] = [];
let page: Page;

test.describe('reference scenes', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(({ page: p }) => {
    test.skip(test.info().project.name !== 'desktop-1280', 'desktop-1280 only');
    page = p;
    errors.length = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
  });

  test.afterAll(() => {
    const out = process.env.TC_REF_TIMES;
    if (out && times.length > 0) writeFileSync(out, `${JSON.stringify(times, null, 2)}\n`);
  });

  for (const rung of REF_RUNGS) {
    test(`${rung.id} runs its frames, as counted`, async () => {
      test.setTimeout(90_000);
      if (rung.page === 'core.html') await core(rung);
      else await ref(rung);
      expect(errors).toEqual([]);
    });
  }
});

function url(rung: RefRungDef): string {
  return `${HARNESS_URL}${rung.page}${rung.query ? `?${rung.query}` : ''}`;
}

async function ref(rung: RefRungDef): Promise<void> {
  await page.goto(url(rung));
  const read = () =>
    page.evaluate(() => {
      const s = window.__harnessRef?.state;
      return s ? (JSON.parse(JSON.stringify(s)) as HarnessRefState) : null;
    });
  await expect
    .poll(
      async () => {
        const s = await read();
        if (s?.ready && s.gpu !== 'ok') throw new Error(`${rung.id}: ${s.gpu}`);
        return s?.done ?? false;
      },
      { timeout: 80_000 },
    )
    .toBe(true);
  const s = (await read())!;
  expect(s.gpuErrors).toBe(0);
  expect(s.measured).toBeGreaterThan(0);
  expect(s.cpuMs).toBeGreaterThan(0);
  if (s.timestamps) expect(s.gpuSamples).toBeGreaterThan(0);
  const kept = KEPT[rung.id]!;
  const book = JSON.parse(readFileSync(kept.json, 'utf8')) as {
    stats: Record<string, unknown>;
    notes: Record<string, number>;
  };
  expect(s.stats, `${rung.id}: renderer.stats as counted`).toEqual(book.stats[kept.row]);
  if (rung.id === 'ref-hud') expect(s.dom).toEqual({ writes: 0, reads: 0 });
  times.push({
    id: rung.id,
    cpuMs: s.cpuMs,
    cpuP95Ms: s.cpuP95Ms,
    gpuMs: s.gpuMs,
    frames: s.measured,
    adapter: s.adapter.description || `${s.adapter.vendor} ${s.adapter.architecture}`.trim(),
  });
}

async function core(rung: RefRungDef): Promise<void> {
  await page.goto(url(rung));
  const read = () =>
    page.evaluate(() => {
      const s = window.__harnessCore?.state;
      return s ? (JSON.parse(JSON.stringify(s)) as HarnessCoreState) : null;
    });
  // The core page keeps the median of its last 60 frames: past warmup and a full window.
  await expect
    .poll(
      async () => {
        const s = await read();
        if (s?.ready && s.gpu !== 'ok') throw new Error(`${rung.id}: ${s.gpu}`);
        return s?.ready ? s.frames : -1;
      },
      { timeout: 80_000 },
    )
    .toBeGreaterThanOrEqual(80);
  const s = (await read())!;
  expect(s.gpuErrors).toBe(0);
  expect(s.cpuMs).toBeGreaterThan(0);
  times.push({ id: rung.id, cpuMs: s.cpuMs, cpuP95Ms: null, gpuMs: null, frames: 60, adapter: '' });
}
