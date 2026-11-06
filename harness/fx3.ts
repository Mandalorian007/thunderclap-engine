/**
 * fx-3 demo page: the extended particle kernel (ws/fx-3) in world space over a small lit
 * scene under a perspective camera. Noun-free; nothing here is engine code. One mode per page
 * load, picked by the query, each with a number the spec can poll (`fx3-state.ts`):
 *
 * - `?sheet` (default): a procedural 4 × 4 sprite sheet (`texture` + `atlas`); a parked sprite
 *   plays tiles 5..15 at 2 fps (`tile`, `tileRate`), spinning, beside a stream of upright
 *   sprites. `state.tileSeen` mirrors the tile the kernel shows.
 * - `?forces`: motes born on a shell around an attractor with a vortex (`system.forces`); 64 of
 *   them are shadowed on the CPU with `applyForces`, and `state.meanRadius` shrinks.
 * - `?collide`: rain over a floating slab with `readsDepth` and `collide`; `countBelowY` counts
 *   what gets under the slab into `state.belowSlab`.
 * - `?sub`: bursts of rising parents whose `onDeath` sub-emitters scatter long-lived children;
 *   `state.aliveAfterParents` is the live count once every parent has died.
 * - `?effect`: the bundled `MAGIC_AURA_EFFECT` attached to a point moving on a circle.
 * - `?still` parks the moving point and the lamp.
 */
import { GameLoop } from '@thunderclap/engine/core';
import {
  applyForces,
  createEffect,
  type Effect,
  type EffectDesc,
  type EmitParams,
  MAGIC_AURA_EFFECT,
  ParticleEmitter,
  type ParticleForce,
  ParticleSystem,
} from '@thunderclap/engine/fx';
import { box, plane } from '@thunderclap/engine/geom';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  type PointLight,
  Renderer,
  Transform,
} from '@thunderclap/engine/render';
import type { Fx3Mode, HarnessFx3Api, HarnessFx3State } from './fx3-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const MODES: Fx3Mode[] = ['sheet', 'forces', 'collide', 'sub', 'effect'];
const mode: Fx3Mode = MODES.find((m) => query.has(m)) ?? 'sheet';

const state: HarnessFx3State = {
  ready: false,
  gpu: 'pending',
  mode,
  still: query.has('still'),
  frames: 0,
  time: 0,
  logical: LOGICAL,
  alive: -1,
  particles: true,
  gpuErrors: 0,
  tileSeen: -1,
  meanRadius: -1,
  belowSlab: -1,
  aliveAfterParents: -1,
  effectInstances: 0,
  effectAlive: -1,
  probe: { x: 0, y: 0 },
};

const api: HarnessFx3Api = {
  state,
  setParticles(visible) {
    state.particles = visible;
  },
};
window.__harnessFx3 = api;

/** Albedo × the engine lighting block, a faint sky term, and a checker on the ground. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  var albedo = in.color.rgb;
  if (in.params.x > 0.0) {
    let cell = floor(in.worldPos.x) + floor(in.worldPos.z);
    albedo *= 0.8 + 0.2 * (cell - 2.0 * floor(cell * 0.5));
  }
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** The clear sky behind everything (linear). */
const SKY = [0.05, 0.07, 0.12] as const;
const TARGET = [0, 2.2, 0] as const;
const EYE = [0, 5.5, 13] as const;
const LAMP_COLOR = [1.6, 0.9, 0.4] as const;
/** The slab the collide mode rains on (centre, half extents). */
const SLAB = { x: 0, y: 3, z: 0, hx: 3, hy: 0.25, hz: 3 } as const;
/** Where the sky mode parks its sprite, in front of the clear sky. */
const SPRITE = [-4.5, 6.5, -4] as const;
const ATTRACTOR = [0, 6.5, -4] as const;
const SHELL = 3;
const TILE_FROM = 5;
const TILE_TO = 15;
const TILE_RATE = 2;
const PARENT_LIFE = [0.6, 0.8] as const;
const BURST_PERIOD = 4;

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

/** A 4 × 4 sheet of 16 × 16 px tiles: each tile a filled disc in its own hue. */
function sheetPixels(): Uint8Array<ArrayBuffer> {
  const tiles = 4;
  const size = 16;
  const data = new Uint8Array(tiles * size * tiles * size * 4);
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const i = ty * tiles + tx;
      const h = (i / 16) * 6;
      const k = Math.floor(h);
      const f = h - k;
      const rgb = [
        [1, f, 0],
        [1 - f, 1, 0],
        [0, 1, f],
        [0, 1 - f, 1],
        [f, 0, 1],
        [1, 0, 1 - f],
      ][k % 6]!;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x + 0.5 - size / 2;
          const dy = y + 0.5 - size / 2;
          const inside = dx * dx + dy * dy <= (size / 2 - 1) ** 2;
          const o = ((ty * size + y) * tiles * size + tx * size + x) * 4;
          data[o] = Math.round(255 * rgb[0]!);
          data[o + 1] = Math.round(255 * rgb[1]!);
          data[o + 2] = Math.round(255 * rgb[2]!);
          data[o + 3] = inside ? 255 : 0;
        }
      }
    }
  }
  return data;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine fx-3 demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  camera.lookAt(EYE, TARGET);
  renderer.camera = camera;

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const ground = renderer.createMesh({ ...plane({ size: 24 }), label: 'ground' });
  const block = renderer.createMesh({ ...box(), label: 'block' });
  const groundT = new Transform();
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const blocks: [Transform, InstanceParams][] = [
    [
      new Transform({ x: -4, y: 0.6, z: 1.5, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }),
      { tint: [0.3, 0.85, 0.35, 1] },
    ],
    [
      new Transform({ x: 4, y: 0.6, z: 1.5, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }),
      { tint: [0.95, 0.8, 0.2, 1] },
    ],
  ];
  if (mode === 'collide') {
    blocks.push([
      new Transform({
        x: SLAB.x,
        y: SLAB.y,
        z: SLAB.z,
        scaleX: SLAB.hx * 2,
        scaleY: SLAB.hy * 2,
        scaleZ: SLAB.hz * 2,
      }),
      { tint: [0.08, 0.28, 1.0, 1] },
    ]);
  }

  const lights = new Lights();
  lights.ambient.set([0.12, 0.12, 0.15]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.45, 0.47, 0.52];
  const lampPos = new Float32Array([2, 1.6, 2]);
  const lamp: PointLight = { position: lampPos, color: LAMP_COLOR, radius: 5 };
  lights.points.push(lamp);

  // ---------------------------------------------------------------- the mode's particles
  const systems: ParticleSystem[] = [];
  const emitters: ParticleEmitter[] = [];
  let main: ParticleSystem | null = null;
  let effect: Effect | null = null;
  let probeAt: readonly [number, number, number] = SPRITE;
  const shadowPos: Float32Array[] = [];
  const shadowVel: Float32Array[] = [];
  let spriteBorn = 0;
  let lastBurst = -Infinity;
  let shadowPending = 0;
  let shadowTime = 0;
  let emitShell: (() => void) | null = null;
  const effectPoint = new Float32Array([0, 4.5, 0]);
  let parent: EmitParams | null = null;

  if (mode === 'sheet') {
    const sheet = renderer.textureFromPixels({
      width: 64,
      height: 64,
      data: sheetPixels(),
      label: 'sheet',
    });
    main = new ParticleSystem(renderer, {
      space: 'world',
      capacity: 4096,
      blend: 'alpha',
      texture: sheet,
      atlas: { columns: 4, rows: 4 },
      stretch: 0,
      softness: 0,
      countAlive: true,
    });
    // The parked sprite: born once, re-emitted when its life ends.
    const stream = new ParticleEmitter(
      main,
      {
        x: 3,
        y: 0.5,
        z: -2,
        shape: { kind: 'box', width: 3, height: 0.2, depth: 2 },
        angle: Math.PI / 2,
        spread: 0.3,
        speed: [1.5, 2.5],
        life: [2, 3],
        size: [0.5, 0.3],
        colorStart: [1, 1, 1, 1],
        colorEnd: [1, 1, 1, 0],
        gravity: [0, 0, 0],
        drag: 0.3,
        emissive: 0.3,
        tile: [0, 15],
        rotation: [0, Math.PI * 2],
        spin: [-2, 2],
        alignToVelocity: false,
      },
      40,
    );
    emitters.push(stream);
  } else if (mode === 'forces') {
    probeAt = ATTRACTOR;
    // Steady orbit radius is (vortex / drag)^2 / attract = (0.35 / 0.4)^2 / 4 ≈ 0.2: the motes
    // settle into a blob on the probe, not a ring around it.
    const forces: ParticleForce[] = [
      { kind: 'attract', x: ATTRACTOR[0], y: ATTRACTOR[1], z: ATTRACTOR[2], strength: 4 },
      {
        kind: 'vortex',
        axis: [0, 1, 0],
        x: ATTRACTOR[0],
        y: ATTRACTOR[1],
        z: ATTRACTOR[2],
        strength: 0.35,
        radius: 6,
      },
      { kind: 'drag', amount: 0.4 },
    ];
    main = new ParticleSystem(renderer, {
      space: 'world',
      capacity: 8192,
      stretch: 0.03,
      softness: 0,
      forces,
      countAlive: true,
    });
    // Born on a shell of radius SHELL, at rest: only the forces move them.
    const shellParams: EmitParams = {
      x: ATTRACTOR[0],
      y: ATTRACTOR[1],
      z: ATTRACTOR[2],
      shape: { kind: 'point' },
      speed: [0, 0],
      life: [6, 8],
      size: [0.08, 0.08],
      colorStart: [2, 1.4, 0.6, 1],
      colorEnd: [1, 0.4, 0.2, 0],
      gravity: [0, 0, 0],
      drag: 0,
      emissive: 1,
    };
    const shell = new ParticleEmitter(main, shellParams, 0);
    emitters.push(shell);
    // 64 shadow particles on the same shell, stepped by `applyForces` once per frame.
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const b = ((i % 8) / 8 - 0.5) * Math.PI;
      shadowPos.push(
        new Float32Array([
          ATTRACTOR[0] + SHELL * Math.cos(a) * Math.cos(b),
          ATTRACTOR[1] + SHELL * Math.sin(b),
          ATTRACTOR[2] + SHELL * Math.sin(a) * Math.cos(b),
        ]),
      );
      shadowVel.push(new Float32Array(3));
    }
    // One ring of 256 at a time, spread on the shell, by moving the point around it.
    let seq = 0;
    emitShell = () => {
      for (let i = 0; i < 256; i++) {
        const a = seq * 2.399963;
        const b = Math.acos(1 - 2 * ((seq * 0.618034) % 1)) - Math.PI / 2;
        seq++;
        shellParams.x = ATTRACTOR[0] + SHELL * Math.cos(a) * Math.cos(b);
        shellParams.y = ATTRACTOR[1] + SHELL * Math.sin(b);
        shellParams.z = ATTRACTOR[2] + SHELL * Math.sin(a) * Math.cos(b);
        main!.emit(shellParams, 1);
      }
    };
    emitShell();
    lastBurst = 0;
  } else if (mode === 'collide') {
    probeAt = [SLAB.x, SLAB.y + SLAB.hy + 0.3, SLAB.z];
    main = new ParticleSystem(renderer, {
      space: 'world',
      capacity: 8192,
      stretch: 0.01,
      readsDepth: true,
      softness: 0,
      collide: { bounce: 0.2, friction: 0.6, thickness: 1.5 },
      countAlive: true,
      countBelowY: SLAB.y - SLAB.hy - 0.2,
    });
    const rain = new ParticleEmitter(
      main,
      {
        x: SLAB.x,
        y: SLAB.y + 5,
        z: SLAB.z,
        shape: { kind: 'box', width: SLAB.hx, height: 0.2, depth: SLAB.hz },
        angle: -Math.PI / 2,
        spread: 0.02,
        speed: [4, 5],
        life: [2.5, 3],
        size: [0.06, 0.06],
        colorStart: [0.8, 0.9, 1.2, 1],
        gravity: [0, -9.8, 0],
        drag: 0,
        emissive: 0.3,
      },
      1500,
    );
    emitters.push(rain);
  } else if (mode === 'sub') {
    probeAt = [0, 6, -3];
    main = new ParticleSystem(renderer, {
      space: 'world',
      capacity: 16384,
      stretch: 0.02,
      softness: 0,
      floorY: 0,
      countAlive: true,
    });
    const child: EmitParams = {
      x: 0,
      y: 0,
      colorStart: [2, 1.2, 0.4, 1],
      colorEnd: [1, 0.2, 0.1, 0],
      speed: [1, 3],
      life: [2.5, 3.5],
      size: [0.06, 0.03],
      gravity: [0, -3, 0],
      drag: 0.8,
      emissive: 1.5,
    };
    parent = {
      x: 0,
      y: 1,
      z: -3,
      shape: { kind: 'box', width: 2, height: 0.2, depth: 1 },
      angle: Math.PI / 2,
      spread: 0.15,
      speed: [7, 9],
      life: PARENT_LIFE,
      size: [0.1, 0.1],
      colorStart: [1, 1, 1.5, 1],
      gravity: [0, -2, 0],
      drag: 0,
      emissive: 1,
      onDeath: { params: child, count: 40 },
      inherit: 0.2,
    };
  } else {
    probeAt = [effectPoint[0]!, effectPoint[1]!, effectPoint[2]!];
    // The bundled descriptor, with GPU counting on, so the state can report `effectAlive`.
    const desc: EffectDesc = {
      ...MAGIC_AURA_EFFECT,
      systems: MAGIC_AURA_EFFECT.systems.map((s) => ({
        ...s,
        options: { ...s.options, countAlive: true },
      })),
    };
    effect = createEffect(renderer, desc);
    effect.attach((out) => out.set(effectPoint));
  }
  if (main) systems.push(main);

  let time = 0;
  const loop = new GameLoop({
    update(dt) {
      time += dt;
      state.time = time;
      if (!state.still) {
        lampPos[0] = 3.2 * Math.cos(time * 0.5);
        lampPos[2] = 3.2 * Math.sin(time * 0.5);
        effectPoint[0] = 3 * Math.cos(time * 0.8);
        effectPoint[2] = 3 * Math.sin(time * 0.8) - 1;
      }
      if (mode === 'sheet' && main) {
        if (time - spriteBorn >= 20 || spriteBorn === 0) {
          spriteBorn = time;
          main.emit(
            {
              x: SPRITE[0],
              y: SPRITE[1],
              z: SPRITE[2],
              speed: [0, 0],
              life: [20, 20],
              size: [1.6, 1.6],
              colorStart: [1, 1, 1, 1],
              gravity: [0, 0, 0],
              drag: 0,
              emissive: 0.5,
              tile: [TILE_FROM, TILE_TO],
              tileRate: TILE_RATE,
              spin: [0.6, 0.6],
              alignToVelocity: false,
            },
            1,
          );
        }
        const frames = TILE_TO - TILE_FROM + 1;
        state.tileSeen = TILE_FROM + (Math.floor((time - spriteBorn) * TILE_RATE) % frames);
      }
      if (mode === 'forces') shadowPending += dt;
      if (mode === 'sub' && main && parent) {
        if (time - lastBurst >= BURST_PERIOD) {
          lastBurst = time;
          main.emit(parent, 24);
        }
        const since = time - lastBurst;
        // Every parent is dead 0.4 s after the longest life; the children live past 2.5 s.
        if (since > PARENT_LIFE[1] + 0.4 && since < 2.4) state.aliveAfterParents = main.alive;
      }
      if (state.particles) for (const e of emitters) e.update(dt);
      for (const s of systems) s.update(dt);
      if (effect) effect.update(dt);
    },
    render(_alpha, t) {
      // The shadow steps once per frame with the kernel's own clamp (the system advances by
      // min(accumulated dt, 0.1) in prepare), so it tracks the GPU particles on a slow frame.
      if (mode === 'forces' && main) {
        const sdt = Math.min(shadowPending, 0.1);
        shadowPending = 0;
        shadowTime += sdt;
        let sum = 0;
        for (let i = 0; i < shadowPos.length; i++) {
          const p = shadowPos[i]!;
          const v = shadowVel[i]!;
          applyForces(main.forces, p, v, sdt);
          p[0]! += v[0]! * sdt;
          p[1]! += v[1]! * sdt;
          p[2]! += v[2]! * sdt;
          sum += Math.hypot(p[0]! - ATTRACTOR[0], p[1]! - ATTRACTOR[1], p[2]! - ATTRACTOR[2]);
        }
        state.meanRadius = sum / shadowPos.length;
        if (shadowTime - lastBurst >= 6 && emitShell) {
          lastBurst = shadowTime;
          emitShell();
          for (let i = 0; i < shadowPos.length; i++) {
            const a = (i / 64) * Math.PI * 2;
            const b = ((i % 8) / 8 - 0.5) * Math.PI;
            shadowPos[i]!.set([
              ATTRACTOR[0] + SHELL * Math.cos(a) * Math.cos(b),
              ATTRACTOR[1] + SHELL * Math.sin(b),
              ATTRACTOR[2] + SHELL * Math.sin(a) * Math.cos(b),
            ]);
            shadowVel[i]!.fill(0);
          }
        }
      }
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(SKY[0], SKY[1], SKY[2]);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      for (const [tr, p] of blocks) frame.mesh(block, lit, tr, p);
      if (state.particles) {
        for (const s of systems) frame.drawable(s, 1);
        if (effect) effect.draw(frame, 1);
      }
      renderer.endFrame();
      state.frames++;
      if (main) {
        state.alive = main.alive;
        if (mode === 'collide') state.belowSlab = main.below;
      }
      if (effect) {
        state.effectInstances = effect.instances.length;
        let sum = 0;
        for (const s of effect.systems) sum += Math.max(s.alive, 0);
        state.effectAlive = sum;
        probeAt = [effectPoint[0]!, effectPoint[1]!, effectPoint[2]!];
      }
      state.gpuErrors = gpuDiagnostics.errorCount;
      camera.worldToScreen(probeAt[0], probeAt[1], probeAt[2], probePoint);
      state.probe.x = probePoint.x;
      state.probe.y = probePoint.y;
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
