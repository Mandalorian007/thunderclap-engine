/**
 * Flipbook (ws/ergo-2d): frame timing over a list of texture sub-rectangles. Pure: no GPU, no
 * allocation in `update`. A 2D game keeps one per animated sprite, calls `update(dt)` each tick
 * and hands `uv` to its `DrawParams.uv`.
 */

/** A sub-rectangle of a texture, `u0, v0, u1, v1` in 0..1 (what `DrawParams.uv` takes). */
export type UvRect = readonly [u0: number, v0: number, u1: number, v1: number];

export interface FlipbookOptions {
  /** The frames, in play order. Must not be empty. */
  frames: readonly UvRect[];
  /** Frames per second. Default 12. */
  fps?: number;
  /** Wrap to the first frame after the last (default true); otherwise hold the last and set `done`. */
  loop?: boolean;
}

export interface Flipbook {
  /** The frames being played (`play(frames)` swaps them). */
  readonly frames: readonly UvRect[];
  /** Frames per second; settable. */
  fps: number;
  /** Whether the book wraps; settable. */
  loop: boolean;
  /** Advance by `dt` seconds. */
  update(dt: number): void;
  /** The current frame's rectangle. */
  readonly uv: UvRect;
  /** Index of the current frame. */
  readonly frame: number;
  /** True once a non-looping book has shown its last frame for a full frame time. */
  readonly done: boolean;
  /** Back to the first frame, time 0. */
  reset(): void;
  /** Restart from the first frame, optionally with another frame list. */
  play(frames?: readonly UvRect[]): void;
}

/**
 * A grid atlas for `atlasFrames`: `cols × rows` equal cells. `inset` (ws/api-render) pulls each
 * rectangle in by that many texels on every side so linear filtering never samples the next
 * cell (half a texel, 0.5, is the usual fix for bleeding); it needs the texture's `width` and
 * `height` in texels. Default 0.
 */
export interface AtlasGrid {
  cols: number;
  rows: number;
  inset?: number;
  width?: number;
  height?: number;
}

/**
 * The `UvRect`s of a grid atlas's cells, row-major from the top left (`cols × rows` cells); with
 * `indices`, only those cells in that order. Throws when `inset` is set without `width` and
 * `height`. Allocates: call it at load time.
 */
export function atlasFrames(atlas: AtlasGrid, indices?: readonly number[]): UvRect[] {
  const { cols, rows } = atlas;
  const inset = atlas.inset ?? 0;
  let du = 0;
  let dv = 0;
  if (inset !== 0) {
    const { width, height } = atlas;
    if (!(width! > 0) || !(height! > 0)) {
      throw new Error('atlasFrames: inset needs the atlas width and height in texels');
    }
    du = inset / width!;
    dv = inset / height!;
  }
  const n = indices ? indices.length : cols * rows;
  const out: UvRect[] = [];
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k]! : k;
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push([c / cols + du, r / rows + dv, (c + 1) / cols - du, (r + 1) / rows - dv]);
  }
  return out;
}

/** Make a `Flipbook` over `frames` at `fps`. */
export function createFlipbook(opts: FlipbookOptions): Flipbook {
  if (opts.frames.length === 0) throw new Error('createFlipbook: no frames');
  let frames = opts.frames;
  let time = 0;
  let index = 0;
  let done = false;
  const book: Flipbook = {
    fps: opts.fps ?? 12,
    loop: opts.loop ?? true,
    get frames() {
      return frames;
    },
    get uv() {
      return frames[index]!;
    },
    get frame() {
      return index;
    },
    get done() {
      return done;
    },
    update(dt: number): void {
      if (done || !(book.fps > 0)) return;
      time += dt;
      const total = frames.length / book.fps;
      if (book.loop) {
        if (time >= total) time -= total * Math.floor(time / total);
      } else if (time >= total) {
        time = total;
        done = true;
      }
      index = Math.min(frames.length - 1, Math.floor(time * book.fps));
    },
    reset(): void {
      time = 0;
      index = 0;
      done = false;
    },
    play(next?: readonly UvRect[]): void {
      if (next) {
        if (next.length === 0) throw new Error('Flipbook.play: no frames');
        frames = next;
      }
      book.reset();
    },
  };
  return book;
}
