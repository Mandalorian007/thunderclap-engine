/**
 * The skinning demo (harness/skin.html) on every matrix row:
 *
 * - the page boots WebGPU, draws two skinned tubes from one palette next to a lit, shadowed
 *   scene, and logs no error;
 * - the tubes move: the tip probe (a point under the top of the first tube, placed by the same
 *   joint matrices the GPU reads) travels across the screen, and the pixel where the tip was
 *   changes colour one second later, while the foot of the tube, held by joint 0, stays put.
 */
import type { Frame, Page } from '@playwright/test';
import type { HarnessSkinState, SkinProbe } from '../harness/skin-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}
type Rgb = [number, number, number];

let frame: Frame;
const errors: string[] = [];

async function open(page: Page, wrapper: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}skin.html`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent('skin.html')}`);
    frame = await harnessFrame(page);
  }
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`skin demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
}

function read(): Promise<HarnessSkinState> {
  return frame.evaluate(() => {
    const s = window.__harnessSkin?.state;
    if (!s) throw new Error('window.__harnessSkin missing');
    return JSON.parse(JSON.stringify(s)) as HarnessSkinState;
  });
}

/** The canvas box in page CSS px. */
async function canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

/** Logical canvas px to page CSS px. */
async function toPage(p: SkinProbe): Promise<Pt> {
  const box = await canvasBox();
  const { logical } = await read();
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/**
 * A screenshot of the page (what the swapchain presented) bracketed by two reads, kept once the
 * tip probe moved under 8 logical px across it (so the pixels and the second read's probes are
 * one pose) and `ok` holds for both reads. A starved runner's screenshot can take 500 ms, a
 * sixth of a radian of sway. Retries for up to 12 s, then fails.
 */
async function snapshot(
  page: Page,
  ok: (s: HarnessSkinState) => boolean = () => true,
): Promise<{ png: string; s: HarnessSkinState }> {
  const deadline = Date.now() + 12_000;
  let last = '';
  while (Date.now() < deadline) {
    const before = await read();
    if (!ok(before)) continue;
    const png = (await page.screenshot({ scale: 'css', animations: 'disabled' })).toString(
      'base64',
    );
    const s = await read();
    const drift = Math.hypot(
      s.probes.tip.x - before.probes.tip.x,
      s.probes.tip.y - before.probes.tip.y,
    );
    if (drift < 8 && ok(s)) return { png, s };
    last = `drift ${drift.toFixed(1)} px, sway ${before.sway.toFixed(2)} -> ${s.sway.toFixed(2)}`;
  }
  throw new Error(`no settled screenshot in 12 s (last: ${last})`);
}

/** Average colour of the 3×3 CSS px around each page point of a `snapshot`'s screenshot. */
async function pixels(page: Page, png: string, points: Pt[]): Promise<Rgb[]> {
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
    [png, points] as const,
  );
}

const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('boots two skinned tubes from one palette in a lit, shadowed scene', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  // Sample near full bend, where the tip moves slowest between the screenshot and the read.
  await expect
    .poll(async () => Math.abs((await read()).sway), { intervals: [60], timeout: 12_000 })
    .toBeGreaterThan(0.7);
  const { png, s } = await snapshot(page, (s) => Math.abs(s.sway) > 0.7);
  expect(s.gpuErrors).toBe(0);
  // Ground, a shadow-casting block and two tubes (one skinned material, one palette).
  expect(s.stats.instances).toBe(4);
  expect(s.skin).toEqual({ joints: 3, instances: 2, tubes: 2 });
  expect(s.shadow).toEqual({ enabled: true, size: 2048 });
  const [tip, ground] = await pixels(page, png, [
    await toPage(s.probes.tip),
    await toPage(s.probes.ground),
  ]);
  // The first tube is orange: the tip probe, placed by the CPU copy of the joint matrices,
  // lands on the GPU-skinned tube (red well above blue; not the dark blue sky).
  expect(tip![0], `tip ${tip}`).toBeGreaterThan(tip![2] + 60);
  expect(tip![0]).toBeGreaterThan(100);
  // The lit ground is neither the sky nor a tube.
  expect(ground![1], `ground ${ground}`).toBeGreaterThan(ground![2]);
  expect(ground![0] + ground![1] + ground![2]).toBeGreaterThan(120);
  expect(errors).toEqual([]);
});

test('the joints sway the tube: the tip probe moves and its old pixel changes colour after one second', async ({
  page,
  wrapper,
}) => {
  await open(page, wrapper);
  // Start from a frame with the first tube near upright: the sway is an eighth of a cycle per
  // second, so one second later |sway| is at least sin(π/4 - 0.3) even after a slow screenshot.
  // Poll faster than the default back-off (which settles at 1 s and could keep sampling the
  // same phases).
  await expect
    .poll(async () => Math.abs((await read()).sway), { intervals: [60], timeout: 12_000 })
    .toBeLessThan(0.3);
  const { png: pngA, s: a } = await snapshot(page, (s) => Math.abs(s.sway) < 0.3);
  const tipA = await toPage(a.probes.tip);
  const [colourA] = await pixels(page, pngA, [tipA]);
  // One second of animation time, measured by the page's own clock.
  await expect
    .poll(async () => (await read()).time, { intervals: [60] })
    .toBeGreaterThanOrEqual(a.time + 1);
  const { png: pngB, s: b } = await snapshot(page);
  expect(b.frames).toBeGreaterThan(a.frames);
  expect(Math.abs(b.sway), `sway ${a.sway} -> ${b.sway}`).toBeGreaterThan(0.4);
  // The tip travelled (logical px) and its world position changed; the foot stayed.
  const moved = Math.hypot(b.probes.tip.x - a.probes.tip.x, b.probes.tip.y - a.probes.tip.y);
  expect(
    moved,
    `tip ${JSON.stringify(a.probes.tip)} -> ${JSON.stringify(b.probes.tip)}`,
  ).toBeGreaterThan(60);
  expect(b.tipWorld).not.toEqual(a.tipWorld);
  expect(Math.abs(b.probes.base.x - a.probes.base.x)).toBeLessThan(2);
  expect(Math.abs(b.probes.base.y - a.probes.base.y)).toBeLessThan(2);
  // Where the tip was is now something else (sky, ground or the tube's side), and where the
  // tip is now is orange again.
  const [colourOld, colourNew] = await pixels(page, pngB, [tipA, await toPage(b.probes.tip)]);
  expect(dist(colourOld!, colourA!), `then ${colourA} now ${colourOld}`).toBeGreaterThan(40);
  expect(colourNew![0], `new tip ${colourNew}`).toBeGreaterThan(colourNew![2] + 60);
  expect(b.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});
