/**
 * UI 5 demo page (ws/ui-5): a lit ground with four blocks under the overlay, one mode per query.
 * Noun-free; the scene is what a game would write, the widgets are the engine's.
 *
 * - `?orb`: two orb meters (`ui.meter({ shape: 'orb' })`), one with the default damage trail and
 *   a value readout, one with a quick trail, a percent readout and a colour override; they drain
 *   in steps and refill. They sit at the two ends of a content-sized `bottom` bar (ws/ui-8:
 *   `bars: { bottom: { size: 'content', max: 160 } }`), so no form factor overflows. `value`, `fill` and `trailDom` (measured from the DOM), `trail`.
 * - `?orb-rails`: the same orbs, one in a content-sized `left` rail and one in a content-sized
 *   `right` rail (ws/ui-9: `bars: { left/right: { size: 'content', max: 160 } }`), so a phone's
 *   56 px rails widen to hold them. `orbRegions`, `railWidths`.
 * - `?orb-sized` (ws/ui-10): the `?orb-rails` page with each orb's `size` per form factor
 *   (`ORB_SIZES`): smaller on a phone, so the rails take less of a small view. `orbWidths` (the
 *   orbs' measured widths) and `orbWant` (the map's size in this form factor, in CSS px).
 * - `?floats`: floating text (`ui.floats(camera)`, ws/ui-6) from a ring of points, a crit every seventh, and
 *   a label behind the camera every half second; `active`, `pooled`, `spawned`, `culled`.
 * - `?minimap`: a round, player-up canvas minimap (`ui.minimap`, ws/ui-6) over a painted
 *   background, 20 markers and a player circling; a click picks the world point (`pick`).
 *   One more marker is an `arrow` kind carrying a `heading` that turns on the clock (ws/ui-7).
 *   `redraws`, `player`, `headingMarkers`.
 * - `?minimap-rail` (ws/ui-11): the `?minimap` page with the map in a content-sized `right` rail
 *   (`max` 400). The map holds its `size` and the rail grows to fit it. `mapWidth` (measured) and
 *   `mapWant` (its size in CSS px), `railWidths`.
 *
 * `?still` (or `park(true)`) stops the clock (E-017).
 */
import { GameLoop } from '@thunderclap/engine/core';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap/engine/render';
import {
  createOverlay,
  type FormSizes,
  formSize,
  type LayoutOverflow,
  type Meter,
  type MinimapMarker,
} from '@thunderclap/engine/ui';
import type { HarnessUi5Api, HarnessUi5Mode, HarnessUi5State } from './ui5-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const query = new URLSearchParams(location.search);
const MODES: HarnessUi5Mode[] = ['orb', 'floats', 'minimap'];
const mode = query.has('minimap-rail') ? 'minimap' : (MODES.find((m) => query.has(m)) ?? 'orb');
/** `?orb-rails` (ws/ui-9): the orb mode with the orbs in content-sized side rails. */
/** `?orb-sized` (ws/ui-10): the `?orb-rails` page with a per-form-factor orb `size`. */
const sizedOrbs = mode === 'orb' && query.has('orb-sized');
const rails = mode === 'orb' && (query.has('orb-rails') || sizedOrbs);
/** `?minimap-rail` (ws/ui-11): the minimap mode with the map in a content-sized `right` rail. */
const mapRail = mode === 'minimap' && query.has('minimap-rail');
/** `?orb-sized`: each orb's diameter per form factor, theme px. */
const ORB_SIZES: FormSizes[] = [
  { phone: 96, tablet: 112, default: 128 },
  { phone: 80, 'phone-portrait': 72, default: 104 },
];

const state: HarnessUi5State = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  mode,
  parked: query.has('still'),
  t: 0,
  value: [],
  fill: [],
  trail: [],
  trailDom: [],
  trailGap: [],
  trailFrames: [],
  active: 0,
  pooled: 0,
  spawned: 0,
  culled: 0,
  redraws: 0,
  pick: null,
  player: { x: 0, z: 0, yaw: 0 },
  headingMarkers: [],
  overflows: [],
  orbRegions: [],
  railWidths: { left: 0, right: 0 },
  orbWidths: [],
  orbWant: [],
  mapRegion: '',
  mapWidth: 0,
  mapWant: 0,
};

// ------------------------------------------------------------------ geometry (12 floats/vertex)

/** A unit cube centred on the origin: 24 vertices (a normal per face), 36 indices, white. */
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
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const [n, r, u] of faces) {
    const base = v / 12;
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
      v += 12;
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i);
    i += 6;
  }
  return { vertices, indices };
}

/** A unit quad in the XZ plane (y = 0) facing +y, white. */
function groundGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const vertices = new Float32Array([
    ...[-0.5, 0, 0.5, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    ...[0.5, 0, 0.5, 0, 1, 0, 1, 1, 1, 1, 1, 1],
    ...[0.5, 0, -0.5, 0, 1, 0, 1, 0, 1, 1, 1, 1],
    ...[-0.5, 0, -0.5, 0, 1, 0, 0, 0, 1, 1, 1, 1],
  ]);
  return { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

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
  let lit = albedo * (engine_lambert(n, in.worldPos) + 0.12 * sky);
  o.color = vec4f(engine_fog(lit, in.worldPos), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

// ------------------------------------------------------------------ the scene

const TARGET = [0, 0.9, 0] as const;
const EYE = [0, 4, 10] as const;
const BLOCKS: [number, number, number][] = [
  [3, 0.5, 0],
  [-3, 0.5, 0],
  [0, 0.5, 3],
  [0, 0.5, -3],
];
const FLOAT_EVERY_S = 0.05;
const BEHIND_EVERY_S = 0.5;
const RING = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return [Math.cos(a) * 3, 1.6, Math.sin(a) * 3] as const;
});
const WORLD = { minX: -20, minZ: -20, maxX: 20, maxZ: 20 };
const MAP_SIZE = 200;
const PLAYER_RADIUS = 8;
const PLAYER_RAD_PER_S = 0.4;
/** `?minimap`: how fast the arrow marker's heading turns. */
const HEADING_RAD_PER_S = 1.1;

/** Fraction of an orb's well a layer covers, from its transformed rect. */
function covered(orb: Meter, layer: string): number {
  const well = orb.el.querySelector<HTMLElement>('.tc-orb-well');
  const el = orb.el.querySelector<HTMLElement>(layer);
  if (!well || !el) return -1;
  const top = well.getBoundingClientRect().top + well.clientTop;
  const r = el.getBoundingClientRect();
  if (!(r.height > 0)) return -1;
  return Math.min(1, Math.max(0, 1 - (r.top - top) / r.height));
}

/** The background the game paints once: a grid over the world rectangle and the blocks. */
function paintBackground(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3b4a33';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  g.lineWidth = 1;
  for (let i = 0; i <= 256; i += 32) {
    g.beginPath();
    g.moveTo(i + 0.5, 0);
    g.lineTo(i + 0.5, 256);
    g.moveTo(0, i + 0.5);
    g.lineTo(256, i + 0.5);
    g.stroke();
  }
  g.fillStyle = '#9aa38f';
  const toPx = (w: number) => ((w - WORLD.minX) / (WORLD.maxX - WORLD.minX)) * 256;
  for (const [x, , z] of BLOCKS) g.fillRect(toPx(x) - 3, toPx(z) - 3, 6, 6);
  return c;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine UI 5 demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);

  // `?orb` sizes the bottom bar to its orbs (ws/ui-8): the bar grows from its fixed track to the
  // tallest orb plus pad, up to 160 px, so no form factor reports a `[layout] … overflows`.
  // `?orb-rails` sizes the side rails to them instead (ws/ui-9): a rail widens to its orb plus pad.
  const ui = createOverlay({
    parent: root,
    caption: { reducedMotion: true },
    layout: rails
      ? {
          bars: {
            left: { size: 'content', max: 160 },
            right: { size: 'content', max: 160 },
          },
        }
      : mode === 'orb'
        ? { bars: { bottom: { size: 'content', max: 160 } } }
        : mapRail
          ? { bars: { right: { size: 'content', max: 400 } } }
          : undefined,
  });
  surface.onResize(({ rect, backbuffer }) => {
    renderer.resize(backbuffer.width, backbuffer.height);
    ui.setFrame(rect);
  });

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  camera.lookAt(EYE, TARGET);

  const orbs: Meter[] = [];
  let toWorld: HarnessUi5Api['toWorld'] = () => ({ x: Number.NaN, z: Number.NaN });
  const api: HarnessUi5Api = {
    state,
    mapSize: MAP_SIZE,
    park(on) {
      state.parked = on;
    },
    setOrb(i, v) {
      orbs[i]?.set(v);
    },
    moveOrb(i, region) {
      orbs[i]?.setPlace(region);
    },
    toWorld: (u, v) => toWorld(u, v),
  };
  window.__harnessUi5 = api;

  // ---- the mode's widgets
  let perStep: (dt: number) => void = () => {};
  let perFrame: () => void = () => {};
  if (mode === 'orb') {
    orbs.push(
      ui.meter({
        shape: 'orb',
        label: 'Health',
        max: 100,
        tone: 'danger',
        ...(sizedOrbs ? { size: ORB_SIZES[0] } : {}),
        trail: true,
        reducedMotion: false,
        region: rails ? 'left' : 'bottom',
        order: 0,
      }),
      ui.meter({
        shape: 'orb',
        label: 'Energy',
        max: 100,
        readout: 'percent',
        color: '#3a7bff',
        size: sizedOrbs ? ORB_SIZES[1] : 104,
        trail: { delay: 200, duration: 400 },
        reducedMotion: false,
        region: rails ? 'right' : 'bottom',
        order: 2,
      }),
    );
    orbs.forEach((o, i) => {
      o.el.id = `orb-${i}`;
    });
    // The orbs at the bar's two ends, the world between them (or one per rail, centred).
    if (rails) {
      for (const r of ['left', 'right'] as const) {
        Object.assign(ui.layout.region(r).style, {
          justifyContent: 'center',
          alignItems: 'center',
        });
      }
      // `?orb-sized`: a hidden probe in each orb's rail, `n` theme px wide, turns the map's size
      // into CSS px with the rail's own tokens (theme px follow the form's units).
      const probes = sizedOrbs
        ? orbs.map(() => {
            const p = document.createElement('div');
            Object.assign(p.style, { position: 'absolute', visibility: 'hidden', height: '0' });
            return p;
          })
        : [];
      const note = () => {
        state.orbRegions = orbs.map((o) => o.el.parentElement?.dataset.region ?? '');
        state.railWidths = {
          left: ui.layout.state.regions.left?.width ?? 0,
          right: ui.layout.state.regions.right?.width ?? 0,
        };
        if (!sizedOrbs) return;
        orbs.forEach((o, i) => {
          const probe = probes[i]!;
          const n = formSize(ORB_SIZES[i]!, ui.layout.formFactor);
          probe.style.width = `calc(${n} * var(--tc-space-1) / 4)`;
          o.el.parentElement?.append(probe);
          state.orbWant[i] = probe.getBoundingClientRect().width;
          state.orbWidths[i] = o.el.getBoundingClientRect().width;
        });
      };
      ui.layout.onChange(note);
      note();
    } else ui.layout.region('bottom').style.justifyContent = 'space-between';
    const steps = [
      { every: 1.2, drop: 25 },
      { every: 0.8, drop: 15 },
    ];
    const clocks = [0, 0];
    perStep = (dt) => {
      for (let i = 0; i < orbs.length; i++) {
        clocks[i]! += dt;
        if (clocks[i]! < steps[i]!.every) continue;
        clocks[i] = 0;
        const o = orbs[i]!;
        o.set(o.value <= 0 ? o.max : o.value - steps[i]!.drop);
      }
    };
    perFrame = () => {
      for (let i = 0; i < orbs.length; i++) {
        const o = orbs[i]!;
        state.value[i] = o.value / o.max;
        state.trail[i] = o.trail / o.max;
        state.fill[i] = covered(o, '.tc-orb-fill');
        state.trailDom[i] = covered(o, '.tc-orb-trail');
        // Counted here, each frame: on how many frames the band stood above the value, and how
        // far the drawn band fell under the model on them (ws/ui-11: a move keeps the band).
        if (state.trail[i]! - state.value[i]! > 0.05 && state.trailDom[i]! >= 0) {
          state.trailFrames[i] = (state.trailFrames[i] ?? 0) + 1;
          const gap = state.trail[i]! - state.trailDom[i]!;
          state.trailGap[i] = Math.max(state.trailGap[i] ?? 0, gap);
        }
      }
    };
  } else if (mode === 'floats') {
    const floats = ui.floats(() => camera);
    let clock = 0;
    let behind = 0;
    let n = 0;
    const colors = ['', '#ffd34d', '#7dff8a', '#ff6b5e'];
    perStep = (dt) => {
      clock += dt;
      behind += dt;
      while (clock >= FLOAT_EVERY_S) {
        clock -= FLOAT_EVERY_S;
        const crit = n % 7 === 6;
        floats.spawn(crit ? `${n % 97}!` : String(n % 97), RING[n % RING.length]!, {
          crit,
          color: colors[n % colors.length] || undefined,
        });
        n++;
        state.spawned++;
      }
      if (behind >= BEHIND_EVERY_S) {
        behind = 0;
        floats.spawn('behind', [0, 2, EYE[2] + 4]);
        state.spawned++;
      }
      floats.update(dt);
    };
    perFrame = () => {
      state.active = floats.live;
      state.pooled = floats.pooled;
      let shown = 0;
      for (const el of ui.layers.hud.querySelectorAll<HTMLElement>('.tc-floats')) {
        if (!el.hidden) shown++;
      }
      state.culled = floats.live - shown;
    };
  } else {
    const map = ui.minimap({
      size: MAP_SIZE,
      world: WORLD,
      rotate: 'player',
      shape: 'round',
      zoom: 1.6,
      background: paintBackground(),
      region: 'right',
      kinds: { mover: { shape: 'arrow', color: 'var(--tc-color-warn)', size: 14 } },
      onPick: (x, z) => {
        state.pick = { x, z };
      },
    });
    map.el.id = 'minimap';
    if (mapRail) {
      // A hidden probe in the rail, `MAP_SIZE` theme px wide, turns the map's size into CSS
      // px with the rail's own tokens; the map should be that wide, not shrunk to the rail.
      const probe = document.createElement('div');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', height: '0' });
      probe.style.width = `calc(${MAP_SIZE} * var(--tc-space-1) / 4)`;
      const note = () => {
        map.el.parentElement?.append(probe);
        state.mapRegion = map.el.parentElement?.dataset.region ?? '';
        state.mapWant = probe.getBoundingClientRect().width;
        state.mapWidth = map.el.getBoundingClientRect().width;
        state.railWidths = {
          left: ui.layout.state.regions.left?.width ?? 0,
          right: ui.layout.state.regions.right?.width ?? 0,
        };
      };
      ui.layout.onChange(note);
      note();
    }
    toWorld = (u, v) => {
      const p = map.toWorld(u, v, { x: 0, y: 0 });
      return { x: p.x, z: p.y };
    };
    const kinds = ['ally', 'enemy', 'objective', 'info'];
    const markers: MinimapMarker[] = Array.from({ length: 20 }, (_, i) => {
      const a = i * 2.4;
      const r = 2 + i * 0.9;
      return { id: `m${i}`, x: Math.cos(a) * r, z: Math.sin(a) * r, kind: kinds[i % 4]! };
    });
    // An arrow marker facing a heading that turns on the clock (0.8 rad at t = 0).
    const mover: MinimapMarker = { id: 'mover', x: -4, z: -3, kind: 'mover', heading: 0.8 };
    markers.push(mover);
    const where = { x: 0, y: 0, outside: false, angle: 0 };
    const place = () => {
      const a = state.t * PLAYER_RAD_PER_S;
      const x = Math.cos(a) * PLAYER_RADIUS;
      const z = Math.sin(a) * PLAYER_RADIUS;
      // Heading along the circle (−sin a, cos a), as radians clockwise from north (−z).
      const yaw = Math.atan2(-Math.sin(a), -Math.cos(a));
      state.player = { x, z, yaw };
      map.setPlayer(x, z, yaw);
      mover.heading = 0.8 + state.t * HEADING_RAD_PER_S;
    };
    place();
    perStep = () => place();
    perFrame = () => {
      // The same list every frame: an unchanged list does not redraw.
      map.setMarkers(markers);
      state.redraws = map.redraws;
      map.markerAt(mover.id, where);
      if (!state.headingMarkers.length)
        state.headingMarkers.push({ id: mover.id, heading: 0, angle: 0 });
      const hm = state.headingMarkers[0]!;
      hm.heading = mover.heading!;
      hm.angle = where.angle;
    };
  }

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });
  const ground = renderer.createMesh({
    ...groundGeometry(),
    layout: VERTEX_LAYOUT_3D,
    label: 'ground',
  });
  const groundT = new Transform({ scaleX: 20, scaleY: 1, scaleZ: 20 });
  const groundP: InstanceParams = { tint: [0.42, 0.46, 0.36, 1], params: [1, 0, 0, 0] };
  const blocks = BLOCKS.map(([x, y, z]) => new Transform({ x, y, z }));
  const tints: InstanceParams[] = [
    { tint: [0.3, 0.85, 0.35, 1] },
    { tint: [1.0, 0.1, 0.06, 1] },
    { tint: [0.95, 0.8, 0.2, 1] },
    { tint: [0.08, 0.28, 1.0, 1] },
  ];

  const lights = new Lights();
  lights.ambient.set([0.18, 0.18, 0.2]);
  lights.sun.dir = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.8, 0.8, 0.78];
  lights.fog.color = [0.6, 0.65, 0.75];
  lights.fog.density = 1;
  lights.fog.near = 8;
  lights.fog.far = 30;

  let lastOverflows: readonly LayoutOverflow[] | null = null;
  const loop = new GameLoop({
    update(dt) {
      if (state.parked) return;
      state.t += dt;
      perStep(dt);
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(0.05, 0.07, 0.12);
      frame.lights = lights;
      frame.mesh(ground, lit, groundT, groundP);
      for (let i = 0; i < blocks.length; i++) frame.mesh(cube, lit, blocks[i]!, tints[i]!);
      renderer.endFrame();
      ui.updateAnchors();
      perFrame();
      // `overflows()` is a new list only after a re-layout: copy the ids then, not per frame.
      const over = ui.layout.overflows();
      if (over !== lastOverflows) {
        lastOverflows = over;
        state.overflows = over.map((o) => o.id);
      }
      state.frames++;
      if (gpuDiagnostics.errorCount > 0 && state.gpu === 'ok') state.gpu = 'error: gpu errors';
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
