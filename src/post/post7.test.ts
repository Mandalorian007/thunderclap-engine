/**
 * Post 7 (ws/post-7): a stack recognises its own `renderer.setJitter` hook. Detached from the
 * renderer (`renderer.post` set to another processor or `null`) its hook clears itself at the
 * next frame; it never clears a hook another stack has set since.
 */
import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { type JitterFn, Renderer } from '../render/renderer';
import { PostStack } from './post-stack';

/** A renderer whose installed jitter hook the test can read (`hook()`). */
function setup() {
  const r = new Renderer(fakeRendererGpu(createFakeDevice()));
  r.resize(800, 450);
  let current: JitterFn | null = null;
  const real = r.setJitter.bind(r);
  const spy = vi.fn((fn: JitterFn | null) => {
    current = fn;
    real(fn);
  });
  r.setJitter = spy;
  const camera = Camera.perspective(1, 16 / 9, 0.1, 100);
  const taa = () => new PostStack(r, { taa: { enabled: true } });
  return { r, camera, taa, spy, hook: () => current };
}

/** One frame drawing a depth camera (so TAA resolves). */
const frame = (r: Renderer, camera: Camera, t = 0) => {
  const f = r.beginFrame(t, 1 / 60);
  f.sprite(null, { x: 1, y: 1 });
  r.render(f, camera);
  r.endFrame();
};

/** Whose hook is installed: `a`'s, `b`'s, someone else's, or none. */
const owner = (fn: JitterFn | null, a: PostStack, b: PostStack): string => {
  if (fn === null) return 'none';
  const own = (s: PostStack) => fn === (s as unknown as { jitterFn: JitterFn }).jitterFn;
  return own(a) ? 'a' : own(b) ? 'b' : 'other';
};

describe('post 7: the stack owns its jitter hook (ws/post-7)', () => {
  it('swapping renderer.post from A to B leaves only B hooked; null leaves no hook', () => {
    const { r, camera, taa, hook } = setup();
    const a = taa();
    const b = taa();
    r.post = a;
    frame(r, camera);
    expect(owner(hook(), a, b)).toBe('a');
    frame(r, camera);
    expect(camera.jitter).not.toEqual([0, 0]);

    r.post = b;
    frame(r, camera, 1);
    expect(owner(hook(), a, b)).toBe('b');
    for (let i = 0; i < 3; i++) frame(r, camera, 1 + i / 60);
    expect(owner(hook(), a, b)).toBe('b');
    // The frame after B hooked runs B's sequence from 0.
    expect(camera.jitter).not.toEqual([0, 0]);
    // Destroying A after the swap leaves B's hook alone: it is no longer A's.
    a.destroy();
    expect(owner(hook(), a, b)).toBe('b');

    r.post = null;
    frame(r, camera, 2);
    expect(hook()).toBeNull();
    expect(camera.jitter).toEqual([0, 0]);
    frame(r, camera, 2.1);
    expect(hook()).toBeNull();
    b.destroy();
  });

  it('null clears the hook before the next frame draws, and destroy after it does nothing', () => {
    const { r, camera, taa, hook, spy } = setup();
    const a = taa();
    r.post = a;
    frame(r, camera);
    frame(r, camera);
    expect(hook()).not.toBeNull();
    r.post = null;
    frame(r, camera, 1);
    expect(hook()).toBeNull();
    expect(camera.jitter).toEqual([0, 0]);
    spy.mockClear();
    a.destroy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('a processor that is not the stack clears the hook a frame later (the stack stopped resolving)', () => {
    const { r, camera, taa, hook } = setup();
    const a = taa();
    r.post = a;
    frame(r, camera);
    frame(r, camera);
    r.post = { resize() {}, encode() {} };
    frame(r, camera, 1);
    frame(r, camera, 1.1);
    expect(hook()).toBeNull();
    expect(camera.jitter).toEqual([0, 0]);
    a.destroy();
  });

  it('a wrapper that forwards encode keeps the hook; A back after B hooks again', () => {
    const { r, camera, taa, hook } = setup();
    const a = taa();
    const b = taa();
    r.post = {
      wantsJitter: true,
      resize: (w, h) => a.resize(w, h),
      encode: (e, i, o, v) => a.encode(e, i, o, v),
    };
    for (let i = 0; i < 4; i++) frame(r, camera, i / 60);
    expect(owner(hook(), a, b)).toBe('a');
    r.post = b;
    frame(r, camera, 1);
    frame(r, camera, 1.1);
    expect(owner(hook(), a, b)).toBe('b');
    // B detached: its hook clears itself, and A, attached again, sets its own.
    r.post = a;
    frame(r, camera, 2);
    frame(r, camera, 2.1);
    frame(r, camera, 2.2);
    expect(owner(hook(), a, b)).toBe('a');
    frame(r, camera, 2.3);
    expect(camera.jitter).not.toEqual([0, 0]);
    a.destroy();
    expect(hook()).toBeNull();
    b.destroy();
  });

  it('two stacks resolving every frame do not fight over the hook (the post4 twin)', () => {
    const { r, camera, taa, spy } = setup();
    const a = taa();
    const b = taa();
    r.post = {
      wantsJitter: true,
      resize: (w, h) => {
        a.resize(w, h);
        b.resize(w, h);
      },
      encode: (e, i, o, v) => {
        a.encode(e, i, o, v);
        b.encode(e, i, o, v);
      },
    };
    frame(r, camera);
    spy.mockClear();
    for (let i = 0; i < 8; i++) frame(r, camera, (i + 1) / 60);
    expect(spy).not.toHaveBeenCalled();
    a.destroy();
    b.destroy();
  });
});
