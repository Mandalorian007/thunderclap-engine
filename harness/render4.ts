/**
 * Render 4 page (ws/render-4): camera jitter and history, aux targets, index sub-range draws
 * and `depthTest: false` on the raw renderer, one mode per flag. Noun-free: the geometry, the
 * lights and the probes are what a game would write.
 *
 * - `?jitter`: a quad under a perspective camera and a two-sample jitter sequence
 *   (`setJitter(±0.25, ±0.25)` alternating per frame) through a post stack that asks for it
 *   (`wantsJitter`). `state.shiftPx` is how far the quad's centre moved on screen between the
 *   last two frames: √0.5 target px when the jitter is applied.
 * - `?aux`: the renderer's target carries the rough-metal and velocity attachments; a standing
 *   quad with a roughness gradient (0 → 1 along u, metalness 0) and a cube sliding left and
 *   right through an `InstanceList` with `velocity`. A tiny debug blit samples both attachments
 *   at a probe each and reads them back: `state.roughSample`, `state.velocitySample`.
 * - `?ranges`: one mesh of three quads with three named index ranges, drawn three times in
 *   three tints: `state.drawCalls` is 3.
 * - `?depth-test-off`: a green panel quad in a material with `depthTest: false` inside a red
 *   cube: the debug blit reads the colour at the panel's centre and `state.panelVisible` says
 *   it is the panel's.
 */
import { GameLoop } from '@thunderclap-engine/engine/core';
import { box } from '@thunderclap-engine/engine/geom';
import { boot } from '@thunderclap-engine/engine/platform';
import { PostStack } from '@thunderclap-engine/engine/post';
import {
  Camera,
  type CameraPoint,
  createStandardMaterial,
  type FullscreenPass,
  gpuDiagnostics,
  type InstanceList,
  type InstanceParams,
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
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { HarnessRender4Api, HarnessRender4State, Render4Mode } from './render4-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const query = new URLSearchParams(location.search);
const mode: Render4Mode = query.has('jitter')
  ? 'jitter'
  : query.has('aux')
    ? 'aux'
    : query.has('depth-test-off')
      ? 'depth-test-off'
      : 'ranges';

const state: HarnessRender4State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  mode,
  target: { width: 0, height: 0 },
  shiftPx: 0,
  jitter: [0, 0],
  roughSample: null,
  velocitySample: null,
  velocityPeak: 0,
  drawCalls: 0,
  instances: 0,
  panelVisible: null,
  gpuErrors: 0,
  readbacks: 0,
};

const api: HarnessRender4Api = { state };
window.__harnessRender4 = api;

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit quad in the XY plane facing +z at `cx`; u runs +x, v runs down (-y), white. */
function wallVertices(cx: number): number[] {
  // x, y, z, nx, ny, nz, u, v, r, g, b, a
  return [
    ...[cx - 0.5, 0.5, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1],
    ...[cx + 0.5, 0.5, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1],
    ...[cx + 0.5, -0.5, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1],
    ...[cx - 0.5, -0.5, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1],
  ];
}

function wallIndices(base: number): number[] {
  return [base, base + 2, base + 1, base, base + 3, base + 2];
}

/** One quad, or `count` quads `spacing` apart in x, in one vertex buffer. */
function wallGeometry(count = 1, spacing = 0) {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    indices.push(...wallIndices(i * 4));
    vertices.push(...wallVertices((i - (count - 1) / 2) * spacing));
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

// ------------------------------------------------------------------ the debug blit

/** The probe target: one row of four `rgba16float` texels, copied into a mappable buffer. */
const PROBE_W = 4;
const PROBE_ROW_BYTES = 256;
const PROBE_WGSL = /* wgsl */ `
struct Probe { rough: vec2f, velocity: vec2f, color: vec2f, pad: vec2f };
@group(0) @binding(0) var<uniform> probe: Probe;
@group(0) @binding(1) var probe_sampler: sampler;
@group(0) @binding(2) var color_tex: texture_2d<f32>;
@group(0) @binding(3) var rough_tex: texture_2d<f32>;
@group(0) @binding(4) var velocity_tex: texture_2d<f32>;
@fragment fn fs_main(in: FullscreenIn) -> @location(0) vec4f {
  let px = u32(in.pos.x);
  if (px == 0u) { return textureSampleLevel(rough_tex, probe_sampler, probe.rough, 0.0); }
  if (px == 1u) { return textureSampleLevel(velocity_tex, probe_sampler, probe.velocity, 0.0); }
  return textureSampleLevel(color_tex, probe_sampler, probe.color, 0.0);
}`;

/** IEEE half → number. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

/**
 * Wraps the post stack: after it runs, a fullscreen pass samples the colour, rough-metal and
 * velocity inputs at three probe uvs into a 4×1 target that is copied into a mappable buffer
 * (`read()` maps it after the submit). In `?jitter` it asks the renderer for the jitter.
 */
class ProbePost implements PostProcessor {
  wantsJitter: boolean;
  /** The probe uvs: rough-metal, velocity, colour (set per frame by the page). */
  readonly uv = new Float32Array(8);
  /** The samples of the last readback: rgba × 4 texels. */
  readonly samples = new Float32Array(PROBE_W * 4);
  readonly jitter: [number, number] = [0, 0];
  private readonly pass: FullscreenPass;
  private readonly target: Texture;
  private readonly buffer: GPUBuffer;
  private mapping = false;
  private copied = false;
  private readonly raw = new Uint16Array(PROBE_W * 4);

  constructor(
    private readonly renderer: Renderer,
    private readonly inner: PostStack,
    wantsJitter: boolean,
  ) {
    this.wantsJitter = wantsJitter;
    this.pass = renderer.createFullscreenPass({
      label: 'render4-probe',
      wgsl: PROBE_WGSL,
      targets: ['rgba16float'],
      uniformBytes: 32,
      textures: 3,
      sampler: 'nearest-clamp',
    });
    this.target = renderer.createRenderTarget({
      width: PROBE_W,
      height: 1,
      format: 'rgba16float',
      label: 'render4-probe',
    });
    this.buffer = renderer.device.createBuffer({
      label: 'render4-probe-readback',
      size: PROBE_ROW_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  resize(width: number, height: number): void {
    this.inner.resize(width, height);
  }

  encode(
    encoder: GPUCommandEncoder,
    inputs: PostInputs,
    output: GPUTextureView,
    viewport?: SceneTargetViewport,
  ): void {
    this.inner.encode(encoder, inputs, output, viewport);
    const j = inputs.view?.jitter;
    this.jitter[0] = j ? j[0] : 0;
    this.jitter[1] = j ? j[1] : 0;
    if (this.mapping) return;
    this.pass.setUniforms(this.uv);
    this.pass.setTexture(0, inputs.color);
    if (inputs.roughMetal) this.pass.setTexture(1, inputs.roughMetal);
    if (inputs.velocity) this.pass.setTexture(2, inputs.velocity);
    this.pass.encode(encoder, this.target.view);
    encoder.copyTextureToBuffer(
      { texture: this.target.texture },
      { buffer: this.buffer, bytesPerRow: PROBE_ROW_BYTES },
      { width: PROBE_W, height: 1 },
    );
    this.copied = true;
  }

  /** After the frame's submit: map the readback when one was encoded; `done` on arrival. */
  read(done: () => void): void {
    if (!this.copied || this.mapping) return;
    this.copied = false;
    this.mapping = true;
    this.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        this.raw.set(new Uint16Array(this.buffer.getMappedRange(0, PROBE_W * 8)));
        this.buffer.unmap();
        for (let i = 0; i < this.raw.length; i++) this.samples[i] = halfToFloat(this.raw[i]!);
        this.mapping = false;
        done();
      },
      () => {
        this.mapping = false;
      },
    );
  }

  get device(): GPUDevice {
    return this.renderer.device;
  }
}

// ------------------------------------------------------------------ the scene

const EYE = [0, 1.2, 7] as const;
const TARGET = [0, 0.6, 0] as const;
const AMBIENT = [0.35, 0.35, 0.38] as const;
const SUN_DIR = [-0.4, -1, -0.7] as const;
const SUN_COLOR = [0.7, 0.7, 0.68] as const;
/** `?jitter`: the two-sample sequence, in target px. */
const JITTER = 0.25;
/** `?aux`: the gradient quad and the cube's slide. */
const GRADIENT_CENTRE = [-1.6, 1.2, 0] as const;
const GRADIENT_SIZE = 2.4;
const GRADIENT_PROBE_U = 0.75;
const CUBE_Y = 0.6;
const CUBE_SLIDE = 1.6;
const CUBE_SPEED = 0.06;
const CUBE_X0 = 1.6;
/** `?ranges`: three quads, three tints. */
const RANGE_TINTS: readonly (readonly [number, number, number, number])[] = [
  [0.9, 0.2, 0.15, 1],
  [0.2, 0.85, 0.25, 1],
  [0.2, 0.3, 0.95, 1],
];
/** `?depth-test-off`: the panel's tint and the cube's. */
const PANEL_TINT = [0.1, 1, 0.1, 1] as const;
const BOX_TINT = [1, 0.12, 0.1, 1] as const;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

/** Probe uv (0..1, y down) of a world point through the camera. */
function probeUv(camera: Camera, x: number, y: number, z: number, out: Float32Array, at: number) {
  camera.worldToScreen(x, y, z, probePoint);
  out[at] = probePoint.x / LOGICAL.width;
  out[at + 1] = probePoint.y / LOGICAL.height;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine render 4 demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(
    gpu,
    mode === 'aux' ? { aux: { roughMetal: true, velocity: true } } : {},
  );
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  camera.lookAt(EYE, TARGET);

  // The post stack with everything that moves pixels off; the probe blit wraps it.
  const post = new ProbePost(
    renderer,
    new PostStack(renderer, { bloom: { enabled: false } }),
    mode === 'jitter',
  );
  renderer.post = post;

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.direction = SUN_DIR;
  lights.sun.color = SUN_COLOR;

  const plain = createStandardMaterial(renderer, { label: 'plain', metallic: 0, roughness: 0.6 });

  // Draws of the mode, filled below; `render` only replays them.
  const draws: { mesh: Mesh; material: Material; t: Transform; p: InstanceParams }[] = [];
  let list: InstanceList | null = null;
  let cubeT: Transform | null = null;
  let quadT: Transform | null = null;
  let panelT: Transform | null = null;
  let lastX = Number.NaN;
  let lastY = Number.NaN;

  if (mode === 'jitter') {
    const quad = renderer.createMesh({
      ...wallGeometry(),
      layout: VERTEX_LAYOUT_3D,
      label: 'quad',
    });
    quadT = new Transform({ x: 0, y: 0.6, z: 0, scaleX: 2.5, scaleY: 2.5, scaleZ: 1 });
    draws.push({ mesh: quad, material: plain, t: quadT, p: { tint: [0.3, 0.6, 0.9, 1] } });
  } else if (mode === 'aux') {
    // The gradient: roughness 0..1 along u in G, metalness 0 in B.
    const px = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      px[i * 4 + 1] = i;
      px[i * 4 + 3] = 255;
    }
    const gradient = renderer.textureFromPixels({
      width: 256,
      height: 1,
      data: px,
      label: 'gradient',
    });
    const gradientMat = createStandardMaterial(renderer, {
      label: 'gradient',
      metallicRoughness: gradient,
      metallic: 1,
      roughness: 1,
    });
    const quad = renderer.createMesh({
      ...wallGeometry(),
      layout: VERTEX_LAYOUT_3D,
      label: 'quad',
    });
    draws.push({
      mesh: quad,
      material: gradientMat,
      t: new Transform({
        x: GRADIENT_CENTRE[0],
        y: GRADIENT_CENTRE[1],
        z: GRADIENT_CENTRE[2],
        scaleX: GRADIENT_SIZE,
        scaleY: GRADIENT_SIZE,
        scaleZ: 1,
      }),
      p: { tint: [0.7, 0.7, 0.7, 1] },
    });
    const cube = renderer.createMesh({ ...box({ size: 1 }), label: 'cube' });
    list = renderer.createInstanceList(cube, plain, 1, { velocity: true });
    cubeT = new Transform({ x: CUBE_X0, y: CUBE_Y, z: 0 });
    list.set(0, cubeT, { tint: [0.9, 0.6, 0.2, 1] });
  } else if (mode === 'ranges') {
    const g = wallGeometry(3, 1.3);
    const mesh = renderer.createMesh({
      ...g,
      layout: VERTEX_LAYOUT_3D,
      label: 'three-quads',
      ranges: {
        left: { first: 0, count: 6 },
        mid: { first: 6, count: 6 },
        right: { first: 12, count: 6 },
      },
    });
    const t = new Transform({ x: 0, y: 0.6, z: 0, scaleX: 1.2, scaleY: 1.2, scaleZ: 1 });
    const ranges = mesh.ranges!;
    draws.push({ mesh, material: plain, t, p: { range: ranges.left!, tint: RANGE_TINTS[0]! } });
    draws.push({ mesh, material: plain, t, p: { range: ranges.mid!, tint: RANGE_TINTS[1]! } });
    draws.push({ mesh, material: plain, t, p: { range: ranges.right!, tint: RANGE_TINTS[2]! } });
  } else {
    const cube = renderer.createMesh({ ...box({ size: 2 }), label: 'room' });
    const quad = renderer.createMesh({
      ...wallGeometry(),
      layout: VERTEX_LAYOUT_3D,
      label: 'panel',
    });
    const overlay = createStandardMaterial(renderer, {
      label: 'panel',
      depthTest: false,
      metallic: 0,
      roughness: 1,
    });
    draws.push({
      mesh: cube,
      material: plain,
      t: new Transform({ x: 0, y: CUBE_Y, z: 0 }),
      p: { tint: BOX_TINT },
    });
    panelT = new Transform({ x: 0, y: CUBE_Y, z: 0, scaleX: 0.8, scaleY: 0.8, scaleZ: 1 });
    draws.push({ mesh: quad, material: overlay, t: panelT, p: { tint: PANEL_TINT } });
  }

  const loop = new GameLoop({
    update() {},
    render(_alpha, time) {
      const f = state.frames;
      if (mode === 'jitter') {
        const s = f % 2 === 0 ? JITTER : -JITTER;
        camera.setJitter(s, s);
      }
      if (list && cubeT) {
        cubeT.setPosition(CUBE_X0 + CUBE_SLIDE * Math.sin(f * CUBE_SPEED), CUBE_Y, 0);
        list.set(0, cubeT, { tint: [0.9, 0.6, 0.2, 1] });
      }
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      for (const d of draws) frame.mesh(d.mesh, d.material, d.t, d.p);
      if (list) frame.list(list);
      // Probe uvs for the blit that runs inside endFrame (after the scene pass).
      probeUv(
        camera,
        GRADIENT_CENTRE[0] + (GRADIENT_PROBE_U - 0.5) * GRADIENT_SIZE,
        GRADIENT_CENTRE[1],
        GRADIENT_CENTRE[2],
        post.uv,
        0,
      );
      if (cubeT) probeUv(camera, cubeT.position.x, CUBE_Y, 0.5, post.uv, 2);
      if (panelT) probeUv(camera, 0, CUBE_Y, 0, post.uv, 4);
      renderer.endFrame();
      post.read(() => {
        const s = post.samples;
        state.readbacks++;
        if (mode === 'aux') {
          state.roughSample = [s[0]!, s[1]!];
          state.velocitySample = [s[4]!, s[5]!];
          state.velocityPeak = Math.max(state.velocityPeak, Math.hypot(s[4]!, s[5]!));
        }
        if (mode === 'depth-test-off') {
          state.panelVisible = s[9]! > s[8]! * 2 && s[9]! > s[10]! * 2;
        }
      });
      state.frames++;
      state.drawCalls = renderer.stats.drawCalls;
      state.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
      state.target.width = renderer.target.width;
      state.target.height = renderer.target.height;
      state.jitter[0] = post.jitter[0];
      state.jitter[1] = post.jitter[1];
      if (quadT) {
        // Where the quad's centre lands this frame, in target px, against last frame.
        camera.worldToScreen(0, 0.6, 0, probePoint);
        const x = (probePoint.x / LOGICAL.width) * renderer.target.width;
        const y = (probePoint.y / LOGICAL.height) * renderer.target.height;
        state.shiftPx = Number.isNaN(lastX) ? 0 : Math.hypot(x - lastX, y - lastY);
        lastX = x;
        lastY = y;
      }
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
