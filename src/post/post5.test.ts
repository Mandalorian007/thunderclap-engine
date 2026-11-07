/**
 * Post 5 (ws/post-5): TAA reprojects by the velocity target when the frame has one and
 * `taa.reprojection` is `'velocity'`, writes a history aux (velocity, linear depth) beside its
 * resolve, rejects history that disagrees, and packs the new flags.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import {
  createFakeDevice,
  type FakeDevice,
  type FakePass,
  fakeRendererGpu,
} from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import type { SceneTargetAux } from '../render/scene-target';
import { PostStack } from './post-stack';
import {
  defaultPostQuality,
  defaultPostSettings,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
} from './settings';
import { TAA_WGSL, taaRejects } from './taa';

function setup(aux?: SceneTargetAux) {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake), aux ? { aux } : {});
  r.resize(800, 450);
  const post = new PostStack(r, { taa: { enabled: true } });
  r.post = post;
  const camera = Camera.perspective(1, 16 / 9, 0.1, 100);
  return { fake, r, post, camera };
}

const deep = (r: Renderer, camera: Camera, t = 0) => {
  const f = r.beginFrame(t, 1 / 60);
  f.sprite(null, { x: 1, y: 1 });
  r.render(f, camera);
  r.endFrame();
};

const groupViews = (fake: FakeDevice, p: FakePass): string[] => {
  const set = p.commands.find((c) => c.op === 'setBindGroup') as { group: unknown } | undefined;
  const g = fake.bindGroups.find((b) => b === set?.group) as
    | { entries: { resource: unknown }[] }
    | undefined;
  return (g?.entries ?? [])
    .map((e) => (e.resource as { texture?: { label: string } }).texture?.label ?? '')
    .filter((l) => l !== '');
};
const lastPass = (fake: FakeDevice, label: string) =>
  [...fake.passes].reverse().find((p) => (p.label ?? '').replace(/^pass:/, '') === label);
const targets = (p: FakePass): string[] =>
  (
    p.desc as { colorAttachments: { view: { texture?: { label: string } } }[] }
  ).colorAttachments.map((a) => a.view.texture?.label ?? '');

describe('post 5: TAA velocity reprojection (ws/post-5)', () => {
  it('binds the velocity target to the resolve by default and writes the aux pair', () => {
    const { fake, r, post, camera } = setup({ velocity: true });
    deep(r, camera);
    deep(r, camera, 1 / 60);
    expect(post.taaActive).toBe(true);
    expect(post.taaVelocityActive).toBe(true);
    const pass = lastPass(fake, 'post-taa')!;
    const views = groupViews(fake, pass);
    expect(views).toContain('scene-velocity');
    // Reads history and aux `read`, writes the other pair.
    expect(views.filter((l) => l.startsWith('post-taa-aux-'))).toHaveLength(1);
    const out = targets(pass);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^post-taa-history-/);
    expect(out[1]).toMatch(/^post-taa-aux-/);
    expect(out[1]!.at(-1)).toBe(out[0]!.at(-1));
    expect(views).not.toContain(out[1]);
  });

  it("'camera' leaves the target unbound and runs the camera path", () => {
    const { fake, r, post, camera } = setup({ velocity: true });
    post.set({ taa: { reprojection: 'camera' } });
    deep(r, camera);
    expect(post.taaActive).toBe(true);
    expect(post.taaVelocityActive).toBe(false);
    expect(groupViews(fake, lastPass(fake, 'post-taa')!)).not.toContain('scene-velocity');
    post.set({ taa: { reprojection: 'velocity' } });
    deep(r, camera, 1 / 60);
    expect(post.taaVelocityActive).toBe(true);
    expect(groupViews(fake, lastPass(fake, 'post-taa')!)).toContain('scene-velocity');
  });

  it('falls back to the camera path without a velocity target', () => {
    const { fake, r, post, camera } = setup();
    deep(r, camera);
    expect(post.taaActive).toBe(true);
    expect(post.taaVelocityActive).toBe(false);
    expect(groupViews(fake, lastPass(fake, 'post-taa')!).some((l) => l.includes('velocity'))).toBe(
      false,
    );
  });

  it('packs the velocity flag in taa2.w and the thresholds in taa3, gated on TAA', () => {
    const out = new Float32Array(POST_UNIFORM_FLOATS);
    const s = defaultPostSettings();
    s.taa.enabled = true;
    s.taa.depthReject = 0.25;
    s.taa.velocityReject = 3;
    const depth = {
      near: 0.1,
      far: 100,
      invProj: new Float32Array(16),
      projX: 1,
      projY: 1,
      outputWidth: 800,
      ortho: false,
    };
    const frame = {
      jitterX: 0,
      jitterY: 0,
      reset: 0,
      reproj: new Float32Array(16),
      autoExposure: 1,
      taaVelocity: 1,
    };
    packPostUniforms(out, s, 0, 800, 450, 800, 450, defaultPostQuality(), depth, 0, frame);
    expect(out[139]).toBe(1);
    expect([out[188], out[189]]).toEqual([0.25, 3]);
    s.taa.enabled = false;
    packPostUniforms(out, s, 0, 800, 450, 800, 450, defaultPostQuality(), depth, 0, frame);
    expect(out[139]).toBe(0);
    // Off without depth (the 2D path).
    s.taa.enabled = true;
    packPostUniforms(out, s, 0, 800, 450, 800, 450, defaultPostQuality(), null, 0, frame);
    expect(out[139]).toBe(0);
  });

  it('rejects history across a depth or a velocity step, keeps it on the same surface', () => {
    const still: [number, number] = [0, 0];
    const moving: [number, number] = [4 / 800, 0];
    // Same surface, same motion.
    expect(taaRejects(moving, 5, moving, 5.2, 800, 450, 0.1, 2)).toBe(false);
    // Disoccluded: the background (far, still) under last frame's object (near, moving).
    expect(taaRejects(still, 9, moving, 5, 800, 450, 0.1, 2)).toBe(true);
    // Same depth, different motion (an object sliding over a coplanar one).
    expect(taaRejects(still, 5, moving, 5, 800, 450, 0.1, 2)).toBe(true);
    expect(taaRejects(still, 5, [1 / 800, 0], 5, 800, 450, 0.1, 2)).toBe(false);
  });

  it('the resolve looks the history up at uv - velocity, from the nearest depth', () => {
    expect(TAA_WGSL).toContain('var puv = in.uv - vel;');
    expect(TAA_WGSL).toMatch(/textureSampleLevel\(velocityTex, nearest, nearUv/);
    expect(TAA_WGSL).toMatch(/@location\(1\) aux/);
  });
});
