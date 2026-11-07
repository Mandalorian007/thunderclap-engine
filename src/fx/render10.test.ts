/**
 * ws/render-10: every pipeline drawing into the scene pass takes its colour targets from
 * `renderer.sceneTargets`, so with aux attachments on (velocity, rough-metal) its target count
 * matches the pass's attachment count, in every view and every target. Fake GPU only; the
 * pixels and `gpuErrors` are checked by `harness/render10.html`.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, type FakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { Renderer } from '../render/renderer';
import type { SceneTargetAux } from '../render/scene-target';
import { SceneTarget } from '../render/scene-target';
import { defaultTextures } from '../render/texture';
import type { PanelCanvas, PanelContext2D } from '../ui/world-panel/paint';
import { createWorldPanel } from '../ui/world-panel/panel';
import { createBillboards } from './billboard';
import { createDebugDraw } from './debug-draw';
import { Decals } from './decals';
import { ParticleSystem } from './particles';
import { Sky } from './sky';
import type { AtlasCanvas, AtlasContext2D } from './text-atlas';
import { Water } from './water';

function atlasCanvas(size: number): AtlasCanvas {
  const ctx: AtlasContext2D = {
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    measureText: (t) => ({ width: t.length * 10 }),
    fillText: () => {},
    strokeText: () => {},
    clearRect: () => {},
  };
  return { width: size, height: size, getContext: () => ctx };
}

function panelCanvas(width: number, height: number): PanelCanvas {
  const noop = () => {};
  const ctx = {
    font: '',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    rect: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    clearRect: noop,
    fillRect: noop,
    fillText: noop,
    measureText: (t: string) => ({ width: t.length * 8 }),
  } satisfies PanelContext2D;
  return { width, height, getContext: () => ctx };
}

interface Bound {
  pass: string;
  attachments: number;
  pipeline: string;
  targets: GPUColorTargetState[];
}

/**
 * A renderer with `aux` on and every engine drawable that builds its own scene-pass pipeline
 * in the scene, drawn for two frames into `renderer.target` and, in the second, also into a
 * plain target (no aux) through the same camera. Returns every pipeline bound in a scene
 * pass and the target lists `sceneTargets` handed out.
 */
function drawAll(aux: SceneTargetAux, depth: boolean) {
  const fake: FakeDevice = createFakeDevice({}, []);
  const r = new Renderer(fakeRendererGpu(fake), { aux });
  r.resize(64, 32);
  const handed = new Set<GPUColorTargetState[]>();
  const real = r.sceneTargets.bind(r);
  r.sceneTargets = (blend?: GPUBlendState, a?: number) => {
    const t = real(blend, a);
    handed.add(t);
    return t;
  };
  const cam = Camera.perspective(Math.PI / 2, 2, 0.1, 100);
  cam.lookAt([0, 2, 6], [0, 0, 0]);
  cam.depthTest = depth;
  cam.cull = false;
  r.camera = cam;

  const sky = new Sky(r);
  const ps2d = new ParticleSystem(r, { capacity: 64 });
  ps2d.emit({ x: 0, y: 0, colorStart: [1, 1, 1, 1] }, 4);
  const psWorld = new ParticleSystem(r, { capacity: 64, space: 'world' });
  psWorld.emit({ x: 0, y: 0, colorStart: [1, 1, 1, 1] }, 4);
  const decals = new Decals(r, { texture: defaultTextures(r.device).white, mode: 'quad' });
  decals.add({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, size: 1 });
  const water = new Water(r);
  const bb = createBillboards(r, { capacity: 4, atlas: { size: 64, canvas: atlasCanvas(64) } });
  bb.add({ position: [0, 1, 0], size: [1, 1] });
  bb.add({ position: [1, 1, 0], size: [1, 1], depth: 'always' });
  const dd = createDebugDraw(r, { retain: true });
  dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
  const panel = createWorldPanel(r, {
    width: 1,
    height: 1,
    resolution: 32,
    canvas: panelCanvas(32, 32),
  });
  const drawables = [sky, ps2d, psWorld, decals, water, bb, dd];

  // The world panel sits on layer 2, which the plain view skips. It keys its pipeline on the aux
  // key too (ws/core-8); `src/ui/world-panel/panel-aux.test.ts` draws it into a plain target.
  const plain = new SceneTarget(r.device, { width: 32, height: 16, label: 'plain' });
  const plainCam = Camera.perspective(Math.PI / 2, 2, 0.1, 100);
  plainCam.lookAt([0, 2, 6], [0, 0, 0]);
  plainCam.depthTest = depth;
  plainCam.cull = false;
  plainCam.layers = 1;
  for (let i = 0; i < 2; i++) {
    bb.update(1 / 60, cam);
    const f = r.beginFrame(i / 60, 1 / 60);
    for (const d of drawables) f.drawable(d);
    f.drawable(panel.drawable, 0, 2);
    if (i === 1) {
      r.render(f, cam);
      r.render(f, plainCam, plain);
    }
    r.endFrame();
  }

  const bound: Bound[] = [];
  for (const p of fake.passes) {
    if (p.kind !== 'render' || (p.label !== 'scene' && p.label !== 'scene-blend')) continue;
    const attachments = (p.desc as GPURenderPassDescriptor).colorAttachments as unknown[];
    for (const c of p.commands) {
      if (c.op !== 'setPipeline') continue;
      const pl = c.pipeline as { label?: string; desc: GPURenderPipelineDescriptor };
      bound.push({
        pass: p.label,
        attachments: attachments.length,
        pipeline: pl.label ?? '',
        targets: pl.desc.fragment!.targets as GPUColorTargetState[],
      });
    }
  }
  return { r, fake, bound, handed };
}

describe('ws/render-10: scene-pass pipelines follow the target aux set', () => {
  const cases: [string, SceneTargetAux][] = [
    ['velocity', { velocity: true }],
    ['rough-metal + velocity', { roughMetal: true, velocity: true }],
    ['none', {}],
  ];
  for (const [name, aux] of cases) {
    for (const depth of [true, false]) {
      it(`${name}, depth ${depth}: every bound pipeline's target count equals the pass's`, () => {
        const { r, bound, handed } = drawAll(aux, depth);
        expect(bound.length).toBeGreaterThan(0);
        for (const b of bound) {
          expect({ pipeline: b.pipeline, n: b.targets.length }).toEqual({
            pipeline: b.pipeline,
            n: b.attachments,
          });
        }
        // The plain target's views drew too: a 2-attachment pass when aux is on.
        const counts = new Set(bound.map((b) => b.attachments));
        const auxCount = (aux.roughMetal ? 1 : 0) + (aux.velocity ? 1 : 0);
        expect(counts).toEqual(new Set(auxCount ? [2, 2 + auxCount] : [2]));
        // Every helper list is one of the shapes a pass can have, aux masked off.
        expect(handed.size).toBeGreaterThan(0);
        for (const t of handed) {
          expect(t.slice(0, 2).map((x) => x.format)).toEqual(r.sceneFormats);
          for (const x of t.slice(2)) expect(x.writeMask).toBe(0);
        }
      });
    }
  }

  it('enumerates the drawables through the helper: each one built a pipeline from it', () => {
    const { bound, handed } = drawAll({ velocity: true }, true);
    // The pipelines whose colour target list is one `sceneTargets` handed out (by identity).
    const viaHelper = bound.filter((b) => handed.has(b.targets));
    const labels = new Set(viaHelper.map((b) => b.pipeline.split(':')[0]));
    for (const l of [
      'sky',
      'particles-render',
      'particles-world',
      'decals',
      'water',
      'billboards',
      'debug-draw',
      'world-panel',
    ]) {
      expect([...labels], l).toContain(l);
    }
    // Every pipeline bound in a scene pass is the helper's, a material's or (ws/render-11) a
    // motion build: a helper list with only the velocity entry written.
    for (const b of bound) {
      if (handed.has(b.targets) || b.pipeline.startsWith('material:')) continue;
      expect(b.pipeline.endsWith(':motion'), b.pipeline).toBe(true);
      const like = [...handed].find(
        (t) =>
          t.length === b.targets.length &&
          t.every((x, i) => i === b.targets.length - 1 || x === b.targets[i]),
      );
      expect(like, b.pipeline).toBeDefined();
      expect(b.targets.at(-1)!.writeMask).toBeUndefined();
    }
  });

  it('returns one cached list per (blend, aux) and keys aux by the target', () => {
    const fake = createFakeDevice({}, []);
    const r = new Renderer(fakeRendererGpu(fake), { aux: { velocity: true } });
    const a = r.sceneTargets();
    expect(a).toBe(r.sceneTargets());
    expect(a.map((t) => t.format)).toEqual(['rgba16float', 'rgba16float', 'rg16float']);
    expect(a[2]!.writeMask).toBe(0);
    expect(r.sceneTargets(undefined, 0)).toHaveLength(2);
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    const b = r.sceneTargets(blend, 3);
    expect(b.map((t) => t.format)).toEqual(['rgba16float', 'rgba16float', 'rg8unorm', 'rg16float']);
    expect(b[0]!.blend).toBe(blend);
    expect(b[2]!.blend).toBeUndefined();
    expect(r.sceneTargets(blend, 3)).toBe(b);
  });
});
