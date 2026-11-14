/** Post per view (ws/core-passes): a processor per viewport, so stereo eyes share no history. */
import { describe, expect, it } from 'vitest';
import type { PostInputs, PostProcessor } from '../render/renderer';
import { createViewPost, VIEW_POST_MAX } from './view-post';

function fake(log: string[]) {
  return (i: number): PostProcessor => ({
    wantsJitter: true,
    resize: (w, h) => log.push(`resize ${i} ${w}x${h}`),
    encode: (_e, _in, _out, vp) => log.push(`encode ${i} ${vp ? vp.x : '-'}`),
  });
}

const enc = {} as GPUCommandEncoder;
const inputs = {} as PostInputs;
const out = {} as GPUTextureView;
const left = { x: 0, y: 0, width: 100, height: 100 };
const right = { x: 100, y: 0, width: 100, height: 100 };

describe('ViewPost (ws/core-passes)', () => {
  it('gives each viewport its own processor, in the order first seen', () => {
    const log: string[] = [];
    const post = createViewPost(fake(log));
    expect(post.wantsJitter).toBe(true);
    post.resize(200, 100);
    for (let f = 0; f < 2; f++) {
      post.encode(enc, inputs, out, left);
      post.encode(enc, inputs, out, { ...right });
    }
    expect(post.views.length).toBe(2);
    expect(log).toEqual([
      'resize 0 200x100',
      'encode 0 0',
      'resize 1 200x100',
      'encode 1 100',
      'encode 0 0',
      'encode 1 100',
    ]);
  });

  it('a call without a viewport is a view of its own; forView makes and resizes on demand', () => {
    const log: string[] = [];
    const post = createViewPost(fake(log));
    post.resize(64, 32);
    post.encode(enc, inputs, out);
    post.encode(enc, inputs, out);
    expect(post.views.length).toBe(1);
    post.forView(2);
    expect(post.views.length).toBe(3);
    expect(log).toContain('resize 2 64x32');
    expect(() => post.forView(VIEW_POST_MAX)).toThrow();
  });
});
