/**
 * Snapshot gate (ws/snap-gate, E-008): every 2D harness page against a committed golden PNG, on
 * the `desktop-1280` row only (skipped elsewhere), at a fixed frame.
 *
 * Determinism: the page's clock is Playwright's fake clock, installed and paused before
 * navigation, so `requestAnimationFrame`, timers, `performance.now` and `Date` are frozen while
 * the page boots. Once the page reports `ready` (real promises: WebGPU adapter and device, fonts)
 * the spec runs the clock forward by exactly `FRAMES` animation frames and takes the screenshot.
 * Frame count, timers that have fired and the typed-out caption are therefore the same on every
 * run, regardless of machine load. A page qualifies when its picture is a function of its frame
 * count alone: no wall-clock reads outside the loop, no `Math.random` without a seed, no
 * perspective camera (3D pages carry their own pixel probes in their own specs; see README).
 *
 * `SNAP_UPDATE=1` (what `pnpm snap` sets) rewrites `e2e/golden/<page>.png` instead of comparing.
 * Otherwise the capture goes to `screens/golden/<page>.png`, the comparison runs through
 * scripts/snap.mjs (max channel delta ≤ `TOLERANCE`, E-008) and a diff lands in
 * `screens/diff/<page>.png` when any pixel differs. `pnpm snap:check` runs this spec alone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type {} from '../harness/game-state';
import type {} from '../harness/gestures-state';
import type {} from '../harness/layout-state';
import type {} from '../harness/state';
import type {} from '../harness/ui-state';
import { comparePng, decodePng, describeCompare, encodePng } from '../scripts/snap.mjs';
import { expect, test } from './fixtures';
import { HARNESS_URL } from './ports';

/** The row goldens are captured on: 1280×720, DPR 1, mouse. */
const PROJECT = 'desktop-1280';
/** Frames run after `ready` before the capture (the fake clock fires one every 16 ms). */
const FRAMES = 12;
const FRAME_MS = 16;
/** The page's wall clock: fixed, so `Date`-driven text and timers agree between runs. */
const EPOCH = new Date('2026-01-01T12:00:00Z');

/** What each page publishes: the readiness flag and the counter the picture is a function of. */
interface Probe {
  ready: boolean;
  /** `gpu` on WebGPU pages: anything but `'ok'` is a boot failure. */
  gpu?: string;
  /** Frames rendered or ticks run so far. */
  count: number;
}

interface GoldenPage {
  name: string;
  /** Path under the harness server (`''` is index.html). */
  path: string;
  probe: () => Probe | null;
}

/**
 * The 2D pages: every `harness/*.html` without a perspective camera. `views.html` (two
 * `Camera.perspective` eyes, spinning cubes) and the other 3D pages are out: they are tested by
 * pixel probes in their own specs and are not under the E-008 invariant.
 */
const PAGES: GoldenPage[] = [
  {
    name: 'smoke',
    path: '',
    probe: () => {
      const s = window.__harness;
      return s ? { ready: s.ready, gpu: s.gpu, count: s.frames } : null;
    },
  },
  {
    name: 'game',
    path: 'game.html',
    probe: () => {
      const s = window.__harnessGame?.state();
      return s ? { ready: s.ready, gpu: s.gpu, count: s.frames } : null;
    },
  },
  {
    name: 'ui',
    path: 'ui.html',
    probe: () => {
      const s = window.__harnessUi?.state;
      return s ? { ready: s.ready, count: s.ticks } : null;
    },
  },
  {
    name: 'layout',
    path: 'layout.html',
    probe: () => {
      const s = window.__harnessLayout?.state;
      return s ? { ready: s.ready, count: s.changes } : null;
    },
  },
  {
    name: 'gestures',
    path: 'gestures.html',
    probe: () => {
      const s = window.__harnessGestures?.state;
      return s ? { ready: s.ready, count: s.ticks } : null;
    },
  },
];

/** Opens `p` under the frozen clock, runs `FRAMES` frames and returns the probe at the capture. */
async function openAtFixedFrame(page: Page, p: GoldenPage): Promise<Probe> {
  // Install lets time flow until pauseAt; the pause point sits ahead of the install time so the
  // jump is never "to the past" however long the two calls take.
  await page.clock.install({ time: EPOCH });
  await page.clock.pauseAt(EPOCH.getTime() + 1000);
  // The fake clock's `performance.now` still carries the page's real boot time (a few ms, varying
  // by run), and its animation frames fire on multiples of FRAME_MS, so a loop that clocks itself
  // with `performance.now` at start would see a run-dependent first delta. Quantising every read
  // to the frame grid pins that delta to exactly one frame.
  await page.addInitScript((ms) => {
    const real = performance.now.bind(performance);
    performance.now = () => Math.floor(real() / ms) * ms;
  }, FRAME_MS);
  await page.goto(`${HARNESS_URL}${p.path}`);
  await expect
    .poll(async () => {
      const s = await page.evaluate(p.probe).catch(() => null);
      if (s?.ready && s.gpu !== undefined && s.gpu !== 'ok') throw new Error(`boot: ${s.gpu}`);
      return s?.ready ?? false;
    })
    .toBe(true);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.clock.runFor(FRAMES * FRAME_MS);
  const s = await page.evaluate(p.probe);
  if (!s) throw new Error(`${p.name}: probe missing after boot`);
  return s;
}

test.describe('golden', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== PROJECT, `goldens are captured on ${PROJECT} only`);
  });

  for (const p of PAGES) {
    test(p.name, async ({ page }, testInfo) => {
      const root = join(testInfo.config.rootDir, '..');
      const goldenPath = join(testInfo.config.rootDir, 'golden', `${p.name}.png`);
      const actualPath = join(root, 'screens', 'golden', `${p.name}.png`);
      const diffPath = join(root, 'screens', 'diff', `${p.name}.png`);

      const probe = await openAtFixedFrame(page, p);
      const actual = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
      mkdirSync(join(root, 'screens', 'golden'), { recursive: true });
      writeFileSync(actualPath, actual);
      // Frame-driven pages must have run exactly FRAMES frames: the picture is at a fixed frame.
      if (p.name === 'smoke' || p.name === 'game') expect(probe.count).toBe(FRAMES);
      else expect(probe.count).toBeGreaterThanOrEqual(0);

      if (process.env.SNAP_UPDATE) {
        mkdirSync(join(testInfo.config.rootDir, 'golden'), { recursive: true });
        writeFileSync(goldenPath, actual);
        console.log(`golden ${p.name}: written ${goldenPath}`);
        return;
      }

      expect(existsSync(goldenPath), `${goldenPath} missing: run \`pnpm snap\``).toBe(true);
      const r = comparePng(decodePng(readFileSync(goldenPath)), decodePng(actual));
      const line = describeCompare(p.name, r);
      console.log(line);
      if (r.diff && r.differing > 0) {
        mkdirSync(join(root, 'screens', 'diff'), { recursive: true });
        writeFileSync(diffPath, encodePng(r.diff));
        await testInfo.attach(`${p.name}-diff`, { path: diffPath, contentType: 'image/png' });
        await testInfo.attach(`${p.name}-actual`, { path: actualPath, contentType: 'image/png' });
      }
      expect(r.pass, `${line}; diff: ${diffPath}`).toBe(true);
    });
  }
});
