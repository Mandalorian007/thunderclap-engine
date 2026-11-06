/**
 * Runtime sprite atlas: `packAtlas` lays loose images out on one sheet (shelf packing, tallest
 * first), `AtlasLayout.draw` paints them onto a 2D canvas context with their edges extruded into
 * the padding, and `createAtlasTexture` does that into an `OffscreenCanvas` and uploads it with
 * `loadTexture`. The packer is pure (no DOM), so Workers and Node tests run it on
 * `{ width, height, data }` sources.
 */
import { type LoadTextureOptions, loadTexture, type Texture } from '../render/texture';

/** Tightly packed RGBA8 texels (`ImageData` is one). */
export interface AtlasPixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** An image the atlas can place: a decoded bitmap, a canvas, or raw RGBA8 texels. */
export type AtlasSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas | AtlasPixels;

export interface AtlasOptions {
  /** Gap in px between two sprites' extruded slots, and nothing else (default 1). */
  padding?: number;
  /** Largest width or height the sheet may reach (default 4096); past it `packAtlas` throws. */
  maxSize?: number;
  /** Round the sheet's width and height up to powers of two (default true). */
  powerOfTwo?: boolean;
  /**
   * Pixels of each sprite's edge copied outward on every side (default 1), so linear filtering
   * and mip reduction at a sprite's border never bleed a neighbour or the clear colour in.
   */
  extrude?: number;
  /**
   * Order sprites tallest first, then widest, then by name (default true): the shelf packer's
   * best case. `false` keeps the input order. Either way the result is deterministic.
   */
  sort?: boolean;
}

/** Where one image sits: pixels (`x y w h`) and texture coordinates (`u0 v0 u1 v1`). */
export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** The subset of a 2D context `AtlasLayout.draw` uses (so tests can hand it a fake). */
export interface AtlasDrawContext {
  drawImage(
    image: Exclude<AtlasSource, AtlasPixels>,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  createImageData(width: number, height: number): ImageData;
  putImageData(data: ImageData, dx: number, dy: number): void;
}

export interface AtlasLayout<N extends string = string> {
  width: number;
  height: number;
  rects: Record<N, AtlasRect>;
  /** The `extrude` the layout was packed with (what `draw` paints around each sprite). */
  extrude: number;
  /**
   * Paint every image at its rect, with `extrude` px of its edge pixels copied outward on each
   * side. Bitmaps and canvases go through `drawImage`; pixel sources are extruded in TS and
   * written with `putImageData`.
   */
  draw(ctx: AtlasDrawContext): void;
}

interface Slot {
  name: string;
  w: number;
  h: number;
}

function isPixels(s: AtlasSource): s is AtlasPixels {
  return 'data' in s && ArrayBuffer.isView((s as AtlasPixels).data);
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Shelf-pack `slots` (in order) into `width`; returns positions and the height used. */
function shelfPack(
  slots: Slot[],
  width: number,
  padding: number,
): { pos: { x: number; y: number }[]; height: number; used: number; overflow: string | null } {
  const pos: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  let used = 0;
  for (const s of slots) {
    if (s.w > width) return { pos, height: 0, used, overflow: s.name };
    if (x > 0 && x + s.w > width) {
      x = 0;
      y += shelf + padding;
      shelf = 0;
    }
    pos.push({ x, y });
    x += s.w + padding;
    if (x - padding > used) used = x - padding;
    if (s.h > shelf) shelf = s.h;
  }
  return { pos, height: slots.length ? y + shelf : 0, used, overflow: null };
}

/**
 * Lay `images` out on one sheet. Each sprite's slot is its size plus `extrude` on every side;
 * slots are `padding` px apart and start at the sheet's top-left corner. Throws naming the image
 * that does not fit when the sheet would exceed `maxSize`.
 */
export function packAtlas<N extends string>(
  images: Record<N, AtlasSource>,
  opts: AtlasOptions = {},
): AtlasLayout<N> {
  const padding = Math.max(0, Math.floor(opts.padding ?? 1));
  const maxSize = Math.max(1, Math.floor(opts.maxSize ?? 4096));
  const extrude = Math.max(0, Math.floor(opts.extrude ?? 1));
  const pow2 = opts.powerOfTwo ?? true;
  const sort = opts.sort ?? true;

  const names = Object.keys(images) as N[];
  const slots: Slot[] = names.map((name) => {
    const img = images[name];
    if (!(img.width > 0 && img.height > 0)) {
      throw new Error(`packAtlas: image "${name}" is ${img.width}×${img.height}`);
    }
    return { name, w: img.width + 2 * extrude, h: img.height + 2 * extrude };
  });
  if (sort) {
    slots.sort(
      (a, b) => b.h - a.h || b.w - a.w || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  }

  let area = 0;
  let widest = 0;
  for (const s of slots) {
    area += (s.w + padding) * (s.h + padding);
    if (s.w > widest) widest = s.w;
  }
  const roundUp = (n: number): number => (pow2 ? nextPow2(n) : Math.ceil(n));
  if (widest > maxSize) {
    const s = slots.find((s) => s.w === widest)!;
    throw new Error(
      `packAtlas: image "${s.name}" is ${s.w}px wide with its extrusion; maxSize is ${maxSize}`,
    );
  }

  let width = Math.min(maxSize, roundUp(Math.max(widest, Math.sqrt(area))));
  let packed = shelfPack(slots, width, padding);
  let height = roundUp(packed.height);
  // A sheet taller than it is wide (or than maxSize) is widened until it fits or cannot grow.
  while ((height > width || height > maxSize) && width < maxSize) {
    width = Math.min(maxSize, pow2 ? width * 2 : Math.ceil(width * 1.25));
    packed = shelfPack(slots, width, padding);
    height = roundUp(packed.height);
  }
  if (packed.overflow !== null || height > maxSize) {
    // The first slot whose bottom edge crosses maxSize is the one that does not fit.
    let culprit = packed.overflow;
    if (culprit === null) {
      for (let i = 0; i < slots.length; i++) {
        if (packed.pos[i]!.y + slots[i]!.h > maxSize) {
          culprit = slots[i]!.name;
          break;
        }
      }
    }
    throw new Error(
      `packAtlas: image "${culprit}" does not fit: ${slots.length} images need more than ${maxSize}×${maxSize}`,
    );
  }
  // The sheet is only as wide as its widest shelf (rounded up when powerOfTwo).
  width = Math.max(1, roundUp(packed.used));
  if (height < 1) height = 1;

  const rects = {} as Record<N, AtlasRect>;
  slots.forEach((s, i) => {
    const p = packed.pos[i]!;
    const x = p.x + extrude;
    const y = p.y + extrude;
    const w = s.w - 2 * extrude;
    const h = s.h - 2 * extrude;
    rects[s.name as N] = {
      x,
      y,
      w,
      h,
      u0: x / width,
      v0: y / height,
      u1: (x + w) / width,
      v1: (y + h) / height,
    };
  });

  return {
    width,
    height,
    rects,
    extrude,
    draw(ctx) {
      for (const name of names) drawOne(ctx, images[name], rects[name], extrude);
    },
  };
}

function drawOne(ctx: AtlasDrawContext, img: AtlasSource, r: AtlasRect, e: number): void {
  if (isPixels(img)) {
    const out = ctx.createImageData(r.w + 2 * e, r.h + 2 * e);
    extrudePixels(img, e, out.data);
    ctx.putImageData(out, r.x - e, r.y - e);
    return;
  }
  const { w, h } = r;
  ctx.drawImage(img, 0, 0, w, h, r.x, r.y, w, h);
  if (e <= 0) return;
  const x0 = r.x - e;
  const y0 = r.y - e;
  const x1 = r.x + w;
  const y1 = r.y + h;
  // Edges: a one-pixel strip of the source stretched across the extrusion.
  ctx.drawImage(img, 0, 0, w, 1, r.x, y0, w, e); // top
  ctx.drawImage(img, 0, h - 1, w, 1, r.x, y1, w, e); // bottom
  ctx.drawImage(img, 0, 0, 1, h, x0, r.y, e, h); // left
  ctx.drawImage(img, w - 1, 0, 1, h, x1, r.y, e, h); // right
  // Corners: one source pixel each.
  ctx.drawImage(img, 0, 0, 1, 1, x0, y0, e, e);
  ctx.drawImage(img, w - 1, 0, 1, 1, x1, y0, e, e);
  ctx.drawImage(img, 0, h - 1, 1, 1, x0, y1, e, e);
  ctx.drawImage(img, w - 1, h - 1, 1, 1, x1, y1, e, e);
}

/**
 * Copy `src` into the centre of an RGBA buffer `(w + 2e) × (h + 2e)` and fill the border with
 * the nearest edge pixel (clamp-to-edge in software). Exported for tests and custom drawers.
 */
export function extrudePixels(
  src: AtlasPixels,
  e: number,
  out: Uint8ClampedArray | Uint8Array,
): void {
  const { width: w, height: h, data } = src;
  const W = w + 2 * e;
  const H = h + 2 * e;
  if (out.length < W * H * 4) throw new Error('extrudePixels: output too small');
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - e));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - e));
      const si = (sy * w + sx) * 4;
      const di = (y * W + x) * 4;
      out[di] = data[si]!;
      out[di + 1] = data[si + 1]!;
      out[di + 2] = data[si + 2]!;
      out[di + 3] = data[si + 3]!;
    }
  }
}

export interface AtlasTextureOptions extends LoadTextureOptions {
  /** The canvas to draw into (default a new `OffscreenCanvas` of the layout's size). */
  canvas?: OffscreenCanvas | HTMLCanvasElement;
}

/** The atlas on the GPU: `createAtlasTexture`'s result. */
export interface AtlasTexture<N extends string = string> {
  texture: Texture;
  rects: Record<N, AtlasRect>;
}

/**
 * Draw `layout` into an `OffscreenCanvas` and upload it with `loadTexture` (sRGB, mips on by
 * default; pass `mips: false` for pixel art, with `filter` or `format` as `loadTexture` takes).
 * Allocates; call it at load time.
 */
export function createAtlasTexture<N extends string>(
  device: GPUDevice,
  layout: AtlasLayout<N>,
  images: Record<N, AtlasSource>,
  opts: AtlasTextureOptions = {},
): AtlasTexture<N> {
  const { canvas: given, ...texOpts } = opts;
  const canvas = given ?? new OffscreenCanvas(layout.width, layout.height);
  if (canvas.width !== layout.width || canvas.height !== layout.height) {
    canvas.width = layout.width;
    canvas.height = layout.height;
  }
  const ctx = (canvas as OffscreenCanvas).getContext('2d') as AtlasDrawContext | null;
  if (!ctx) throw new Error('createAtlasTexture: no 2d context');
  // `images` is the layout's own source map; a different one with the same names draws too.
  packLayoutWith(layout, images).draw(ctx);
  const texture = loadTexture(device, canvas, { label: 'atlas', ...texOpts });
  return { texture, rects: layout.rects };
}

/** The layout's `draw` over `images` (the same object it was packed from, or a stand-in). */
function packLayoutWith<N extends string>(
  layout: AtlasLayout<N>,
  images: Record<N, AtlasSource>,
): { draw(ctx: AtlasDrawContext): void } {
  return {
    draw(ctx) {
      for (const name of Object.keys(layout.rects) as N[]) {
        const img = images[name];
        if (!img) throw new Error(`createAtlasTexture: no image for "${name}"`);
        drawOne(ctx, img, layout.rects[name], layout.extrude);
      }
    },
  };
}
