import { describe, expect, it } from 'vitest';
import { mat4 } from '../core/math';
import {
  ALL_LAYERS,
  CAMERA_BLOCK_FLOATS,
  Camera,
  FRUSTUM_FLOATS,
  ORTHO2D_HALF_DEPTH,
} from './camera';

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

describe('Camera.frustum (ws/cull)', () => {
  it('is on for perspective, off for ortho2d, and has six unit planes', () => {
    expect(Camera.perspective(1, 1, 0.1, 100).cull).toBe(true);
    expect(Camera.ortho2d(100, 100).cull).toBe(false);
    const c = Camera.perspective(Math.PI / 2, 1, 1, 100);
    const f = c.frustum;
    expect(f).toHaveLength(FRUSTUM_FLOATS);
    for (let i = 0; i < FRUSTUM_FLOATS; i += 4) {
      expect(Math.hypot(f[i]!, f[i + 1]!, f[i + 2]!)).toBeCloseTo(1, 5);
    }
  });

  it('seesSphere accepts spheres in view and rejects those past any plane', () => {
    const c = Camera.perspective(Math.PI / 2, 1, 1, 100); // looks down -z from the origin
    expect(c.seesSphere(0, 0, -10, 1)).toBe(true);
    expect(c.seesSphere(0, 0, 10, 1)).toBe(false); // behind
    expect(c.seesSphere(0, 0, -0.5, 0.1)).toBe(false); // nearer than near
    expect(c.seesSphere(0, 0, -150, 1)).toBe(false); // past far
    expect(c.seesSphere(-12, 0, -10, 1)).toBe(false); // left of the 90° cone
    expect(c.seesSphere(12, 0, -10, 1)).toBe(false);
    expect(c.seesSphere(0, 12, -10, 1)).toBe(false);
    expect(c.seesSphere(0, -12, -10, 1)).toBe(false);
    // Straddling a plane keeps it: the centre is out, the radius reaches in.
    expect(c.seesSphere(-12, 0, -10, 3)).toBe(true);
    expect(c.seesSphere(0, 0, 10, 20)).toBe(true);
  });

  it('follows the view, is cached, and an infinite far plane never rejects', () => {
    const c = Camera.perspective(Math.PI / 2, 1, 1, 100);
    const a = c.frustum;
    expect(c.frustum).toBe(a);
    const before = Array.from(a);
    c.lookAt([0, 0, 0], [0, 0, 1]); // turn round
    expect(Array.from(c.frustum)).not.toEqual(before);
    expect(c.seesSphere(0, 0, 10, 1)).toBe(true);
    expect(c.seesSphere(0, 0, -10, 1)).toBe(false);
    const inf = Camera.perspective(Math.PI / 2, 1, 1, Number.POSITIVE_INFINITY);
    expect(inf.seesSphere(0, 0, -1e9, 1)).toBe(true);
    const ortho = Camera.ortho2d(100, 100);
    ortho.cull = true;
    expect(ortho.seesSphere(50, 50, 0, 1)).toBe(true);
    expect(ortho.seesSphere(150, 50, 0, 1)).toBe(false);
    expect(ortho.seesSphere(150, 50, 0, 60)).toBe(true);
  });
});

describe('Camera helpers (ws/camera-ergo)', () => {
  /**
   * `cam.invViewProj × cam.viewProjection` is the identity within 1e-5, scaled by the largest
   * inverse entry (the inverse is stored as f32: a design-px ortho2d inverse carries ~1e3).
   */
  function expectInverse(cam: Camera): void {
    const inv = cam.invViewProj;
    let scale = 1;
    for (let i = 0; i < 16; i++) scale = Math.max(scale, Math.abs(inv[i]!));
    const prod = mat4.multiply(mat4.create(), inv, cam.viewProjection);
    const id = mat4.create();
    for (let i = 0; i < 16; i++) expect(Math.abs(prod[i]! - id[i]!)).toBeLessThan(1e-5 * scale);
  }

  it('invViewProj is cached and recomputed after every view or projection setter', () => {
    const c = Camera.ortho2d(1920, 1080);
    const inv = c.invViewProj;
    expect(c.invViewProj).toBe(inv);
    expectInverse(c);
    c.x = 40;
    c.zoom = 1.3;
    c.rotation = 0.2;
    expectInverse(c);
    c.fitRect({ x: 10, y: 10, width: 300, height: 100 });
    expectInverse(c);
    c.fitFreeRect(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 100, y: 0, width: 400, height: 300 },
      { rect: { x: 0, y: 0, width: 960, height: 540 } },
    );
    expectInverse(c);
    c.setView(mat4.lookAt(mat4.create(), [1, 2, 3], [0, 0, 0], [0, 1, 0]));
    expectInverse(c);
    c.setViewMatrix(mat4.lookAt(mat4.create(), [3, 2, 1], [0, 1, 0], [0, 1, 0]));
    expectInverse(c);
    c.setPerspective(1, 1.5, 0.2, 80);
    expectInverse(c);
    c.lookAt([5, 5, 5], [0, 0, 0]);
    expectInverse(c);
    c.setProjection(mat4.perspective(mat4.create(), 0.8, 1, 0.5, 20));
    expectInverse(c);
    c.setOrtho2d(640, 360);
    expectInverse(c);
    expect(c.invViewProj).toBe(inv); // same array throughout
  });

  it('viewZ of a point on the view axis is its distance, positive in front', () => {
    const c = Camera.perspective(1, 1, 0.1, 100).lookAt([0, 0, 10], [0, 0, 0]);
    expect(c.viewZ(0, 0, 3)).toBeCloseTo(7, 5);
    expect(c.viewZ(0, 0, -5)).toBeCloseTo(15, 5);
    expect(c.viewZ(0, 0, 12)).toBeCloseTo(-2, 5); // behind the eye
    c.lookAt([4, 3, 8], [0, 0, 0]);
    expect(c.viewZ(0, 0, 0)).toBeCloseTo(Math.hypot(4, 3, 8), 5);
    expect(c.viewZ(4, 3, 8)).toBeCloseTo(0, 5);
    // ortho2d looks down +z: larger world z is farther from the eye.
    const o = Camera.ortho2d(100, 100);
    expect(o.viewZ(50, 50, 7)).toBeCloseTo(-7, 6);
  });

  it('projectMany matches worldToScreen for 100 random points and counts those inside', () => {
    const c = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 100).lookAt([4, 3, 8], [0, 0, 0]);
    c.screen.width = 1600;
    c.screen.height = 900;
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 0xffffffff;
    };
    const N = 100;
    const pts = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) pts[i] = (rnd() - 0.5) * 60;
    const out = new Float32Array(N * 3);
    const n = c.projectMany(pts, out);
    let expected = 0;
    const p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < N; i++) {
      c.worldToScreen(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!, p);
      expect(out[i * 3]).toBe(Math.fround(p.x));
      expect(out[i * 3 + 1]).toBe(Math.fround(p.y));
      expect(out[i * 3 + 2]).toBe(Math.fround(p.z));
      const front = c.viewZ(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!) > 0;
      if (front && p.x >= 0 && p.x <= 1600 && p.y >= 0 && p.y <= 900 && p.z >= 0 && p.z <= 1)
        expected++;
    }
    expect(n).toBe(expected);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(N);
    // A point behind the eye never counts, even when its mirrored projection lands on screen.
    expect(c.projectMany([8, 6, 16], new Float32Array(3))).toBe(0);
    // Stride and count: the fourth float of each point is skipped; `out` sized for `count`.
    const strided = new Float32Array([0, 0, 0, 99, 1, 0, 0, 99, 0, 0, 50, 99]);
    const so = new Float32Array(6);
    expect(c.projectMany(strided, so, 2, 4)).toBe(2);
    c.worldToScreen(1, 0, 0, p);
    expect(so[3]).toBe(Math.fround(p.x));
  });

  it('frustumCorners puts the near corners at near and the far at far along the view axis', () => {
    const c = Camera.perspective(Math.PI / 2, 16 / 9, 0.5, 60).lookAt([2, 1, 5], [0, 0, 0]);
    const out = new Float32Array(24);
    expect(c.frustumCorners(out)).toBe(out);
    for (let k = 0; k < 4; k++) {
      expect(c.viewZ(out[k * 3]!, out[k * 3 + 1]!, out[k * 3 + 2]!)).toBeCloseTo(0.5, 4);
      const f = 12 + k * 3;
      expect(c.viewZ(out[f]!, out[f + 1]!, out[f + 2]!)).toBeCloseTo(60, 2);
    }
    // Each corner projects back to its clip corner.
    const p = { x: 0, y: 0, z: 0 };
    c.worldToScreen(out[0]!, out[1]!, out[2]!, p); // near bottom-left → screen (0, 1)
    expect(p.x).toBeCloseTo(0, 3);
    expect(p.y).toBeCloseTo(1, 3);
    expect(p.z).toBeCloseTo(0, 4);
    c.worldToScreen(out[18]!, out[19]!, out[20]!, p); // far top-right → screen (1, 0)
    expect(p.x).toBeCloseTo(1, 3);
    expect(p.y).toBeCloseTo(0, 3);
    expect(p.z).toBeCloseTo(1, 4);
    // ortho2d: the near corners sit at world z = -ORTHO2D_HALF_DEPTH over the design rect.
    const o = Camera.ortho2d(1920, 1080).frustumCorners(out);
    expect(o[0]).toBeCloseTo(0, 2);
    expect(o[1]).toBeCloseTo(1080, 2);
    expect(o[2]).toBeCloseTo(-ORTHO2D_HALF_DEPTH, 2);
    expect(o[18]).toBeCloseTo(1920, 2);
    expect(o[19]).toBeCloseTo(0, 2);
    expect(o[20]).toBeCloseTo(ORTHO2D_HALF_DEPTH, 2);
  });

  it('setPerspective configures a default camera like Camera.perspective', () => {
    const a = Camera.perspective(1.1, 1.6, 0.3, 300);
    const b = new Camera().setPerspective(1.1, 1.6, 0.3, 300);
    expect(b.depthTest).toBe(a.depthTest);
    expect(b.depthWrite).toBe(a.depthWrite);
    expect(b.cull).toBe(a.cull);
    expect(b.layers).toBe(a.layers);
    expect([...b.projection]).toEqual([...a.projection]);
    expect([...b.view].map((v) => v + 0)).toEqual([...a.view].map((v) => v + 0));
    expect([...b.viewProjection].map((v) => v + 0)).toEqual(
      [...a.viewProjection].map((v) => v + 0),
    );
    expect(b.screen).toEqual(a.screen);
    // setProjection stays raw: the flags are left alone.
    const raw = Camera.ortho2d(10, 10).setProjection(a.projection);
    expect([raw.depthTest, raw.depthWrite, raw.cull]).toEqual([false, false, false]);
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
