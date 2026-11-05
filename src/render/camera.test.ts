import { describe, expect, it } from 'vitest';
import { mat4 } from '../core/math';
import { ALL_LAYERS, CAMERA_BLOCK_FLOATS, Camera, ORTHO2D_HALF_DEPTH } from './camera';

/** The renderer's pre-matrix-camera viewProj, verbatim: the 2D path must match it bit for bit. */
function legacyViewProj(
  W: number,
  H: number,
  cam: { x: number; y: number; zoom: number; rotation: number },
) {
  const g = new Float32Array(16);
  const sx = 2 / W;
  const sy = 2 / H;
  const c = Math.cos(-cam.rotation) * cam.zoom;
  const s = Math.sin(-cam.rotation) * cam.zoom;
  const cx = W / 2 + cam.x;
  const cy = H / 2 + cam.y;
  g[0] = c * sx;
  g[1] = -s * sy;
  g[4] = -s * sx;
  g[5] = -c * sy;
  g[10] = 1 / 2048; // the legacy matrix had z pass through (1, 0); only the depth row widened
  g[12] = -c * sx * cx + s * sx * cy;
  g[13] = s * sy * cx + c * sy * cy;
  g[14] = 0.5;
  g[15] = 1;
  return g;
}

describe('Camera.ortho2d', () => {
  it('defaults: identity view, design space as screen, no depth, every layer', () => {
    const c = Camera.ortho2d(1920, 1080);
    expect([...c.view].map((v) => v + 0)).toEqual([...mat4.create()]);
    expect(c.depthTest).toBe(false);
    expect(c.depthWrite).toBe(false);
    expect(c.layers).toBe(ALL_LAYERS);
    expect(c.screen).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect([c.x, c.y, c.zoom, c.rotation]).toEqual([0, 0, 1, 0]);
  });

  it('matches the legacy 2D viewProj bit for bit, and equals proj × view', () => {
    const c = Camera.ortho2d(1920, 1080);
    for (const s of [
      { x: 0, y: 0, zoom: 1, rotation: 0 },
      { x: 120, y: -40, zoom: 1.5, rotation: 0 },
      { x: -13.7, y: 9.1, zoom: 0.8, rotation: 0.3 },
    ]) {
      Object.assign(c, s);
      expect([...c.viewProjection]).toEqual([...legacyViewProj(1920, 1080, s)]);
      const pv = mat4.multiply(mat4.create(), c.projection, c.view);
      for (let i = 0; i < 16; i++) expect(pv[i]!).toBeCloseTo(c.viewProjection[i]!, 6);
    }
  });

  it('spans world z in ±ORTHO2D_HALF_DEPTH, z = 0 at clip depth 0.5, larger z farther', () => {
    const c = Camera.ortho2d(1920, 1080);
    expect(ORTHO2D_HALF_DEPTH).toBe(1024);
    expect(c.worldToScreen(5, 5, -ORTHO2D_HALF_DEPTH).z).toBeCloseTo(0, 6);
    expect(c.worldToScreen(5, 5, 0).z).toBeCloseTo(0.5, 6);
    expect(c.worldToScreen(5, 5, ORTHO2D_HALF_DEPTH).z).toBeCloseTo(1, 6);
    expect(c.worldToScreen(5, 5, 100).z).toBeGreaterThan(c.worldToScreen(5, 5, -100).z);
    // x/y do not depend on z, and pan/zoom do not touch the depth mapping.
    c.x = 30;
    c.zoom = 1.7;
    const a = c.worldToScreen(300, 200, -900);
    const b = c.worldToScreen(300, 200, 900);
    expect([a.x, a.y]).toEqual([b.x, b.y]);
    expect(c.screenToWorld(10, 10, 0).z).toBeCloseTo(-ORTHO2D_HALF_DEPTH, 3);
    expect(c.screenToWorld(10, 10, 1).z).toBeCloseTo(ORTHO2D_HALF_DEPTH, 3);
  });

  it('maps world to screen 1:1 at rest (origin top-left, y down)', () => {
    const c = Camera.ortho2d(1920, 1080);
    expect(c.worldToScreen(0, 0)).toEqual({ x: 0, y: 0, z: 0.5 });
    const p = c.worldToScreen(1920, 1080);
    expect(p.x).toBeCloseTo(1920, 3);
    expect(p.y).toBeCloseTo(1080, 3);
  });

  it('round-trips worldToScreen and screenToWorld under pan, zoom and rotation', () => {
    const c = Camera.ortho2d(1920, 1080);
    c.x = 200;
    c.y = -50;
    c.zoom = 2;
    c.rotation = 0.4;
    const out = { x: 0, y: 0, z: 0 };
    for (const [x, y] of [
      [0, 0],
      [960, 540],
      [1500, 80],
    ] as const) {
      const s = c.worldToScreen(x, y, 0, out);
      const w = c.screenToWorld(s.x, s.y, s.z);
      expect(w.x).toBeCloseTo(x, 2);
      expect(w.y).toBeCloseTo(y, 2);
      expect(w.z).toBeCloseTo(0, 3);
    }
    // The pan target sits on the screen centre.
    const centre = c.worldToScreen(960 + 200, 540 - 50);
    expect(centre.x).toBeCloseTo(960, 3);
    expect(centre.y).toBeCloseTo(540, 3);
  });

  it('caches matrices and invalidates them on change', () => {
    const c = Camera.ortho2d(100, 100);
    const vp = c.viewProjection;
    const before = vp[12];
    expect(c.viewProjection).toBe(vp); // same array, no reallocation
    c.x = 10;
    expect(c.viewProjection).toBe(vp);
    expect(vp[12]).not.toBe(before);
    expect(c.screenToWorld(50, 50).x).toBeCloseTo(60, 4);
  });

  it('fitRect frames a world rect into a viewport, contained and centred', () => {
    const c = Camera.ortho2d(1920, 1080);
    c.rotation = 1;
    c.fitRect(
      { x: 100, y: 100, width: 400, height: 200 },
      { x: 960, y: 0, width: 960, height: 1080 },
    );
    expect(c.rotation).toBe(0);
    expect(c.zoom).toBeCloseTo(2.4); // min(960/400, 1080/200)
    const tl = c.worldToScreen(100, 100);
    const br = c.worldToScreen(500, 300);
    expect(tl.x).toBeCloseTo(960, 2);
    expect(br.x).toBeCloseTo(1920, 2);
    expect((tl.y + br.y) / 2).toBeCloseTo(540, 2);
    // Default viewport: the whole screen.
    c.fitRect({ x: 0, y: 0, width: 1920, height: 1080 });
    expect([c.x, c.y, c.zoom]).toEqual([0, 0, 1]);
  });

  it('fitRect honours a screen in other units', () => {
    const c = Camera.ortho2d(1920, 1080);
    Object.assign(c.screen, { x: 0, y: 0, width: 960, height: 540 }); // e.g. CSS px
    c.fitRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 270, height: 270 });
    const br = c.worldToScreen(100, 100);
    expect(br.x).toBeCloseTo(270, 2);
    expect(br.y).toBeCloseTo(270, 2);
  });

  it('fitFreeRect converts a CSS-px free rect through the surface rect into screen units', () => {
    const c = Camera.ortho2d(1920, 1080);
    // The canvas sits at (10, 20) and is half design size in CSS px; the HUD leaves the right half.
    const surface = { rect: { x: 10, y: 20, width: 960, height: 540 } };
    const free = { x: 490, y: 20, width: 480, height: 540 };
    c.fitFreeRect({ x: 100, y: 100, width: 400, height: 200 }, free, surface);
    // Same result as fitRect with the right half of the screen in design px.
    const d = Camera.ortho2d(1920, 1080).fitRect(
      { x: 100, y: 100, width: 400, height: 200 },
      { x: 960, y: 0, width: 960, height: 1080 },
    );
    expect([c.x, c.y, c.zoom]).toEqual([d.x, d.y, d.zoom]);
    expect(c.worldToScreen(100, 100).x).toBeCloseTo(960, 2);
  });

  it('fitFreeRect ignores an empty free rect or surface', () => {
    const c = Camera.ortho2d(1920, 1080);
    c.zoom = 3;
    c.fitFreeRect(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 100 },
      {
        rect: { x: 0, y: 0, width: 960, height: 540 },
      },
    );
    c.fitFreeRect(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 100, height: 100 },
      {
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    );
    expect(c.zoom).toBe(3);
  });

  it('fitRect needs the 2D preset', () => {
    const c = Camera.perspective(1, 1, 0.1, 10);
    expect(() => c.fitRect({ x: 0, y: 0, width: 1, height: 1 })).toThrow(/ortho2d/);
  });
});

describe('Camera.perspective', () => {
  it('turns depth on and round-trips through lookAt', () => {
    const c = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 100);
    expect(c.depthTest).toBe(true);
    expect(c.depthWrite).toBe(true);
    c.lookAt([4, 3, 8], [0, 0, 0]);
    c.screen.width = 1600;
    c.screen.height = 900;
    const centre = c.worldToScreen(0, 0, 0);
    expect(centre.x).toBeCloseTo(800, 2);
    expect(centre.y).toBeCloseTo(450, 2);
    expect(centre.z).toBeGreaterThan(0);
    expect(centre.z).toBeLessThan(1);
    for (const p of [
      [1, 2, -1],
      [-2, 0.5, 1],
    ] as const) {
      const s = c.worldToScreen(p[0], p[1], p[2]);
      const w = c.screenToWorld(s.x, s.y, s.z);
      expect(w.x).toBeCloseTo(p[0], 3);
      expect(w.y).toBeCloseTo(p[1], 3);
      expect(w.z).toBeCloseTo(p[2], 3);
    }
    expect([...c.position].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([4, 3, 8]);
  });

  it('screenToWorld at depth 0 and 1 gives a ray through the point', () => {
    const c = Camera.perspective(Math.PI / 2, 1, 1, 100);
    const near = c.screenToWorld(0.5, 0.5, 0);
    const far = c.screenToWorld(0.5, 0.5, 1);
    expect(near.x).toBeCloseTo(0, 4);
    expect(near.y).toBeCloseTo(0, 4);
    expect(near.z).toBeCloseTo(-1, 4);
    expect(far.z).toBeCloseTo(-100, 1);
  });

  it('setView switches off the 2D controls until setOrtho2d', () => {
    const c = Camera.ortho2d(100, 100);
    c.setView(mat4.view2d(mat4.create(), 0, 0, 2, 0, 100, 100));
    c.x = 30; // ignored by the custom view
    expect(c.worldToScreen(50, 50).x).toBeCloseTo(50, 4);
    expect(c.worldToScreen(60, 50).x).toBeCloseTo(70, 4);
    c.setOrtho2d(100, 100);
    expect(c.worldToScreen(80, 50).x).toBeCloseTo(50, 4);
  });
});

describe('Camera layers and block', () => {
  it('sees draws whose mask overlaps', () => {
    const c = Camera.ortho2d(1, 1);
    expect(c.sees(1 << 31)).toBe(true);
    c.layers = 0b0101;
    expect(c.sees(0b0100)).toBe(true);
    expect(c.sees(0b1010)).toBe(false);
  });

  it('writes view, proj, view_proj, camera_pos, viewport and view_index', () => {
    const c = Camera.perspective(1, 1, 0.5, 50).lookAt([1, 2, 3], [0, 0, 0]);
    const f = new Float32Array(8 + CAMERA_BLOCK_FLOATS).fill(-1);
    const u = new Uint32Array(f.buffer);
    c.writeBlock(f, u, 8, { x: 0, y: 0, width: 640, height: 360 }, 1);
    expect([...f.subarray(8, 24)]).toEqual([...c.view]);
    expect([...f.subarray(24, 40)]).toEqual([...c.projection]);
    expect([...f.subarray(40, 56)]).toEqual([...c.viewProjection]);
    expect([...f.subarray(56, 60)].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([1, 2, 3, 1]);
    expect([...f.subarray(60, 64)]).toEqual([0, 0, 640, 360]);
    expect(u[64]).toBe(1);
    expect(f[0]).toBe(-1); // nothing before the offset
  });

  it("view_index defaults to the camera's viewIndex (0), which a stereo eye sets", () => {
    const c = Camera.perspective(1, 1, 0.5, 50);
    const f = new Float32Array(CAMERA_BLOCK_FLOATS);
    const u = new Uint32Array(f.buffer);
    c.writeBlock(f, u, 0, { x: 0, y: 0, width: 1, height: 1 });
    expect(u[56]).toBe(0);
    c.viewIndex = 1;
    c.writeBlock(f, u, 0, { x: 0, y: 0, width: 1, height: 1 });
    expect(u[56]).toBe(1);
  });
});
