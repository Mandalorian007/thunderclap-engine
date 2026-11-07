/**
 * Billboards demo page: six lit capsules in a row, each with a name plate (text from the shared
 * atlas over a dark backing, sized in screen px) and a health bar (one two-colour quad, world
 * units, hidden behind geometry), plus damage numbers that rise and fade out. Nothing here is
 * engine code: a game would write the same page. e2e/billboards.spec.ts samples a plate and bar
 * pixel over capsule 0, steps time by hand to see a damage number drift upward, and watches it
 * remove itself after `DAMAGE_LIFE`.
 */
import { GameLoop } from '@thunderclap/engine/core';
import { type BillboardHandle, createBillboards } from '@thunderclap/engine/fx';
import { capsule, plane } from '@thunderclap/engine/geom';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
} from '@thunderclap/engine/render';
import {
  DAMAGE_LIFE,
  DAMAGE_RISE,
  type HarnessBillboardsApi,
  type HarnessBillboardsState,
} from './billboards-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessBillboardsState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  count: 0,
  atlasUsed: 0,
  draws: 0,
  damageAlive: 0,
  paused: false,
  visible: true,
  probes: { plate: { x: 0, y: 0 }, bar: { x: 0, y: 0 }, damage: { x: 0, y: 0 } },
  gpuErrors: 0,
};

/** Vertex colour × the engine lighting block plus a faint sky term from above. */
const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.1 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

const CLEAR = [0.05, 0.07, 0.12] as const;
const AMBIENT = [0.2, 0.2, 0.22] as const;
const SUN_DIR = [-0.4, -1.0, -0.5] as const;
const SUN_COLOR = [0.9, 0.88, 0.82] as const;
const EYE = [0, 4.5, 13] as const;
const TARGET = [0, 1.2, 0] as const;

const COUNT = 6;
const SPACING = 2.4;
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_Y = CAPSULE_HEIGHT / 2;
const PLATE_OFFSET = [0, CAPSULE_Y + 0.85, 0] as const;
const BAR_OFFSET = [0, CAPSULE_Y + 0.45, 0] as const;
const BAR_SIZE = [1.6, 0.18] as const;
const DAMAGE_OFFSET = [0, CAPSULE_Y + 0.25, 0] as const;
const DAMAGE_EVERY = 0.9;
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const HUES: [number, number, number, number][] = [
  [0.9, 0.35, 0.3, 1],
  [0.95, 0.65, 0.25, 1],
  [0.85, 0.85, 0.3, 1],
  [0.35, 0.8, 0.4, 1],
  [0.3, 0.6, 0.95, 1],
  [0.75, 0.45, 0.95, 1],
];

const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

function capsuleX(i: number): number {
  return (i - (COUNT - 1) / 2) * SPACING;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine billboards demo' });
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
  const ground = renderer.createMesh(plane({ size: 30, color: [0.4, 0.45, 0.36, 1] }));
  const groundT = new Transform();
  const bodies = HUES.map((color) =>
    renderer.createMesh(capsule({ radius: 0.4, height: CAPSULE_HEIGHT, color })),
  );
  const transforms = bodies.map((_, i) => new Transform({ x: capsuleX(i), y: CAPSULE_Y }));

  const lights = new Lights();
  lights.ambient.set(AMBIENT);
  lights.sun.direction = SUN_DIR;
  lights.sun.color = SUN_COLOR;

  const billboards = createBillboards(renderer, { capacity: 64 });
  const plateStyle = { size: 36, font: 'bold sans-serif', stroke: '#000', strokeWidth: 5 };
  const bars: BillboardHandle[] = [];
  const health: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    const position = [capsuleX(i), CAPSULE_Y, 0] as const;
    // A dark backing behind the text, both the same px size at any distance.
    billboards.add({
      position,
      offset: PLATE_OFFSET,
      size: { px: [190, 46] },
      color: [0, 0, 0, 0.7],
    });
    billboards.add({
      position,
      offset: PLATE_OFFSET,
      size: { px: [180, 40] },
      region: billboards.text(NAMES[i]!, plateStyle),
    });
    bars.push(
      billboards.add({
        position,
        offset: BAR_OFFSET,
        ...billboards.bar(1, BAR_SIZE, [0.25, 0.9, 0.3, 1], [0.25, 0.05, 0.05, 0.9]),
      }),
    );
    health.push(1);
  }

  const damage: BillboardHandle[] = [];
  let lastDamage: { x: number; y: number; z: number; age: number } | null = null;
  const damageStyle = {
    size: 40,
    font: 'bold sans-serif',
    color: '#ffd166',
    stroke: '#300',
    strokeWidth: 5,
  };

  function spawnDamage(target = 0): number {
    const amount = 5 + Math.floor(Math.random() * 30);
    const x = capsuleX(target);
    const h = billboards.add({
      position: [x, CAPSULE_Y, 0],
      offset: DAMAGE_OFFSET,
      size: { px: [110, 48] },
      region: billboards.text(`-${amount}`, damageStyle),
      life: DAMAGE_LIFE,
      velocity: [0, DAMAGE_RISE, 0],
      depth: 'always',
    });
    damage.push(h);
    if (target === 0) lastDamage = { x, y: CAPSULE_Y + DAMAGE_OFFSET[1], z: 0, age: 0 };
    health[target] = Math.max(0.05, health[target]! - amount / 100);
    bars[target]!.fraction = health[target]!;
    bars[target]!.color = health[target]! > 0.4 ? [0.25, 0.9, 0.3, 1] : [0.95, 0.6, 0.2, 1];
    return damage.filter((d) => d.alive).length;
  }

  /** Age everything by `dt`: the batch, the damage bookkeeping, the probe of the last number. */
  function step(dt: number): void {
    billboards.update(dt, camera);
    if (lastDamage) {
      lastDamage.age += dt;
      lastDamage.y += DAMAGE_RISE * dt;
      if (lastDamage.age >= DAMAGE_LIFE) lastDamage = null;
    }
    for (let i = damage.length - 1; i >= 0; i--) if (!damage[i]!.alive) damage.splice(i, 1);
  }

  const api: HarnessBillboardsApi = {
    state,
    setPaused(on) {
      state.paused = on;
    },
    advance(dt) {
      step(dt);
    },
    spawnDamage() {
      return spawnDamage(0);
    },
    setVisible(visible) {
      state.visible = visible;
    },
  };
  window.__harnessBillboards = api;

  let sinceDamage = 0;
  let nextTarget = 0;
  const loop = new GameLoop({
    update(dt) {
      if (state.paused) return;
      sinceDamage += dt;
      if (sinceDamage >= DAMAGE_EVERY) {
        sinceDamage = 0;
        spawnDamage(nextTarget);
        nextTarget = (nextTarget + 1) % COUNT;
        // Heal the one that went lowest so the bars keep moving both ways.
        let low = 0;
        for (let i = 1; i < COUNT; i++) if (health[i]! < health[low]!) low = i;
        if (health[low]! < 0.3) {
          health[low] = 1;
          bars[low]!.fraction = 1;
          bars[low]!.color = [0.25, 0.9, 0.3, 1];
        }
      }
      step(dt);
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT);
      for (let i = 0; i < COUNT; i++) frame.mesh(bodies[i]!, lit, transforms[i]!);
      if (state.visible) frame.drawable(billboards, 10);
      renderer.endFrame();
      state.frames++;
      state.count = billboards.count;
      state.atlasUsed = billboards.atlasUsed;
      state.draws = state.visible ? billboards.draws : 0;
      state.damageAlive = damage.length;
      state.gpuErrors = gpuDiagnostics.errorCount;
      const x0 = capsuleX(0);
      probe(camera, x0, CAPSULE_Y + PLATE_OFFSET[1], 0, state.probes.plate);
      probe(camera, x0, CAPSULE_Y + BAR_OFFSET[1], 0, state.probes.bar);
      if (lastDamage) probe(camera, lastDamage.x, lastDamage.y, lastDamage.z, state.probes.damage);
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
