/**
 * The page lifecycle a phone or a browser puts a game through, on every matrix row, against the
 * createGame harness (harness/game.html). iOS and Android can freeze or kill a background tab
 * without warning, so every way out (hidden, pagehide, freeze) must flush the save at once,
 * stop drawing and pause audio; coming back must resume both. Also: audio unlocks on the first
 * gesture, and browser zoom (double-tap, pinch, ctrl+wheel) is blocked.
 *
 * Moved from the game's tests/e2e/lifecycle.spec.ts (D-041 addendum 2, ws/create-game).
 */
import type { Frame, Page } from '@playwright/test';
import { expect, openGameHarness, readGame, test } from './fixtures';

/** Every AudioContext the page made, and its state now (installed before the page loads). */
async function trackAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    const AC = window.AudioContext;
    window.AudioContext = class extends AC {
      constructor(o?: AudioContextOptions) {
        super(o);
        contexts.push(this);
      }
    };
    (window as unknown as { __audio: () => string[] }).__audio = () => contexts.map((c) => c.state);
  });
}

function audioStates(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => (window as unknown as { __audio: () => string[] }).__audio());
}

const lastAudio = (frame: Frame) => audioStates(frame).then((a) => a.at(-1) ?? 'none');

/** Console errors and page errors, to assert none happened. */
function trackProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  return problems;
}

/** One click (mouse rows) or tap (touch rows) on the canvas: a real user gesture. */
async function gesture(frame: Frame): Promise<void> {
  const canvas = frame.locator('canvas').first();
  if (test.info().project.use.hasTouch) await canvas.tap({ position: { x: 8, y: 8 } });
  else await canvas.click({ position: { x: 8, y: 8 } });
}

function setHidden(frame: Frame, hidden: boolean) {
  return frame.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Writes `n` to the save in memory and returns what storage held right after (not `n`). */
function writeMarker(frame: Frame, n: number) {
  return frame.evaluate((n) => {
    const g = window.__harnessGame;
    if (!g) throw new Error('no harness');
    g.write(n);
    return g.stored();
  }, n);
}

function stored(frame: Frame) {
  return frame.evaluate(() => window.__harnessGame?.stored() ?? null);
}

const frames = (frame: Frame) => readGame(frame).then((s) => s.frames);

async function bootAndUnlock(page: Page, wrapper: 'top' | 'itch-iframe'): Promise<Frame> {
  await trackAudio(page);
  const frame = await openGameHarness(page, wrapper);
  await gesture(frame);
  await expect.poll(() => lastAudio(frame), { timeout: 10_000 }).toBe('running');
  return frame;
}

test('audio unlocks on the first gesture, not before', async ({ page, wrapper }) => {
  const problems = trackProblems(page);
  await trackAudio(page);
  const frame = await openGameHarness(page, wrapper);
  const before = await readGame(frame);
  expect(before.audio).toBe('locked');
  expect((await audioStates(frame)).every((s) => s !== 'running')).toBe(true);
  await gesture(frame);
  await expect.poll(() => readGame(frame).then((s) => s.audio)).toBe('running');
  await expect.poll(() => lastAudio(frame)).toBe('running');
  expect(problems).toEqual([]);
});

test('hiding the page flushes the save, stops frames and audio; showing it resumes both', async ({
  page,
  wrapper,
}) => {
  const problems = trackProblems(page);
  const frame = await bootAndUnlock(page, wrapper);
  expect(await writeMarker(frame, 4101)).not.toBe(4101);

  await setHidden(frame, true);
  expect(await stored(frame)).toBe(4101);
  const hidden = await readGame(frame);
  expect(hidden.hides).toBe(1);
  expect(hidden.loopRunning).toBe(false);
  await expect.poll(() => lastAudio(frame)).toBe('suspended');
  const before = await frames(frame);
  await page.waitForTimeout(400);
  expect(await frames(frame)).toBe(before);

  await setHidden(frame, false);
  await expect.poll(() => lastAudio(frame)).toBe('running');
  await expect.poll(() => frames(frame)).toBeGreaterThan(before + 3);
  expect(problems).toEqual([]);
});

test('pagehide and freeze flush the save; pageshow and resume bring the game back', async ({
  page,
  wrapper,
}) => {
  const problems = trackProblems(page);
  const frame = await bootAndUnlock(page, wrapper);

  // pagehide (iOS: switching apps, closing the tab, bfcache).
  expect(await writeMarker(frame, 4201)).not.toBe(4201);
  await frame.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  );
  expect(await stored(frame)).toBe(4201);
  await expect.poll(() => lastAudio(frame)).toBe('suspended');
  const before = await frames(frame);
  await page.waitForTimeout(300);
  expect(await frames(frame)).toBe(before);
  await frame.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect.poll(() => lastAudio(frame)).toBe('running');
  await expect.poll(() => frames(frame)).toBeGreaterThan(before + 3);

  // freeze (Chrome on Android freezes background tabs, then may discard them unannounced).
  expect(await writeMarker(frame, 4202)).not.toBe(4202);
  await frame.evaluate(() => document.dispatchEvent(new Event('freeze')));
  expect(await stored(frame)).toBe(4202);
  expect((await readGame(frame)).loopRunning).toBe(false);
  const frozen = await frames(frame);
  await frame.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect.poll(() => frames(frame)).toBeGreaterThan(frozen + 3);
  expect((await readGame(frame)).hides).toBe(2);
  expect(problems).toEqual([]);
});

test('browser zoom is blocked: double-tap, pinch and ctrl+wheel; plain wheel is not', async ({
  page,
  wrapper,
}) => {
  const frame = await openGameHarness(page, wrapper);
  const prevented = await frame.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const fire = (e: Event) => {
      canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const opts = { bubbles: true, cancelable: true };
    return {
      dblclick: fire(new MouseEvent('dblclick', opts)),
      gesturestart: fire(new Event('gesturestart', opts)),
      gesturechange: fire(new Event('gesturechange', opts)),
      ctrlWheel: fire(new WheelEvent('wheel', { ...opts, ctrlKey: true, deltaY: -10 })),
      wheel: fire(new WheelEvent('wheel', { ...opts, deltaY: -10 })),
    };
  });
  expect(prevented).toEqual({
    dblclick: true,
    gesturestart: true,
    gesturechange: true,
    ctrlWheel: true,
    wheel: false,
  });
});
