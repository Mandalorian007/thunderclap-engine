/**
 * The mesh demo (harness/mesh.html) on every matrix row: the Phase 3 seams together (E-001).
 *
 * - the page boots WebGPU, draws a perspective scene with depth on and logs no error;
 * - occlusion: a near block stays in front of a taller block drawn after it and behind it
 *   (pixels sampled from a screenshot, no golden image), and the ground renders;
 * - orbit: a pointer drag (mouse, or touch through CDP) and the right stick move the camera;
 *   the triggers zoom.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessMeshState, MeshProbe } from '../harness/mesh-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}
type Rgb = [number, number, number];

let frame: Frame;
let touch = false;
const errors: string[] = [];

async function open(page: Page, wrapper: string): Promise<void> {
  touch = test.info().project.use.hasTouch === true;
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}mesh.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('mesh.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`mesh demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessMeshState> {
  return frame.evaluate(() => {
    const s = window.__harnessMesh?.state;
    if (!s) throw new Error('window.__harnessMesh missing');
    return JSON.parse(JSON.stringify(s)) as HarnessMeshState;
  });
}

function setPad(axes: number[], pressed: number[]): Promise<void> {
  return frame.evaluate(([a, p]) => window.__harnessMesh?.setPad(a, p), [axes, pressed] as const);
}

async function frames(n: number): Promise<void> {
  const start = (await read()).frames;
  await expect.poll(async () => (await read()).frames).toBeGreaterThanOrEqual(start + n);
}

/** The canvas box in page CSS px. */
async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** Logical canvas px to page CSS px. */
async function toPage(p: MeshProbe): Promise<Pt> {
  const box = await canvasBox();
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/**
 * Average colour of the 3×3 CSS px around each page point, from a screenshot of the page (so
 * what the swapchain presented, after the engine's tonemap), decoded by the browser itself.
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

/** Drag the primary pointer from `from` by (dx, dy) in CSS px: mouse, or a touch through CDP. */
async function drag(page: Page, from: Pt, dx: number, dy: number): Promise<void> {
  const steps = 8;
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    const at = (k: number) => ({
      x: from.x + (dx * k) / steps,
      y: from.y + (dy * k) / steps,
      id: 1,
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)] });
    for (let k = 1; k <= steps; k++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(k)] });
      await frames(1);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return;
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await frames(1);
  await page.mouse.up();
}

test('boots a perspective scene with depth, and a near block occludes a far one', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  const s = await read();
  expect(s.depth).toEqual({ test: true, write: true });
  expect(s.stats.instances).toBe(5);
  // The five instances share one material and two meshes; the depth sort keeps batching.
  expect(s.stats.drawCalls).toBeLessThanOrEqual(5);
  expect(s.gpuErrors).toBe(0);

  const [near, far, ground] = await sample(page, [
    await toPage(s.probes.near),
    await toPage(s.probes.far),
    await toPage(s.probes.ground),
  ]);
  // The near block is red; the taller blue block behind it was drawn later and lost the depth test.
  expect(near![0], `near ${near}`).toBeGreaterThan(near![2] + 40);
  expect(near![0]).toBeGreaterThan(near![1] + 40);
  // Above the near block the far block shows: blue.
  expect(far![2], `far ${far}`).toBeGreaterThan(far![0] + 40);
  // The lit ground is neither the sky (dark blue) nor a block.
  expect(ground![1], `ground ${ground}`).toBeGreaterThan(ground![2]);
  expect(ground![0] + ground![1] + ground![2]).toBeGreaterThan(120);
  expect(errors).toEqual([]);
});

test('a pointer drag orbits the camera', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const before = await read();
  const box = await canvasBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const dx = Math.round(box.width * 0.2);
  await drag(page, centre, dx, 0);
  const after = await read();
  // The view turns the way the pointer went (a drag right orbits the camera left: yaw falls).
  expect(after.camera.yaw).toBeLessThan(before.camera.yaw - 0.3);
  expect(after.camera.pitch).toBeCloseTo(before.camera.pitch, 1);
  // The eye moved; the probes moved with it.
  expect(Math.abs(after.camera.eye[0] - before.camera.eye[0])).toBeGreaterThan(1);
  expect(Math.abs(after.probes.near.x - before.probes.near.x)).toBeGreaterThan(10);
  // A vertical drag pitches.
  await drag(page, centre, 0, Math.round(box.height * 0.15));
  expect((await read()).camera.pitch).toBeGreaterThan(after.camera.pitch + 0.1);
  expect(errors).toEqual([]);
});

test('the right stick orbits and the triggers zoom', async ({ page, wrapper }) => {
  await open(page, wrapper);
  const before = await read();
  await setPad([0, 0, 1, 0], []);
  await expect.poll(async () => (await read()).camera.yaw).toBeLessThan(before.camera.yaw - 0.3);
  await setPad([0, 0, 0, -1], []);
  await expect
    .poll(async () => (await read()).camera.pitch)
    .toBeLessThan(before.camera.pitch - 0.05);
  await setPad([0, 0, 0, 0], []);
  await frames(2);
  const turned = await read();
  // Right trigger zooms in; left trigger zooms out.
  await setPad([0, 0, 0, 0], [7]);
  await expect
    .poll(async () => (await read()).camera.distance)
    .toBeLessThan(turned.camera.distance - 1);
  await setPad([0, 0, 0, 0], [6]);
  await expect
    .poll(async () => (await read()).camera.distance)
    .toBeGreaterThan(turned.camera.distance);
  await setPad([0, 0, 0, 0], []);
  const s = await read();
  expect(s.zoom.in).toBeGreaterThan(0);
  expect(s.zoom.out).toBeGreaterThan(0);
  // The stick never changed the distance, and the triggers never turned the camera.
  expect(turned.camera.distance).toBeCloseTo(before.camera.distance, 5);
  expect(s.camera.yaw).toBeCloseTo(turned.camera.yaw, 5);
  expect(errors).toEqual([]);
});

test('the wheel zooms', async ({ page, wrapper }) => {
  test.skip(touch, 'no wheel on a touch row');
  await open(page, wrapper);
  const before = await read();
  const box = await canvasBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await read()).zoom.in).toBeGreaterThan(0);
  await expect
    .poll(async () => (await read()).camera.distance)
    .toBeLessThan(before.camera.distance);
  expect(errors).toEqual([]);
});
