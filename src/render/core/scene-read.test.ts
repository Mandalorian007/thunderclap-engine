/**
 * ws/scene-read-fit: the core's scene-read group on the fake GPU. A draw set that reads the
 * scene binds the group after its own, declares it in its prelude, makes the core keep a
 * sampleable depth and a colour copy, and records its bundle again when either is re-made.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakeDevice, type PassCommand } from '../fake-gpu';
import { Arena } from './arena';
import { type CoreTarget, createRenderCore, type RenderCore } from './core';
import type { DrawSet, DrawSetDesc } from './draw-set';
import { createVertexLayout } from './layout';
import { coreSceneReadWgsl } from './scene-read';
import { createRenderView, type RenderView, setViewFromCamera } from './view';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const CODE =
  '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(0.0); }\n' +
  '@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }';

interface World {
  fake: FakeDevice;
  device: GPUDevice;
  core: RenderCore;
  vertices: Arena;
  view: RenderView;
  modules: string[];
}

function world(): World {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const modules: string[] = [];
  const make = fake.device.createShaderModule.bind(fake.device);
  (fake.device as unknown as { createShaderModule: unknown }).createShaderModule = (
    d: GPUShaderModuleDescriptor,
  ) => {
    modules.push(d.code);
    return make(d);
  };
  const core = createRenderCore(device);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 16 });
  const camera = Camera.perspective(Math.PI / 3, 1, 0.1, 1000);
  camera.lookAt([0, 10, -20], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), camera);
  return { fake, device, core, vertices, view, modules };
}

function target(w: World, size = 64, copyable = true): CoreTarget {
  const texture = w.device.createTexture({
    size: [size, size],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  return {
    view: texture.createView(),
    texture: copyable ? texture : undefined,
    format: 'rgba8unorm',
    width: size,
    height: size,
  };
}

function frame(w: World, t: CoreTarget): void {
  const enc = w.device.createCommandEncoder();
  w.core.prepare(enc, [w.view]);
  w.core.draw(enc, 0, t);
  w.device.queue.submit([enc.finish()]);
}

function set(w: World, desc: Partial<DrawSetDesc> = {}): DrawSet {
  const s = w.core.createDrawSet({
    label: 'reader',
    shader: { code: CODE },
    vertexLayout: PACKED,
    vertices: w.vertices,
    capacity: 8,
    cull: 'gpu',
    pass: 'transparent',
    ...desc,
  });
  s.add({ vertices: w.vertices.alloc(64, 8), indexCount: 6, bounds: [0, 0, 0, 1] });
  return s;
}

const binds = (cmds: PassCommand[]) =>
  cmds.filter((c) => c.op === 'setBindGroup') as { index: number; group: unknown }[];

describe('the scene-read group (ws/scene-read-fit)', () => {
  it('declares, lays out and binds the group after the set’s own', () => {
    const w = world();
    const own = w.device.createBindGroupLayout({ entries: [] });
    const ownGroup = w.device.createBindGroup({ layout: own, entries: [] });
    const s = set(w, { readsDepth: true, readsColor: true, bindGroups: [{ layout: own, group: ownGroup }] });
    expect(s.sceneGroup).toBe(2);
    expect(w.modules.at(-1)).toContain(coreSceneReadWgsl(2));
    frame(w, target(w));
    expect(w.fake.errors).toEqual([]);
    const b = binds(w.fake.bundles.at(-1)!.commands);
    expect(b.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(b[2]!.group).toBe(w.core.sceneRead.group);
    const g = w.core.sceneRead.group as unknown as { entries: GPUBindGroupEntry[] };
    expect(g.entries[0]!.resource).toBe(w.core.sceneDepthView);
    expect(g.entries[1]!.resource).toBe(w.core.sceneColorView);
    // The core made its depth sampleable and copied the colour before the pass.
    expect(w.core.depth!.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
    expect(w.fake.textureCopies.length).toBe(1);
  });

  it('a set that reads nothing is unchanged', () => {
    const w = world();
    const s = set(w);
    expect(s.sceneGroup).toBe(-1);
    expect(w.modules.at(-1)).not.toContain('core_scene_depth');
    frame(w, target(w));
    expect(binds(w.fake.bundles.at(-1)!.commands).map((c) => c.index)).toEqual([0]);
    expect(w.fake.textureCopies.length).toBe(0);
  });

  it('re-records its bundle when the views are re-made (resize), not otherwise', () => {
    const w = world();
    set(w, { readsDepth: true });
    frame(w, target(w));
    const builds = w.core.stats.bundleBuilds;
    const first = w.core.sceneRead.group;
    frame(w, target(w));
    expect(w.core.stats.bundleBuilds).toBe(builds);
    expect(w.core.sceneRead.group).toBe(first);
    frame(w, target(w, 128));
    expect(w.core.stats.bundleBuilds).toBe(builds + 1);
    expect(w.core.sceneRead.group).not.toBe(first);
    expect(binds(w.fake.bundles.at(-1)!.commands)[1]!.group).toBe(w.core.sceneRead.group);
    expect(w.fake.errors).toEqual([]);
  });

  it('stands in a 1×1 colour without a copyable target', () => {
    const w = world();
    set(w, { readsColor: true });
    frame(w, target(w, 64, false));
    expect(w.core.sceneColorView).toBeNull();
    const g = w.core.sceneRead.group as unknown as { entries: GPUBindGroupEntry[] };
    const tex = w.fake.textures.find((t) => t.label === 'core scene-read no colour');
    expect(tex).toBeDefined();
    expect(g.entries[1]!.resource).toBeDefined();
  });

  it('refuses depth reads in a writing pass, and a shadow', () => {
    const w = world();
    expect(() => set(w, { pass: 'opaque', readsDepth: true })).toThrow(/writes depth/);
    expect(() => set(w, { readsColor: true, castShadow: true })).toThrow(/no shadow/);
    expect(set(w, { pass: 'opaque', readsColor: true }).castShadow).toBe(false);
  });

  it('follows the core onto a restored device', () => {
    const w = world();
    const s = set(w, { readsDepth: true });
    frame(w, target(w));
    const layout = w.core.sceneRead.layout;
    const fake2 = createFakeDevice();
    w.core.restore(fake2.device as unknown as GPUDevice);
    w.device = fake2.device as unknown as GPUDevice;
    w.fake = fake2;
    s.add({ vertices: w.vertices.alloc(64, 8), indexCount: 6, bounds: [0, 0, 0, 1] });
    frame(w, target(w));
    expect(fake2.errors).toEqual([]);
    expect(w.core.sceneRead.layout).not.toBe(layout);
    expect(binds(fake2.bundles.at(-1)!.commands)[1]!.group).toBe(w.core.sceneRead.group);
  });
});
