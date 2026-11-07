/**
 * Post 6 (ws/post-6): the stack jitters through `renderer.setJitter` while TAA runs (never
 * `Camera.setJitter`), clears the hook when TAA stops or the stack is destroyed, and samples the
 * TAA history through a 5-tap Catmull-Rom filter unless `taa.historyFilter` is `'bilinear'`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import { PostStack } from './post-stack';
import {
  cinematicPostSettings,
  defaultPostQuality,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
} from './settings';
import { TAA_WGSL, taaCatmullRomWeights } from './taa';

const here = dirname(fileURLToPath(import.meta.url));

function setup() {
  const fake = createFakeDevice();
  const r = new Renderer(fakeRendererGpu(fake));
  r.resize(800, 450);
  const post = new PostStack(r);
  r.post = post;
  const camera = Camera.perspective(1, 16 / 9, 0.1, 100);
  return { fake, r, post, camera };
}

/** One frame drawing `cams` in turn (a second view: an XR eye, an offscreen camera). */
const deep = (r: Renderer, cams: Camera[], t = 0) => {
  const f = r.beginFrame(t, 1 / 60);
  f.sprite(null, { x: 1, y: 1 });
  for (const c of cams) r.render(f, c);
  r.endFrame();
};

describe('post 6: jitter through the renderer (ws/post-6)', () => {
  it('no src/post source calls Camera.setJitter or clearJitter', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(here)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const src = readFileSync(join(here, name), 'utf8');
      // Every `.setJitter(` call must be the renderer's; no camera jitter is cleared here.
      const calls = src.match(/[\w.!\]]+\s*\.\s*setJitter\s*\(/g) ?? [];
      const own = calls.filter((c) => !/\brenderer\s*\.\s*setJitter/.test(c));
      if (own.length > 0 || /\.\s*clearJitter\s*\(/.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('drives Halton (2, 3) on every camera through renderer.setJitter while TAA runs', () => {
    const { r, post, camera } = setup();
    const eye = Camera.perspective(1, 1, 0.1, 100);
    const hook = vi.spyOn(r, 'setJitter');
    deep(r, [camera, eye]);
    expect(hook).not.toHaveBeenCalled();
    expect(camera.jitter).toEqual([0, 0]);
    post.set({ taa: { enabled: true } });
    // The first TAA frame runs unjittered and sets the hook; from the next frame on the
    // renderer applies frame i - 1 of the sequence to both views.
    deep(r, [camera, eye]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(camera.jitter).toEqual([0, 0]);
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      deep(r, [camera, eye], (i + 1) / 60);
      const j = post.taa.jitter(i);
      expect(camera.jitter).toEqual([j[0], j[1]]);
      expect(eye.jitter).toEqual([j[0], j[1]]);
      seen.push(`${j[0]},${j[1]}`);
      expect(Math.abs(j[0])).toBeLessThanOrEqual(0.5);
      expect(Math.abs(j[1])).toBeLessThanOrEqual(0.5);
    }
    expect(new Set(seen).size).toBe(8);
    // The hook is set once, not per frame.
    expect(hook).toHaveBeenCalledTimes(1);
    // TAA off: cleared with null, once; both cameras lose their jitter.
    post.set({ taa: { enabled: false } });
    deep(r, [camera, eye], 1);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenLastCalledWith(null);
    expect(camera.jitter).toEqual([0, 0]);
    expect(eye.jitter).toEqual([0, 0]);
    deep(r, [camera, eye], 1.1);
    expect(hook).toHaveBeenCalledTimes(2);
    // Back on: the sequence restarts at 0.
    post.set({ taa: { enabled: true } });
    deep(r, [camera], 2);
    deep(r, [camera], 2.1);
    const j0 = post.taa.jitter(0);
    expect(camera.jitter).toEqual([j0[0], j0[1]]);
  });

  it('quality.taa off clears the hook; destroy clears it; a stack that never ran TAA leaves it alone', () => {
    const { r, post, camera } = setup();
    post.set({ taa: { enabled: true } });
    deep(r, [camera]);
    deep(r, [camera]);
    expect(camera.jitter).not.toEqual([0, 0]);
    post.setQuality({ taa: false });
    deep(r, [camera]);
    expect(camera.jitter).toEqual([0, 0]);
    post.setQuality({ taa: true });
    deep(r, [camera]);
    deep(r, [camera]);
    expect(camera.jitter).not.toEqual([0, 0]);
    const hook = vi.spyOn(r, 'setJitter');
    post.destroy();
    expect(hook).toHaveBeenCalledWith(null);
    expect(camera.jitter).toEqual([0, 0]);
    // A second stack with TAA off (a reference beside the measured one) never touches the hook.
    const other = new PostStack(r);
    hook.mockClear();
    r.post = other;
    deep(r, [camera]);
    other.destroy();
    expect(hook).not.toHaveBeenCalled();
  });

  it('allocates nothing per frame for the jitter: the hook is one closure returning one tuple', () => {
    const { r, post, camera } = setup();
    post.set({ taa: { enabled: true } });
    let fn: ((i: number) => readonly [number, number]) | null = null;
    const out: (readonly [number, number])[] = [];
    const real = r.setJitter.bind(r);
    r.setJitter = (f) => {
      fn = f;
      // Record what the renderer gets each frame (ws/post-7: the hook is called once per frame).
      real(
        f &&
          ((i) => {
            const t = f(i);
            out.push(t);
            return t;
          }),
      );
    };
    deep(r, [camera]);
    expect(fn).not.toBeNull();
    deep(r, [camera]);
    deep(r, [camera]);
    expect(out).toHaveLength(2);
    const [a, b] = out;
    expect(a).toBe(b);
  });
});

describe('post 6: Catmull-Rom history filter (ws/post-6)', () => {
  it("defaults to 'catmull-rom' and packs it in taa3.z", () => {
    expect(cinematicPostSettings().taa.historyFilter).toBe('catmull-rom');
    const out = new Float32Array(POST_UNIFORM_FLOATS);
    const s = cinematicPostSettings();
    s.taa.enabled = true;
    const pack = () =>
      packPostUniforms(out, s, 0, 800, 450, 800, 450, defaultPostQuality(), null, 0, {
        jitterX: 0,
        jitterY: 0,
        reset: 0,
        reproj: new Float32Array(16),
        autoExposure: 1,
        roughMetal: 0,
        objectVelocity: 0,
        taaVelocity: 0,
      });
    pack();
    expect(out[190]).toBe(1);
    s.taa.historyFilter = 'bilinear';
    pack();
    expect(out[190]).toBe(0);
    expect(out[188]).toBeCloseTo(0.1, 6);
    expect(out[189]).toBe(2);
  });

  it('the weights sum to 1, read a texel centre exactly and are symmetric', () => {
    const w: [number, number, number, number] = [0, 0, 0, 0];
    for (const f of [0, 0.1, 0.25, 0.37, 0.5, 0.75, 0.99]) {
      taaCatmullRomWeights(f, w);
      expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 12);
      const m = taaCatmullRomWeights(1 - f);
      expect(w[0]).toBeCloseTo(m[3], 12);
      expect(w[1]).toBeCloseTo(m[2], 12);
    }
    expect(taaCatmullRomWeights(0).map((x) => x + 0)).toEqual([0, 1, 0, 0]);
    // Sharper than bilinear: at f = 0.37 the nearer texel keeps more than 1 - f.
    expect(taaCatmullRomWeights(0.37)[1]).toBeGreaterThan(1 - 0.37);
  });

  it('the resolve branches on taa3.z between the 5-tap filter and one bilinear tap', () => {
    expect(TAA_WGSL).toContain('fn hist_catmull_rom(uv: vec2f) -> vec3f');
    expect(TAA_WGSL).toMatch(/if \(P\.taa3\.z > 0\.5\) \{\s*hs = hist_catmull_rom\(puv\);/);
    // Five history taps in the filter, normalised by their weight.
    const body = TAA_WGSL.slice(TAA_WGSL.indexOf('fn hist_catmull_rom'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn.match(/hist\(/g)?.length).toBe(5);
    expect(fn).toContain('sum / (a + b + c + d + e)');
  });
});
