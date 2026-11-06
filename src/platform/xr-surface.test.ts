/**
 * `XrSurface` on the fake XR stack and the fake GPU: one layer in the scene format, two eyes
 * per frame with `viewIndex` 0 and 1 over the two halves of one shared target, matrices from
 * the views, the head between the eyes, rotating layer textures re-adopted, and a texture-array
 * layer giving each eye its own target.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import { SCENE_FORMAT } from '../render/scene-target';
import { type FakeXr, type FakeXrSession, installFakeXr } from './xr-fake';
import { XrSurface, type XrSurfaceOptions } from './xr-surface';

let xr: FakeXr | null = null;

afterEach(() => {
  xr?.uninstall();
  xr = null;
});

async function setup(opts: Partial<XrSurfaceOptions> = {}, fakeOpts = {}) {
  xr = installFakeXr(fakeOpts);
  const fake: FakeDevice = createFakeDevice();
  const session = (await xr.system.requestSession('immersive-vr')) as FakeXrSession;
  const referenceSpace = await session.requestReferenceSpace('local-floor');
  const surface = new XrSurface(session, fake.device, { referenceSpace, ...opts });
  return { fake, session, surface, xr };
}

describe('XrSurface', () => {
  it('supported() follows XRGPUBinding', () => {
    expect(XrSurface.supported()).toBe(false);
    xr = installFakeXr();
    expect(XrSurface.supported()).toBe(true);
  });

  it('makes one projection layer in the scene format with depth and installs it', async () => {
    const { session, surface, xr } = await setup();
    const binding = xr.bindings[0]!;
    expect(binding.layers.length).toBe(1);
    expect(binding.layers[0]!.init).toEqual({
      colorFormat: SCENE_FORMAT,
      depthStencilFormat: 'depth24plus',
      textureType: 'texture',
    });
    expect(session.renderStateUpdates).toEqual([
      { layers: [surface.layer], depthNear: 0.1, depthFar: 1000 },
    ]);
    expect(surface.head.depthTest).toBe(true);
  });

  it('two eyes share one target, side by side, with viewIndex 0 and 1 and the views matrices', async () => {
    const { session, surface, xr } = await setup();
    const frame = xr.step();
    const eyes = surface.views(frame);
    expect(eyes.length).toBe(2);
    const [l, r] = eyes as [(typeof eyes)[0], (typeof eyes)[0]];
    expect(l.eye).toBe('left');
    expect(r.eye).toBe('right');
    expect(l.camera.viewIndex).toBe(0);
    expect(r.camera.viewIndex).toBe(1);
    expect(l.camera.depthTest).toBe(true);
    expect(r.camera.depthWrite).toBe(true);
    // One texture, 128×32, both eyes on it.
    expect(l.target).toBe(r.target);
    expect(l.target.isExternal).toBe(true);
    expect(l.target.width).toBe(128);
    expect(l.target.height).toBe(32);
    expect(l.viewport).toEqual({ x: 0, y: 0, width: 64, height: 32 });
    expect(r.viewport).toEqual({ x: 64, y: 0, width: 64, height: 32 });
    expect(l.camera.screen).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
    expect(r.camera.screen).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
    // View matrices: the inverse of each eye's pose (head at y 1.6, eyes ±0.032 on x).
    const half = session.opts.ipd / 2;
    expect(l.camera.view[12]).toBeCloseTo(half);
    expect(r.camera.view[12]).toBeCloseTo(-half);
    expect(l.camera.view[13]).toBeCloseTo(-1.6);
    expect(surface.head.view[12]).toBeCloseTo(0);
    expect(surface.head.view[13]).toBeCloseTo(-1.6);
    expect(surface.head.projection).toEqual(l.camera.projection);
    expect(l.camera.projection[0]).toBeCloseTo(0.5); // 90° at 2:1
  });

  it('reuses the views and the array across frames and follows the head', async () => {
    const { session, surface, xr } = await setup();
    const a = surface.views(xr.step());
    const first = a[0]!;
    session.headPosition = [1, 1.6, -2];
    const b = surface.views(xr.step());
    expect(b).toBe(a);
    expect(b[0]).toBe(first);
    expect(first.camera.view[12]).toBeCloseTo(-1 + session.opts.ipd / 2);
    expect(first.camera.view[14]).toBeCloseTo(2);
  });

  it('returns no eyes while tracking is lost', async () => {
    const { session, surface, xr } = await setup();
    session.tracking = false;
    expect(surface.views(xr.step()).length).toBe(0);
  });

  it('re-adopts the layer texture when the compositor rotates it', async () => {
    const { surface, xr } = await setup({}, { rotateTextures: true });
    const t1 = surface.views(xr.step())[0]!.target;
    const c1 = t1.adoptedColor;
    const t2 = surface.views(xr.step())[0]!.target;
    expect(t2).toBe(t1);
    expect(t2.adoptedColor).not.toBe(c1);
    expect(t2.adoptedColor).toBe(xr.bindings[0]!.layers[0]!.colorTextures[1]);
    expect(t2.colorAtt.view).toBe(t2.color.view);
    expect(t2.width).toBe(128);
  });

  it('a texture-array layer gives each eye its own target over its layer', async () => {
    const { surface, xr } = await setup({ textureType: 'texture-array' });
    const [l, r] = surface.views(xr.step());
    expect(l!.target).not.toBe(r!.target);
    expect(l!.target.adoptedColor).toBe(r!.target.adoptedColor);
    expect(l!.target.width).toBe(64);
    expect(l!.camera.screen).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(r!.camera.screen).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('renders each eye as one scene pass into the shared target: clear then load, two viewports', async () => {
    const { fake, surface, xr } = await setup();
    const r = new Renderer(fakeRendererGpu(fake));
    const frame = r.beginFrame(0, 1 / 72);
    const eyes = surface.views(xr.step());
    const loadOps: string[] = [];
    for (const eye of eyes) {
      r.render(frame, eye.camera, eye.target);
      loadOps.push(`${eye.target.colorAtt.loadOp}/${eye.target.depthAtt.depthLoadOp}`);
    }
    r.endFrame({ present: false });
    expect(loadOps).toEqual(['clear/clear', 'load/load']);
    const scene = fake.passes.filter((p) => p.label === 'scene');
    expect(scene.length).toBe(2);
    for (const p of scene) {
      const names = p.commands
        .filter((c) => c.op === 'other')
        .map((c) => (c as { name: string }).name);
      expect(names).toContain('setViewport');
      expect(names).toContain('setScissorRect');
    }
    // The adopted depth texture is the pass's depth attachment; no own depth was allocated.
    expect(fake.textures.some((t) => t.label === 'xr-eye-0-depth')).toBe(false);
    expect(fake.textures.some((t) => t.label === 'xr-eye-0-emissive')).toBe(true);
    // Nothing presented: the swapchain texture was never a pass attachment.
    expect(fake.passes.some((p) => p.label?.includes('present'))).toBe(false);
    expect(fake.errors).toEqual([]);
  });

  it('destroy frees the eye targets and the layer, and views() is then empty', async () => {
    const { fake, surface, xr } = await setup();
    surface.views(xr.step());
    const layerTex = xr.bindings[0]!.layers[0]!.colorTextures[0]!;
    surface.destroy();
    expect((surface.layer as { destroyed?: boolean }).destroyed).toBe(true);
    expect(fake.textures.find((t) => t.label === 'xr-eye-0-emissive')?.destroyed).toBe(true);
    // The layer's own texture is not the surface's to destroy.
    expect((layerTex as unknown as { destroyed: boolean }).destroyed).toBe(false);
    expect(surface.views(xr.step()).length).toBe(0);
    surface.destroy();
  });

  it('refuses without the binding', async () => {
    xr = installFakeXr();
    const fake = createFakeDevice();
    const session = (await xr.system.requestSession('immersive-vr')) as FakeXrSession;
    const referenceSpace = await session.requestReferenceSpace('local');
    xr.uninstall();
    xr = null;
    expect(() => new XrSurface(session, fake.device, { referenceSpace })).toThrow(/binding/);
    expect(new Camera().viewIndex).toBe(0);
  });
});
