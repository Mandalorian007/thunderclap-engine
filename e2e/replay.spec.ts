/**
 * Input recording and replay (ws/input-replay) on every matrix row, against harness/replay.html:
 * the page records a scripted 3 s session, replays it and compares every tick. The replay must
 * match on every row (E-011: the engine's determinism is a platform capability), and the
 * recording must be JSON that survives `serializeRecording` → `parseRecording`.
 */
import type { Frame } from '@playwright/test';
import type { HarnessReplayState } from '../harness/replay-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;
const errors: string[] = [];

test.beforeEach(async ({ page, wrapper }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}replay.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('replay.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`replay demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(1);
});

function read(): Promise<HarnessReplayState> {
  return frame.evaluate(() => {
    const s = window.__harnessReplay?.state;
    if (!s) throw new Error('window.__harnessReplay missing');
    return JSON.parse(JSON.stringify(s)) as HarnessReplayState;
  });
}

/** Wait until the recorded session has been replayed to its end (two 3 s sessions, under load). */
async function replayed(): Promise<HarnessReplayState> {
  await expect.poll(async () => (await read()).phase, { timeout: 25_000 }).toBe('live');
  return read();
}

test('the replayed session matches the recorded one on every tick', async () => {
  const s = await replayed();
  expect(s.recordedTicks).toBe(180);
  expect(s.replayTick).toBe(180);
  expect(s.firstMismatch).toBeNull();
  expect(s.mismatches).toBe(0);
  expect(s.positionAfterRecord).not.toBeNull();
  // The script moved the sprite: right, down, a dash, the stick, the arrows.
  expect(s.positionAfterRecord![0]).not.toBe(960);
  expect(s.positionAfterRecord![1]).not.toBe(540);
  expect(s.positionAfterReplay).toEqual(s.positionAfterRecord);
  expect(s.equal).toBe(true);
  expect(s.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('the recording is compact JSON that round-trips through serialize and parse', async () => {
  const s = await replayed();
  const rec = JSON.parse(s.json) as { version: number; ticks: { t: number; n?: number }[] };
  expect(rec.version).toBe(1);
  expect(Array.isArray(rec.ticks)).toBe(true);
  // Deltas only: far fewer entries than ticks, and the idle stretches are runs.
  expect(rec.ticks.length).toBeLessThan(40);
  expect(rec.ticks.some((t) => typeof t.n === 'number' && t.n > 1)).toBe(true);
  const last = rec.ticks[rec.ticks.length - 1]!;
  expect(last.t + (last.n ?? 1)).toBe(180);
  expect(s.roundTrip).toBe(true);
});
