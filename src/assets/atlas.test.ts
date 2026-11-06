import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDevice } from '../render/fake-gpu';
import {
  type AtlasDrawContext,
  type AtlasPixels,
  type AtlasRect,
  createAtlasTexture,
  extrudePixels,
  packAtlas,
} from './atlas';

/** A solid RGBA image. */
function solid(w: number, h: number, rgba: [number, number, number, number]): AtlasPixels {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

/** Pixels where each texel encodes its own x, y (so extrusion is checkable). */
function coords(w: number, h: number): AtlasPixels {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x, y, 7, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

function overlaps(a: AtlasRect, b: AtlasRect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
  );
}

/** Fake 2D context recording what `draw` does. */
function fakeContext() {
  const draws: unknown[][] = [];
  const puts: { data: ImageData; x: number; y: number }[] = [];
  const ctx: AtlasDrawContext = {
    drawImage: (...args: unknown[]) => {
      draws.push(args);
    },
    createImageData: (width, height) =>
      ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
    putImageData: (data, x, y) => {
      puts.push({ data, x, y });
    },
  };
  return { ctx, draws, puts };
}

describe('packAtlas', () => {
  const images = {
    big: solid(60, 40, [255, 0, 0, 255]),
    tall: solid(10, 50, [0, 255, 0, 255]),
    small: solid(8, 8, [0, 0, 255, 255]),
    wide: solid(30, 12, [255, 255, 0, 255]),
    tiny: solid(1, 1, [1, 2, 3, 4]),
  };

  it('places every image inside a power-of-two sheet, padding apart, uvs matching', () => {
    const layout = packAtlas(images, { padding: 2, extrude: 1 });
    expect(Math.log2(layout.width) % 1).toBe(0);
    expect(Math.log2(layout.height) % 1).toBe(0);
    const names = Object.keys(images) as (keyof typeof images)[];
    expect(Object.keys(layout.rects).sort()).toEqual([...names].sort());
    for (const n of names) {
      const r = layout.rects[n];
      expect(r.w).toBe(images[n].width);
      expect(r.h).toBe(images[n].height);
      // Inside, with room for the extrusion.
      expect(r.x).toBeGreaterThanOrEqual(1);
      expect(r.y).toBeGreaterThanOrEqual(1);
      expect(r.x + r.w + 1).toBeLessThanOrEqual(layout.width);
      expect(r.y + r.h + 1).toBeLessThanOrEqual(layout.height);
      expect(r.u0).toBeCloseTo(r.x / layout.width, 9);
      expect(r.v0).toBeCloseTo(r.y / layout.height, 9);
      expect(r.u1).toBeCloseTo((r.x + r.w) / layout.width, 9);
      expect(r.v1).toBeCloseTo((r.y + r.h) / layout.height, 9);
    }
    // Extruded slots (rect grown by 1) stay 2 px apart.
    for (const a of names)
      for (const b of names) {
        if (a === b) continue;
        const ra = layout.rects[a];
        const rb = layout.rects[b];
        const ea = { ...ra, x: ra.x - 1, y: ra.y - 1, w: ra.w + 2, h: ra.h + 2 };
        const eb = { ...rb, x: rb.x - 1, y: rb.y - 1, w: rb.w + 2, h: rb.h + 2 };
        expect(overlaps(ea, eb, 2), `${a} vs ${b}`).toBe(false);
      }
  });

  it('is deterministic and independent of input order when sorting', () => {
    const a = packAtlas(images);
    const b = packAtlas(images);
    const reversed = Object.fromEntries(Object.entries(images).reverse()) as typeof images;
    const c = packAtlas(reversed);
    expect(b.rects).toEqual(a.rects);
    expect(c.rects).toEqual(a.rects);
    expect([c.width, c.height]).toEqual([a.width, a.height]);
  });

  it('keeps input order with sort: false', () => {
    const layout = packAtlas(
      { small: solid(8, 8, [0, 0, 0, 0]), big: solid(32, 32, [0, 0, 0, 0]) },
      {
        sort: false,
        extrude: 0,
        padding: 0,
      },
    );
    expect(layout.rects.small).toMatchObject({ x: 0, y: 0 });
    expect(layout.rects.big.x).toBe(8);
  });

  it('can skip power-of-two sizing and extrusion', () => {
    const layout = packAtlas(
      { a: solid(10, 10, [0, 0, 0, 0]), b: solid(10, 10, [0, 0, 0, 0]) },
      { powerOfTwo: false, extrude: 0, padding: 0 },
    );
    expect(layout.width).toBe(20);
    expect(layout.height).toBe(10);
    expect(layout.rects.a).toMatchObject({ x: 0, y: 0, u0: 0, v0: 0, u1: 0.5, v1: 1 });
    expect(layout.rects.b).toMatchObject({ x: 10, y: 0, u0: 0.5, v0: 0, u1: 1, v1: 1 });
  });

  it('throws naming the image that overflows maxSize', () => {
    expect(() => packAtlas({ huge: solid(70, 10, [0, 0, 0, 0]) }, { maxSize: 64 })).toThrow(
      /"huge".*maxSize is 64/,
    );
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`s${i}`, solid(16, 16, [0, 0, 0, 0])]),
    );
    expect(() => packAtlas(many, { maxSize: 32, extrude: 0, padding: 0 })).toThrow(
      /packAtlas: image "s\d+" does not fit/,
    );
    expect(() => packAtlas({ empty: solid(0, 4, [0, 0, 0, 0]) })).toThrow(/"empty" is 0×4/);
  });

  it('grows the sheet rather than making it taller than wide', () => {
    const many = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`s${i}`, solid(16, 16, [0, 0, 0, 0])]),
    );
    const layout = packAtlas(many, { extrude: 0, padding: 0 });
    expect(layout.height).toBeLessThanOrEqual(layout.width);
    expect(layout.width).toBe(64);
    expect(layout.height).toBe(64);
  });
});

describe('AtlasLayout.draw', () => {
  it('writes pixel sources extruded through createImageData/putImageData', () => {
    const img = coords(3, 2);
    const layout = packAtlas({ img }, { extrude: 1, padding: 0 });
    const { ctx, puts, draws } = fakeContext();
    layout.draw(ctx);
    expect(draws).toEqual([]);
    expect(puts).toHaveLength(1);
    const r = layout.rects.img;
    expect(puts[0]!.x).toBe(r.x - 1);
    expect(puts[0]!.y).toBe(r.y - 1);
    const d = puts[0]!.data;
    expect([d.width, d.height]).toEqual([5, 4]);
    // Centre pixel (1,0 of the source) sits at (2,1) of the slot; the corner copies (0,0).
    expect([...d.data.subarray((1 * 5 + 2) * 4, (1 * 5 + 2) * 4 + 4)]).toEqual([1, 0, 7, 255]);
    expect([...d.data.subarray(0, 4)]).toEqual([0, 0, 7, 255]);
    // Bottom-right corner copies the source's (2,1).
    const br = (3 * 5 + 4) * 4;
    expect([...d.data.subarray(br, br + 4)]).toEqual([2, 1, 7, 255]);
  });

  it('draws bitmaps with the body and eight edge strips', () => {
    const bmp = { width: 4, height: 3 } as unknown as ImageBitmap;
    const layout = packAtlas({ bmp }, { extrude: 2, padding: 0 });
    const { ctx, draws, puts } = fakeContext();
    layout.draw(ctx);
    expect(puts).toEqual([]);
    expect(draws).toHaveLength(9);
    const r = layout.rects.bmp;
    expect(draws[0]).toEqual([bmp, 0, 0, 4, 3, r.x, r.y, 4, 3]);
    // Top strip: source row 0 stretched 2 px above the sprite.
    expect(draws[1]).toEqual([bmp, 0, 0, 4, 1, r.x, r.y - 2, 4, 2]);
    // Bottom-right corner: the last source pixel in the 2×2 past the sprite.
    expect(draws[8]).toEqual([bmp, 3, 2, 1, 1, r.x + 4, r.y + 3, 2, 2]);
  });

  it('draws only the body when extrude is 0', () => {
    const bmp = { width: 4, height: 3 } as unknown as ImageBitmap;
    const layout = packAtlas({ bmp }, { extrude: 0 });
    const { ctx, draws } = fakeContext();
    layout.draw(ctx);
    expect(draws).toHaveLength(1);
  });
});

describe('extrudePixels', () => {
  it('clamps to the edge', () => {
    const out = new Uint8Array(4 * 3 * 4);
    extrudePixels(coords(2, 1), 1, out);
    const px = (x: number, y: number) => [...out.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(px(0, 0)).toEqual([0, 0, 7, 255]);
    expect(px(3, 2)).toEqual([1, 0, 7, 255]);
    expect(px(1, 1)).toEqual([0, 0, 7, 255]);
    expect(px(2, 1)).toEqual([1, 0, 7, 255]);
    expect(() => extrudePixels(coords(2, 1), 1, new Uint8Array(4))).toThrow(/too small/);
  });
});

describe('createAtlasTexture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('draws into an OffscreenCanvas and uploads it with loadTexture', () => {
    const made: { w: number; h: number; ctx: ReturnType<typeof fakeContext> }[] = [];
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          const f = fakeContext();
          made.push({ w: this.width, h: this.height, ctx: f });
          return f.ctx;
        }
      },
    );
    const fake = createFakeDevice();
    const copies: unknown[] = [];
    (fake.device.queue as unknown as Record<string, unknown>).copyExternalImageToTexture = (
      src: unknown,
    ) => copies.push(src);
    const images = { a: solid(4, 4, [1, 1, 1, 1]), b: solid(2, 2, [2, 2, 2, 2]) };
    const layout = packAtlas(images);
    const { texture, rects } = createAtlasTexture(fake.device, layout, images, { mips: false });
    expect(made).toHaveLength(1);
    expect([made[0]!.w, made[0]!.h]).toEqual([layout.width, layout.height]);
    expect(made[0]!.ctx.puts).toHaveLength(2);
    expect(copies).toHaveLength(1);
    expect(texture.width).toBe(layout.width);
    expect(texture.height).toBe(layout.height);
    expect(texture.mipLevels).toBe(1);
    expect(rects).toBe(layout.rects);
    texture.destroy();
  });
});
