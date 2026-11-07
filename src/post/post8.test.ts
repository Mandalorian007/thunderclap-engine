/**
 * Post 8 (ws/post-8): a stack reads its ownership of the jitter hook from the renderer
 * (`renderer.jitter === hook`), so a hook the page installs by hand is never cleared by a stack.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { type JitterFn, Renderer } from '../render/renderer';
import { PostStack } from './post-stack';

const frame = (r: Renderer, camera: Camera, t = 0) => {
  const f = r.beginFrame(t, 1 / 60);
  f.sprite(null, { x: 1, y: 1 });
  r.render(f, camera);
  r.endFrame();
};

const stackHook = (s: PostStack) => (s as unknown as { jitterFn: JitterFn }).jitterFn;

describe('post 8: hook ownership by renderer.jitter (ws/post-8)', () => {
  it('a page-installed hook is never cleared by a stack', () => {
    const r = new Renderer(fakeRendererGpu(createFakeDevice()));
    r.resize(800, 450);
    const camera = Camera.perspective(1, 16 / 9, 0.1, 100);
    const a = new PostStack(r, { taa: { enabled: true } });
    r.post = a;
    for (let i = 0; i < 3; i++) frame(r, camera, i / 60);
    expect(r.jitter).toBe(stackHook(a));

    const page: JitterFn = () => [0.25, -0.25];
    r.setJitter(page);
    // Still attached and resolving: the stack leaves the page's hook in place.
    for (let i = 0; i < 3; i++) frame(r, camera, 1 + i / 60);
    expect(r.jitter).toBe(page);
    // TAA off, detached, destroyed: none of them clears it.
    a.set({ taa: { enabled: false } });
    frame(r, camera, 2);
    expect(r.jitter).toBe(page);
    r.post = null;
    frame(r, camera, 2.1);
    frame(r, camera, 2.2);
    expect(r.jitter).toBe(page);
    a.destroy();
    expect(r.jitter).toBe(page);
  });

  it('a page hook set while the stack is detached survives the stack destroy', () => {
    const r = new Renderer(fakeRendererGpu(createFakeDevice()));
    r.resize(800, 450);
    const camera = Camera.perspective(1, 16 / 9, 0.1, 100);
    const a = new PostStack(r, { taa: { enabled: true } });
    r.post = a;
    for (let i = 0; i < 3; i++) frame(r, camera, i / 60);
    r.post = null;
    frame(r, camera, 1);
    expect(r.jitter).toBeNull();
    const page: JitterFn = () => [0.5, 0.5];
    r.setJitter(page);
    frame(r, camera, 1.1);
    a.destroy();
    expect(r.jitter).toBe(page);
  });
});
