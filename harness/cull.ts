/**
 * Cull readback page (ws/cull-fix, B18): what the GPU actually drew, read back. Two render
 * cores on one device draw the same streamed scene into their own offscreen target: one
 * GPU-culls a static set (indirect draws replayed from recorded bundles), the other CPU-culls it
 * (direct draws). Each section is a box in its own id colour, unlit, so the readback names every
 * section a core drew; the spec wants the same ids and the same pixels from both.
 *
 * The scene is the shape a streamed world has: both cores reversed-Z under an infinite reversed
 * projection, camera-relative (`originGrid`) 100 km out, sections arriving a batch a frame,
 * off-axis ones straddling the frustum's sides, some at and through the near plane, the rest
 * ahead out to 600 m. The indirect core also has a mirror set (a caster, as a shadow map's) in
 * a pass that never runs, given every section too: a set no pass draws must not hold up the
 * drawn set's bundle rebuilds (`?mirror=0` drops it).
 *
 * Nothing here is engine code beyond the core and `boot`.
 */
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  createRenderCore,
  createRenderView,
  createVertexLayout,
  type DrawSet,
  gpuDiagnostics,
  installGpuErrorLogging,
  type RenderCore,
  setViewFromCamera,
} from '@thunderclap-engine/engine/render';
import type { HarnessCullState } from './cull-state';

const root = document.getElementById('root') as HTMLElement;
const params = new URLSearchParams(location.search);
const mirror = params.get('mirror') !== '0';

const W = 640;
const H = 360;
const FOV = Math.PI / 3;
const NEAR = 0.1;
/** How far out the camera sits on x and z, metres. */
const FAR = 100_000;
const EYE_Y = 12;
/** Sections added to each core per frame, and frames drawn after the last before the readback. */
const BATCH = 12;
const SETTLE = 6;
/** The id colour's blue byte: a pixel with it is a section, its red and green bytes the id. */
const MARK = 0xc8;

const state: HarnessCullState = {
  ready: false,
  gpu: 'pending',
  sections: 0,
  frames: 0,
  mirror,
  indirectIds: 0,
  directIds: 0,
  missing: [],
  extra: [],
  diffPixels: 0,
  drawnOffAxis: 0,
  drawnNear: 0,
  drawnAhead: 0,
  deferredBuilds: 0,
  gpuErrors: 0,
};
window.__harnessCull = state;

/** A corner's position (float32x3, local to the section's origin) and its colour (rgba8). */
const VERTEX = createVertexLayout({
  stride: 16,
  attributes: [
    { name: 'pos', format: 'float32x3', offset: 0 },
    { name: 'color', format: 'uint32', offset: 12 },
  ],
});

const SHADER = /* wgsl */ `
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) color: u32,
};
@vertex fn vs(in: VertexIn) -> Out {
  var o: Out;
  o.clip = view.viewProj * vec4f(in.core_origin + in.pos, 1.0);
  o.color = in.color;
  return o;
}
@fragment fn fs(in: Out) -> @location(0) vec4f { return unpack4x8unorm(in.color); }
`;

type Kind = 'offAxis' | 'near' | 'ahead';
interface Section {
  id: number;
  kind: Kind;
  /** The centre, relative to the eye, camera space (x right, y up, z = -distance). */
  at: [number, number, number];
  size: number;
}

/** A small deterministic hash in [0, 1). */
function rand(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The scene: off-axis sections on the frustum's four sides, sections at the near plane, the rest ahead. */
function sections(): Section[] {
  const tanY = Math.tan(FOV / 2);
  const tanX = tanY * (W / H);
  const out: Section[] = [];
  let id = 1;
  for (let i = 0; i < 80; i++) {
    const d = 3 + rand(i) ** 2 * 300;
    const size = d * 0.05;
    // Centre a little inside or outside the side: the sphere straddles the plane.
    const off = (rand(i + 11) - 0.5) * size * 1.2;
    const along = (rand(i + 23) * 1.6 - 0.8) * d;
    const side = i % 4;
    const x = side === 0 ? -tanX * d - off : side === 1 ? tanX * d + off : along * tanX;
    const y = side === 2 ? -tanY * d - off : side === 3 ? tanY * d + off : along * tanY;
    out.push({ id: id++, kind: 'offAxis', at: [x, y, -d], size });
  }
  for (let i = 0; i < 24; i++) {
    // Through the near plane (its near face in front of it) or just past it, towards the corners.
    const size = 0.02;
    const d = NEAR + (rand(i + 101) - 0.35) * size * 2;
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    const k = 0.55 + 0.4 * rand(i + 131);
    out.push({ id: id++, kind: 'near', at: [sx * k * tanX * d, sy * k * tanY * d, -d], size });
  }
  for (let i = 0; i < 120; i++) {
    const d = 4 + rand(i + 201) ** 2 * 600;
    const x = (rand(i + 211) * 1.4 - 0.7) * tanX * d;
    const y = (rand(i + 223) * 1.4 - 0.7) * tanY * d;
    out.push({ id: id++, kind: 'ahead', at: [x, y, -d], size: d * 0.03 });
  }
  // Streamed in an order that mixes the kinds.
  return out.sort((a, b) => rand(a.id + 977) - rand(b.id + 977));
}

const FACES = [
  [0b001, 0b011, 0b111, 0b101], // +x
  [0b000, 0b100, 0b110, 0b010], // -x
  [0b010, 0b110, 0b111, 0b011], // +y
  [0b000, 0b001, 0b101, 0b100], // -y
  [0b100, 0b101, 0b111, 0b110], // +z
  [0b000, 0b010, 0b011, 0b001], // -z
];

/** A box of side `size` about its centre, 24 corners in quad order, every corner `id`'s colour. */
function boxBytes(size: number, id: number): ArrayBuffer {
  const buf = new ArrayBuffer(24 * 16);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  const color = (id & 255) | (((id >> 8) & 255) << 8) | (MARK << 16) | (255 << 24);
  for (let face = 0; face < 6; face++) {
    for (let k = 0; k < 4; k++) {
      const c = FACES[face]![k]!;
      const o = (face * 4 + k) * 4;
      f[o] = ((c & 1) - 0.5) * size;
      f[o + 1] = (((c >> 1) & 1) - 0.5) * size;
      f[o + 2] = (((c >> 2) & 1) - 0.5) * size;
      u[o + 3] = color >>> 0;
    }
  }
  return buf;
}

interface Side {
  core: RenderCore;
  set: DrawSet;
  add(s: Section): void;
  target: {
    view: GPUTextureView;
    format: GPUTextureFormat;
    width: number;
    height: number;
    clear: GPUColor;
    texture: GPUTexture;
  };
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Cull readback' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { gpu } = res;
  const device = gpu.device;
  installGpuErrorLogging(device);

  const make = (cull: 'gpu' | 'cpu', withMirror: boolean): Side => {
    const core = createRenderCore(gpu, { originGrid: 1024, reversedZ: true });
    const vertices = core.createArena({
      kind: 'vertex',
      blockBytes: 1 << 20,
      label: `cull ${cull}`,
    });
    const desc = {
      shader: { code: SHADER },
      vertexLayout: VERTEX,
      vertices,
      capacity: 1024,
      kind: 'static' as const,
      cull,
    };
    if (withMirror) core.definePass({ id: 'off', when: () => false });
    // Made first, so as the oldest stale set it is first in line for the rebuild turn.
    const shadow = withMirror
      ? core.createDrawSet({ ...desc, label: 'mirror', pass: 'off' })
      : null;
    const set = core.createDrawSet({ ...desc, label: `sections ${cull}` });
    const texture = device.createTexture({
      size: [W, H],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const add = (s: Section) => {
      const v = vertices.alloc(24 * 16, 16);
      vertices.write(v, boxBytes(s.size, s.id));
      const slot = {
        vertices: v,
        indexCount: 36,
        bounds: [0, 0, 0, s.size * 0.8661],
        origin: [FAR + s.at[0], EYE_Y + s.at[1], FAR + s.at[2]],
      };
      shadow?.add(slot);
      set.add(slot);
    };
    return {
      core,
      set,
      add,
      target: {
        view: texture.createView(),
        format: 'rgba8unorm',
        width: W,
        height: H,
        clear: { r: 0, g: 0, b: 0, a: 1 },
        texture,
      },
    };
  };
  const indirect = make('gpu', mirror);
  const direct = make('cpu', false);
  const sides = [indirect, direct];

  const list = sections();
  state.sections = list.length;
  const kinds = new Map<number, Kind>();
  for (const s of list) kinds.set(s.id, s.kind);

  const proj = new Float32Array(16);
  const f = 1 / Math.tan(FOV / 2);
  proj[0] = f / (W / H);
  proj[5] = f;
  proj[11] = -1;
  proj[14] = NEAR;
  const camera = Camera.perspective(FOV, W / H, NEAR, 1000).setProjection(proj);
  camera.lookAt([0, EYE_Y, 0], [0, EYE_Y, -1]);
  const view = createRenderView();
  setViewFromCamera(view, camera, Float64Array.of(FAR, EYE_Y, FAR));
  const views = [view];

  let next = 0;
  let after = 0;
  state.gpu = 'ok';

  const frame = () => {
    for (let i = 0; i < BATCH && next < list.length; i++, next++) {
      for (const side of sides) side.add(list[next]!);
    }
    const encoder = device.createCommandEncoder();
    for (const side of sides) {
      side.core.prepare(encoder, views);
      side.core.draw(encoder, 0, side.target);
    }
    device.queue.submit([encoder.finish()]);
    state.deferredBuilds += indirect.core.stats.deferredBuilds;
    state.frames++;
    if (next >= list.length && ++after > SETTLE) {
      void readBack();
      return;
    }
    requestAnimationFrame(frame);
  };

  const readBack = async () => {
    const pixels = await Promise.all(sides.map((s) => read(device, s.target.texture)));
    const idsOf = (p: Uint8Array) => {
      const ids = new Set<number>();
      for (let i = 0; i < p.length; i += 4)
        if (p[i + 2] === MARK) ids.add(p[i]! | (p[i + 1]! << 8));
      return ids;
    };
    const a = idsOf(pixels[0]!);
    const b = idsOf(pixels[1]!);
    state.indirectIds = a.size;
    state.directIds = b.size;
    state.missing = [...b].filter((id) => !a.has(id)).slice(0, 16);
    state.extra = [...a].filter((id) => !b.has(id)).slice(0, 16);
    let diff = 0;
    const pa = pixels[0]!;
    const pb = pixels[1]!;
    for (let i = 0; i < pa.length; i += 4) {
      if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) diff++;
    }
    state.diffPixels = diff;
    for (const id of b) {
      const k = kinds.get(id);
      if (k === 'offAxis') state.drawnOffAxis++;
      else if (k === 'near') state.drawnNear++;
      else if (k === 'ahead') state.drawnAhead++;
    }
    state.gpuErrors = gpuDiagnostics.errorCount;
    state.ready = true;
  };
  requestAnimationFrame(frame);
}

/** The texture's rgba8 bytes, rows packed. */
async function read(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const bytesPerRow = W * 4; // 2560, a multiple of 256
  const buffer = device.createBuffer({
    size: bytesPerRow * H,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [W, H]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const out = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return out;
}

main().catch((e: unknown) => {
  state.gpu = e instanceof Error ? e.message : String(e);
  state.ready = true;
});
