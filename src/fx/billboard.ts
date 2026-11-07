import type { Camera } from '../render/camera';
import type { Drawable, Frame } from '../render/frame';
import type { Renderer } from '../render/renderer';
import type { Texture } from '../render/texture';
import { createShaderModule } from '../render/wgsl';
import {
  BB_FLAG_BAR,
  BB_FLAG_PX,
  BB_FLAG_TEXTURED,
  BB_FLAG_YAW,
  BILLBOARD_BYTES,
  BILLBOARD_FLOATS,
  BILLBOARD_WGSL,
} from './billboard-wgsl';
import { type AtlasRegion, TextAtlas, type TextAtlasOptions, type TextStyle } from './text-atlas';

/** `'camera'`: the quad faces the eye. `'cameraY'`: it turns about y only (stays upright). */
export type BillboardFacing = 'camera' | 'cameraY';
/** `'test'`: hidden behind scene geometry (no depth write). `'always'`: drawn over everything. */
export type BillboardDepth = 'test' | 'always';
/** `[w, h]` in world units, or `{ px: [w, h] }` in logical px, the same size at any distance. */
export type BillboardSize = readonly [number, number] | { readonly px: readonly [number, number] };

export interface BillboardDesc {
  /**
   * World anchor. A `Float32Array` (x, y, z at 0..2) is followed live, so a plate tracks the
   * thing it is over without being told; a tuple is copied.
   */
  position: Float32Array | readonly [number, number, number];
  /** World-space offset from `position` (a head height). Default none. */
  offset?: readonly [number, number, number];
  size: BillboardSize;
  /** An atlas region to show (`billboards.text(...)`), or `null`/unset for a solid colour. */
  region?: AtlasRegion | null;
  /**
   * A text plate (ws/fx-4): `text` in its own atlas cell (`TextAtlas.cell`), changed later with
   * `handle.setText`. Overrides `region`. Size the quad to the text with `billboards.measure`.
   */
  text?: string;
  /** The plate's style (with `text`). */
  textStyle?: TextStyle;
  /** Linear RGBA multiplier (straight alpha). Default white. */
  color?: ArrayLike<number>;
  /** Default `'camera'`. `{ px }` sizes are always screen-aligned. */
  facing?: BillboardFacing;
  /** Default `'test'`. */
  depth?: BillboardDepth;
  /**
   * Seconds to live: the quad holds for the first half, fades over the second and removes
   * itself at the end. Default none (lives until `remove`).
   */
  life?: number;
  /** World units per second added to the anchor (damage numbers drift up). Default none. */
  velocity?: readonly [number, number, number];
  /**
   * A health bar in one quad: `color` fills `fraction` of the width from the left, `bg` the
   * rest. `billboards.bar(...)` builds this. Default none.
   */
  bar?: { fraction: number; bg: ArrayLike<number> };
}

export interface BillboardsOptions {
  /** Billboards the buffers start with (they grow when full). Default 1024. */
  capacity?: number;
  /** The text atlas: canvas `size` (default 1024) and default `font`. */
  atlas?: TextAtlasOptions;
  label?: string;
}

const WHITE = [1, 1, 1, 1] as const;
const ZERO3 = [0, 0, 0] as const;
const F = BILLBOARD_FLOATS;
/** Added to the sort key of `depth: 'always'` quads so they draw after every `'test'` one. */
const ALWAYS_KEY = 1e9;

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/**
 * World units a span of `px` logical px covers at `viewDistance` from a camera whose projection
 * is `projection` (column-major; `projection[5]` is the vertical scale) on a viewport
 * `viewportPx` logical px tall. The shader applies the same ratio in clip space for `{ px }`
 * sizes; use this on the CPU to size something in world units to match a px plate.
 */
export function pxToWorld(
  px: number,
  viewDistance: number,
  projection: ArrayLike<number>,
  viewportPx: number,
): number {
  const scale = projection[5] ?? 1;
  const w = Math.abs(projection[11] ?? 0) > 0 ? viewDistance : 1;
  return ((px / viewportPx) * 2 * w) / scale;
}

/**
 * One billboard, returned by `Billboards.add`. Setters change it in place; it is `alive` until
 * `remove` or its `life` runs out, after which the setters do nothing.
 */
export class BillboardHandle {
  /** @internal slot in the owner's arrays, -1 when dead. */
  slot = -1;

  constructor(private readonly owner: Billboards) {}

  get alive(): boolean {
    return this.slot >= 0;
  }

  set position(p: Float32Array | readonly [number, number, number]) {
    if (this.slot >= 0) this.owner.setPosition(this.slot, p);
  }
  set offset(o: readonly [number, number, number]) {
    if (this.slot >= 0) this.owner.setOffset(this.slot, o);
  }
  set color(c: ArrayLike<number>) {
    if (this.slot >= 0) this.owner.setColor(this.slot, c);
  }
  set size(s: BillboardSize) {
    if (this.slot >= 0) this.owner.setSize(this.slot, s);
  }
  set region(r: AtlasRegion | null) {
    if (this.slot >= 0) this.owner.setRegion(this.slot, r);
  }
  /** The text plate's text (`desc.text`, `setText`); null when not a plate. */
  get text(): string | null {
    return this.slot >= 0 ? this.owner.plateText(this.slot) : null;
  }
  /**
   * Change a text plate's text (ws/fx-4). Re-rasterised into the plate's own atlas cell when it
   * fits (no new region, no new texture), else into a wider cell: the quad's height stays and
   * its width grows with the cell, so the glyphs keep their scale. A handle that is not a plate
   * becomes one, in the default style, at its current size.
   */
  setText(text: string): void {
    if (this.slot >= 0) this.owner.setText(this.slot, text);
  }
  /** The filled share of a bar quad, 0..1. */
  set fraction(f: number) {
    if (this.slot >= 0) this.owner.setFraction(this.slot, f);
  }
}

/**
 * World-anchored, camera-facing quads in one batch: name plates, damage numbers, health bars,
 * markers. Each shows a region of the shared text atlas or a solid colour, is sized in world
 * units or in screen px, optionally fades out over `life` and drifts by `velocity`. Alpha
 * blended, depth tested without writing (or drawn over everything with `depth: 'always'`),
 * sorted back to front each `update`. Draw with `frame.drawable(billboards)`.
 *
 * ```ts
 * const bb = createBillboards(renderer);
 * const plate = bb.add({ position: hero.position, offset: [0, 2, 0], size: { px: [160, 40] },
 *                        region: bb.text('Hero', { size: 28, stroke: '#000', strokeWidth: 4 }) });
 * bb.add({ position: hero.position, offset: [0, 2.3, 0], size: [1, 0.12], life: 0.9,
 *          velocity: [0, 1.2, 0], region: bb.text('-37', { color: '#f44' }) });
 * bb.update(dt, camera);        // ages, drifts, sorts
 * frame.drawable(bb);           // inside the scene's render
 * ```
 *
 * Nothing allocates per frame once the buffers are big enough; `add` past `capacity` doubles
 * them.
 */
export class Billboards implements Drawable {
  /** The atlas canvas as a texture, uploaded when the atlas changed (once per frame at most). */
  readonly atlasTexture: Texture;
  /** The text atlas behind `text()`. */
  readonly atlas: TextAtlas;
  /** Draw calls the last `draw` issued (0, 1 or 2: one per depth mode in use). */
  draws = 0;

  private readonly renderer: Renderer;
  private readonly device: GPUDevice;
  private readonly label: string;
  private capacity: number;
  private n = 0;
  // Per slot, CPU side.
  private anchor: Float32Array;
  private tracked: (Float32Array | null)[];
  private offset: Float32Array;
  private velocity: Float32Array;
  /** age, life (life <= 0: immortal). */
  private life: Float32Array;
  private rgba: Float32Array;
  private mode: Uint8Array;
  private regions: (AtlasRegion | null)[];
  /** A text plate's text (its region an owned atlas cell); null when not a plate. */
  private plates: (string | null)[];
  private handles: BillboardHandle[];
  /** Instance data per slot, in `BILLBOARD_WGSL`'s layout. */
  private inst: Float32Array;
  // Per frame.
  private order: Uint32Array;
  private keys: Float32Array;
  private upload: Float32Array<ArrayBuffer>;
  private testCount = 0;
  private alwaysCount = 0;
  private uploadDirty = false;
  private buffer: GPUBuffer;
  private group: GPUBindGroup;
  private readonly groupLayout: GPUBindGroupLayout;
  private readonly pipelineDesc: GPURenderPipelineDescriptor;
  private readonly flatPipeline: GPURenderPipeline;
  /** Per depth format: [test, always] pipelines, made on first use. */
  private readonly depthPipelines = new Map<
    GPUTextureFormat,
    [GPURenderPipeline, GPURenderPipeline]
  >();

  constructor(renderer: Renderer, opts: BillboardsOptions = {}) {
    const device = renderer.device;
    this.renderer = renderer;
    this.device = device;
    this.label = opts.label ?? 'billboards';
    const cap = Math.max(16, Math.floor(opts.capacity ?? 1024));
    this.capacity = cap;
    this.anchor = new Float32Array(cap * 3);
    this.tracked = new Array<Float32Array | null>(cap).fill(null);
    this.offset = new Float32Array(cap * 3);
    this.velocity = new Float32Array(cap * 3);
    this.life = new Float32Array(cap * 2);
    this.rgba = new Float32Array(cap * 4);
    this.mode = new Uint8Array(cap);
    this.regions = new Array<AtlasRegion | null>(cap).fill(null);
    this.plates = new Array<string | null>(cap).fill(null);
    this.handles = new Array<BillboardHandle>(cap);
    this.inst = new Float32Array(cap * F);
    this.order = new Uint32Array(cap);
    this.keys = new Float32Array(cap);
    this.upload = new Float32Array(cap * F);

    this.atlas = new TextAtlas(opts.atlas);
    this.atlasTexture = renderer.createTexture({
      width: this.atlas.size,
      height: this.atlas.size,
      format: 'rgba8unorm-srgb',
      label: `${this.label}-atlas`,
    });

    this.groupLayout = device.createBindGroupLayout({
      label: `${this.label}-layout`,
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.buffer = this.makeBuffer(cap);
    this.group = this.makeGroup();
    const mod = createShaderModule(device, BILLBOARD_WGSL, this.label);
    this.pipelineDesc = {
      label: this.label,
      layout: device.createPipelineLayout({
        bindGroupLayouts: [renderer.globalsLayout, this.groupLayout],
      }),
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: {
        module: mod,
        entryPoint: 'fs',
        targets: renderer.sceneFormats.map((format) => ({ format, blend: ALPHA_BLEND })),
      },
      primitive: { topology: 'triangle-list' },
    };
    this.flatPipeline = device.createRenderPipeline(this.pipelineDesc);
  }

  /** Live billboards. */
  get count(): number {
    return this.n;
  }

  /** Share of the atlas canvas in use, 0..1. */
  get atlasUsed(): number {
    return this.atlas.used;
  }

  private makeBuffer(cap: number): GPUBuffer {
    return this.device.createBuffer({
      label: this.label,
      size: cap * BILLBOARD_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private makeGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      label: this.label,
      layout: this.groupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: this.renderer.samplers['linear-clamp'] },
        { binding: 2, resource: this.atlasTexture.view },
      ],
    });
  }

  /** Double every array and the GPU buffer (only when `add` finds the batch full). */
  private grow(): void {
    const cap = this.capacity * 2;
    const copy = <T extends Float32Array | Uint8Array | Uint32Array>(old: T, per: number): T => {
      const out = new (old.constructor as new (n: number) => T)(cap * per);
      out.set(old as never);
      return out;
    };
    this.anchor = copy(this.anchor, 3);
    this.offset = copy(this.offset, 3);
    this.velocity = copy(this.velocity, 3);
    this.life = copy(this.life, 2);
    this.rgba = copy(this.rgba, 4);
    this.mode = copy(this.mode, 1);
    this.inst = copy(this.inst, F);
    this.order = copy(this.order, 1);
    this.keys = copy(this.keys, 1);
    this.upload = new Float32Array(cap * F);
    this.tracked.length = cap;
    this.regions.length = cap;
    this.plates.length = cap;
    this.handles.length = cap;
    for (let i = this.capacity; i < cap; i++) {
      this.tracked[i] = null;
      this.regions[i] = null;
      this.plates[i] = null;
    }
    this.capacity = cap;
    this.buffer.destroy();
    this.buffer = this.makeBuffer(cap);
    this.group = this.makeGroup();
  }

  /** Add a billboard; the handle changes or removes it later. */
  add(desc: BillboardDesc): BillboardHandle {
    if (this.n === this.capacity) this.grow();
    const i = this.n++;
    const h = new BillboardHandle(this);
    h.slot = i;
    this.handles[i] = h;
    this.setPosition(i, desc.position);
    this.setOffset(i, desc.offset ?? ZERO3);
    const v = desc.velocity ?? ZERO3;
    this.velocity[i * 3] = v[0];
    this.velocity[i * 3 + 1] = v[1];
    this.velocity[i * 3 + 2] = v[2];
    this.life[i * 2] = 0;
    this.life[i * 2 + 1] = desc.life ?? 0;
    this.mode[i] = desc.depth === 'always' ? 1 : 0;
    const o = i * F;
    const inst = this.inst;
    inst.fill(0, o, o + F);
    inst[o + 3] = desc.facing === 'cameraY' ? BB_FLAG_YAW : 0;
    this.setSize(i, desc.size);
    this.plates[i] = null;
    this.regions[i] = null;
    if (desc.text !== undefined) this.makePlate(i, desc.text, desc.textStyle);
    else this.setRegion(i, desc.region ?? null);
    this.setColor(i, desc.color ?? WHITE);
    const bar = desc.bar;
    if (bar) {
      inst[o + 3] = (inst[o + 3]! | BB_FLAG_BAR) >>> 0;
      inst[o + 6] = bar.fraction;
      inst[o + 16] = bar.bg[0]!;
      inst[o + 17] = bar.bg[1]!;
      inst[o + 18] = bar.bg[2]!;
      inst[o + 19] = bar.bg[3] ?? 1;
    }
    return h;
  }

  /** Remove a billboard now (a no-op for one already gone). */
  remove(handle: BillboardHandle): void {
    const i = handle.slot;
    if (i < 0 || this.handles[i] !== handle) return;
    this.removeAt(i);
  }

  /** Remove every billboard. Atlas text stays cached; text plates give their cells back. */
  clear(): void {
    for (let i = 0; i < this.n; i++) {
      this.handles[i]!.slot = -1;
      this.releasePlate(i);
      this.tracked[i] = null;
      this.regions[i] = null;
    }
    this.n = 0;
    this.testCount = 0;
    this.alwaysCount = 0;
    this.uploadDirty = true;
  }

  /** Swap-remove slot `i`: the last slot moves into it. */
  private removeAt(i: number): void {
    const last = --this.n;
    this.handles[i]!.slot = -1;
    this.releasePlate(i);
    if (i !== last) {
      const h = this.handles[last]!;
      h.slot = i;
      this.handles[i] = h;
      this.tracked[i] = this.tracked[last];
      this.regions[i] = this.regions[last];
      this.plates[i] = this.plates[last]!;
      this.mode[i] = this.mode[last]!;
      this.anchor.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.offset.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.velocity.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.life.copyWithin(i * 2, last * 2, last * 2 + 2);
      this.rgba.copyWithin(i * 4, last * 4, last * 4 + 4);
      this.inst.copyWithin(i * F, last * F, last * F + F);
    }
    this.tracked[last] = null;
    this.regions[last] = null;
    this.plates[last] = null;
  }

  /**
   * The atlas region for `text` in `style`, rasterised on first use and cached (text + style).
   * Throws when the string is larger than the whole atlas canvas.
   */
  text(text: string, style?: TextStyle): AtlasRegion {
    const r = this.atlas.text(text, style);
    if (!r) throw new Error(`billboards: "${text}" does not fit a ${this.atlas.size}px atlas`);
    return r;
  }

  /**
   * A health bar in one quad, `fraction` (0..1) of its width in `fg` and the rest in `bg`:
   * spread it into `add` with a `position`, then set `handle.fraction`.
   */
  bar(
    fraction: number,
    size: BillboardSize,
    fg: ArrayLike<number>,
    bg: ArrayLike<number>,
  ): Omit<BillboardDesc, 'position'> {
    return { size, color: fg, region: null, bar: { fraction, bg } };
  }

  /** @internal */
  setPosition(i: number, p: Float32Array | readonly [number, number, number]): void {
    if (p instanceof Float32Array) {
      this.tracked[i] = p;
    } else {
      this.tracked[i] = null;
      this.anchor[i * 3] = p[0];
      this.anchor[i * 3 + 1] = p[1];
      this.anchor[i * 3 + 2] = p[2];
    }
  }

  /** @internal */
  setOffset(i: number, o: readonly [number, number, number]): void {
    this.offset[i * 3] = o[0];
    this.offset[i * 3 + 1] = o[1];
    this.offset[i * 3 + 2] = o[2];
  }

  /** @internal */
  setColor(i: number, c: ArrayLike<number>): void {
    const o = i * 4;
    this.rgba[o] = c[0]!;
    this.rgba[o + 1] = c[1]!;
    this.rgba[o + 2] = c[2]!;
    this.rgba[o + 3] = c[3] ?? 1;
  }

  /** @internal */
  setSize(i: number, s: BillboardSize): void {
    const o = i * F;
    const inst = this.inst;
    const flags = inst[o + 3]! & ~BB_FLAG_PX;
    if ('px' in s) {
      inst[o + 3] = flags | BB_FLAG_PX;
      inst[o + 4] = s.px[0];
      inst[o + 5] = s.px[1];
    } else {
      inst[o + 3] = flags;
      inst[o + 4] = s[0];
      inst[o + 5] = s[1];
    }
  }

  /**
   * The width and height, in atlas px, a text plate of `text` in `style` gets (its cell): size
   * a plate's quad to this aspect.
   */
  measure(text: string, style?: TextStyle): { width: number; height: number } {
    return this.atlas.cellSize(text, style);
  }

  /** @internal */
  plateText(i: number): string | null {
    return this.plates[i] ?? null;
  }

  /** @internal */
  setText(i: number, text: string): void {
    const old = this.regions[i];
    if (this.plates[i] === null || !old) {
      this.makePlate(i, text);
      return;
    }
    const r = this.atlas.rewrite(old, text);
    if (!r) throw new Error(`billboards: "${text}" does not fit a ${this.atlas.size}px atlas`);
    if (r !== old) {
      // A wider cell: keep the height and the glyph scale.
      this.inst[i * F + 4] *= r.width / old.width;
      this.regions[i] = null;
      this.writeRegion(i, r);
    }
    this.plates[i] = text;
  }

  private makePlate(i: number, text: string, style?: TextStyle): void {
    const r = this.atlas.cell(text, style);
    if (!r) throw new Error(`billboards: "${text}" does not fit a ${this.atlas.size}px atlas`);
    this.setRegion(i, r);
    this.plates[i] = text;
  }

  private releasePlate(i: number): void {
    if (this.plates[i] === null) return;
    const r = this.regions[i];
    if (r) this.atlas.release(r);
    this.plates[i] = null;
  }

  /** @internal */
  setRegion(i: number, r: AtlasRegion | null): void {
    if (this.regions[i] !== r) this.releasePlate(i);
    this.writeRegion(i, r);
  }

  private writeRegion(i: number, r: AtlasRegion | null): void {
    const o = i * F;
    const inst = this.inst;
    this.regions[i] = r;
    const flags = inst[o + 3]! & ~BB_FLAG_TEXTURED;
    if (r) {
      inst[o + 3] = flags | BB_FLAG_TEXTURED;
      inst[o + 8] = r.u0;
      inst[o + 9] = r.v0;
      inst[o + 10] = r.u1;
      inst[o + 11] = r.v1;
    } else {
      inst[o + 3] = flags;
    }
  }

  /** @internal */
  setFraction(i: number, f: number): void {
    this.inst[i * F + 6] = f;
  }

  /**
   * Age and drift every billboard, remove the ones past their `life`, resolve anchors and fades
   * into the instance data and sort back to front for `camera` (without one, submission order).
   * Call once per update or frame; allocation-free.
   */
  update(dt: number, camera?: Camera | null): void {
    const life = this.life;
    const vel = this.velocity;
    const anchor = this.anchor;
    const offset = this.offset;
    const tracked = this.tracked;
    const inst = this.inst;
    const rgba = this.rgba;
    const keys = this.keys;
    const order = this.order;
    const atlas = this.atlas;
    const view = camera ? camera.view : null;
    // Expire from the end so swap-removes never skip a slot.
    for (let i = this.n - 1; i >= 0; i--) {
      const total = life[i * 2 + 1]!;
      if (total <= 0) continue;
      const age = life[i * 2]! + dt;
      life[i * 2] = age;
      if (age >= total) this.removeAt(i);
    }
    const n = this.n;
    let test = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const t = tracked[i];
      // Velocity moves the copied anchor, or the offset of a tracked one.
      const dst = t ? offset : anchor;
      dst[i3] = dst[i3]! + vel[i3]! * dt;
      dst[i3 + 1] = dst[i3 + 1]! + vel[i3 + 1]! * dt;
      dst[i3 + 2] = dst[i3 + 2]! + vel[i3 + 2]! * dt;
      const x = (t ? t[0]! : anchor[i3]!) + offset[i3]!;
      const y = (t ? t[1]! : anchor[i3 + 1]!) + offset[i3 + 1]!;
      const z = (t ? t[2]! : anchor[i3 + 2]!) + offset[i3 + 2]!;
      const o = i * F;
      inst[o] = x;
      inst[o + 1] = y;
      inst[o + 2] = z;
      const total = life[i * 2 + 1]!;
      let fade = 1;
      if (total > 0) {
        const left = 1 - life[i * 2]! / total;
        fade = left < 0.5 ? left * 2 : 1;
      }
      inst[o + 12] = rgba[i * 4]!;
      inst[o + 13] = rgba[i * 4 + 1]!;
      inst[o + 14] = rgba[i * 4 + 2]!;
      inst[o + 15] = rgba[i * 4 + 3]! * fade;
      const r = this.regions[i];
      if (r) atlas.touch(r);
      const z_view = view ? view[2]! * x + view[6]! * y + view[10]! * z + view[14]! : 0;
      const always = this.mode[i]! === 1;
      if (!always) test++;
      keys[i] = (always ? ALWAYS_KEY : 0) + z_view;
      order[i] = i;
    }
    this.testCount = test;
    this.alwaysCount = n - test;
    // Insertion sort by key ascending (farther view z is more negative, so back to front).
    // Frame-to-frame coherence keeps it near linear.
    for (let i = 1; i < n; i++) {
      const idx = order[i]!;
      const k = keys[idx]!;
      let j = i - 1;
      while (j >= 0 && keys[order[j]!]! > k) {
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = idx;
    }
    const upload = this.upload;
    for (let i = 0; i < n; i++) {
      const src = order[i]! * F;
      upload.set(inst.subarray(src, src + F), i * F);
    }
    this.uploadDirty = true;
  }

  /** Upload the instance data and, when the atlas changed, its canvas. Runs before the pass. */
  prepare(_encoder: GPUCommandEncoder, _frame?: Frame): void {
    if (this.uploadDirty) {
      this.uploadDirty = false;
      if (this.n > 0) {
        this.device.queue.writeBuffer(
          this.buffer,
          0,
          this.upload.buffer,
          0,
          this.n * BILLBOARD_BYTES,
        );
      }
    }
    const atlas = this.atlas;
    if (atlas.dirty) {
      atlas.markUploaded();
      this.device.queue.copyExternalImageToTexture(
        { source: atlas.canvas as OffscreenCanvas },
        { texture: this.atlasTexture.texture },
        [atlas.size, atlas.size],
      );
    }
  }

  /** Draw inside the scene pass: the `'test'` quads, then the `'always'` ones. */
  draw(pass: GPURenderPassEncoder, frame?: Frame): void {
    this.draws = 0;
    if (this.n === 0) return;
    const fmt = frame?.depthFormat ?? null;
    pass.setBindGroup(1, this.group);
    if (!fmt) {
      pass.setPipeline(this.flatPipeline);
      pass.draw(6, this.n);
      this.draws = 1;
      return;
    }
    const [test, always] = this.depthPipeline(fmt);
    if (this.testCount > 0) {
      pass.setPipeline(test);
      pass.draw(6, this.testCount, 0, 0);
      this.draws++;
    }
    if (this.alwaysCount > 0) {
      pass.setPipeline(always);
      pass.draw(6, this.alwaysCount, 0, this.testCount);
      this.draws++;
    }
  }

  private depthPipeline(format: GPUTextureFormat): [GPURenderPipeline, GPURenderPipeline] {
    let p = this.depthPipelines.get(format);
    if (!p) {
      const d = this.pipelineDesc;
      p = [
        this.device.createRenderPipeline({
          ...d,
          label: `${this.label}:${format}`,
          depthStencil: { format, depthWriteEnabled: false, depthCompare: 'less-equal' },
        }),
        this.device.createRenderPipeline({
          ...d,
          label: `${this.label}:${format}:always`,
          depthStencil: { format, depthWriteEnabled: false, depthCompare: 'always' },
        }),
      ];
      this.depthPipelines.set(format, p);
    }
    return p;
  }

  destroy(): void {
    this.clear();
    this.buffer.destroy();
    this.atlasTexture.destroy();
  }
}

/** `new Billboards(renderer, opts)`. */
export function createBillboards(renderer: Renderer, opts?: BillboardsOptions): Billboards {
  return new Billboards(renderer, opts);
}
