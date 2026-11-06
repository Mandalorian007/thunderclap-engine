import { describe, expect, it } from 'vitest';
import { atlasFrames, createFlipbook, type UvRect } from './flipbook';

const FOUR = atlasFrames({ cols: 2, rows: 2 });

describe('atlasFrames', () => {
  it('walks a grid row-major from the top left, or the given cells', () => {
    expect(FOUR).toEqual([
      [0, 0, 0.5, 0.5],
      [0.5, 0, 1, 0.5],
      [0, 0.5, 0.5, 1],
      [0.5, 0.5, 1, 1],
    ]);
    expect(atlasFrames({ cols: 4, rows: 1 }, [2, 0])).toEqual([
      [0.5, 0, 0.75, 1],
      [0, 0, 0.25, 1],
    ]);
  });
});

describe('createFlipbook', () => {
  it('advances at fps, wraps when looping and hands out the frame list entries themselves', () => {
    const book = createFlipbook({ frames: FOUR, fps: 8 });
    expect(book.frame).toBe(0);
    expect(book.uv).toBe(FOUR[0]);
    book.update(0.125);
    expect(book.frame).toBe(1);
    book.update(0.25);
    expect(book.frame).toBe(3);
    expect(book.uv).toBe(FOUR[3]);
    book.update(0.125);
    expect(book.frame).toBe(0);
    expect(book.done).toBe(false);
    // Big steps wrap any number of times.
    book.update(1.25);
    expect(book.frame).toBe(2);
  });

  it('holds the last frame and reports done when not looping; reset and play start over', () => {
    const book = createFlipbook({ frames: FOUR, fps: 4, loop: false });
    book.update(0.5);
    expect(book.frame).toBe(2);
    expect(book.done).toBe(false);
    book.update(0.25);
    expect(book.frame).toBe(3);
    expect(book.done).toBe(false);
    book.update(0.25);
    expect(book.frame).toBe(3);
    expect(book.done).toBe(true);
    book.update(5);
    expect(book.frame).toBe(3);
    book.reset();
    expect(book.frame).toBe(0);
    expect(book.done).toBe(false);
    const two: UvRect[] = [FOUR[1]!, FOUR[2]!];
    book.update(0.3);
    book.play(two);
    expect(book.frames).toBe(two);
    expect(book.frame).toBe(0);
    expect(book.uv).toBe(FOUR[1]);
    book.update(0.5);
    expect(book.done).toBe(true);
  });

  it('a one-frame book is done after its frame time without looping; fps and loop are live', () => {
    const one = createFlipbook({ frames: [FOUR[0]!], fps: 2, loop: false });
    one.update(0.4);
    expect(one.done).toBe(false);
    one.update(0.1);
    expect(one.done).toBe(true);
    const book = createFlipbook({ frames: FOUR, fps: 1 });
    book.fps = 100;
    book.update(0.02);
    expect(book.frame).toBe(2);
    book.loop = false;
    book.update(1);
    expect(book.done).toBe(true);
  });

  it('refuses an empty frame list and defaults to 12 fps, looping', () => {
    expect(() => createFlipbook({ frames: [] })).toThrow(/no frames/);
    const book = createFlipbook({ frames: FOUR });
    expect(book.fps).toBe(12);
    expect(book.loop).toBe(true);
    expect(() => book.play([])).toThrow(/no frames/);
  });
});
