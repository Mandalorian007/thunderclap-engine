/**
 * Post 4 (ws/post-4): the stack reads the frame from `PostInputs` alone (no `renderer.camera`
 * anywhere in src/post), drives the camera jitter while TAA runs, binds the rough-metal and
 * velocity targets when SSR and object motion blur read them, packs the new flags, and the
 * settings debts (`clonePostSettings`, qualified snap keys).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { aoProjectedRadius } from './ao';
import { easeLinear, PostBlender } from './blend';
import { PostStack } from './post-stack';
import {
  clonePostSettings,
  defaultPostQuality,
  defaultPostSettings,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
} from './settings';
import { ssrRoughnessFade, ssrSurfaceWeight } from './ssr';

const here = dirname(fileURLToPath(import.meta.url));

function setup(aux?: SceneTargetAux) {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake), aux ? { aux } : {});
  r.resize(800, 450);
  const post = new PostStack(r);
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

describe('post 4: inputs, not the renderer (ws/post-4)', () => {
  it('no src/post source reads the renderer camera', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(here)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const src = readFileSync(join(here, name), 'utf8');
      if (/\b(renderer|r|this\.renderer)\s*\.\s*camera\b/.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

describe('post 4: TAA on camera jitter (ws/post-4)', () => {
  it('wants jitter only while TAA is enabled and allowed', () => {
    const { post } = setup();
    expect(post.wantsJitter).toBe(false);
    post.set({ taa: { enabled: true } });
    expect(post.wantsJitter).toBe(true);
    post.setQuality({ taa: false });
    expect(post.wantsJitter).toBe(false);
  });

  it('steps the jitter camera through the Halton sequence and clears it when TAA stops', () => {
    const { r, post, camera } = setup();
    post.addJitterCamera(camera).addJitterCamera(camera);
    deep(r, camera);
    expect(camera.jitter).toEqual([0, 0]);
    post.set({ taa: { enabled: true } });
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      deep(r, camera, i / 60);
      const [x, y] = camera.jitter;
      const j = post.taa.jitter(i);
      expect([x, y]).toEqual([j[0], j[1]]);
      seen.push(`${x},${y}`);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
    }
    expect(new Set(seen).size).toBe(8);
    post.set({ taa: { enabled: false } });
    deep(r, camera, 1);
    expect(camera.jitter).toEqual([0, 0]);
    // Back on: the sequence restarts.
    post.set({ taa: { enabled: true } });
    deep(r, camera, 2);
    const j0 = post.taa.jitter(0);
    expect(camera.jitter).toEqual([j0[0], j0[1]]);
    post.removeJitterCamera(camera);
    expect(camera.jitter).toEqual([0, 0]);
    deep(r, camera, 3);
    expect(camera.jitter).toEqual([0, 0]);
  });

  it('packs the view jitter in uv and the reprojection from the view', () => {
    const out = new Float32Array(POST_UNIFORM_FLOATS);
    const s = defaultPostSettings();
    s.taa.enabled = true;
    const reproj = new Float32Array(16).map((_, i) => i * 0.5);
    packPostUniforms(out, s, 0, 800, 450, 800, 450, defaultPostQuality(), null, 0, {
      jitterX: 0.25 / 800,
      jitterY: -0.125 / 450,
      reset: 0,
      reproj,
      autoExposure: 1,
    });
    expect(out[136]).toBeCloseTo(0.25 / 800, 9);
    expect(out[137]).toBeCloseTo(-0.125 / 450, 9);
    expect(Array.from(out.subarray(172, 188))).toEqual(Array.from(reproj));
  });
});

describe('post 4: per-surface inputs (ws/post-4)', () => {
  it('binds the rough-metal target to SSR and the velocity target to motion blur', () => {
    const { fake, r, post, camera } = setup({ roughMetal: true, velocity: true });
    post.set({ ssr: { enabled: true }, motionBlur: { enabled: true } });
    deep(r, camera);
    expect(groupViews(fake, lastPass(fake, 'post-ssr')!)).toContain('scene-rough-metal');
    expect(groupViews(fake, lastPass(fake, 'post-motion-blur')!)).toContain('scene-velocity');
    // Camera mode leaves the velocity target unbound.
    post.set({ motionBlur: { mode: 'camera' } });
    deep(r, camera, 1);
    expect(groupViews(fake, lastPass(fake, 'post-motion-blur')!)).not.toContain('scene-velocity');
  });

  it('runs without the targets (the constant SSR path, camera blur)', () => {
    const { fake, r, post, camera } = setup();
    post.set({ ssr: { enabled: true }, motionBlur: { enabled: true } });
    deep(r, camera);
    expect(post.ssrActive).toBe(true);
    expect(post.motionBlurActive).toBe(true);
    const ssr = groupViews(fake, lastPass(fake, 'post-ssr')!);
    expect(ssr.some((l) => l.includes('rough-metal'))).toBe(false);
  });

  it('packs the rough-metal, object-velocity and ortho flags', () => {
    const out = new Float32Array(POST_UNIFORM_FLOATS);
    const s = defaultPostSettings();
    s.ssr.enabled = true;
    s.motionBlur.enabled = true;
    const q = defaultPostQuality();
    const depth = {
      near: 0.1,
      far: 100,
      invProj: new Float32Array(16),
      projX: 1,
      projY: 1,
      outputWidth: 800,
      ortho: true,
    };
    const frame = {
      jitterX: 0,
      jitterY: 0,
      reset: 0,
      reproj: new Float32Array(16),
      autoExposure: 1,
      roughMetal: 1,
      objectVelocity: 1,
    };
    packPostUniforms(out, s, 0, 800, 450, 800, 450, q, depth, 0, frame);
    expect([out[70], out[147], out[167]]).toEqual([1, 1, 1]);
    // Off without depth (the 2D path packs exactly as before).
    packPostUniforms(out, s, 0, 800, 450, 800, 450, q, null, 0, frame);
    expect([out[70], out[147], out[167]]).toEqual([0, 0, 0]);
  });

  it('weights a reflection by metalness over Schlick Fresnel and fades it by roughness', () => {
    expect(ssrSurfaceWeight(1, 1)).toBe(1);
    expect(ssrSurfaceWeight(0, 1)).toBeCloseTo(0.04);
    expect(ssrSurfaceWeight(0, 0)).toBeCloseTo(1);
    expect(ssrSurfaceWeight(0.5, 1)).toBeCloseTo(0.52);
    expect(ssrRoughnessFade(0.05, 0.6)).toBeGreaterThan(0.99);
    expect(ssrRoughnessFade(0.9, 0.6)).toBe(0);
  });

  it('projects the AO radius without the depth divide under an ortho camera', () => {
    expect(aoProjectedRadius(1, 2, 4, false)).toBeCloseTo(0.25);
    expect(aoProjectedRadius(1, 2, 4, true)).toBeCloseTo(1);
    expect(aoProjectedRadius(1, 2, 40, true)).toBe(aoProjectedRadius(1, 2, 4, true));
  });
});

describe('post 4: settings debts (ws/post-4)', () => {
  it('clonePostSettings deep-copies sections and colours, sharing GPU handles', () => {
    const s = defaultPostSettings();
    const tex = { label: 'lut' } as unknown as GPUTexture;
    s.lut.texture = tex;
    const c = clonePostSettings(s);
    expect(c).toEqual(s);
    expect(c.bloom).not.toBe(s.bloom);
    expect(c.fog).not.toBe(s.fog);
    c.grade.lift[0] = 9;
    c.motionBlur.mode = 'camera';
    expect(s.grade.lift[0]).not.toBe(9);
    expect(s.motionBlur.mode).toBe('object');
    expect(c.lut.texture).toBe(tex);
  });

  it('snaps bloom.levels, lut.texture and motionBlur.mode at the end of a blend, by section', () => {
    const s = defaultPostSettings();
    const b = new PostBlender();
    const tex = { label: 'lut' } as unknown as GPUTexture;
    b.blendTo(
      s,
      { motionBlur: { mode: 'camera' }, lut: { texture: tex }, bloom: { levels: 3 } },
      1,
      easeLinear,
    );
    b.advance(s, 0.5);
    expect(s.motionBlur.mode).toBe('object');
    expect(s.lut.texture).toBeNull();
    expect(s.bloom.levels).not.toBe(3);
    b.advance(s, 0.6);
    expect(s.motionBlur.mode).toBe('camera');
    expect(s.lut.texture).toBe(tex);
    expect(s.bloom.levels).toBe(3);
  });
});
