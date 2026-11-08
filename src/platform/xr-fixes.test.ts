/**
 * VR correctness (ws/xr-fixes, E-038) on the fake XR stack and the fake GPU: the head frustum is
 * the union of the eyes', the eye cameras cull, a frame that throws or has no views leaves the
 * renderer ready for the next one without rendering the page target, adopting a cycling layer
 * texture allocates nothing once warm, and auto exposure adapts once per frame across the eyes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PostStack } from '../post/post-stack';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import type { MaterialDesc } from '../render/material';
import { VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from '../render/mesh';
import { Renderer } from '../render/renderer';
import { Transform } from '../render/transform';
import { type FakeXr, type FakeXrOptions, type FakeXrSession, installFakeXr } from './xr-fake';
import { XrSurface, type XrSurfaceOptions } from './xr-surface';

let xr: FakeXr | null = null;

afterEach(() => {
  xr?.uninstall();
  xr = null;
});

async function setup(opts: Partial<XrSurfaceOptions> = {}, fakeOpts: FakeXrOptions = {}) {
  xr = installFakeXr(fakeOpts);
  const fake: FakeDevice = createFakeDevice();
  const session = (await xr.system.requestSession('immersive-vr')) as FakeXrSession;
  const referenceSpace = await session.requestReferenceSpace('local-floor');
  const surface = new XrSurface(session, fake.device, { referenceSpace, ...opts });
  return { fake, session, surface, xr };
}

const WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> u: vec4f;
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = u; o.emissive = u; return o; }`;
const OPAQUE: MaterialDesc = { label: 'o', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' };

/** Headset-like off-axis eyes: wider toward the eye's own side than toward the nose. */
const FOV = { outer: 1.2, inner: 0.8, up: 1, down: 1.1 };

describe('XrSurface head frustum (ws/xr-fixes)', () => {
  it('contains every point either eye sees, including the right eye’s outer edge', async () => {
    const { surface, xr } = await setup({}, { fov: FOV });
    const [l, r] = surface.views(xr.step()) as [
      ReturnType<XrSurface['views']>[0],
      ReturnType<XrSurface['views']>[0],
    ];
    const head = surface.head;
    // A point 2 m ahead near the right eye's outer edge: the right eye sees it, the left eye's
    // projection (what `head` used to take) does not.
    const half = 0.032;
    const p: [number, number, number] = [half + FOV.outer * 2 - 0.05, 1.6, -2];
    expect(r.camera.seesSphere(...p, 0)).toBe(true);
    expect(l.camera.seesSphere(...p, 0)).toBe(false);
    expect(head.seesSphere(...p, 0)).toBe(true);
    // Sampled: everything inside either eye's frustum is inside the head's.
    let inside = 0;
    for (let z = -0.2; z >= -60; z *= 1.6) {
      for (let x = -3; x <= 3; x += 0.05) {
        for (let y = -3; y <= 3; y += 0.25) {
          const d = -z;
          const px = x * d;
          const py = 1.6 + y * d;
          if (l.camera.seesSphere(px, py, z, 0) || r.camera.seesSphere(px, py, z, 0)) {
            inside++;
            expect(head.seesSphere(px, py, z, 1e-4)).toBe(true);
          }
        }
      }
    }
    expect(inside).toBeGreaterThan(1000);
    // Not much wider than the eyes: a point well outside both is still culled.
    expect(head.seesSphere(half + FOV.outer * 2 + 0.5, 1.6, -2, 0)).toBe(false);
  });

  it('keeps the head at the viewer pose (the pull-back lives in the projection)', async () => {
    const { session, surface, xr } = await setup({}, { fov: FOV });
    session.headPosition = [1, 1.7, -2];
    surface.views(xr.step());
    const pos = surface.head.position;
    expect(pos[0]).toBeCloseTo(1);
    expect(pos[1]).toBeCloseTo(1.7);
    expect(pos[2]).toBeCloseTo(-2);
    // Symmetric eyes too: points just inside each eye's outer edge are inside the head's.
    const sym = await setup();
    const eyes = sym.surface.views(sym.xr.step());
    const h = sym.surface.head;
    for (const z of [-0.15, -1, -20]) {
      for (const e of eyes) {
        const ex = e.camera.position[0]!;
        const edge = ex + Math.sign(ex) * 0.999 * -z;
        expect(e.camera.seesSphere(edge, 1.6, z, 0)).toBe(true);
        expect(h.seesSphere(edge, 1.6, z, 0)).toBe(true);
      }
    }
  });
});

describe('XR culling (ws/xr-fixes)', () => {
  it('eye cameras cull, so a draw outside both eyes is skipped', async () => {
    const { fake, surface, xr } = await setup({ scene: true, colorFormat: 'bgra8unorm' });
    const r = new Renderer(fakeRendererGpu(fake));
    const cube = r.createMesh({
      vertices: new Float32Array(VERTEX3D_FLOATS * 3),
      indices: new Uint16Array([0, 1, 2]),
      layout: VERTEX_LAYOUT_3D,
      bounds: { center: [0, 0, 0], radius: 0.5 },
      label: 'cube',
    });
    const mat = r.createMaterial(OPAQUE);
    const ahead = new Transform({ x: 0, y: 1.6, z: -3 });
    const behind = new Transform({ x: 0, y: 1.6, z: 5 });
    const f = r.beginFrame(0, 1 / 72);
    const eyes = surface.views(xr.step());
    expect(eyes.every((e) => e.camera.cull)).toBe(true);
    f.mesh(cube, mat, ahead);
    f.mesh(cube, mat, behind);
    for (const eye of eyes) {
      r.render(f, eye.camera, surface.scene!);
      r.resolve(surface.scene!, eye.target.color.view, eye.viewport);
    }
    r.endFrame({ present: false });
    // Each eye drew the cube ahead and skipped the one behind.
    expect(r.stats.culled).toBe(2);
    expect(r.stats.instances).toBe(2);
    expect(fake.errors).toEqual([]);
  });
});

describe('Renderer frame recovery (ws/xr-fixes)', () => {
  it('a frame that threw before endFrame is dropped unsubmitted; the next one runs', async () => {
    const { fake, surface, xr } = await setup({ scene: true, colorFormat: 'bgra8unorm' });
    const r = new Renderer(fakeRendererGpu(fake));
    const submits = fake.submits;
    const f = r.beginFrame(0, 1 / 72);
    const [eye] = surface.views(xr.step());
    r.render(f, eye!.camera, surface.scene!);
    // The game threw here: no resolve, no endFrame.
    const g = r.beginFrame(1 / 72, 1 / 72);
    expect(fake.submits).toBe(submits);
    for (const e of surface.views(xr.step())) {
      r.render(g, e.camera, surface.scene!);
      r.resolve(surface.scene!, e.target.color.view, e.viewport);
    }
    r.endFrame({ present: false });
    expect(fake.submits).toBe(submits + 1);
    expect(fake.errors).toEqual([]);
  });

  it('a viewless XR frame renders nothing (not the page target) and submits nothing', async () => {
    const { fake, session, surface, xr } = await setup({ scene: true, colorFormat: 'bgra8unorm' });
    const r = new Renderer(fakeRendererGpu(fake));
    session.tracking = false;
    const passes = fake.passes.length;
    const submits = fake.submits;
    r.beginFrame(0, 1 / 72);
    expect(surface.views(xr.step()).length).toBe(0);
    r.endFrame({ present: false });
    expect(fake.passes.length).toBe(passes);
    expect(fake.submits).toBe(submits);
    // The flat path still renders renderer.camera when nothing rendered.
    r.beginFrame(1, 1 / 60);
    r.endFrame();
    expect(fake.passes.slice(passes).some((p) => p.label === 'scene')).toBe(true);
    expect(fake.submits).toBe(submits + 1);
    expect(fake.errors).toEqual([]);
  });
});

describe('SceneTarget.adopt cache (ws/xr-fixes)', () => {
  it('a compositor cycling three textures allocates no wrapper or view once warm', async () => {
    const { surface, xr } = await setup({}, { rotateTextures: true, textureRing: 3 });
    const seen = new Set<unknown>();
    for (let i = 0; i < 3; i++) seen.add(surface.views(xr.step())[0]!.target.color);
    expect(seen.size).toBe(3);
    for (let i = 0; i < 9; i++) {
      const t = surface.views(xr.step())[0]!.target;
      expect(seen.has(t.color)).toBe(true);
      expect(t.colorAtt.view).toBe(t.color.view);
      expect(seen.has(t.depth)).toBe(false);
    }
  });
});

describe('Auto exposure in XR (ws/xr-fixes)', () => {
  /** A renderer with an auto-exposure post stack whose histogram has been read back. */
  async function exposed(fake: FakeDevice) {
    const r = new Renderer(fakeRendererGpu(fake));
    r.resize(128, 64);
    const post = new PostStack(r);
    r.post = post;
    post.set({ exposure: { mode: 'auto', speedUp: 3, speedDown: 3 } });
    return { r, post };
  }

  it('adapts once per frame with the frame dt, and both eyes use the same EV', async () => {
    const { fake, surface, xr } = await setup({ scene: true, colorFormat: 'bgra8unorm' });
    const flatFake = createFakeDevice();
    const flat = await exposed(flatFake);
    const stereo = await exposed(fake);
    const evs: number[] = [];
    const flatEvs: number[] = [];
    const stereoEvs: number[] = [];
    const frame = (t: number) => {
      flat.r.beginFrame(t, 1 / 72);
      flat.r.endFrame();
      flatEvs.push(flat.post.exposure);
      const g = stereo.r.beginFrame(t, 1 / 72);
      for (const eye of surface.views(xr.step())) {
        stereo.r.render(g, eye.camera, surface.scene!);
        stereo.r.resolve(surface.scene!, eye.target.color.view, eye.viewport);
        evs.push(stereo.post.exposure);
      }
      stereo.r.endFrame({ present: false });
      stereoEvs.push(stereo.post.exposure);
    };
    for (let i = 0; i < 6; i++) {
      frame(i / 72);
      await new Promise((res) => setTimeout(res, 0));
    }
    // The two eyes of a frame agree.
    for (let i = 0; i < evs.length; i += 2) expect(evs[i + 1]).toBe(evs[i]);
    // The EV moves one flat step per frame (the readback may land a frame apart: compare
    // from each run's first adapted frame).
    const moved = (list: number[]) => list.slice(list.findIndex((v) => v !== 0));
    const s = moved(stereoEvs);
    const f = moved(flatEvs);
    expect(Math.min(s.length, f.length)).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < Math.min(s.length, f.length); i++) expect(s[i]).toBeCloseTo(f[i]!, 9);
  });
});
