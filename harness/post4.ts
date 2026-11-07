/**
 * Post 4 page (ws/post-4): the post stack on the renderer's camera jitter, view history and
 * aux targets, one mode per flag. Noun-free: boxes, a floor and a bar.
 *
 * The page wraps the measured `PostStack` in a capture processor: it resolves into an offscreen
 * copy of the output (blitted to the screen) and, on request, runs a reference stack with the
 * feature off from the same inputs into a second copy, and reads both back. Every value is a
 * difference between the two (or between two phases of one), computed on the CPU.
 *
 * - `?taa`: a static lit scene. TAA off for a while (the reference frame), then on with
 *   `sharpen: 0` and the camera jittered by the stack: after 16 frames `convergedDelta` is the
 *   flat-pixel difference to the reference. Then a bright bar slides across a dark band and
 *   `ghost` is the brightest trail behind it. Then (ws/post-5) a striped cube slides through an
 *   `InstanceList` with velocity under the still camera, first with `taa.reprojection`
 *   `'camera'`, then `'velocity'`: `ghostObjectCamera` / `ghostObject` are how far the TAA frame
 *   strays from the same inputs with TAA off around the cube. `?still` skips the bar and cube.
 * - `?ssr`: a floor split into a rough (0.9) and a smooth (0.05) metal half, a bright pillar on
 *   each, the rough-metal target on: `smoothReflect` / `roughReflect` are what SSR adds in front
 *   of each pillar.
 * - `?blur`: a still camera, a cube swinging through an `InstanceList` with velocity, static
 *   boxes behind: `cubeBlurPx` / `backgroundBlurPx` count the px motion blur changed in a row
 *   through the cube and in a row through the background only.
 * - `?ortho`: a box on a floor under an orthographic camera at two zooms and distances, AO on:
 *   `aoTerms` is the AO term at a world point near the crease in each, `aoDelta` their gap.
 */
import { GameLoop, mat4 } from '@thunderclap/engine/core';
import { box } from '@thunderclap/engine/geom';
import { boot } from '@thunderclap/engine/platform';
import { type PostSettingsPatch, PostStack } from '@thunderclap/engine/post';
import {
  Camera,
  type CameraPoint,
  createStandardMaterial,
  type FullscreenPass,
  gpuDiagnostics,
  type InstanceList,
  installGpuErrorLogging,
  Lights,
  type Material,
  type Mesh,
  type PostInputs,
  type PostProcessor,
  Renderer,
  type SceneTargetViewport,
  type Texture,
  Transform,
} from '@thunderclap/engine/render';
import type { HarnessPost4Api, HarnessPost4State, Post4Mode } from './post4-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const query = new URLSearchParams(location.search);
const mode: Post4Mode = query.has('ssr')
  ? 'ssr'
  : query.has('blur')
    ? 'blur'
    : query.has('ortho')
      ? 'ortho'
      : 'taa';
const still = query.has('still');

const state: HarnessPost4State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  mode,
  still,
  phase: mode === 'taa' ? 'warm' : 'run',
  readbacks: 0,
  wantsJitter: false,
  jitter: [0, 0],
  active: false,
  convergedDelta: null,
  ghost: null,
  ghostObject: null,
  ghostObjectCamera: null,
  velocityActive: false,
  smoothReflect: null,
  roughReflect: null,
  cubeBlurPx: null,
  backgroundBlurPx: null,
  aoDelta: null,
  aoTerms: null,
  gpuErrors: 0,
};

const api: HarnessPost4Api = { state };
window.__harnessPost4 = api;

// ------------------------------------------------------------------ capture

/** One read-back image: 8-bit rgba (swizzled from bgra when the output is), `w × h`. */
interface Image {
  w: number;
  h: number;
  data: Uint8Array;
}

const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(src, samp, in.uv, 0.0).rgb, 1.0);
}`;

/** An offscreen output-format copy and its mappable buffer. */
class Grab {
  tex: Texture | null = null;
  buffer: GPUBuffer | null = null;
  w = 0;
  h = 0;
  row = 0;

  constructor(
    private readonly renderer: Renderer,
    private readonly label: string,
  ) {}

  fit(w: number, h: number): void {
    if (this.tex && w === this.w && h === this.h) return;
    this.tex?.destroy();
    this.buffer?.destroy();
    this.w = w;
    this.h = h;
    this.row = Math.ceil((w * 4) / 256) * 256;
    this.tex = this.renderer.createRenderTarget({
      width: w,
      height: h,
      format: this.renderer.format,
      label: `post4-${this.label}`,
    });
    this.buffer = this.renderer.device.createBuffer({
      label: `post4-${this.label}-readback`,
      size: this.row * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  copy(encoder: GPUCommandEncoder): void {
    encoder.copyTextureToBuffer(
      { texture: this.tex!.texture },
      { buffer: this.buffer!, bytesPerRow: this.row },
      { width: this.w, height: this.h },
    );
  }

  async map(): Promise<Image> {
    const buf = this.buffer!;
    const w = this.w;
    const h = this.h;
    const row = this.row;
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const data = new Uint8Array(w * h * 4);
    const bgra = this.renderer.format.startsWith('bgra');
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * row + x * 4;
        const d = (y * w + x) * 4;
        data[d] = src[s + (bgra ? 2 : 0)]!;
        data[d + 1] = src[s + 1]!;
        data[d + 2] = src[s + (bgra ? 0 : 2)]!;
        data[d + 3] = 255;
      }
    }
    buf.unmap();
    return { w, h, data };
  }
}

/**
 * The page's post processor: the measured stack resolves into `main` (blitted to the output);
 * on a capture frame the reference stack (if any) resolves the same inputs into `ref`, and both
 * are copied for read-back. It forwards the measured stack's `wantsJitter`.
 */
class CapturePost implements PostProcessor {
  readonly jitter: [number, number] = [0, 0];
  /** Set by the page before `endFrame` to read this frame back. */
  capture = false;
  private readonly mainGrab: Grab;
  private readonly refGrab: Grab;
  private readonly blit: FullscreenPass;
  private copied = false;
  private mapping = false;

  constructor(
    renderer: Renderer,
    readonly main: PostStack,
    readonly ref: PostStack | null,
  ) {
    this.mainGrab = new Grab(renderer, 'main');
    this.refGrab = new Grab(renderer, 'ref');
    this.blit = renderer.createFullscreenPass({
      label: 'post4-blit',
      wgsl: BLIT_WGSL,
      targets: [renderer.format],
      textures: 1,
      sampler: 'nearest-clamp',
    });
    this.renderer = renderer;
  }

  private readonly renderer: Renderer;

  get wantsJitter(): boolean {
    return this.main.wantsJitter;
  }

  resize(width: number, height: number): void {
    this.main.resize(width, height);
    this.ref?.resize(width, height);
  }

  encode(
    encoder: GPUCommandEncoder,
    inputs: PostInputs,
    output: GPUTextureView,
    viewport?: SceneTargetViewport,
  ): void {
    const w = this.renderer.outputWidth;
    const h = this.renderer.outputHeight;
    this.mainGrab.fit(w, h);
    this.main.encode(encoder, inputs, this.mainGrab.tex!.view, viewport);
    const j = inputs.view?.jitter;
    this.jitter[0] = j ? j[0] : 0;
    this.jitter[1] = j ? j[1] : 0;
    this.blit.setTexture(0, this.mainGrab.tex!);
    this.blit.encode(encoder, output);
    if (!this.capture || this.mapping || this.copied) return;
    this.mainGrab.copy(encoder);
    if (this.ref) {
      this.refGrab.fit(w, h);
      this.ref.encode(encoder, inputs, this.refGrab.tex!.view, viewport);
      this.refGrab.copy(encoder);
    }
    this.copied = true;
  }

  /** After the frame's submit: map what was copied; `done(main, ref)` on arrival. */
  read(done: (main: Image, ref: Image | null) => void): boolean {
    if (!this.copied || this.mapping) return false;
    this.copied = false;
    this.mapping = true;
    const both = Promise.all([this.mainGrab.map(), this.ref ? this.refGrab.map() : null]);
    both.then(
      ([m, r]) => {
        this.mapping = false;
        done(m, r);
      },
      (err) => {
        this.mapping = false;
        console.error('[post4] readback', err);
      },
    );
    return true;
  }
}

// ------------------------------------------------------------------ image helpers

const luma = (img: Image, x: number, y: number): number => {
  const xi = Math.min(img.w - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(img.h - 1, Math.max(0, Math.round(y)));
  const i = (yi * img.w + xi) * 4;
  return (0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!) / 255;
};

/** Largest per-channel absolute difference of one pixel, 0..255. */
const diffAt = (a: Image, b: Image, x: number, y: number): number => {
  const i = (y * a.w + x) * 4;
  return Math.max(
    Math.abs(a.data[i]! - b.data[i]!),
    Math.abs(a.data[i + 1]! - b.data[i + 1]!),
    Math.abs(a.data[i + 2]! - b.data[i + 2]!),
  );
};

/** Mean per-channel absolute difference (0..1) over a rect. */
function meanDiff(a: Image, b: Image, x0: number, y0: number, x1: number, y1: number): number {
  const xa = Math.max(0, Math.floor(Math.min(x0, x1)));
  const xb = Math.min(a.w - 1, Math.ceil(Math.max(x0, x1)));
  const ya = Math.max(0, Math.floor(Math.min(y0, y1)));
  const yb = Math.min(a.h - 1, Math.ceil(Math.max(y0, y1)));
  let sum = 0;
  let n = 0;
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const i = (y * a.w + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i + c]! - b.data[i + c]!);
      n += 3;
    }
  }
  return n ? sum / n / 255 : 0;
}

/** `convergedDelta`: mean difference over pixels whose 3×3 range in `ref` is under 8/255. */
function flatDelta(cur: Image, ref: Image): number {
  let sum = 0;
  let n = 0;
  for (let y = 1; y < ref.h - 1; y++) {
    for (let x = 1; x < ref.w - 1; x++) {
      let lo = 255;
      let hi = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((y + dy) * ref.w + x + dx) * 4;
          for (let c = 0; c < 3; c++) {
            const v = ref.data[i + c]!;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (hi - lo >= 8) continue;
      const i = (y * ref.w + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs(cur.data[i + c]! - ref.data[i + c]!);
      n += 3;
    }
  }
  return n ? sum / n / 255 : 0;
}

// ------------------------------------------------------------------ the scene

const AMBIENT = [0.35, 0.35, 0.38] as const;
const SUN_DIR = [-0.4, -1, -0.7] as const;
const SUN_COLOR = [0.8, 0.8, 0.78] as const;
/** `?taa`: frames per phase. */
const WARM_FRAMES = 12;
const CONVERGE_FRAMES = 16;
const GHOST_FRAMES = 24;
const GHOST_READS = 6;
/** `?taa`: the bar's band and its slide, world units per frame. */
const BAR_Y = 2.3;
const BAR_H = 0.35;
const BAR_W = 0.5;
const BAR_SPEED = 0.03;
const BAR_X0 = -2.2;
/**
 * `?taa` (ws/post-5): the striped cube (`OBJ_STRIPES` slabs across x), its slide (world units
 * per frame, about 5 px at 1280 × 720) and the frames each reprojection runs before it is read.
 */
const OBJ_Y = 1.3;
const OBJ_Z = 1.2;
const OBJ_STRIPES = 4;
const OBJ_SPEED = 0.04;
const OBJ_X0 = -2.4;
const OBJ_WARM = 20;
const OBJ_READS = 6;
const OBJ_MARGIN = 16;
/** `?blur`: the cube's swing. */
const CUBE_Y = 0.6;
const CUBE_SWING = 1.6;
const CUBE_RATE = 0.15;
/** `?ortho`: the two configurations (distance along (0, 1, 1), half height), and the probe. */
const ORTHO = [
  { distance: 8, half: 3 },
  { distance: 16, half: 1.5 },
] as const;
const ORTHO_FRAMES = 8;
const AO_PROBE = [0, 0, 1] as const;

interface Draw {
  mesh: Mesh;
  material: Material;
  t: Transform;
  tint: [number, number, number, number];
}

const point: CameraPoint = { x: 0, y: 0, z: 0 };

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine post 4 demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu, {
    aux: { roughMetal: mode === 'ssr', velocity: mode === 'blur' || mode === 'taa' },
  });
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const aspect = LOGICAL.width / LOGICAL.height;
  const camera = Camera.perspective((50 * Math.PI) / 180, aspect, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;

  // Output px of a world point through the camera.
  const toOut = (x: number, y: number, z: number): [number, number] => {
    camera.worldToScreen(x, y, z, point);
    return [
      (point.x / LOGICAL.width) * renderer.outputWidth,
      (point.y / LOGICAL.height) * renderer.outputHeight,
    ];
  };

  const base: PostSettingsPatch = { bloom: { enabled: false } };
  const patches: Record<Post4Mode, PostSettingsPatch> = {
    taa: { ...base, taa: { enabled: false, sharpen: 0 } },
    ssr: { ...base, ssr: { enabled: true, intensity: 1 } },
    blur: { ...base, motionBlur: { enabled: true, intensity: 1, maxSamples: 16 } },
    ortho: { ...base, ao: { enabled: true, radius: 0.6, intensity: 1.5 } },
  };
  const measured = new PostStack(renderer, patches[mode]);
  measured.addJitterCamera(camera);
  // `?taa` reads the reference only around the moving cube (ws/post-5).
  const reference = new PostStack(renderer, base);
  const post = new CapturePost(renderer, measured, reference);
  renderer.post = post;

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.dir = SUN_DIR;
  lights.sun.color = SUN_COLOR;

  const plain = createStandardMaterial(renderer, { label: 'plain', metallic: 0, roughness: 0.7 });
  const cube = renderer.createMesh({ ...box({ size: 1 }), label: 'cube' });
  const draws: Draw[] = [];
  const add = (
    material: Material,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    tint: [number, number, number, number],
  ): Transform => {
    const t = new Transform({ x, y, z, scaleX: sx, scaleY: sy, scaleZ: sz });
    draws.push({ mesh: cube, material, t, tint });
    return t;
  };

  let list: InstanceList | null = null;
  let cubeT: Transform | null = null;
  let barT: Transform | null = null;
  let barX = BAR_X0;
  let objList: InstanceList | null = null;
  const objT: Transform[] = [];
  let objX = OBJ_X0;
  const placeObject = (x: number, y: number) => {
    for (let i = 0; i < OBJ_STRIPES; i++) {
      const w = 1 / OBJ_STRIPES;
      objT[i]!.setPosition(x - 0.5 + w * (i + 0.5), y, OBJ_Z);
      objList!.set(i, objT[i]!, {
        tint: i % 2 === 0 ? [0.95, 0.95, 0.9, 1] : [0.08, 0.08, 0.1, 1],
      });
    }
  };

  if (mode === 'taa') {
    camera.lookAt([0, 1.4, 7], [0, 1.2, 0]);
    add(plain, 0, -0.1, 0, 10, 0.2, 10, [0.5, 0.5, 0.52, 1]);
    add(plain, 0, 2.2, -2, 10, 4.4, 0.2, [0.06, 0.06, 0.07, 1]);
    add(plain, -1.6, 0.6, 0, 1.2, 1.2, 1.2, [0.8, 0.3, 0.2, 1]);
    add(plain, 1.4, 0.45, 0.6, 0.9, 0.9, 0.9, [0.2, 0.5, 0.8, 1]);
    const bright = createStandardMaterial(renderer, {
      label: 'bar',
      metallic: 0,
      roughness: 1,
      emissiveFactor: [1.5, 1.5, 1.5],
    });
    barT = add(bright, barX, BAR_Y, -1.8, BAR_W, BAR_H, 0.1, [1, 1, 1, 1]);
    // Out of sight (under the floor) until its phase.
    objList = renderer.createInstanceList(cube, plain, OBJ_STRIPES, { velocity: true });
    for (let i = 0; i < OBJ_STRIPES; i++) {
      objT.push(new Transform({ scaleX: 1 / OBJ_STRIPES, scaleY: 1, scaleZ: 1 }));
    }
    placeObject(0, -30);
  } else if (mode === 'ssr') {
    camera.lookAt([0, 1.6, 5], [0, 0.4, -1]);
    const rough = createStandardMaterial(renderer, { label: 'rough', metallic: 1, roughness: 0.9 });
    const smooth = createStandardMaterial(renderer, {
      label: 'smooth',
      metallic: 1,
      roughness: 0.05,
    });
    const pillar = createStandardMaterial(renderer, {
      label: 'pillar',
      metallic: 0,
      roughness: 1,
      emissiveFactor: [2, 2, 2],
    });
    add(rough, -2, -0.05, 0, 4, 0.1, 10, [0.6, 0.6, 0.6, 1]);
    add(smooth, 2, -0.05, 0, 4, 0.1, 10, [0.6, 0.6, 0.6, 1]);
    add(pillar, -1.5, 1.1, -1.5, 0.8, 2.2, 0.8, [1, 1, 1, 1]);
    add(pillar, 1.5, 1.1, -1.5, 0.8, 2.2, 0.8, [1, 1, 1, 1]);
  } else if (mode === 'blur') {
    camera.lookAt([0, 1.2, 6], [0, 1, 0]);
    add(plain, 0, -0.1, 0, 12, 0.2, 12, [0.45, 0.45, 0.47, 1]);
    add(plain, 0, 2, -3, 12, 4, 0.2, [0.15, 0.17, 0.2, 1]);
    for (let i = -2; i <= 2; i++) add(plain, i * 1.4, 2.4, -2.5, 0.6, 0.6, 0.6, [0.9, 0.8, 0.2, 1]);
    list = renderer.createInstanceList(cube, plain, 1, { velocity: true });
    cubeT = new Transform({ x: 0, y: CUBE_Y, z: 0 });
    list.set(0, cubeT, { tint: [0.9, 0.3, 0.2, 1] });
  } else {
    add(plain, 0, -0.1, 0, 12, 0.2, 12, [0.7, 0.7, 0.7, 1]);
    add(plain, 0, 0.75, 0, 1.5, 1.5, 1.5, [0.7, 0.7, 0.7, 1]);
  }

  const orthoM = new Float32Array(16);
  const setOrtho = (i: number) => {
    const c = ORTHO[i]!;
    mat4.ortho(orthoM, -c.half * aspect, c.half * aspect, -c.half, c.half, 0.1, 60);
    camera.setProjection(orthoM);
    const k = c.distance / Math.SQRT2;
    camera.lookAt([0, k, k], [0, 0, 0]);
  };
  if (mode === 'ortho') setOrtho(0);

  // ?taa phases; ?ortho configuration and terms.
  let phaseFrame = 0;
  let reference0: Image | null = null;
  let ghostMax = 0;
  let ghostReads = 0;
  let objSum = 0;
  let objReads = 0;
  let orthoIndex = 0;
  const terms: [number, number] = [Number.NaN, Number.NaN];
  /** The frame being captured's bar rect in output px (left, right, top, bottom). */
  const barRect = [0, 0, 0, 0];

  const onRead = (img: Image, ref: Image | null, at: number[] | null, ortho: number) => {
    state.readbacks++;
    if (mode === 'taa') {
      if (state.phase === 'reference') {
        reference0 = img;
        state.phase = 'converge';
        phaseFrame = 0;
        measured.set({ taa: { enabled: true } });
      } else if (state.phase === 'converge' && reference0) {
        state.convergedDelta = flatDelta(img, reference0);
        state.phase = still ? 'done' : 'ghost';
        phaseFrame = 0;
      } else if (state.phase === 'ghost' && at) {
        const [left, , top, bottom] = at as [number, number, number, number];
        const mid = (top + bottom) / 2;
        const above = top - 10;
        // The bar's trailing edge as drawn (the read frame can trail the page's rect by a frame):
        // the first px from the left, near the expected edge, past half way from the band to the
        // bar.
        const lo = Math.floor(left - 40);
        const half = (luma(img, lo, above) + luma(img, left + 6, mid)) / 2;
        let edge = left;
        for (let x = lo; x <= left + 6; x++) {
          if (luma(img, x, mid) > half) {
            edge = x;
            break;
          }
        }
        let g = 0;
        for (let x = edge - 16; x <= edge - 2; x++) {
          g = Math.max(g, luma(img, x, mid) - luma(img, x, above));
        }
        ghostMax = Math.max(ghostMax, g);
        if (++ghostReads >= GHOST_READS) {
          state.ghost = ghostMax;
          state.phase = 'objectCamera';
          phaseFrame = 0;
          objX = OBJ_X0;
          measured.set({ taa: { reprojection: 'camera' } });
        }
      } else if (
        (state.phase === 'objectCamera' || state.phase === 'objectVelocity') &&
        at &&
        ref
      ) {
        const [left, right, top, bottom] = at as [number, number, number, number];
        objSum += meanDiff(
          img,
          ref,
          left - OBJ_MARGIN,
          top - OBJ_MARGIN,
          right + OBJ_MARGIN,
          bottom + OBJ_MARGIN,
        );
        if (++objReads >= OBJ_READS) {
          const mean = objSum / objReads;
          objSum = 0;
          objReads = 0;
          if (state.phase === 'objectCamera') {
            state.ghostObjectCamera = mean;
            state.phase = 'objectVelocity';
            phaseFrame = 0;
            objX = OBJ_X0;
            measured.set({ taa: { reprojection: 'velocity' } });
          } else {
            state.ghostObject = mean;
            state.phase = 'done';
          }
        }
      }
      return;
    }
    if (!ref) return;
    if (mode === 'ssr') {
      const rect = (cx: number) => {
        const a = toOut(cx - 0.45, 0, -1.0);
        const b = toOut(cx + 0.45, 0, 0.5);
        return meanDiff(img, ref, a[0], a[1], b[0], b[1]);
      };
      state.smoothReflect = rect(1.5);
      state.roughReflect = rect(-1.5);
    } else if (mode === 'blur' && at) {
      const [cubeRow, bgRow] = at as [number, number];
      const count = (row: number) => {
        const y = Math.min(img.h - 1, Math.max(0, Math.round(row)));
        let n = 0;
        for (let x = 0; x < img.w; x++) if (diffAt(img, ref, x, y) > 4) n++;
        return n;
      };
      // The largest over the reads: the swing's speed (and so the smear) changes every frame.
      state.cubeBlurPx = Math.max(state.cubeBlurPx ?? 0, count(cubeRow));
      state.backgroundBlurPx = Math.max(state.backgroundBlurPx ?? 0, count(bgRow));
    } else if (mode === 'ortho' && at) {
      const [px, py] = at as [number, number];
      let m = 0;
      let r = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          m += luma(img, px + dx, py + dy);
          r += luma(ref, px + dx, py + dy);
        }
      }
      terms[ortho] = r > 0 ? m / r : 1;
      if (!Number.isNaN(terms[0]) && !Number.isNaN(terms[1])) {
        state.aoTerms = [terms[0], terms[1]];
        state.aoDelta = Math.abs(terms[0] - terms[1]);
      }
    }
  };

  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      phaseFrame++;
      let at: number[] | null = null;
      post.capture = false;
      if (mode === 'taa') {
        if (state.phase === 'warm' && phaseFrame >= WARM_FRAMES) state.phase = 'reference';
        if (state.phase === 'reference') post.capture = true;
        if (state.phase === 'converge' && phaseFrame > CONVERGE_FRAMES) post.capture = true;
        if (state.phase === 'ghost' && barT) {
          barX += BAR_SPEED;
          if (barX > -BAR_X0) barX = BAR_X0;
          barT.setPosition(barX, BAR_Y, -1.8);
          const a = toOut(barX - BAR_W / 2, BAR_Y + BAR_H / 2, -1.75);
          const b = toOut(barX + BAR_W / 2, BAR_Y - BAR_H / 2, -1.75);
          barRect[0] = a[0];
          barRect[1] = b[0];
          barRect[2] = a[1];
          barRect[3] = b[1];
          // Only while the bar is well inside the screen and has slid for a while.
          const inside = a[0] > 40 && b[0] < renderer.outputWidth - 40;
          if (phaseFrame > GHOST_FRAMES && inside && barX - BAR_X0 > 0.6) {
            post.capture = true;
            at = barRect.slice();
          }
        }
        if ((state.phase === 'objectCamera' || state.phase === 'objectVelocity') && objList) {
          objX += OBJ_SPEED;
          if (objX > -OBJ_X0) {
            objX = OBJ_X0;
            phaseFrame = 0;
          }
          placeObject(objX, OBJ_Y);
          const a = toOut(objX - 0.5, OBJ_Y + 0.5, OBJ_Z + 0.5);
          const b = toOut(objX + 0.5, OBJ_Y - 0.5, OBJ_Z + 0.5);
          // After the history has followed it a while, and well inside the screen.
          const inside = a[0] - OBJ_MARGIN > 0 && b[0] + OBJ_MARGIN < renderer.outputWidth;
          if (phaseFrame > OBJ_WARM && inside) {
            post.capture = true;
            at = [a[0], b[0], a[1], b[1]];
          }
        }
      } else if (mode === 'ssr') {
        post.capture = state.frames > 6;
      } else if (mode === 'blur') {
        if (cubeT && list && !still) {
          cubeT.setPosition(CUBE_SWING * Math.sin(state.frames * CUBE_RATE), CUBE_Y, 0);
          list.set(0, cubeT, { tint: [0.9, 0.3, 0.2, 1] });
        }
        post.capture = state.frames > 6;
        at = [toOut(0, CUBE_Y, 0.5)[1], toOut(0, 2.4, -2.2)[1]];
      } else {
        if (phaseFrame >= ORTHO_FRAMES) {
          post.capture = true;
          at = toOut(AO_PROBE[0], AO_PROBE[1], AO_PROBE[2]);
        }
      }
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.02, 0.02, 0.03);
      frame.lights = lights;
      for (const d of draws) frame.mesh(d.mesh, d.material, d.t, { tint: d.tint });
      if (list) frame.list(list);
      if (objList) frame.list(objList);
      renderer.endFrame();
      const ortho = orthoIndex;
      const reading = post.read((img, ref) => onRead(img, ref, at, ortho));
      if (mode === 'ortho' && reading) {
        orthoIndex = 1 - orthoIndex;
        setOrtho(orthoIndex);
        phaseFrame = 0;
      }
      state.frames++;
      state.wantsJitter = measured.wantsJitter;
      state.jitter[0] = post.jitter[0];
      state.jitter[1] = post.jitter[1];
      state.active =
        mode === 'taa'
          ? measured.taaActive
          : mode === 'ssr'
            ? measured.ssrActive
            : mode === 'blur'
              ? measured.motionBlurActive
              : true;
      state.velocityActive = measured.taaVelocityActive;
      state.gpuErrors = gpuDiagnostics.errorCount;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
