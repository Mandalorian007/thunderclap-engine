/**
 * Engine platform smoke, run on every matrix entry (playwright.config.ts): WebGPU comes up and
 * presents, the surface letterboxes and follows a resize, and one tap or click reaches an input
 * action at the right logical position.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessState } from '../harness/state';
import { expect, readHarness, test, waitForFrames } from './fixtures';

/** The harness surface uses the engine defaults: a 1920×1080 logical design. */
const LOGICAL = { width: 1920, height: 1080 };

/** The surface must be the centred contain fit of the logical aspect in its container. */
function expectLetterbox(s: HarnessState, container: { width: number; height: number }): void {
  expect(s.container).toEqual(container);
  const scale = Math.min(container.width / LOGICAL.width, container.height / LOGICAL.height);
  expect(s.rect.scale).toBeCloseTo(scale, 3);
  expect(Math.abs(s.rect.width - LOGICAL.width * scale)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.rect.height - LOGICAL.height * scale)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.rect.x - (container.width - s.rect.width) / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.rect.y - (container.height - s.rect.height) / 2)).toBeLessThanOrEqual(1);
  // The backbuffer keeps the aspect, at a capped DPR, and the swapchain presents at its size.
  expect(s.backbuffer.pixelRatio).toBeGreaterThan(0);
  expect(s.backbuffer.pixelRatio).toBeLessThanOrEqual(2);
  expect(s.backbuffer.width / s.backbuffer.height).toBeCloseTo(LOGICAL.width / LOGICAL.height, 1);
}

async function canvasBox(frame: Frame) {
  return frame.evaluate(() => {
    const r = document.querySelector('canvas')?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
}

/** Size of the box the harness root fills: the viewport, or the wrapper's iframe. */
async function resizeHost(page: Page, wrapper: string, size: { width: number; height: number }) {
  if (wrapper === 'top') {
    await page.setViewportSize(size);
    return;
  }
  await page.evaluate(({ width, height }) => {
    const f = document.getElementById('frame') as HTMLElement;
    f.style.width = `${width}px`;
    f.style.height = `${height}px`;
  }, size);
}

test('WebGPU init, surface resize and one input tap', async ({ page, harness, wrapper }) => {
  // 1. WebGPU init: boot succeeds and frames are presented.
  await expect.poll(async () => (await readHarness(harness).catch(() => null))?.ready).toBe(true);
  const booted = await readHarness(harness);
  expect(booted.gpu, 'WebGPU boot').toBe('ok');
  expect(['bgra8unorm', 'rgba8unorm']).toContain(booted.format);
  expect(booted.embedded).toBe(wrapper === 'itch-iframe');
  let s = await waitForFrames(harness);

  // 2. Surface: letterboxed in its container, swapchain at the backbuffer size.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  const host = wrapper === 'top' ? viewport : { width: 960, height: 540 };
  expectLetterbox(s, host);
  await expect
    .poll(async () => (await readHarness(harness)).presented)
    .toEqual({
      width: s.backbuffer.width,
      height: s.backbuffer.height,
    });
  const box = await canvasBox(harness);
  expect(box).not.toBeNull();
  expect(Math.abs((box?.width ?? 0) - s.rect.width)).toBeLessThanOrEqual(1);

  // Resize to a taller-than-design box (the bars move to top and bottom), and follow it.
  const resized = { width: Math.round(host.width * 0.6), height: host.height };
  await resizeHost(page, wrapper, resized);
  await expect.poll(async () => (await readHarness(harness)).container).toEqual(resized);
  s = await readHarness(harness);
  expect(s.resizes).toBeGreaterThan(booted.resizes);
  expectLetterbox(s, resized);
  await expect
    .poll(async () => (await readHarness(harness)).presented)
    .toEqual({
      width: s.backbuffer.width,
      height: s.backbuffer.height,
    });

  // 3. Input: one tap (touch projects) or click at the canvas centre is one `tap` press at the
  // logical centre, from the right device.
  const canvas = harness.locator('canvas');
  const after = await canvasBox(harness);
  if (!after) throw new Error('no canvas');
  const position = { x: after.width / 2, y: after.height / 2 };
  const touch = test.info().project.use.hasTouch === true;
  if (touch) await canvas.tap({ position });
  else await canvas.click({ position });
  await expect.poll(async () => (await readHarness(harness)).taps.length).toBe(1);
  const [tap] = (await readHarness(harness)).taps;
  expect(tap?.device).toBe(touch ? 'touch' : 'mouse');
  expect(Math.abs((tap?.x ?? 0) - LOGICAL.width / 2)).toBeLessThanOrEqual(4);
  expect(Math.abs((tap?.y ?? 0) - LOGICAL.height / 2)).toBeLessThanOrEqual(4);
});
