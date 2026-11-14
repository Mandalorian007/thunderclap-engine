/**
 * Voxel demo (`demos/voxel`) on every matrix row: a voxel game on `@thunderclap-engine/engine/voxel`
 * end to end (the grid, the mesher Worker, the culled chunk meshes and the picking ray are the
 * engine's; the blocks are the demo's).
 *
 * - boots to a steady state with all 256 chunks meshed in the Worker and no console errors, and
 *   the spawn view draws well under one call per chunk;
 * - the world keeps the generator's promises as numbers, not only as a boot console error:
 *   every terrain top in 16..44 (`terrainTops`) and the spawn cell open over solid land above
 *   the sea (`spawn`);
 * - a click (touch rows: a tap on the right half, real touch events through CDP) breaks the
 *   block under the reticle: `lookingAt` changes and, on desktop, the re-mesh round trip is
 *   under 50 ms, with no mesh growth;
 * - a right click (touch rows: the place key) puts the hotbar block on the looked-at face, as
 *   fast and with no growth either;
 * - walking forward for a second moves `playerPos`;
 * - `?still&time=0.25` parks the day cycle at noon;
 * - desktop rows run above 20 fps once settled.
 *
 * Server: the harness Vite server serves the demo at `/demos/voxel/` (the `serveDemos` plugin in
 * vite.harness.config.ts). The itch row embeds that route in the wrapper page (`?page=`).
 */
import type { CDPSession, Frame, Page } from '@playwright/test';
import {
  Block,
  CHUNK_COUNT,
  SEA_LEVEL,
  type VoxelDemoApi,
  type VoxelDemoState,
} from '../../demos/voxel/world';
import { expect, test } from '../fixtures';
import { HARNESS_URL, WRAPPER_URL } from '../ports';

const demoUrl = `${HARNESS_URL}demos/voxel/`;
let frame: Frame;
let touch = false;
let cdp: CDPSession | null = null;
const errors: string[] = [];

async function open(page: Page, wrapper: string, query = ''): Promise<void> {
  const url = demoUrl + query;
  if (wrapper === 'top') {
    await page.goto(url);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(url)}`);
    await expect.poll(() => page.frames().some((f) => f.url().startsWith(demoUrl))).toBe(true);
    const f = page.frames().find((f) => f.url().startsWith(demoUrl));
    if (!f) throw new Error('voxel demo iframe not found');
    frame = f;
  }
  // The world generates and meshes in the Worker; wait for every chunk and a few frames.
  await expect
    .poll(
      async () => {
        const s = await read().catch(() => null);
        if (s?.ready && s.gpu !== 'ok') throw new Error(`voxel demo: ${s.gpu}`);
        return s?.ready && s.frame >= 3 ? s.chunks : -1;
      },
      { timeout: 25_000 },
    )
    .toBe(CHUNK_COUNT);
  // Mouse rows: park the pointer at the reticle once. A later move under a granted pointer lock
  // would turn the view, so every click lands where the pointer already is.
  if (!touch) {
    const c = await centre();
    await page.mouse.move(c.x, c.y);
  }
}

test.beforeEach(async ({ page }) => {
  touch = test.info().project.use.hasTouch === true;
  cdp = null;
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
});

function read(): Promise<VoxelDemoState> {
  return frame.evaluate(() => {
    const d = (window as unknown as { __demo?: VoxelDemoApi }).__demo;
    if (!d) throw new Error('window.__demo missing');
    return JSON.parse(JSON.stringify(d)) as VoxelDemoState;
  });
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frame;
  await expect.poll(async () => (await read()).frame).toBeGreaterThanOrEqual(start + n);
}

async function centre(): Promise<{ x: number; y: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function aim(yaw: number, pitch: number): Promise<void> {
  return frame.evaluate(
    ([y, p]) => {
      (window as unknown as { __demo: VoxelDemoApi }).__demo.aim(y, p);
    },
    [yaw, pitch] as const,
  );
}

function blockAt(cell: [number, number, number]): Promise<number> {
  return frame.evaluate(
    ([x, y, z]) => (window as unknown as { __demo: VoxelDemoApi }).__demo.blockAtWorld(x, y, z),
    cell,
  );
}

/**
 * A break: a tap on the right half (touch rows) or a click where the mouse rests, both as raw
 * CDP input. The press and the release go out back to back: the browser runs them in order
 * without a round trip to the runner in between, so a starved runner cannot stretch the press
 * past the demo's 420 ms long-press (a touch then places a block; a click is no tap).
 */
async function tapBreak(page: Page): Promise<void> {
  cdp ??= await page.context().newCDPSession(page);
  const session = cdp;
  if (touch) {
    const box = await frame.locator('canvas').first().boundingBox();
    if (!box) throw new Error('no canvas');
    const x = box.x + box.width * 0.75;
    const y = box.y + box.height / 2;
    await Promise.all([
      session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1 }],
      }),
      session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    ]);
  } else {
    const { x, y } = await centre();
    const click = { x, y, button: 'left', clickCount: 1 } as const;
    await Promise.all([
      session.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...click }),
      session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...click }),
    ]);
  }
}

/** A place: the right button (mouse rows) or the place key (touch rows, no long-press timing). */
async function place(page: Page): Promise<void> {
  if (touch) {
    await page.keyboard.down('KeyE');
    await frames(1);
    await page.keyboard.up('KeyE');
  } else {
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
  }
}

/** Errors the page threw, minus the browser's own note when it refuses the pointer lock. */
const pageErrors = () => errors.filter((e) => !/pointer ?lock/i.test(e));

test('boots with every chunk meshed and draws under 200 calls', async ({ page, wrapper }) => {
  await open(page, wrapper);
  await frames(2);
  const s = await read();
  expect(s.chunks).toBe(CHUNK_COUNT);
  expect(s.chunksSolid).toBeGreaterThan(64);
  expect(s.chunksDrawn).toBeGreaterThan(0);
  expect(s.triangles).toBeGreaterThan(1000);
  expect(s.drawCalls).toBeLessThan(200);
  expect(s.drawCalls).toBeLessThan(s.chunksSolid);
  expect(s.edits).toBe(0);
  expect(s.gpuErrors).toBe(0);
  // Spawned on land: the feet stand on a block above the sea.
  expect(s.playerPos[1]).toBeGreaterThan(20);
  expect(pageErrors()).toEqual([]);
});

test('the world keeps its promises: terrain tops in 16..44, spawn on solid land', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  // Every column's generated top, trees and caves aside (the page measures it once at boot).
  const [lo, hi] = s.terrainTops;
  expect(lo).toBeGreaterThanOrEqual(16);
  expect(hi).toBeLessThanOrEqual(44);
  expect(lo).toBeLessThanOrEqual(hi);
  // The spawn cell is open, with land under it (not air or sand) above the sea.
  const [x, y, z] = s.spawn;
  const [at, under] = await frame.evaluate(
    ([x, y, z]) => {
      const d = (window as unknown as { __demo: VoxelDemoApi }).__demo;
      return [d.blockAtWorld(x, y, z), d.blockAtWorld(x, y - 1, z)];
    },
    [x, y, z] as const,
  );
  expect(at).toBe(Block.Air);
  expect([Block.Air, Block.Sand]).not.toContain(under);
  expect(y - 1).toBeGreaterThan(SEA_LEVEL);
  expect(pageErrors()).toEqual([]);
});

test('a click breaks the looked-at block and re-meshes fast', async ({ page, wrapper }) => {
  test.fixme(
    test.info().project.use.browserName === 'webkit',
    'Playwright drives touch through CDP, which is Chromium-only',
  );
  await open(page, wrapper);
  // Look steeply down at the ground just ahead.
  await aim(0, -1.2);
  await frames(2);
  const before = await read();
  expect(before.lookingAt).not.toBeNull();
  const target = before.lookingAt as [number, number, number];
  expect(await blockAt(target)).not.toBe(0);
  await tapBreak(page);
  await expect.poll(async () => (await read()).edits).toBe(1);
  expect(await blockAt(target)).toBe(0);
  await expect
    .poll(async () => JSON.stringify((await read()).lookingAt))
    .not.toBe(JSON.stringify(target));
  await expect.poll(async () => (await read()).remeshMs).toBeGreaterThanOrEqual(0);
  const after = await read();
  if (/^desktop-/.test(test.info().project.name)) expect(after.remeshMs).toBeLessThan(50);
  expect(after.growths).toBe(0);
  expect(after.gpuErrors).toBe(0);
  expect(pageErrors()).toEqual([]);
});

test('a right click places the hotbar block on the looked-at face', async ({ page, wrapper }) => {
  await open(page, wrapper);
  // Look at the ground a couple of blocks ahead, so the placed block is clear of the player.
  await aim(0, -0.6);
  await frames(2);
  const before = await read();
  expect(before.lookingAt).not.toBeNull();
  const hit = before.lookingAt as [number, number, number];
  await place(page);
  await expect.poll(async () => (await read()).edits).toBe(1);
  // The new block is the selected one, on one of the hit block's six faces.
  const faces: [number, number, number][] = [
    [hit[0] + 1, hit[1], hit[2]],
    [hit[0] - 1, hit[1], hit[2]],
    [hit[0], hit[1] + 1, hit[2]],
    [hit[0], hit[1] - 1, hit[2]],
    [hit[0], hit[1], hit[2] + 1],
    [hit[0], hit[1], hit[2] - 1],
  ];
  const placed = await Promise.all(faces.map((f) => blockAt(f)));
  expect(placed).toContain(before.selectedBlock);
  // The place re-meshes as fast as a break: the chunk mesh is rewritten in place, no growth.
  await expect.poll(async () => (await read()).remeshMs).toBeGreaterThanOrEqual(0);
  const after = await read();
  if (/^desktop-/.test(test.info().project.name)) expect(after.remeshMs).toBeLessThan(50);
  expect(after.growths).toBe(0);
  expect(after.gpuErrors).toBe(0);
  expect(pageErrors()).toEqual([]);
});

test('walking forward for a second moves the player', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const before = await read();
  const moved = (s: VoxelDemoState) =>
    Math.hypot(s.playerPos[0] - before.playerPos[0], s.playerPos[2] - before.playerPos[2]);
  // Held until the player has covered the distance, however slowly the frames come.
  await page.keyboard.down('KeyW');
  await expect.poll(async () => moved(await read())).toBeGreaterThan(0.5);
  await page.keyboard.up('KeyW');
  expect(pageErrors()).toEqual([]);
});

test('?still&time=0.25 parks the day at noon', async ({ page, wrapper }) => {
  await open(page, wrapper, '?still&time=0.25');
  const a = await read();
  expect(a.still).toBe(true);
  expect(a.timeOfDay).toBeCloseTo(0.25, 6);
  await frames(10);
  const b = await read();
  expect(b.timeOfDay).toBeCloseTo(0.25, 6);
  expect(pageErrors()).toEqual([]);
});

test('desktop: runs above 20 fps', async ({ page, wrapper }) => {
  test.skip(!/^desktop-/.test(test.info().project.name), 'desktop rows only');
  await open(page, wrapper);
  await frames(40);
  await expect.poll(async () => (await read()).fps).toBeGreaterThan(20);
  expect(pageErrors()).toEqual([]);
});
