/**
 * Save slots, settings and the undo journal (`@thunderclap/engine/save`) on every matrix row,
 * against harness/save.html (no WebGPU; `MemoryStorage`, so rows share nothing): `list()` from
 * the meta sidecars after two saves, undo and redo restoring the tilemap checksum, and a slider
 * bound through `bind` reaching the settings store. On the itch-iframe row the page runs inside
 * the cross-site wrapper (`?page=save.html`).
 */
import type { Frame } from '@playwright/test';
import type { HarnessSaveState } from '../harness/save-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

let frame: Frame;

test.beforeEach(async ({ page, wrapper }) => {
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}save.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('save.html')}`);
    frame = await harnessFrame(page);
  }
  await expect.poll(() => read().then((s) => s.ready)).toBe(true);
});

function read(): Promise<HarnessSaveState> {
  return frame.evaluate(() => {
    const s = window.__harnessSave?.state;
    if (!s) throw new Error('window.__harnessSave missing');
    return JSON.parse(JSON.stringify(s)) as HarnessSaveState;
  });
}

const paint = (x: number, y: number, v: number) =>
  frame.evaluate(([a, b, c]) => window.__harnessSave?.paint(a, b, c), [x, y, v]);
const save = (slot: number) => frame.evaluate((n) => window.__harnessSave?.save(n), slot);

test('list() shows two saved slots from the sidecars and mostRecent is the later one', async () => {
  const fresh = await read();
  expect(fresh.slots).toEqual([]);
  expect(fresh.mostRecent).toBeNull();

  // The working tilemap is slot 1 and flushes on every paint, so it is listed first.
  await paint(3, 4, 7);
  await expect.poll(() => read().then((s) => s.slots.map((i) => i.slot))).toEqual([1]);
  expect((await read()).slots[0]).toMatchObject({ label: 'Working', playMs: 1000 });

  await save(2);
  await expect.poll(() => read().then((s) => s.slots.length)).toBe(2);
  // A later wall-clock tick for the next save.
  await frame.waitForTimeout(5);
  await paint(10, 10, 2);
  await save(3);
  await expect.poll(() => read().then((s) => s.slots.length)).toBe(3);

  const s = await read();
  expect(s.slots.map((i) => i.slot)).toEqual([1, 2, 3]);
  expect(s.slots[1]).toMatchObject({ label: 'Slot 2 save', version: 1, playMs: 1000 });
  expect(s.slots[2]).toMatchObject({ label: 'Slot 3 save', version: 1, playMs: 2000 });
  expect(s.slots[2]!.savedAt).toBeGreaterThan(s.slots[1]!.savedAt);
  expect(s.slots[2]!.size).toBeGreaterThan(0);
  expect(s.mostRecent?.slot).toBe(3);
  await expect(frame.locator('#slots li')).toHaveCount(3);
  await expect(frame.locator('#recent')).toHaveText('most recent: slot 3 (Slot 3 save)');

  // The slot buttons drive the same path; saving into slot 1 relabels the working slot.
  await frame.waitForTimeout(5);
  await frame.locator('#save-1').click();
  await expect.poll(() => read().then((st) => st.mostRecent?.slot)).toBe(1);
  expect((await read()).slots[0]?.label).toBe('Slot 1 save');
});

test('undo restores the tilemap checksum and redo brings the paint back', async () => {
  const empty = await read();
  expect(empty.canUndo).toBe(false);
  expect(empty.painted).toBe(0);

  await paint(1, 1, 5);
  const one = await read();
  expect(one.painted).toBe(1);
  expect(one.tileChecksum).not.toBe(empty.tileChecksum);
  expect(one.canUndo).toBe(true);
  expect(one.canRedo).toBe(false);

  await paint(2, 2, 6);
  const two = await read();
  expect(two.painted).toBe(2);

  await frame.locator('#undo').click();
  await expect.poll(() => read().then((s) => s.tileChecksum)).toBe(one.tileChecksum);
  expect((await read()).canRedo).toBe(true);
  await frame.locator('#undo').click();
  await expect.poll(() => read().then((s) => s.tileChecksum)).toBe(empty.tileChecksum);
  const back = await read();
  expect(back.painted).toBe(0);
  expect(back.paints).toBe(0);
  expect(back.canUndo).toBe(false);
  await expect(frame.locator('#undo')).toBeDisabled();

  await frame.locator('#redo').click();
  await frame.locator('#redo').click();
  await expect.poll(() => read().then((s) => s.tileChecksum)).toBe(two.tileChecksum);
  expect((await read()).canRedo).toBe(false);
});

test('the volume slider bound through bind() writes the settings store, and setVolume moves the slider', async () => {
  const slider = frame.locator('#volume');
  await expect(slider).toHaveValue('0.5');
  expect((await read()).volume).toBe(0.5);

  await slider.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '0.25';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => read().then((s) => s.volume)).toBe(0.25);
  await expect(frame.locator('#volume-text')).toHaveText('0.25');

  await frame.evaluate(() => window.__harnessSave?.setVolume(0.9));
  await expect(slider).toHaveValue('0.9');
  expect((await read()).volume).toBe(0.9);
});
