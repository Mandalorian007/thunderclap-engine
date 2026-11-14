/**
 * The world scene: the one screen of this client.
 *
 * - `enter` turns `ctx.camera` into a perspective camera (depth and frustum culling on), builds
 *   the block material from a texture array, one `Mesh` per chunk (created empty with a capacity)
 *   and asks the mesher Worker for every chunk; each reply goes to `mesh.update()` with its
 *   bounds, straight from the transferred buffer.
 * - `update(dt)` runs once per rendered frame (`sim: false`): `Look` has already turned the
 *   mouse, the touch zones, the sticks and the keys into `look` and `move`; the scene walks the
 *   player over the height field (a one-block step up is allowed, higher blocks stop you), aims
 *   the camera, moves the snow with the player and finds the landmark in the crosshair.
 * - `render(frame)` sets the frame's lights (sun with a shadow map, fog that matches the sky),
 *   draws the chunks, the landmark markers and the weather. Nothing is allocated per frame.
 * - Landmarks carry a DOM label through `ui.anchors` and a hit box on `ctx.pointers`. The scene's
 *   verbs are intents (`createIntents`): `inspect` is a tap aimed by a ray (a finger's or a free
 *   mouse's point, or `null` for the crosshair under the pointer lock or on a pad), `respawn` a
 *   press. The scene never asks which device it was.
 */
import type { Scene } from '@thunderclap-engine/engine/core';
import { ParticleEmitter, ParticleSystem } from '@thunderclap-engine/engine/fx';
import {
  aabbTester,
  createIntents,
  createRay,
  type HitTester,
  type IntentAim,
  type Intents,
  type RayBox,
  screenRay,
} from '@thunderclap-engine/engine/input';
import {
  type Frame,
  type InstanceParams,
  Lights,
  loadTextureArray,
  type Material,
  type Mesh,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import { h } from '@thunderclap-engine/engine/ui';
import { blockLayers } from '../art/blocks';
import type { GameCtx } from '../ctx';
import {
  CHUNK,
  CHUNK_BUFFER_BYTES,
  INDEX_OFFSET,
  MAX_INDICES,
  MAX_VERTICES,
  VERTEX_FLOATS,
} from '../world/mesher';
import type { ChunkReply, ChunkRequest } from '../world/protocol';
import { type Landmark, surfaceY } from '../world/terrain';

/** Camera: vertical field of view and clip range (world units). */
const FOV = (70 * Math.PI) / 180;
const NEAR = 0.1;
const FAR = 160;
/** Eye height over the feet, walking speeds (units per second) and the pitch limit (radians). */
const EYE = 1.6;
const WALK = 4.5;
const SPRINT = 8;
const PITCH_LIMIT = 1.45;
/** The highest block edge the player steps over; higher ones are walls. */
const STEP_UP = 1.05;
const STEP_RATE = 10;
const GRAVITY = 22;
/** How far the crosshair reaches a landmark. */
const INSPECT_RANGE = 36;
/** Sky and fog colour (linear RGB), the fog's range and the sun's shadow box. */
const SKY = [0.42, 0.55, 0.74] as const;
const FOG_NEAR = 24;
const FOG_FAR = 120;
const SHADOW_EXTENT = 28;
const SHADOW_SIZE = 2048;
const MARKER_HEIGHT = 1.2;

/**
 * Block faces from the texture array; `engine_lambert` (ambient + shadowed sun) with a faint sky
 * term from above, then `engine_fog` by distance from the eye. The face's layer is a whole
 * number in the vertex colour's alpha; the rgb is the mesher's shade.
 */
const BLOCKS_WGSL = /* wgsl */ `
@group(1) @binding(1) var blockSampler: sampler;
@group(1) @binding(2) var blocks: texture_2d_array<f32>;

@fragment fn fs_main(in: VSOut) -> FragOut {
  let layer = u32(round(in.color.a));
  let albedo = textureSample(blocks, blockSampler, in.uv, layer).rgb * in.color.rgb;
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  let lit = albedo * (engine_lambert(n, in.worldPos) + 0.1 * sky);
  var o: FragOut;
  o.color = vec4f(engine_fog(lit, in.worldPos), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** Landmark markers: unlit, glowing through the fog. */
const MARKER_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let c = in.color.rgb * (0.7 + 0.3 * n.y);
  var o: FragOut;
  o.color = vec4f(engine_fog(c, in.worldPos), 1.0);
  o.emissive = vec4f(in.color.rgb * in.emissive, 1.0);
  return o;
}`;

/** A unit cube on the origin, 24 vertices in the 3D layout, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const faces: [number[], number[], number[]][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const vertices = new Float32Array(24 * VERTEX_FLOATS);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const [n, r, u] of faces) {
    const base = v / VERTEX_FLOATS;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) vertices[v + k] = (n[k]! + sx * r[k]! + sy * u[k]!) * 0.5;
      vertices[v + 3] = n[0]!;
      vertices[v + 4] = n[1]!;
      vertices[v + 5] = n[2]!;
      vertices[v + 6] = (sx + 1) / 2;
      vertices[v + 7] = (1 - sy) / 2;
      vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
      v += VERTEX_FLOATS;
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i);
    i += 6;
  }
  return { vertices, indices };
}

interface Marker {
  readonly landmark: Landmark;
  readonly transform: Transform;
  readonly params: InstanceParams;
}

export function createWorldScene(ctx: GameCtx): Scene<GameCtx, Frame> {
  const { renderer, camera, look, player, world } = ctx;
  const chunksPerSide = world.terrain.size / CHUNK;

  // ── GPU resources, built once ─────────────────────────────────────────
  const blocks: Material = renderer.createMaterial({
    label: 'blocks',
    blend: 'opaque',
    wgsl: BLOCKS_WGSL,
    textures: 1,
    viewDimension: '2d-array',
    sampler: 'linear-mip-repeat',
  });
  blocks.setTexture(0, loadTextureArray(renderer.device, blockLayers(), { label: 'blocks' }));
  const markerMaterial = renderer.createMaterial({
    label: 'marker',
    blend: 'opaque',
    wgsl: MARKER_WGSL,
  });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });

  const chunks: Mesh[] = [];
  const chunkTransforms: Transform[] = [];
  for (let cz = 0; cz < chunksPerSide; cz++) {
    for (let cx = 0; cx < chunksPerSide; cx++) {
      chunks.push(
        renderer.createMesh({
          label: `chunk-${cx}-${cz}`,
          layout: VERTEX_LAYOUT_3D,
          capacity: { vertices: MAX_VERTICES, indices: MAX_INDICES },
        }),
      );
      chunkTransforms.push(new Transform({ x: cx * CHUNK, y: 0, z: cz * CHUNK }));
    }
  }

  const markers: Marker[] = world.landmarks.map((landmark) => ({
    landmark,
    transform: new Transform({
      x: landmark.x + 0.5,
      y: landmark.height + MARKER_HEIGHT / 2,
      z: landmark.z + 0.5,
      scaleX: 0.5,
      scaleY: MARKER_HEIGHT,
      scaleZ: 0.5,
    }),
    params: { tint: [1.0, 0.75, 0.3, 1], emissive: 1.2 },
  }));

  // ── Lights: a sun with a shadow map, fog the colour of the sky ────────
  const lights = new Lights();
  lights.ambient.set([0.26, 0.28, 0.34]);
  lights.sun.direction = [-0.5, -1.0, -0.35];
  lights.sun.color = [1.0, 0.95, 0.85];
  lights.sun.shadow = { extent: SHADOW_EXTENT, size: SHADOW_SIZE };
  lights.fog.color = SKY;
  lights.fog.density = 1;
  lights.fog.near = FOG_NEAR;
  lights.fog.far = FOG_FAR;

  // ── Weather: snow in world space, soft against the ground, following the player ──
  const snow = new ParticleSystem(renderer, {
    space: 'world',
    capacity: 6144,
    blend: 'alpha',
    lit: true,
    fade: { near: 28, far: 48 },
    softness: 0.3,
    stretch: 0,
  });
  const flakes = new ParticleEmitter(
    snow,
    {
      x: 0,
      y: 0,
      z: 0,
      shape: { kind: 'box', width: 44, height: 2, depth: 44 },
      speed: [0, 0.3],
      life: [5, 7],
      size: [0.1, 0.08],
      colorStart: [1, 1, 1, 0.9],
      colorEnd: [1, 1, 1, 0.5],
      gravity: [0, -0.7, 0],
      wind: [0.5, -1.2, 0.2],
      drag: 1.5,
      emissive: 0,
    },
    700,
  );

  // ── Picking: hit boxes on the pointer router, and the same tester for the crosshair ──
  const boxes: RayBox<Landmark>[] = world.landmarks.map((l) => ({
    min: [l.x, l.height, l.z],
    max: [l.x + 1, l.height + MARKER_HEIGHT, l.z + 1],
    target: l,
  }));
  const tester: HitTester<Landmark> = aabbTester(boxes);
  const centreRay = createRay();
  let focus: Landmark | null = null;

  // ── The Worker and the anchors are scene-lifetime: built on enter, torn down on exit ──
  let worker: Worker | null = null;
  let removeTester: (() => void) | null = null;
  let removeAnchors: (() => void)[] = [];
  let loaded = 0;

  const eye = new Float32Array(3);
  const target = new Float32Array(3);
  let vy = 0;

  const aim = () => {
    const cp = Math.cos(player.pitch);
    eye[0] = player.position[0]!;
    eye[1] = player.position[1]! + EYE;
    eye[2] = player.position[2]!;
    // Yaw 0 looks down -z; positive yaw turns right (towards +x).
    target[0] = eye[0] + Math.sin(player.yaw) * cp;
    target[1] = eye[1] + Math.sin(player.pitch);
    target[2] = eye[2] - Math.cos(player.yaw) * cp;
    camera.lookAt(eye, target);
  };

  /** Moves the feet along one axis unless the ground there rises more than a step. */
  const step = (axis: 0 | 2, delta: number) => {
    if (delta === 0) return;
    const p = player.position;
    const limit = world.terrain.size - 0.3;
    const next = Math.max(0.3, Math.min(limit, p[axis]! + delta));
    const ground =
      axis === 0 ? surfaceY(world.terrain, next, p[2]!) : surfaceY(world.terrain, p[0]!, next);
    if (ground - p[1]! <= STEP_UP) p[axis] = next;
  };

  const inspect = (landmark: Landmark) => {
    ctx.ui.toasts.show(`${landmark.name}: ${landmark.note}`, { tone: 'info', duration: 4000 });
  };

  /** What `aim` points at in reach: its own ray's hit, or the crosshair's (`null` aims at the centre). */
  const pointedAt = (aim: IntentAim): Landmark | null => {
    if (aim === null) return focus;
    const hit = tester(aim);
    return hit && hit.distance <= INSPECT_RANGE ? hit.target : null;
  };

  // The scene's verbs. Every scheme reaches the same handlers: a key, a pad button, a click, a tap.
  let intents: Intents | null = null;
  const logical = { x: 0, y: 0 };
  const startIntents = () =>
    createIntents(
      {
        inspect: { kind: 'tap', actions: ['inspect'] },
        respawn: { kind: 'press', actions: ['respawn'] },
      },
      {
        inspect: (aim) => {
          const chosen = pointedAt(aim);
          if (chosen) inspect(chosen);
        },
        respawn: () => ctx.respawn(),
      },
      {
        input: ctx.input,
        camera,
        pointers: ctx.pointers,
        // The locked mouse aims at the crosshair; the move stick's thumb never taps.
        centred: () => look.locked,
        stickZone: 'left',
        toScreen: (x, y) => ctx.surface.clientToLogical(x, y, logical),
      },
    );

  return {
    name: 'world',
    enter() {
      camera.setPerspective(FOV, ctx.design.width / ctx.design.height, NEAR, FAR);
      aim();

      worker = new Worker(new URL('../world/worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (e: MessageEvent<ChunkReply>) => {
        const { cx, cz, buffer, vertexCount, indexCount, bounds } = e.data;
        // Views over the transferred buffer: the upload reads them in place, and the Worker's
        // bounds go with them, so the mesh never scans its vertices.
        chunks[cz * chunksPerSide + cx]!.update({
          vertices: new Float32Array(buffer, 0, vertexCount * VERTEX_FLOATS),
          indices: new Uint16Array(buffer, INDEX_OFFSET, indexCount),
          vertexCount,
          indexCount,
          bounds,
        });
        loaded++;
      });
      for (let cz = 0; cz < chunksPerSide; cz++) {
        for (let cx = 0; cx < chunksPerSide; cx++) {
          const req: ChunkRequest = {
            seed: world.seed,
            cx,
            cz,
            buffer: new ArrayBuffer(CHUNK_BUFFER_BYTES),
          };
          worker.postMessage(req, [req.buffer]);
        }
      }

      removeTester = ctx.pointers.addTester(tester);
      intents = startIntents();
      const anchors = ctx.ui.anchors(() => camera);
      removeAnchors = world.landmarks.map((l) => {
        const label = h(
          'div',
          {
            class: 'landmark-label',
            style: {
              padding: '4px 10px',
              borderRadius: '6px',
              background: 'rgba(10, 12, 20, 0.55)',
              color: 'var(--tc-color-text)',
              fontFamily: 'var(--tc-font-display)',
              fontSize: 'var(--tc-font-size-m)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            },
          },
          l.name,
        );
        const handle = anchors.add(label, [l.x + 0.5, l.height + MARKER_HEIGHT + 0.4, l.z + 0.5], {
          align: [0.5, 1],
          scale: 'distance',
          clamp: true,
          margin: 24,
        });
        return () => handle.remove();
      });
    },
    exit() {
      worker?.terminate();
      worker = null;
      removeTester?.();
      removeTester = null;
      intents?.dispose();
      intents = null;
      for (const r of removeAnchors) r();
      removeAnchors = [];
      ctx.hud.setFocus(null);
    },
    update(dt) {
      const { input } = ctx;

      // Look: the deltas are already summed over mouse, touch and pad for this tick.
      player.yaw += look.look.dx;
      player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, player.pitch + look.look.dy));

      // Walk on the height field, one axis at a time so a wall slides instead of stopping.
      const speed = (input.held('sprint') ? SPRINT : WALK) * dt;
      const fx = Math.sin(player.yaw);
      const fz = -Math.cos(player.yaw);
      step(0, (fx * look.move.y - fz * look.move.x) * speed);
      step(2, (fz * look.move.y + fx * look.move.x) * speed);
      const p = player.position;
      const ground = surfaceY(world.terrain, p[0]!, p[2]!);
      if (ground > p[1]!) {
        // Up a step: ease onto it.
        p[1] = Math.min(ground, p[1]! + STEP_RATE * dt);
        vy = 0;
      } else if (ground < p[1]!) {
        vy -= GRAVITY * dt;
        p[1] = Math.max(ground, p[1]! + vy * dt);
      } else vy = 0;
      aim();

      // The snow falls around the player wherever they go.
      flakes.params.x = p[0]!;
      flakes.params.y = p[1]! + 14;
      flakes.params.z = p[2]!;
      flakes.update(dt);
      snow.update(dt);

      // What the crosshair points at: the same tester the pointer router runs for taps.
      screenRay(camera, ctx.design.width / 2, ctx.design.height / 2, centreRay);
      const hit = tester(centreRay);
      focus = hit && hit.distance <= INSPECT_RANGE ? hit.target : null;
      ctx.hud.setFocus(focus);

      // After the camera moved: the intents' rays are made through this frame's view.
      intents?.update();
    },
    render(frame) {
      frame.clear(SKY[0], SKY[1], SKY[2]);
      frame.lights = lights;
      for (let c = 0; c < chunks.length; c++) {
        // A chunk the Worker has not answered for yet has nothing to draw.
        if (chunks[c]!.indexCount > 0) frame.mesh(chunks[c]!, blocks, chunkTransforms[c]!);
      }
      for (const m of markers) frame.mesh(cube, markerMaterial, m.transform, m.params);
      if (loaded > 0) frame.drawable(snow, 1);
    },
  };
}
