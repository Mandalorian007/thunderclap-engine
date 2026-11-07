import { describe, expect, it } from 'vitest';
import { Renderer } from '../render';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { PostStack } from './post-stack';
import {
  cinematicPostSettings,
  defaultPostQuality,
  POST_UNIFORM_FLOATS,
  packPostUniforms,
} from './settings';

function frame(r: Renderer) {
  r.beginFrame(0, 1 / 60);
  r.endFrame();
}

describe('PostStack quality caps', () => {
  it('caps bloom levels without touching the look settings, and only reallocates on change', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    r.resize(1920, 1080);
    const post = new PostStack(r);
    r.post = post;
    const mips = () =>
      fake.textures.filter((t) => t.label === 'post-bloom').map((t) => t.mipLevelCount);
    frame(r);
    const full = mips().at(-1);
    expect(full).toBe(post.settings.bloom.levels);
    post.setQuality({ maxBloomLevels: 4 });
    frame(r);
    expect(mips().at(-1)).toBe(4);
    expect(post.settings.bloom.levels).toBe(cinematicPostSettings().bloom.levels);
    const n = mips().length;
    frame(r);
    frame(r);
    expect(mips().length).toBe(n);
    expect(fake.errors).toEqual([]);
  });

  it('does not reallocate every frame when the size clamps the levels', () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    r.resize(160, 90);
    r.post = new PostStack(r);
    frame(r);
    const n = fake.textures.filter((t) => t.label === 'post-bloom').length;
    frame(r);
    frame(r);
    expect(fake.textures.filter((t) => t.label === 'post-bloom').length).toBe(n);
  });

  it('packs ray samples and fog octaves into the quality slot', () => {
    const out = new Float32Array(POST_UNIFORM_FLOATS);
    const q = defaultPostQuality();
    packPostUniforms(out, cinematicPostSettings(), 0, 100, 100, 100, 100, q);
    expect([out[68], out[69]]).toEqual([64, 5]);
    packPostUniforms(out, cinematicPostSettings(), 0, 100, 100, 100, 100, {
      ...q,
      raySamples: 3,
      fogOctaves: 9,
    });
    expect([out[68], out[69]]).toEqual([8, 5]);
  });
});
