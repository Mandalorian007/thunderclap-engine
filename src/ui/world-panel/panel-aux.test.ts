/**
 * ws/core-8: a WorldPanel keys its pipelines on `frame.auxKey`, so it draws into a target with
 * aux attachments (velocity) and into a plain target in the same frame, each with a pipeline
 * whose colour target count matches the pass. Fake GPU only.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../../render/camera';
import { createFakeDevice, fakeRendererGpu } from '../../render/fake-gpu';
import { Renderer } from '../../render/renderer';
import { SceneTarget, type SceneTargetAux } from '../../render/scene-target';
import type { PanelCanvas, PanelContext2D } from './paint';
import { createWorldPanel } from './panel';

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
  attachments: number;
  label: string;
  targets: number;
}

function drawTwice(aux: SceneTargetAux, depth: boolean) {
  const fake = createFakeDevice({}, []);
  const r = new Renderer(fakeRendererGpu(fake), { aux });
  r.resize(64, 32);
  const cam = Camera.perspective(Math.PI / 2, 2, 0.1, 100);
  cam.lookAt([0, 0, 3], [0, 0, 0]);
  cam.depthTest = depth;
  cam.cull = false;
  r.camera = cam;
  const panel = createWorldPanel(r, {
    width: 1,
    height: 1,
    resolution: 32,
    canvas: panelCanvas(32, 32),
  });
  const plain = new SceneTarget(r.device, { width: 32, height: 16, label: 'plain' });
  for (let i = 0; i < 2; i++) {
    const f = r.beginFrame(i / 60, 1 / 60);
    f.drawable(panel.drawable, 0);
    r.render(f, cam);
    r.render(f, cam, plain);
    r.endFrame();
  }
  const bound: Bound[] = [];
  const objects: unknown[] = [];
  for (const p of fake.passes) {
    if (p.kind !== 'render' || (p.label !== 'scene' && p.label !== 'scene-blend')) continue;
    const attachments = ((p.desc as GPURenderPassDescriptor).colorAttachments as unknown[]).length;
    for (const c of p.commands) {
      if (c.op !== 'setPipeline') continue;
      const pl = c.pipeline as { label?: string; desc: GPURenderPipelineDescriptor };
      if (!(pl.label ?? '').startsWith('world-panel')) continue;
      objects.push(pl);
      bound.push({ attachments, label: pl.label ?? '', targets: pl.desc.fragment!.targets.length });
    }
  }
  return { fake, bound, objects };
}

describe('WorldPanel on frame.auxKey (ws/core-8)', () => {
  for (const depth of [true, false]) {
    it(`velocity target and plain target in one frame, depth ${depth}: counts match`, () => {
      const { fake, bound } = drawTwice({ velocity: true }, depth);
      expect(fake.errors).toEqual([]);
      // Both passes drew the panel, in both frames.
      expect(new Set(bound.map((b) => b.attachments))).toEqual(new Set([2, 3]));
      expect(bound.length).toBe(4);
      for (const b of bound)
        expect({ label: b.label, n: b.targets }).toEqual({
          label: b.label,
          n: b.attachments,
        });
      // The aux variant has its own label; the plain one keeps the label it had before.
      const labels = new Set(bound.map((b) => b.label));
      expect(labels.size).toBe(2);
      expect([...labels].filter((l) => l.endsWith(':aux2'))).toHaveLength(1);
      expect([...labels].filter((l) => !l.includes(':aux'))).toHaveLength(1);
    });
  }

  it('builds each variant once: the second frame binds the same pipelines', () => {
    const { objects } = drawTwice({ velocity: true }, true);
    expect(objects).toHaveLength(4);
    expect(objects[2]).toBe(objects[0]);
    expect(objects[3]).toBe(objects[1]);
    expect(objects[1]).not.toBe(objects[0]);
  });

  it('without aux both passes bind one 2-target pipeline', () => {
    const { fake, bound } = drawTwice({}, true);
    expect(fake.errors).toEqual([]);
    expect(bound.length).toBe(4);
    for (const b of bound) expect(b.targets).toBe(2);
    expect(new Set(bound.map((b) => b.label)).size).toBe(1);
  });
});
