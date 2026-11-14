/**
 * The reference scenes (E-041 A4), the src copy of harness/ref-scenes.ts for the counted budget
 * tests (src/**\/ref-*.budget.test.ts): the src tree cannot import the harness. Everything below
 * the `shared` line is identical in both files (src/render/ref-scenes.budget.test.ts checks);
 * edit harness/ref-scenes.ts and copy the body here.
 */
import {
  type AnimationClip,
  AnimationMixer,
  inverseBindFromRest,
  POSE_NODE_FLOATS,
  type Skeleton,
  skinPose,
} from '../anim';
import { box, plane, sphere } from '../geom';
import { PostStack } from '../post';
import { createOverlay } from '../ui';
import {
  createVoxelChunks,
  createVoxelGrid,
  VOXEL_WGSL,
  type VoxelGrid,
  type VoxelMesher,
} from '../voxel';
import {
  atlasFrames,
  Camera,
  createFlipbook,
  createStandardMaterial,
  createTileLayer,
  type DrawParams,
  type InstanceParams,
  Lights,
  loadTextureArray,
  type Material,
  type PixelSource,
  type PointLight,
  type Renderer,
  SkinPalette,
  type SpotLight,
  setVertexSkin,
  Transform,
  VERTEX_LAYOUT_SKINNED,
  VERTEX_SKINNED_FLOATS,
} from './index';

// ---- shared: identical in harness/ref-scenes.ts and src/render/ref-scenes.test-util.ts ----

export type RefSceneId = 'board' | 'characters' | 'arena' | 'voxel' | 'stereo' | 'hud';

export const REF_SCENE_IDS: readonly RefSceneId[] = [
  'board',
  'characters',
  'arena',
  'voxel',
  'stereo',
  'hud',
];

/** The fixed clock: frame `i` is at `i * REF_DT` seconds. */
export const REF_DT = 1 / 60;
/** Logical screen every scene lays out in (cameras, sprites). */
export const REF_LOGICAL = { width: 1920, height: 1080 } as const;
/** The frame whose `renderer.stats` the budget tests pin and the page reports. */
export const REF_STATS_FRAME = 30;

/**
 * Default size per scene: sprites (board), figures (characters, stereo), spheres (arena),
 * chunks across x and z (voxel, two chunks high), and 1 for the HUD.
 */
export const REF_DEFAULT_SIZE: Readonly<Record<RefSceneId, number>> = {
  board: 4000,
  characters: 64,
  arena: 49,
  voxel: 8,
  stereo: 32,
  hud: 1,
};

export interface RefOptions {
  /** See `REF_DEFAULT_SIZE`. */
  size?: number;
  /**
   * Called as a frame moves between its parts: `update` (CPU work before `beginFrame`),
   * `view` (one camera) or `left` and `right` (two), `present` (`endFrame`). A work meter's
   * `view` goes here.
   */
  mark?: (part: string) => void;
  /** voxel: the mesher for the grid (the page passes a Worker one). Default in-thread. */
  mesher?: (grid: VoxelGrid) => VoxelMesher;
  /** hud: the overlay's parent element. */
  parent?: HTMLElement;
  /** stereo: 1 draws the same scene through one full-screen camera (the mono comparison). */
  views?: 1 | 2;
}

export interface RefScene {
  readonly id: RefSceneId;
  readonly size: number;
  /** Set-up work that spans frames (voxel meshing); true once frames are representative. */
  prepare(): boolean;
  /** Frame `i` on the fixed clock: the update, `beginFrame`, the views and `endFrame`. */
  step(i: number): void;
  dispose(): void;
}

export function createRefScene(
  id: RefSceneId,
  renderer: Renderer,
  opts: RefOptions = {},
): RefScene {
  const size = opts.size ?? REF_DEFAULT_SIZE[id];
  const mark = opts.mark ?? noMark;
  switch (id) {
    case 'board':
      return refBoard(renderer, size, mark);
    case 'characters':
      return refFigures('characters', renderer, size, 1, false, mark);
    case 'arena':
      return refArena(renderer, size, mark);
    case 'voxel':
      return refVoxel(renderer, size, mark, opts.mesher);
    case 'stereo':
      return refFigures('stereo', renderer, size, opts.views ?? 2, true, mark);
    case 'hud': {
      if (!opts.parent) throw new Error('ref hud: opts.parent is required');
      return refHud(renderer, opts.parent, mark);
    }
  }
}

const noMark = (_part: string): void => {};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Albedo × the engine lighting block plus a faint sky term. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.15 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

function perspective(fovDeg: number, far: number): Camera {
  const camera = Camera.perspective(
    (fovDeg * Math.PI) / 180,
    REF_LOGICAL.width / REF_LOGICAL.height,
    0.1,
    far,
  );
  Object.assign(camera.screen, { x: 0, y: 0, ...REF_LOGICAL });
  camera.cull = true;
  return camera;
}

// ------------------------------------------------------------------------- S1, the 2D board

/**
 * S1: a 48×27 tile layer from a 4×4 generated atlas, `size` default-material sprites drifting
 * on fixed circles, and a flipbook walker crossing the screen; the 2D path through `ortho2d`.
 */
function refBoard(renderer: Renderer, size: number, mark: (part: string) => void): RefScene {
  const camera = Camera.ortho2d(REF_LOGICAL.width, REF_LOGICAL.height);
  renderer.camera = camera;
  const CELL = 16;
  const ATLAS = { cols: 4, rows: 4 };
  const side = CELL * ATLAS.cols;
  const pixels = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const cell = Math.floor(x / CELL) + Math.floor(y / CELL) * ATLAS.cols;
      const rim = x % CELL === 0 || y % CELL === 0;
      const o = (y * side + x) * 4;
      pixels[o] = rim ? 40 : 60 + ((cell * 37) % 160);
      pixels[o + 1] = rim ? 40 : 90 + ((cell * 59) % 140);
      pixels[o + 2] = rim ? 40 : 70 + ((cell * 23) % 120);
      pixels[o + 3] = 255;
    }
  }
  const texture = renderer.textureFromPixels({
    width: side,
    height: side,
    data: pixels,
    format: 'rgba8unorm-srgb',
    label: 'ref-board-atlas',
  });
  const material = renderer.createSpriteMaterial({
    texture,
    label: 'ref-board',
    sampler: 'nearest-clamp',
  });
  const GRID = { columns: 48, rows: 27, tileW: 40, tileH: 40 };
  const layer = createTileLayer(renderer, { material, ...GRID, atlas: ATLAS, label: 'ref-board' });
  const rand = lcg(0xb0a2d);
  const tiles = new Int16Array(GRID.columns * GRID.rows);
  for (let k = 0; k < tiles.length; k++) tiles[k] = Math.floor(rand() * 12);
  layer.fill(tiles);
  const book = createFlipbook({ frames: atlasFrames(ATLAS, [12, 13, 14, 15]), fps: 8 });
  const walker: DrawParams = { x: 0, y: 13 * 40, w: 80, h: 80, uv: book.uv, order: 2 };
  const base = new Float32Array(size * 3);
  const sprites: DrawParams[] = [];
  for (let k = 0; k < size; k++) {
    base[k * 3] = rand() * REF_LOGICAL.width;
    base[k * 3 + 1] = rand() * REF_LOGICAL.height;
    base[k * 3 + 2] = rand() * Math.PI * 2;
    const tint: [number, number, number, number] = [
      0.4 + 0.6 * rand(),
      0.4 + 0.6 * rand(),
      0.4 + 0.6 * rand(),
      1,
    ];
    sprites.push({ x: 0, y: 0, w: 16, h: 16, tint, order: 1 });
  }
  return {
    id: 'board',
    size,
    prepare: () => true,
    step(i) {
      mark('update');
      const t = i * REF_DT;
      book.update(REF_DT);
      for (let k = 0; k < size; k++) {
        const s = sprites[k]!;
        const a = base[k * 3 + 2]! + t * 0.8;
        s.x = base[k * 3]! + 24 * Math.cos(a);
        s.y = base[k * 3 + 1]! + 24 * Math.sin(a);
      }
      walker.x = (t * 240) % REF_LOGICAL.width;
      walker.uv = book.uv;
      const frame = renderer.beginFrame(t, REF_DT);
      frame.clear(0, 0, 0);
      layer.draw(frame);
      for (let k = 0; k < size; k++) frame.sprite(null, sprites[k]!);
      frame.sprite(material, walker);
      mark('view');
      renderer.render(frame, camera);
      mark('present');
      renderer.endFrame();
    },
    dispose() {},
  };
}

// --------------------------------------------------------- S2 characters, S5 stereo (figures)

/** The figure's rig: hips, spine, head, two arms, two legs; every node is a joint. */
const FIGURE_PARENTS = [-1, 0, 1, 1, 1, 0, 0];
/** Rest translation of each node from its parent. */
const FIGURE_REST: readonly (readonly [number, number, number])[] = [
  [0, 1, 0],
  [0, 0.25, 0],
  [0, 0.5, 0],
  [-0.3, 0.4, 0],
  [0.3, 0.4, 0],
  [-0.12, 0, 0],
  [0.12, 0, 0],
];
/** Each node's box: its centre (offset from the node's bind position) and size. */
const FIGURE_PARTS: readonly (readonly [number, number, number, number, number, number])[] = [
  [0, 0, 0, 0.4, 0.25, 0.25],
  [0, 0.25, 0, 0.45, 0.5, 0.25],
  [0, 0.15, 0, 0.25, 0.25, 0.25],
  [0, -0.25, 0, 0.12, 0.55, 0.12],
  [0, -0.25, 0, 0.12, 0.55, 0.12],
  [0, -0.45, 0, 0.15, 0.9, 0.15],
  [0, -0.45, 0, 0.15, 0.9, 0.15],
];

function figureSkeleton(): Skeleton {
  const n = FIGURE_PARENTS.length;
  const rest = new Float32Array(n * POSE_NODE_FLOATS);
  for (let k = 0; k < n; k++) {
    const o = k * POSE_NODE_FLOATS;
    rest.set(FIGURE_REST[k]!, o);
    rest[o + 6] = 1;
    rest[o + 7] = rest[o + 8] = rest[o + 9] = 1;
  }
  const parents = new Int16Array(FIGURE_PARENTS);
  const skeleton: Skeleton = { parents, rest, joints: new Uint16Array(n).map((_v, k) => k) };
  skeleton.inverseBind = inverseBindFromRest(skeleton);
  return skeleton;
}

/** One skinned mesh of the figure's boxes, each vertex bound wholly to its node. */
function figureGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const parts = FIGURE_PARTS.map(([, , , sx, sy, sz]) => box({ size: [sx, sy, sz] }));
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of parts) {
    vertexCount += p.vertices.length / 12;
    indexCount += p.indices.length;
  }
  const vertices = new Float32Array(vertexCount * VERTEX_SKINNED_FLOATS);
  const bytes = new Uint8Array(vertices.buffer);
  const indices = new Uint16Array(indexCount);
  const bind = new Float32Array(FIGURE_PARENTS.length * 3);
  for (let k = 0; k < FIGURE_PARENTS.length; k++) {
    const p = FIGURE_PARENTS[k]!;
    for (let a = 0; a < 3; a++)
      bind[k * 3 + a] = (p < 0 ? 0 : bind[p * 3 + a]!) + FIGURE_REST[k]![a]!;
  }
  let v = 0;
  let ix = 0;
  parts.forEach((part, k) => {
    const first = v;
    const count = part.vertices.length / 12;
    for (let q = 0; q < count; q++) {
      const o = v * VERTEX_SKINNED_FLOATS;
      vertices.set(part.vertices.subarray(q * 12, q * 12 + 12), o);
      for (let a = 0; a < 3; a++) vertices[o + a]! += bind[k * 3 + a]! + FIGURE_PARTS[k]![a]!;
      setVertexSkin(bytes, v, [k, k], [1, 0]);
      v++;
    }
    for (let q = 0; q < part.indices.length; q++) indices[ix++] = first + part.indices[q]!;
  });
  return { vertices, indices };
}

/** A quaternion about x by `angle`, as clip values. */
function quatX(angle: number): number[] {
  return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
}

/** The walk: arms and legs swing in opposition, the hips bob twice a cycle. */
function walkClip(): AnimationClip {
  const times = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
  const swing = (amp: number) => new Float32Array([0, 1, 0, -1, 0].flatMap((s) => quatX(amp * s)));
  return {
    name: 'walk',
    duration: 1,
    channels: [
      {
        node: 0,
        path: 'translation',
        interpolation: 'LINEAR',
        times,
        values: new Float32Array([0, 1, 0, 0, 1.05, 0, 0, 1, 0, 0, 1.05, 0, 0, 1, 0]),
      },
      { node: 3, path: 'rotation', interpolation: 'LINEAR', times, values: swing(0.6) },
      { node: 4, path: 'rotation', interpolation: 'LINEAR', times, values: swing(-0.6) },
      { node: 5, path: 'rotation', interpolation: 'LINEAR', times, values: swing(-0.5) },
      { node: 6, path: 'rotation', interpolation: 'LINEAR', times, values: swing(0.5) },
    ],
  };
}

/**
 * S2 (and S5's scene): `size` walking figures on a lit ground, one skinned mesh and one
 * `SkinPalette` slot each, an `AnimationMixer` per figure posed through `skinPose`, the sun
 * casting a shadow, the camera orbiting. `stereo` draws it through two eyes 0.064 apart, each
 * half the screen (`views` 1: one full-screen camera, the same scene).
 */
function refFigures(
  id: 'characters' | 'stereo',
  renderer: Renderer,
  size: number,
  views: 1 | 2,
  stereo: boolean,
  mark: (part: string) => void,
): RefScene {
  const skeleton = figureSkeleton();
  const joints = FIGURE_PARENTS.length;
  const palette = new SkinPalette(renderer.device, {
    joints,
    instances: size,
    label: 'ref-figures',
  });
  const skinned = renderer.createMaterial({
    label: 'ref-figures',
    blend: 'opaque',
    wgsl: LIT_WGSL,
    buffers: [palette.buffer],
  });
  const lit = renderer.createMaterial({ label: 'ref-ground', blend: 'opaque', wgsl: LIT_WGSL });
  const body = renderer.createMesh({
    ...figureGeometry(),
    layout: VERTEX_LAYOUT_SKINNED,
    label: 'ref-figure',
  });
  const side = Math.ceil(Math.sqrt(size));
  const span = side * 1.6;
  const ground = renderer.createMesh({ ...plane({ size: span + 8 }), label: 'ref-ground' });
  const groundT = new Transform();
  const groundP: InstanceParams = { tint: [0.4, 0.46, 0.36, 1] };
  const clip = walkClip();
  const rand = lcg(0xc4a2);
  const mixers: AnimationMixer[] = [];
  const transforms: Transform[] = [];
  const params: InstanceParams[] = [];
  for (let k = 0; k < size; k++) {
    const mixer = new AnimationMixer(skeleton);
    mixer.play(clip, { startTime: rand(), speed: 0.8 + 0.4 * rand() });
    mixers.push(mixer);
    transforms.push(
      new Transform({
        x: ((k % side) - (side - 1) / 2) * 1.6,
        z: (Math.floor(k / side) - (side - 1) / 2) * 1.6,
      }).setAxisAngle(0, 1, 0, rand() * Math.PI * 2),
    );
    params.push({
      tint: [0.5 + 0.5 * rand(), 0.4 + 0.4 * rand(), 0.3 + 0.3 * rand(), 1],
      params: [0, 0, 0, k],
    });
  }
  const lights = new Lights();
  lights.ambient.set([0.2, 0.2, 0.22]);
  lights.sun.direction = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.85, 0.85, 0.8];
  lights.sun.shadow = { extent: span * 0.75 + 4, size: 2048 };
  const eyes: Camera[] = [];
  const count = stereo ? views : 1;
  for (let e = 0; e < count; e++) {
    const c = Camera.perspective(
      (50 * Math.PI) / 180,
      REF_LOGICAL.width / count / REF_LOGICAL.height,
      0.1,
      span * 4 + 20,
    );
    c.cull = true;
    if (count === 2) {
      c.screen.width = 0.5;
      c.screen.x = e * 0.5;
      c.viewIndex = e;
    }
    eyes.push(c);
  }
  renderer.camera = eyes[0]!;
  const eye = new Float32Array(3);
  const target = new Float32Array(3);
  const radius = span * 0.9 + 4;
  return {
    id,
    size,
    prepare: () => true,
    step(i) {
      mark('update');
      const t = i * REF_DT;
      for (let k = 0; k < size; k++) skinPose(skeleton, mixers[k]!, palette, k, REF_DT);
      palette.flush();
      const a = t * 0.2;
      const frame = renderer.beginFrame(t, REF_DT);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      for (let k = 0; k < size; k++) frame.mesh(body, skinned, transforms[k]!, params[k]);
      for (let e = 0; e < eyes.length; e++) {
        // The eyes sit 0.064 apart along the orbit's right vector.
        const off = eyes.length === 2 ? (e - 0.5) * 0.064 : 0;
        eye[0] = Math.sin(a) * radius + Math.cos(a) * off;
        eye[1] = radius * 0.55;
        eye[2] = Math.cos(a) * radius - Math.sin(a) * off;
        target[0] = Math.cos(a) * off;
        target[1] = 0.8;
        target[2] = -Math.sin(a) * off;
        eyes[e]!.lookAt(eye, target);
        mark(eyes.length === 2 ? (e === 0 ? 'left' : 'right') : 'view');
        renderer.render(frame, eyes[e]!);
      }
      mark('present');
      renderer.endFrame();
    },
    dispose() {
      palette.destroy();
    },
  };
}

// ---------------------------------------------------------------------- S3, the lit arena

/**
 * S3: `size` spheres in a ring of rings, alternately metal and rough (two standard
 * materials), eight pillars, a floor; the sun with a shadow, eight point lights circling, two
 * spots; bloom, vignette and the grade through a `PostStack`; the camera orbiting.
 */
function refArena(renderer: Renderer, size: number, mark: (part: string) => void): RefScene {
  const camera = perspective(55, 120);
  renderer.camera = camera;
  const post = new PostStack(renderer, { bloom: { enabled: true }, vignette: { enabled: true } });
  renderer.post = post;
  const metal = createStandardMaterial(renderer, {
    label: 'ref-metal',
    metallic: 1,
    roughness: 0.3,
  });
  const rough = createStandardMaterial(renderer, {
    label: 'ref-rough',
    metallic: 0,
    roughness: 0.8,
  });
  const stone = createStandardMaterial(renderer, {
    label: 'ref-floor',
    metallic: 0,
    roughness: 0.95,
  });
  const ball = renderer.createMesh({
    ...sphere({ radius: 0.5, segments: [32, 16] }),
    label: 'ref-ball',
  });
  const pillar = renderer.createMesh({ ...box({ size: [1, 4, 1] }), label: 'ref-pillar' });
  const floor = renderer.createMesh({ ...plane({ size: 60 }), label: 'ref-floor' });
  const rand = lcg(0xa2e4a);
  const ballT: Transform[] = [];
  const ballP: InstanceParams[] = [];
  for (let k = 0; k < size; k++) {
    const ring = Math.floor(Math.sqrt(k));
    const a = ((k - ring * ring) / (2 * ring + 1)) * Math.PI * 2 + ring;
    const r = 3 + ring * 2;
    ballT.push(new Transform({ x: Math.cos(a) * r, y: 0.5 + rand() * 1.5, z: Math.sin(a) * r }));
    ballP.push({ tint: [0.4 + 0.6 * rand(), 0.4 + 0.6 * rand(), 0.4 + 0.6 * rand(), 1] });
  }
  const pillarT: Transform[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    pillarT.push(new Transform({ x: Math.cos(a) * 9, y: 2, z: Math.sin(a) * 9 }));
  }
  const pillarP: InstanceParams = { tint: [0.7, 0.68, 0.64, 1] };
  const floorT = new Transform();
  const floorP: InstanceParams = { tint: [0.35, 0.37, 0.33, 1] };
  const lights = new Lights();
  lights.ambient.set([0.08, 0.08, 0.1]);
  lights.sun.direction = [-0.4, -1.0, -0.5];
  lights.sun.color = [1.2, 1.15, 1.05];
  lights.sun.shadow = { extent: 24, size: 2048 };
  const lamps: PointLight[] = [];
  for (let k = 0; k < 8; k++) {
    const lamp: PointLight = {
      position: new Float32Array(3),
      color: [1.5 * rand() + 0.5, 1.2 * rand() + 0.4, 1.0 * rand() + 0.3],
      radius: 8,
    };
    lamps.push(lamp);
    lights.points.push(lamp);
  }
  for (let k = 0; k < 2; k++) {
    const spot: SpotLight = {
      position: [k === 0 ? -6 : 6, 7, 0],
      direction: [k === 0 ? 0.5 : -0.5, -1, 0],
      color: [3, 2.6, 2],
      radius: 18,
      innerAngle: 0.3,
      outerAngle: 0.5,
    };
    lights.spots.push(spot);
  }
  return {
    id: 'arena',
    size,
    prepare: () => true,
    step(i) {
      mark('update');
      const t = i * REF_DT;
      for (let k = 0; k < lamps.length; k++) {
        const p = lamps[k]!.position as Float32Array;
        const a = (k / lamps.length) * Math.PI * 2 + t * 0.5;
        p[0] = Math.cos(a) * 6;
        p[1] = 1.5 + Math.sin(t + k);
        p[2] = Math.sin(a) * 6;
      }
      const a = t * 0.15;
      camera.lookAt([Math.sin(a) * 22, 9, Math.cos(a) * 22], [0, 1, 0]);
      const frame = renderer.beginFrame(t, REF_DT);
      frame.clear(0.02, 0.02, 0.03);
      frame.lights = lights;
      frame.mesh(floor, stone, floorT, floorP);
      for (let k = 0; k < pillarT.length; k++) frame.mesh(pillar, stone, pillarT[k]!, pillarP);
      for (let k = 0; k < size; k++)
        frame.mesh(ball, k % 2 === 0 ? metal : rough, ballT[k]!, ballP[k]);
      mark('view');
      renderer.render(frame, camera);
      mark('present');
      renderer.endFrame();
    },
    dispose() {
      renderer.post = null;
      post.destroy();
    },
  };
}

// ------------------------------------------------------------------------ S4, the voxel world

const VOXEL_CHUNK = 16;
const VOXEL_HEIGHT = 32;

/** Rolling hills between 2 and 28, deterministic (harness/voxel.ts's terrain). */
function terrainHeight(x: number, z: number): number {
  const h =
    12 +
    2.5 * Math.sin(x * 0.21) +
    2 * Math.cos(z * 0.17 + x * 0.05) +
    1.2 * Math.sin((x + z) * 0.37);
  return Math.max(2, Math.min(VOXEL_HEIGHT - 4, Math.round(h)));
}

const BLOCKS_WGSL = /* wgsl */ `
${VOXEL_WGSL}
@group(1) @binding(1) var blockSampler: sampler;
@group(1) @binding(2) var blocks: texture_2d_array<f32>;

@fragment fn fs_main(in: VSOut) -> FragOut {
  let albedo = textureSample(blocks, blockSampler, voxel_uv_wrap(in.uv), voxel_layer(in.color)).rgb;
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(albedo * (engine_lambert(n, in.worldPos) + 0.15 * sky) * voxel_ao(in.color), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

function blockLayers(): PixelSource[] {
  const colours = [
    [112, 186, 84],
    [150, 108, 70],
    [128, 130, 136],
  ];
  return colours.map((rgb, layer) => {
    const data = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const h = Math.sin(x * 12.9898 + y * 78.233 + layer * 37.719) * 43758.5453;
        const k = 0.86 + 0.14 * (h - Math.floor(h));
        const o = (y * 16 + x) * 4;
        data[o] = rgb[0]! * k;
        data[o + 1] = rgb[1]! * k;
        data[o + 2] = rgb[2]! * k;
        data[o + 3] = 255;
      }
    }
    return { width: 16, height: 16, data };
  });
}

/**
 * S4: a `size` × 2 × `size`-chunk block world (16³ chunks: grass over dirt over stone) through
 * the `voxel` module at its best settings today (greedy meshing with baked AO, a mesher off the
 * main thread on the page, per-chunk frustum culling), the camera flying a circle over it.
 */
function refVoxel(
  renderer: Renderer,
  size: number,
  mark: (part: string) => void,
  mesherFor?: (grid: VoxelGrid) => VoxelMesher,
): RefScene {
  const camera = perspective(60, 160);
  renderer.camera = camera;
  const extent = size * VOXEL_CHUNK;
  const grid = createVoxelGrid({
    sizeX: extent,
    sizeY: VOXEL_HEIGHT,
    sizeZ: extent,
    chunk: VOXEL_CHUNK,
  });
  grid.fill((x, y, z) => {
    const h = terrainHeight(x, z);
    if (y >= h) return 0;
    if (y === h - 1) return 1;
    return y >= h - 4 ? 2 : 3;
  });
  const array = loadTextureArray(renderer.device, blockLayers(), { label: 'ref-blocks' });
  const material: Material = renderer.createMaterial({
    label: 'ref-blocks',
    blend: 'opaque',
    wgsl: BLOCKS_WGSL,
    textures: 1,
    viewDimension: '2d-array',
    sampler: 'nearest-mip-repeat',
  });
  material.setTexture(0, array);
  const chunks = createVoxelChunks(renderer, grid, {
    material,
    slack: 1.5,
    ...(mesherFor ? { mesher: mesherFor(grid) } : {}),
  });
  const lights = new Lights();
  lights.ambient.set([0.28, 0.3, 0.34]);
  lights.sun.direction = [-0.45, -1.0, -0.55];
  lights.sun.color = [0.85, 0.82, 0.74];
  const eye = new Float32Array(3);
  const target = new Float32Array(3);
  const centre = extent / 2;
  const radius = extent * 0.3;
  return {
    id: 'voxel',
    size,
    prepare() {
      const asked = chunks.update();
      return asked === 0 && chunks.stats.pending === 0 && chunks.stats.chunks > 0;
    },
    step(i) {
      mark('update');
      const t = i * REF_DT;
      chunks.update();
      const a = t * 0.1;
      eye[0] = centre + Math.sin(a) * radius;
      eye[1] = VOXEL_HEIGHT + 6;
      eye[2] = centre + Math.cos(a) * radius;
      target[0] = eye[0] + Math.cos(a) * 10;
      target[1] = VOXEL_HEIGHT - 4;
      target[2] = eye[2] - Math.sin(a) * 10;
      camera.lookAt(eye, target);
      const frame = renderer.beginFrame(t, REF_DT);
      frame.clear(0.5, 0.68, 0.9);
      frame.lights = lights;
      chunks.draw(frame, camera);
      mark('view');
      renderer.render(frame, camera);
      mark('present');
      renderer.endFrame();
    },
    dispose() {
      chunks.dispose();
    },
  };
}

// --------------------------------------------------------------------------- S6, the idle HUD

/**
 * S6: today's HUD widgets (a reticle, two meters, a 6-slot strip, a heading) over a still lit
 * scene, idle: every frame sets each widget to the value it already shows, as a game that pushes
 * its state every frame does. The goal is no DOM write or read in such a frame.
 */
function refHud(renderer: Renderer, parent: HTMLElement, mark: (part: string) => void): RefScene {
  const camera = perspective(50, 100);
  renderer.camera = camera;
  camera.lookAt([0, 4, 9], [0, 1, 0]);
  const ui = createOverlay({ parent, caption: { reducedMotion: true } });
  const reticle = ui.reticle({ style: 'cross', size: 28, gap: 8 });
  const steady = ui.meter({ label: 'Steady', max: 100, region: 'left', order: 1 });
  const draining = ui.meter({
    label: 'Draining',
    max: 100,
    region: 'left',
    order: 2,
    tone: 'warn',
  });
  const slots = ui.slots({ count: 6, hints: ['1', '2', '3', '4', '5', '6'], region: 'bottom' });
  for (let k = 0; k < 6; k++) slots.setContent(k, String.fromCharCode(65 + k));
  const heading = ui.heading({ region: 'top' });
  steady.set(100);
  draining.set(62);
  slots.select(2);
  heading.setYaw(0.5);
  const lit = renderer.createMaterial({ label: 'ref-hud', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...box(), label: 'ref-hud-cube' });
  const ground = renderer.createMesh({ ...plane({ size: 16 }), label: 'ref-hud-ground' });
  const groundT = new Transform();
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1] };
  const cubeT = [-2, 0, 2].map((x) => new Transform({ x, y: 0.5 }));
  const cubeP: InstanceParams = { tint: [0.9, 0.5, 0.2, 1] };
  const lights = new Lights();
  lights.ambient.set([0.18, 0.18, 0.2]);
  lights.sun.direction = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];
  return {
    id: 'hud',
    size: 1,
    prepare: () => true,
    step(i) {
      mark('update');
      const t = i * REF_DT;
      const frame = renderer.beginFrame(t, REF_DT);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      for (let k = 0; k < cubeT.length; k++) frame.mesh(cube, lit, cubeT[k]!, cubeP);
      mark('view');
      renderer.render(frame, camera);
      mark('present');
      renderer.endFrame();
      // Idle: the same values again.
      mark('hud');
      steady.set(100);
      draining.set(62);
      slots.select(2);
      heading.setYaw(0.5);
      reticle.show();
    },
    dispose() {
      ui.destroy();
    },
  };
}

// ------------------------------------------------------------------------- DOM work counting

export interface DomCounts {
  /** Mutation records under the root: attributes (style and class included), children, text. */
  writes: number;
  /** Layout reads: `getBoundingClientRect`, `getComputedStyle`, offset/client/scroll sizes. */
  reads: number;
}

/**
 * Count DOM writes under `root` and layout reads anywhere between `start` and `stop`, by a
 * `MutationObserver` and by wrapping the layout-reading methods and getters on the prototypes
 * (restored by `stop`). For S6's idle frames. `reading(false)` leaves reads between frames out
 * (a test tool's own, such as Playwright's trace snapshots); reads count from `start` until then.
 */
export function countDom(root: Node): {
  start(): void;
  stop(): DomCounts;
  reading(on: boolean): void;
} {
  const counts: DomCounts = { writes: 0, reads: 0 };
  let live = true;
  const observer = new MutationObserver((records) => {
    counts.writes += records.length;
  });
  const restore: (() => void)[] = [];
  /** The object on `obj`'s prototype chain that owns `name`, with its descriptor. */
  const own = (obj: object, name: string): [object, PropertyDescriptor] | [null, undefined] => {
    for (let o: object | null = obj; o; o = Object.getPrototypeOf(o) as object | null) {
      const desc = Object.getOwnPropertyDescriptor(o, name);
      if (desc) return [o, desc];
    }
    return [null, undefined];
  };
  const wrapMethod = (obj: object, name: string) => {
    const [proto, desc] = own(obj, name);
    if (!proto) return;
    if (typeof desc.value !== 'function') return;
    const fn = desc.value as (...args: unknown[]) => unknown;
    Object.defineProperty(proto, name, {
      ...desc,
      value(this: unknown, ...args: unknown[]) {
        if (live) counts.reads++;
        return fn.apply(this, args);
      },
    });
    restore.push(() => Object.defineProperty(proto, name, desc));
  };
  const wrapGetter = (obj: object, name: string) => {
    const [proto, desc] = own(obj, name);
    if (!proto || !desc.get) return;
    const get = desc.get;
    Object.defineProperty(proto, name, {
      ...desc,
      get(this: unknown) {
        if (live) counts.reads++;
        return get.call(this);
      },
    });
    restore.push(() => Object.defineProperty(proto, name, desc));
  };
  return {
    reading(on: boolean) {
      live = on;
    },
    start() {
      counts.writes = 0;
      counts.reads = 0;
      live = true;
      observer.observe(root, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      wrapMethod(Element.prototype, 'getBoundingClientRect');
      wrapMethod(Element.prototype, 'getClientRects');
      wrapMethod(window, 'getComputedStyle');
      for (const name of [
        'offsetWidth',
        'offsetHeight',
        'offsetTop',
        'offsetLeft',
        'offsetParent',
      ]) {
        wrapGetter(HTMLElement.prototype, name);
      }
      for (const name of [
        'clientWidth',
        'clientHeight',
        'clientTop',
        'clientLeft',
        'scrollWidth',
        'scrollHeight',
        'scrollTop',
        'scrollLeft',
      ]) {
        wrapGetter(Element.prototype, name);
      }
    },
    stop() {
      counts.writes += observer.takeRecords().length;
      observer.disconnect();
      while (restore.length) restore.pop()!();
      return { writes: counts.writes, reads: counts.reads };
    },
  };
}
