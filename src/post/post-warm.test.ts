/**
 * E26: a post pass that is off is not made (nor warmed) at load. The stack warms the passes that are on
 * when it is made, one turned on in the frame it turns on, and the rest one a frame after
 * `warmAfterFrames` frames, so a cold shader cache doesn't hold up the first view.
 */
import { describe, expect, it } from 'vitest';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import { PostStack, type PostStackOptions } from './post-stack';
import { neutralPostSettings } from './settings';

/** Labels of the post pipelines warmed so far, in the order their warms were encoded. */
const warmed = (fake: FakeDevice): string[] =>
  fake.warmPasses.flatMap((p) =>
    p.commands
      .filter((c) => c.op === 'setPipeline')
      .map((c) =>
        ((c as { pipeline: { label?: string } }).pipeline.label ?? '').replace(/^pass:/, ''),
      )
      .filter((l) => l.startsWith('post-')),
  );

function setup(opts: PostStackOptions = {}, look = neutralPostSettings()) {
  const fake = createFakeDevice();
  const made: string[] = [];
  const create = fake.device.createRenderPipeline.bind(fake.device);
  (fake.device as unknown as { createRenderPipeline: unknown }).createRenderPipeline = (
    d: GPURenderPipelineDescriptor,
  ) => {
    made.push((d.label ?? '').replace(/^pass:/, ''));
    return create(d);
  };
  const r = new Renderer(fakeRendererGpu(fake));
  r.resize(800, 450);
  const post = new PostStack(r, look, opts);
  r.post = post;
  const frame = () => {
    r.beginFrame(0, 1 / 60);
    r.endFrame();
  };
  const madePost = () => made.filter((l) => l.startsWith('post-'));
  return { fake, r, post, frame, madePost };
}

const ALL_OFF = [
  'post-bloom-prefilter',
  'post-bloom-down',
  'post-bloom-up',
  'post-godrays',
  'post-fxaa',
  'post-outline',
  'post-ao',
  'post-ao-blur',
  'post-dof',
  'post-taa',
  'post-ssr',
  'post-motion-blur',
  'post-upscale',
];

describe('PostStack warming (E26)', () => {
  it('warms the composite and what is on at load, nothing that is off', () => {
    const look = neutralPostSettings();
    look.bloom.enabled = true;
    const { fake, post, frame, madePost } = setup({}, look);
    // WebKit compiles a pipeline when it is made: an off pass's isn't.
    expect(madePost().sort()).toEqual(
      ['post-bloom-down', 'post-bloom-prefilter', 'post-bloom-up', 'post-composite'].sort(),
    );
    frame();
    expect(warmed(fake).sort()).toEqual(
      ['post-bloom-down', 'post-bloom-prefilter', 'post-bloom-up', 'post-composite'].sort(),
    );
    expect(post.coldPasses).toBe(ALL_OFF.length - 3);
    expect(fake.errors).toEqual([]);
  });

  it('a pass turned on is warmed that frame', () => {
    const { fake, post, frame } = setup();
    frame();
    const before = warmed(fake).length;
    post.settings.fxaa.enabled = true;
    frame();
    expect(warmed(fake).slice(before)).toEqual(['post-fxaa']);
    frame();
    expect(warmed(fake).length).toBe(before + 1);
    expect(fake.errors).toEqual([]);
  });

  it('after warmAfterFrames, the rest warm one a frame, then never again', () => {
    const { fake, post, frame } = setup({ warmAfterFrames: 3 });
    for (let i = 0; i < 2; i++) frame();
    expect(warmed(fake)).toEqual(['post-composite']);
    const left = post.coldPasses;
    expect(left).toBe(ALL_OFF.length);
    for (let i = 0; i < left; i++) {
      frame();
      expect(warmed(fake).length).toBe(2 + i);
    }
    expect(post.coldPasses).toBe(0);
    expect(warmed(fake).slice(1).sort()).toEqual([...ALL_OFF].sort());
    for (let i = 0; i < 3; i++) frame();
    expect(warmed(fake).length).toBe(1 + ALL_OFF.length);
    expect(fake.errors).toEqual([]);
  });

  it('warmAfterFrames Infinity warms only what turns on; warmAll warms the rest at once', () => {
    const { fake, post, frame, madePost } = setup({ warmAfterFrames: Infinity });
    for (let i = 0; i < 200; i++) frame();
    expect(warmed(fake)).toEqual(['post-composite']);
    expect(madePost()).toEqual(['post-composite']);
    post.warmAll();
    frame();
    expect(post.coldPasses).toBe(0);
    expect(warmed(fake).slice(1).sort()).toEqual([...ALL_OFF].sort());
    expect(madePost().length).toBe(1 + ALL_OFF.length);
    expect(fake.errors).toEqual([]);
  });

  it('a pass drawn before its warm is not warmed after', () => {
    const { fake, post, frame } = setup({ warmAfterFrames: Infinity });
    post.settings.fxaa.enabled = true;
    frame();
    post.settings.fxaa.enabled = false;
    post.warmAll();
    frame();
    expect(warmed(fake).filter((l) => l === 'post-fxaa').length).toBe(1);
  });
});
