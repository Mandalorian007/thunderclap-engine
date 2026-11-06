/**
 * The depth post page (harness/depth-post.html, ws/post-depth) on every matrix row:
 *
 * - with AO and DoF on the stack is handed the scene depth and records the AO and DoF passes;
 *   `?ao=0` / `?dof=0` drop each pass, and `?ao=0&dof=0` records none;
 * - AO: ground at the foot of the far block is darker with AO on than off;
 * - DoF: two far-ground patches across a checker edge differ less with DoF on than off;
 * - with both off the stack's output matches mesh.html's near and far probes within tolerance.
 *
 * Pixels are sampled from screenshots (no golden image); the scene is still, so values are
 * compared across page loads, polled for readiness per E-017.
 */
import type { Frame, Page } from '@playwright/test';
import type { DepthPostProbe, HarnessDepthPostState } from '../harness/depth-post-state';
import type { HarnessMeshState } from '../harness/mesh-state';
import { expect, harnessFrame, test } from './fixtures';
import { HARNESS_URL, WRAPPER_URL } from './ports';

interface Pt {
  x: number;
  y: number;
}
type Rgb = [number, number, number];

let frame: Frame;
const errors: string[] = [];

async function openPage(page: Page, wrapper: string, file: string): Promise<void> {
  errors.length = 0;
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (wrapper === 'top') {
    await page.goto(`${HARNESS_URL}${file}`);
    frame = page.mainFrame();
  } else {
    await page.goto(`${WRAPPER_URL}?page=${encodeURIComponent(file)}`);
    frame = await harnessFrame(page);
  }
}

async function open(page: Page, wrapper: string, query = ''): Promise<HarnessDepthPostState> {
  await openPage(page, wrapper, `depth-post.html${query}`);
  await expect
    .poll(async () => {
      const s = await read().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`depth post: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return read();
}

async function openMesh(page: Page, wrapper: string): Promise<HarnessMeshState> {
  await openPage(page, wrapper, 'mesh.html');
  const readMesh = () =>
    frame.evaluate(() => {
      const s = window.__harnessMesh?.state;
      if (!s) throw new Error('window.__harnessMesh missing');
      return JSON.parse(JSON.stringify(s)) as HarnessMeshState;
    });
  await expect
    .poll(async () => {
      const s = await readMesh().catch(() => null);
      if (s?.ready && s.gpu !== 'ok') throw new Error(`mesh demo: ${s.gpu}`);
      return s?.ready ? s.frames : -1;
    })
    .toBeGreaterThanOrEqual(5);
  return readMesh();
}

function read(): Promise<HarnessDepthPostState> {
  return frame.evaluate(() => {
    const s = window.__harnessDepthPost?.state;
    if (!s) throw new Error('window.__harnessDepthPost missing');
    return JSON.parse(JSON.stringify(s)) as HarnessDepthPostState;
  });
}

/** Logical canvas px to page CSS px. */
async function toPage(p: DepthPostProbe, logical: { width: number; height: number }): Promise<Pt> {
  const box = await frame.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return {
    x: box.x + (p.x / logical.width) * box.width,
    y: box.y + (p.y / logical.height) * box.height,
  };
}

/** Average colour of the 3×3 CSS px around each page point, from a screenshot of the page. */
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

const sum = (c: Rgb) => c[0] + c[1] + c[2];
const diff = (a: Rgb, b: Rgb) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

async function probes(
  page: Page,
  s: HarnessDepthPostState,
  names: (keyof HarnessDepthPostState['probes'])[],
): Promise<Rgb[]> {
  const pts: Pt[] = [];
  for (const n of names) pts.push(await toPage(s.probes[n], s.logical));
  return sample(page, pts);
}

test('the stack gets the depth and records the AO and DoF passes; the query drops each', async ({
  page,
  wrapper,
}) => {
  const both = await open(page, wrapper);
  expect(both.depth).toBe(true);
  expect(both).toMatchObject({ aoEnabled: true, dofEnabled: true });
  expect(both.passes).toEqual(['post-ao', 'post-ao-blur', 'post-dof', 'post-composite']);
  expect(both.gpuErrors).toBe(0);

  const noAo = await open(page, wrapper, '?ao=0');
  expect(noAo).toMatchObject({ aoEnabled: false, dofEnabled: true });
  expect(noAo.passes).toEqual(['post-dof', 'post-composite']);

  const noDof = await open(page, wrapper, '?dof=0');
  expect(noDof).toMatchObject({ aoEnabled: true, dofEnabled: false });
  expect(noDof.passes).toEqual(['post-ao', 'post-ao-blur', 'post-composite']);

  const none = await open(page, wrapper, '?ao=0&dof=0');
  expect(none.depth).toBe(true);
  expect(none.passes).toEqual(['post-composite']);
  expect(none.gpuErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('ambient occlusion darkens the crease at the foot of the far block', async ({
  page,
  wrapper,
}) => {
  const on = await open(page, wrapper, '?dof=0');
  const [creaseOn, groundOn] = await probes(page, on, ['crease', 'ground']);
  const off = await open(page, wrapper, '?ao=0&dof=0');
  const [creaseOff, groundOff] = await probes(page, off, ['crease', 'ground']);
  // The crease lost light; open ground away from any wall did not (within sampling noise).
  expect(sum(creaseOn!), `crease on ${creaseOn} off ${creaseOff}`).toBeLessThan(
    sum(creaseOff!) * 0.92,
  );
  expect(diff(groundOn!, groundOff!), `ground on ${groundOn} off ${groundOff}`).toBeLessThan(24);
  expect(errors).toEqual([]);
});

test('depth of field lowers the local contrast of the far ground', async ({ page, wrapper }) => {
  const off = await open(page, wrapper, '?ao=0&dof=0');
  const [aOff, bOff, nearOff] = await probes(page, off, ['farGroundA', 'farGroundB', 'near']);
  const on = await open(page, wrapper, '?ao=0');
  const [aOn, bOn, nearOn] = await probes(page, on, ['farGroundA', 'farGroundB', 'near']);
  const contrastOff = diff(aOff!, bOff!);
  const contrastOn = diff(aOn!, bOn!);
  // The checker edge is visible when sharp, and softer when blurred.
  expect(contrastOff, `off ${aOff} / ${bOff}`).toBeGreaterThan(12);
  expect(contrastOn, `on ${aOn} / ${bOn} (off ${contrastOff})`).toBeLessThan(contrastOff * 0.7);
  // The near block is in focus: unchanged.
  expect(diff(nearOn!, nearOff!), `near on ${nearOn} off ${nearOff}`).toBeLessThan(24);
  expect(errors).toEqual([]);
});

test('with both passes off the stack matches the mesh page', async ({ page, wrapper }) => {
  const s = await open(page, wrapper, '?ao=0&dof=0');
  const [near, far] = await probes(page, s, ['near', 'far']);
  const m = await openMesh(page, wrapper);
  const [meshNear, meshFar] = await sample(page, [
    await toPage(m.probes.near, m.logical),
    await toPage(m.probes.far, m.logical),
  ]);
  // Same probes, same colours: red in front, blue above (the mesh page's lamp moves, so the
  // near face's light differs a little between the pages).
  expect(near![0], `near ${near}`).toBeGreaterThan(near![2] + 40);
  expect(far![2], `far ${far}`).toBeGreaterThan(far![0] + 40);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(near![i]! - meshNear![i]!), `near ${near} mesh ${meshNear}`).toBeLessThan(70);
    expect(Math.abs(far![i]! - meshFar![i]!), `far ${far} mesh ${meshFar}`).toBeLessThan(70);
  }
  expect(errors).toEqual([]);
});
