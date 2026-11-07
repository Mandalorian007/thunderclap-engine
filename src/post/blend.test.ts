import { describe, expect, it } from 'vitest';
import { Renderer } from '../render';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { easeInOut, easeLinear, PostBlender } from './blend';
import { PostStack } from './post-stack';
import { cinematicPostSettings } from './settings';

describe('PostBlender', () => {
  it('interpolates numbers and colours with the ease, then lands exactly', () => {
    const s = cinematicPostSettings();
    s.bloom.intensity = 1;
    s.mist.color = [0, 0, 0];
    const b = new PostBlender();
    b.blendTo(s, { bloom: { intensity: 3 }, mist: { color: [1, 0.5, 0] } }, 2, easeLinear);
    expect(b.active).toBe(true);
    b.advance(s, 0.5);
    expect(s.bloom.intensity).toBeCloseTo(1.5);
    expect(s.mist.color).toEqual([0.25, 0.125, 0]);
    b.advance(s, 1.5);
    expect(s.bloom.intensity).toBe(3);
    expect(s.mist.color).toEqual([1, 0.5, 0]);
    expect(b.active).toBe(false);
  });

  it('eases with smoothstep and never mutates the patch or a shared preset', () => {
    const preset: [number, number, number] = [0.2, 0.2, 0.2];
    const s = cinematicPostSettings();
    s.vignette.color = preset; // as `set` would leave it
    const patch = { vignette: { intensity: 0, color: [1, 1, 1] as [number, number, number] } };
    const b = new PostBlender();
    const i0 = s.vignette.intensity;
    b.blendTo(s, patch, 1, easeInOut);
    b.advance(s, 0.25);
    expect(s.vignette.intensity).toBeCloseTo(i0 * (1 - easeInOut(0.25)));
    b.advance(s, 1);
    expect(preset).toEqual([0.2, 0.2, 0.2]);
    expect(patch.vignette.color).toEqual([1, 1, 1]);
    expect(s.vignette.color).not.toBe(patch.vignette.color);
  });

  it('turns passes on at the start and off at the end; snaps tonemap and levels at the end', () => {
    const s = cinematicPostSettings();
    s.mist.enabled = false;
    const b = new PostBlender();
    b.blendTo(
      s,
      {
        mist: { enabled: true, density: 0 },
        godRays: { enabled: false, intensity: 0 },
        grade: { tonemap: 'reinhard' },
        bloom: { levels: 3 },
      },
      1,
      easeLinear,
    );
    expect(s.mist.enabled).toBe(true);
    b.advance(s, 0.5);
    expect(s.godRays.enabled).toBe(true);
    expect(s.grade.tonemap).toBe('aces');
    expect(s.bloom.levels).toBe(6);
    b.advance(s, 0.5);
    expect(s.godRays.enabled).toBe(false);
    expect(s.godRays.intensity).toBe(0);
    expect(s.grade.tonemap).toBe('reinhard');
    expect(s.bloom.levels).toBe(3);
  });

  it('retargets from the current value, cancels and finishes', () => {
    const s = cinematicPostSettings();
    s.grade.exposure = 0;
    const b = new PostBlender();
    b.blendTo(s, { grade: { exposure: 1 }, mist: { density: 0 } }, 1, easeLinear);
    b.advance(s, 0.5);
    b.blendTo(s, { grade: { exposure: 0 } }, 1, easeLinear); // from 0.5 back down
    b.advance(s, 0.5);
    expect(s.grade.exposure).toBeCloseTo(0.25);
    b.cancel({ grade: { exposure: 9 } });
    b.advance(s, 0.25);
    expect(s.grade.exposure).toBeCloseTo(0.25);
    b.finish(s);
    expect(s.mist.density).toBe(0);
    expect(b.active).toBe(false);
  });

  it('zero seconds applies at once', () => {
    const s = cinematicPostSettings();
    const b = new PostBlender();
    b.blendTo(s, { bloom: { intensity: 5, enabled: false } }, 0, easeLinear);
    expect(s.bloom).toMatchObject({ intensity: 5, enabled: false });
    expect(b.active).toBe(false);
  });
});

describe('PostStack.blendTo', () => {
  it('advances with frame time, and set() takes over a blended key', () => {
    const r = new Renderer(fakeRendererGpu(createFakeDevice()));
    const post = new PostStack(r, { grade: { exposure: 1 } });
    post.blendTo({ grade: { exposure: 3 }, bloom: { intensity: 0 } }, 1, (t) => t);
    expect(post.blending).toBe(true);
    post.advanceBlend(10);
    post.advanceBlend(10.05);
    post.advanceBlend(10.1);
    expect(post.settings.grade.exposure).toBeCloseTo(1.2);
    post.advanceBlend(60); // a hitch counts as at most 0.1 s
    expect(post.settings.grade.exposure).toBeCloseTo(1.4);
    post.set({ grade: { exposure: 2 } });
    post.advanceBlend(60.1);
    expect(post.settings.grade.exposure).toBe(2);
    post.finishBlend();
    expect(post.settings.bloom.intensity).toBe(0);
    expect(post.blending).toBe(false);
  });

  it('is driven by encode', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const post = new PostStack(r);
    r.post = post;
    post.set({ vignette: { intensity: 0 } }).blendTo({ vignette: { intensity: 1 } }, 0.5);
    for (let i = 0; i <= 40; i++) {
      r.beginFrame(i / 60, 1 / 60);
      r.endFrame();
    }
    expect(post.settings.vignette.intensity).toBe(1);
    expect(fake.errors).toEqual([]);
  });
});
