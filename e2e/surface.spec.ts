/**
 * The surface under stress, against the createGame harness (harness/game.html): resize and DPR
 * changes mid-scene keep the canvas, the overlay and the backbuffer in step; a lost GPU device
 * shows the reload screen on top and nothing keeps running behind it.
 *
 * Moved from the game's tests/e2e/robustness.spec.ts (D-041 addendum 2, ws/create-game).
 */
import type { Frame, Page } from '@playwright/test';
import { expect, openGameHarness, readGame, test } from './fixtures';

function trackProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  return problems;
}

/** The overlay root must cover the canvas exactly (letterbox and DOM in step). */
function overlayMatchesCanvas(frame: Frame) {
  return frame.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#root canvas');
    const overlay = document.querySelector('.tc-overlay');
    if (!canvas || !overlay) throw new Error('canvas or overlay missing');
    const c = canvas.getBoundingClientRect();
    const o = overlay.getBoundingClientRect();
    return {
      dx: Math.abs(c.left - o.left) + Math.abs(c.right - o.right),
      dy: Math.abs(c.top - o.top) + Math.abs(c.bottom - o.bottom),
      buffer: [canvas.width, canvas.height],
      css: [c.width, c.height],
    };
  });
}

async function waitFrames(frame: Frame, n: number): Promise<void> {
  const start = (await readGame(frame)).frames;
  await expect.poll(() => readGame(frame).then((s) => s.frames)).toBeGreaterThanOrEqual(start + n);
}

test('resize and devicePixelRatio changes mid-scene keep canvas, overlay and buffer in step', async ({
  page,
  wrapper,
}) => {
  // The itch iframe has a fixed size: resizing the outer page does not resize the game.
  test.skip(wrapper !== 'top', 'top-level page only');
  const problems = trackProblems(page);
  const frame = await openGameHarness(page, wrapper);
  const cdp = await page.context().newCDPSession(page);
  const mobile = test.info().project.use.isMobile === true;
  const sizes = [
    { width: 1920, height: 1080, dpr: 1 },
    { width: 960, height: 540, dpr: 2 },
    { width: 1000, height: 800, dpr: 1.5 },
    { width: 1600, height: 600, dpr: 1 },
    { width: 390, height: 844, dpr: 3 },
    { width: 1280, height: 720, dpr: 1 },
  ];
  for (const s of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: s.width,
      height: s.height,
      deviceScaleFactor: s.dpr,
      mobile,
    });
    await waitFrames(frame, 6);
    const at = JSON.stringify(s);
    await expect
      .poll(async () => {
        const m = await overlayMatchesCanvas(frame);
        return m.dx + m.dy;
      }, `overlay vs canvas at ${at}`)
      .toBeLessThan(3);
    const m = await overlayMatchesCanvas(frame);
    const g = await readGame(frame);
    // The drawing buffer follows the CSS size x DPR (capped at 2), so the picture stays sharp,
    // and the surface's backbuffer is what the canvas holds.
    const ratio = Math.min(s.dpr, 2);
    expect(m.buffer[0], `buffer width at ${at}`).toBeGreaterThanOrEqual(
      Math.round(m.css[0]! * ratio * 0.5),
    );
    expect(g.backbuffer.pixelRatio, `pixelRatio at ${at}`).toBeCloseTo(ratio, 1);
    expect([g.backbuffer.width, g.backbuffer.height]).toEqual(m.buffer);
  }
  // Still alive: input reaches the game after all that.
  await frame
    .locator('canvas')
    .first()
    .click({ position: { x: 20, y: 20 } });
  await expect.poll(() => readGame(frame).then((s) => s.taps.length)).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});

type Work = { frames: number; intervals: number; audio: string[] };

test('a lost GPU device shows the reload screen on top and halts everything behind it', async ({
  page,
  wrapper,
}) => {
  await page.addInitScript(() => {
    // Work trackers: frames scheduled, live intervals and every AudioContext's state.
    let frames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      frames++;
      return raf(cb);
    };
    const intervals = new Set<unknown>();
    const setI = window.setInterval.bind(window);
    const clearI = window.clearInterval.bind(window);
    window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id = setI(fn, ms, ...args);
      // Vite's dev-server ping is not the page's work.
      if (!new Error().stack?.includes('/@vite/client')) intervals.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      intervals.delete(id);
      clearI(id);
    }) as typeof window.clearInterval;
    const contexts: AudioContext[] = [];
    const AC = window.AudioContext;
    window.AudioContext = class extends AC {
      constructor(o?: AudioContextOptions) {
        super(o);
        contexts.push(this);
      }
    };
    (window as unknown as { __work: () => Work }).__work = () => ({
      frames,
      intervals: intervals.size,
      audio: contexts.map((c) => c.state),
    });
    if (typeof GPUAdapter === 'undefined') return;
    const orig = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, d) {
      const dev = await orig.call(this, d);
      let lose: (i: GPUDeviceLostInfo) => void = () => {};
      const lost = new Promise<GPUDeviceLostInfo>((r) => {
        lose = r;
      });
      Object.defineProperty(dev, 'lost', { value: lost });
      (window as unknown as { __loseDevice: () => void }).__loseDevice = () => {
        lose({ reason: 'unknown', message: 'test: device lost' } as GPUDeviceLostInfo);
        dev.destroy();
      };
      return dev;
    };
  });
  const problems = trackProblems(page);
  const frame = await openGameHarness(page, wrapper);
  // Unlock audio first, so the test proves a running context gets halted.
  const canvas = frame.locator('canvas').first();
  if (test.info().project.use.hasTouch) await canvas.tap({ position: { x: 8, y: 8 } });
  else await canvas.click({ position: { x: 8, y: 8 } });
  await expect.poll(() => readGame(frame).then((s) => s.audio)).toBe('running');

  // A write still in memory (the save is debounced for a minute) when the device goes.
  await frame.evaluate(() => window.__harnessGame?.write(77));
  expect(await frame.evaluate(() => window.__harnessGame?.stored())).not.toBe(77);
  await frame.evaluate(() => (window as unknown as { __loseDevice: () => void }).__loseDevice());
  const screen = frame.getByRole('alertdialog').filter({ hasText: 'The lights went out' });
  await expect(screen).toBeVisible();
  // The reload button is on top and takes focus, so a click or Enter reaches it.
  const reload = screen.getByRole('button', { name: 'Reload' });
  await expect(reload).toBeFocused();
  const top = await reload.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
  });
  expect(top).toBe(true);
  const g = await readGame(frame);
  expect(g.lost).toBe(1);
  expect(g.loopHalted).toBe(true);
  expect(g.loopRunning).toBe(false);
  // The save was flushed on the way down.
  expect(await frame.evaluate(() => window.__harnessGame?.stored())).toBe(77);

  // Nothing runs behind the dialog: no frames are scheduled, the audio context is not running
  // and no interval is live, even after the tab is hidden and shown again.
  const work = () => frame.evaluate(() => (window as unknown as { __work: () => Work }).__work());
  await page.waitForTimeout(200);
  const before = await work();
  expect(before.audio.length).toBeGreaterThan(0);
  expect(before.audio.every((s) => s !== 'running')).toBe(true);
  expect(before.intervals).toBe(0);
  await frame.evaluate(() => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await page.waitForTimeout(500);
  const after = await work();
  expect(after.frames).toBe(before.frames);
  expect(after.audio.every((s) => s !== 'running')).toBe(true);
  expect(after.intervals).toBe(0);
  expect((await readGame(frame)).loopRunning).toBe(false);
  // Only the one expected error: the loss itself. No error storm from a loop still drawing.
  await page.waitForTimeout(500);
  expect(problems.filter((p) => !p.includes('[gpu] device lost'))).toEqual([]);
  // Reload brings the harness back.
  await reload.click();
  const again = wrapper === 'top' ? page.mainFrame() : frame;
  await expect
    .poll(
      () =>
        readGame(again)
          .then((s) => s.frames)
          .catch(() => -1),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(2);
});

test('orientation flips do not leak GPU textures or buffers', async ({ page, wrapper }) => {
  // From the game's scripts/perf/mem.spec.ts flip check (test-split: mem.spec, MIXED).
  test.skip(wrapper !== 'top', 'top-level page only');
  await page.addInitScript(() => {
    if (typeof GPUDevice === 'undefined') return;
    const tex = new Set<GPUTexture>();
    const buf = new Set<GPUBuffer>();
    const createTexture = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (this: GPUDevice, d: GPUTextureDescriptor) {
      const t = createTexture.call(this, d);
      tex.add(t);
      return t;
    };
    const destroyTexture = GPUTexture.prototype.destroy;
    GPUTexture.prototype.destroy = function (this: GPUTexture) {
      tex.delete(this);
      return destroyTexture.call(this);
    };
    const createBuffer = GPUDevice.prototype.createBuffer;
    GPUDevice.prototype.createBuffer = function (this: GPUDevice, d: GPUBufferDescriptor) {
      const b = createBuffer.call(this, d);
      buf.add(b);
      return b;
    };
    const destroyBuffer = GPUBuffer.prototype.destroy;
    GPUBuffer.prototype.destroy = function (this: GPUBuffer) {
      buf.delete(this);
      return destroyBuffer.call(this);
    };
    (window as unknown as { __gpuLive: () => number[] }).__gpuLive = () => [tex.size, buf.size];
  });
  const frame = await openGameHarness(page, wrapper);
  const live = () =>
    frame.evaluate(() => (window as unknown as { __gpuLive: () => number[] }).__gpuLive());
  const vp = page.viewportSize();
  if (!vp) throw new Error('no viewport');
  const flip = async () => {
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await waitFrames(frame, 6);
    await page.setViewportSize(vp);
    await waitFrames(frame, 6);
  };
  // One flip first, so lazily made targets for both shapes exist.
  await flip();
  const [tex0, buf0] = await live();
  expect(tex0, 'the probe sees the render targets').toBeGreaterThan(0);
  for (let i = 0; i < 10; i++) await flip();
  const [tex1, buf1] = await live();
  expect(tex1, 'live textures after 10 flips').toBeLessThanOrEqual(tex0 ?? 0);
  expect(buf1, 'live buffers after 10 flips').toBeLessThanOrEqual(buf0 ?? 0);
});
