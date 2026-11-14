/**
 * ws/actors on the fake GPU: rigs compile from part models and skins, the CPU pose matches the
 * anim module's, and a frame of 100 or 1,000 actors costs the same GPU calls and, held,
 * allocates nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  type AnimationClip,
  createClipCursor,
  createPose,
  poseToWorld,
  type Skeleton,
  sampleClip,
  skinMatrices,
} from '../anim';
import type { MaterialCodeTable, PartModel } from '../models/spec';
import { Camera } from '../render/camera';
import { createRenderCore, type RenderCore } from '../render/core/core';
import { createRenderView, type RenderView, setViewFromCamera } from '../render/core/view';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import { SKIN_JOINTS_BYTE_OFFSET, VERTEX_SKINNED_STRIDE } from '../render/mesh';
import { countAllocs, createWorkMeter, type WorkMeter } from '../testing/budget';
import { actorMatrix } from './pose-cpu';
import { ACTOR_HEADER_WORDS, ACTOR_NONE, ACTOR_RECORD, recordShape } from './record';
import { ACTOR_VERTEX_BYTES, type ActorRig, defineRig } from './rig';
import { type ActorSystem, createActorSystem } from './system';

const MATS: MaterialCodeTable = {
  body: { color: [0.5, 0.5, 0.6] },
  trim: { color: [0.9, 0.7, 0.2] },
};

/** A walker of parts: a body, a head on it and two legs that swing from the hips. */
const WALKER: PartModel = {
  name: 'walker',
  parts: [
    { name: 'legL', shape: { type: 'box', from: [-0.3, 0, -0.1], to: [-0.1, 0.8, 0.1] } },
    { name: 'body', shape: { type: 'box', from: [-0.4, 0.8, -0.3], to: [0.4, 1.6, 0.3] } },
    {
      name: 'head',
      material: 'trim',
      shape: { type: 'box', from: [-0.2, 1.6, -0.2], to: [0.2, 2, 0.2] },
    },
    {
      name: 'legR',
      color: 'instance',
      shape: { type: 'box', from: [0.1, 0, -0.1], to: [0.3, 0.8, 0.1] },
    },
  ],
} as PartModel;

const quatZ = (a: number) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];

/** A swing of two parts (by part index) about z over one second, looped. */
function swing(a: number, b: number): AnimationClip {
  const times = new Float32Array([0, 0.5, 1]);
  return {
    name: 'walk',
    duration: 1,
    channels: [a, b].map((node, i) => ({
      node,
      path: 'rotation' as const,
      interpolation: 'LINEAR' as const,
      times,
      values: new Float32Array([...quatZ(0), ...quatZ(i ? -0.6 : 0.6), ...quatZ(0)]),
    })),
  };
}

function walkerRig(): ActorRig {
  return defineRig({
    kind: 'rigid',
    model: WALKER,
    materials: MATS,
    bones: {
      legL: { parent: 'body', pivot: [-0.2, 0.8, 0] },
      legR: { parent: 'body', pivot: [0.2, 0.8, 0] },
      head: { parent: 'body', pivot: [0, 1.6, 0] },
      body: { pivot: [0, 0.8, 0] },
    },
    clips: [{ clip: swing(0, 3) }],
  });
}

/** A skinned tube: a chain of three nodes up +y, rings blended between them. */
function tube(): {
  skeleton: Skeleton;
  vertices: ArrayBuffer;
  indices: Uint32Array;
  clip: AnimationClip;
} {
  const rest = new Float32Array(30);
  for (let i = 0; i < 3; i++) {
    rest.set([0, i === 0 ? 0 : 0.5, 0, 0, 0, 0, 1, 1, 1, 1], i * 10);
  }
  const skeleton: Skeleton = { parents: new Int16Array([-1, 0, 1]), rest };
  const rings = 7;
  const sides = 6;
  const vb = new ArrayBuffer(rings * sides * VERTEX_SKINNED_STRIDE);
  const f = new Float32Array(vb);
  const u8 = new Uint8Array(vb);
  for (let r = 0; r < rings; r++) {
    const y = r * 0.25;
    const t = Math.min(y / 0.5, 2);
    const j0 = Math.min(Math.floor(t), 1);
    const w1 = Math.round((t - j0) * 255);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const i = r * sides + s;
      const o = (i * VERTEX_SKINNED_STRIDE) / 4;
      f.set(
        [
          Math.cos(a) * 0.15,
          y,
          Math.sin(a) * 0.15,
          Math.cos(a),
          0,
          Math.sin(a),
          0,
          0,
          0.8,
          0.3,
          0.3,
          1,
        ],
        o,
      );
      const b = i * VERTEX_SKINNED_STRIDE + SKIN_JOINTS_BYTE_OFFSET;
      u8.set([j0, j0 + 1, 0, 0, 255 - w1, w1, 0, 0], b);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r + 1 < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s;
      const b = r * sides + ((s + 1) % sides);
      idx.push(a, a + sides, b, b, a + sides, b + sides);
    }
  }
  const times = new Float32Array([0, 0.4, 0.8]);
  const clip: AnimationClip = {
    name: 'sway',
    duration: 0.8,
    channels: [1, 2].map((node) => ({
      node,
      path: 'rotation' as const,
      interpolation: 'LINEAR' as const,
      times,
      values: new Float32Array([...quatZ(0), ...quatZ(0.5), ...quatZ(0)]),
    })),
  };
  return { skeleton, vertices: vb, indices: Uint32Array.from(idx), clip };
}

function tubeRig(): ActorRig {
  const t = tube();
  return defineRig({
    kind: 'linear',
    skeleton: t.skeleton,
    meshes: [{ vertices: t.vertices, indices: t.indices, tint: true }],
    clips: [{ clip: t.clip }],
  });
}

interface Scene {
  fake: FakeDevice;
  device: GPUDevice;
  meter: WorkMeter;
  core: RenderCore;
  actors: ActorSystem;
  view: RenderView;
  views: RenderView[];
}

function scene(n: number, slots = 1024): Scene {
  const fake = createFakeDevice();
  const meter = createWorkMeter(fake.device as unknown as GPUDevice);
  const device = meter.device;
  const core = createRenderCore(device);
  const actors = createActorSystem(core, { slots, lods: [40, 120] });
  const walker = actors.addModel(walkerRig());
  const skinned = actors.addModel(tubeRig());
  for (let i = 0; i < n; i++) {
    actors.setRecord(i, {
      model: i % 2 ? skinned : walker,
      position: [(i % 32) * 2, 0, Math.floor(i / 32) * 2],
      velocity: [0, 0, 0.5],
      yaw: i * 0.1,
      clip: 0,
      clipStart: -i * 0.05,
      tint: 0xff3080ff,
    });
  }
  const camera = Camera.perspective(Math.PI / 3, 16 / 9, 0.1, 500);
  camera.lookAt([32, 30, -20], [32, 0, 32]);
  const view = setViewFromCamera(createRenderView(), camera);
  return { fake, device, meter, core, actors, view, views: [view] };
}

const target = (fake: FakeDevice) => {
  const tex = fake.device.createTexture({
    size: [640, 360],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return {
    view: tex.createView(),
    format: 'bgra8unorm' as GPUTextureFormat,
    width: 640,
    height: 360,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  };
};

function frame(s: Scene, time: number, t = target(s.fake)): number {
  const before = s.fake.calls;
  const enc = s.device.createCommandEncoder();
  s.actors.prepare(enc, 1, time);
  s.core.prepare(enc, s.views);
  s.core.draw(enc, 0, t);
  s.device.queue.submit([enc.finish()]);
  return s.fake.calls - before;
}

const close = (a: ArrayLike<number>, b: ArrayLike<number>, n: number, eps = 1e-4) => {
  for (let i = 0; i < n; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(eps);
};

describe('records (ws/actors)', () => {
  it('lays game fields after the header, stride rounded to four words', () => {
    const s = recordShape({ hp: 'f32', team: 'u32', lean: 'i32' });
    expect(s.fields.get('hp')).toEqual({ word: ACTOR_HEADER_WORDS, type: 'f32' });
    expect(s.fields.get('lean')!.word).toBe(ACTOR_HEADER_WORDS + 2);
    expect(s.stride).toBe(24);
    expect(recordShape().stride).toBe(20);
    expect(() => recordShape({ 'two words': 'f32' })).toThrow(/not a name/);
    expect(() => recordShape({ x: 'f64' as 'f32' })).toThrow(/type/);
  });
});

describe('rigs (ws/actors)', () => {
  it('turns a part model into bones, parent first, one joint per vertex', () => {
    const rig = walkerRig();
    expect(rig.kind).toBe('rigid');
    expect(rig.names).toEqual(['body', 'legL', 'head', 'legR']);
    expect([...rig.parents]).toEqual([-1, 0, 0, 0]);
    expect(rig.nodes).toBe(4);
    expect(rig.joints).toBe(4);
    // Rest translation is the pivot relative to the parent's.
    expect([...rig.rest.subarray(10, 13)]).toEqual([-0.2, 0, 0].map(Math.fround));
    const mesh = rig.meshes[0]!;
    expect(mesh.vertices.byteLength).toBe(mesh.vertexCount * ACTOR_VERTEX_BYTES);
    expect(mesh.indices.length).toBe(4 * 36);
    const seen = new Set<number>();
    for (let i = 0; i < mesh.vertexCount; i++) {
      const b = i * ACTOR_VERTEX_BYTES;
      seen.add(mesh.vertices[b + 20]!);
      expect(mesh.vertices[b + 24]).toBe(255);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    // The instance-coloured leg is tinted; the rest are not.
    const tinted = new Set<number>();
    for (let i = 0; i < mesh.vertexCount; i++) {
      if (mesh.vertices[i * ACTOR_VERTEX_BYTES + 19] === 255) {
        tinted.add(mesh.vertices[i * ACTOR_VERTEX_BYTES + 20]!);
      }
    }
    expect([...tinted]).toEqual([rig.bone('legR')]);
    // The clip's part indices (0 and 3) land on the leg bones.
    expect(rig.clip('walk')).toBe(0);
    const c = rig.clips[0]!;
    expect(c.frameCount).toBe(30);
    const mid = 15 * rig.nodes * 10;
    expect(c.frames[mid + rig.bone('legL') * 10 + 5]).toBeCloseTo(Math.sin(0.3), 5);
    expect(c.frames[mid + rig.bone('body') * 10 + 5]).toBe(0);
  });

  it('turns a skin into a linear rig and refuses bad input', () => {
    const rig = tubeRig();
    expect(rig.kind).toBe('linear');
    expect(rig.joints).toBe(3);
    expect(rig.meshes[0]!.vertexCount).toBe(42);
    expect(() =>
      defineRig({
        kind: 'rigid',
        model: WALKER,
        materials: MATS,
        bones: { arm: { parent: 'body' } },
      }),
    ).toThrow(/no part 'arm'/);
    expect(() =>
      defineRig({
        kind: 'rigid',
        model: WALKER,
        materials: MATS,
        bones: { body: { parent: 'head' }, head: { parent: 'body' } },
      }),
    ).toThrow(/cycle/);
    expect(() =>
      defineRig({
        kind: 'linear',
        skeleton: tube().skeleton,
        meshes: [{ vertices: new ArrayBuffer(50) }],
      }),
    ).toThrow(/56-byte/);
  });
});

describe('poseCpu (ws/actors)', () => {
  it('matches the anim module at the baked frames, placement included', () => {
    const s = scene(0, 4);
    const t = tube();
    const rig = s.actors.rig(1);
    s.actors.setRecord(0, {
      model: 1,
      position: [3, 1, -2],
      since: 0,
      velocity: [1, 0, 0.5],
      yaw: 0.7,
      scale: 1.5,
      clip: 0,
      clipStart: 0.1,
    });
    const pose = createPose(t.skeleton);
    const cursor = createClipCursor(t.clip);
    const world = new Float32Array(rig.nodes * 12);
    const skin = new Float32Array(rig.joints * 12);
    const placed = new Float32Array(rig.joints * 12);
    const actor = new Float32Array(12);
    const got = new Float32Array(rig.joints * 12);
    const rec = new Float32Array(ACTOR_HEADER_WORDS);
    for (const k of [0, 3, 7, 12, 23, 30]) {
      const time = 0.1 + k / rig.clips[0]!.fps;
      pose.set(t.skeleton.rest);
      sampleClip(t.clip, (time - 0.1) % 0.8, pose, 1, 'override', cursor);
      poseToWorld(t.skeleton, pose, world);
      skinMatrices({ ...t.skeleton, inverseBind: rig.inverseBind }, world, skin);
      rec.set([3, 1, -2, 0.7, 1, 0, 0.5, 0, 1.5]);
      actorMatrix(rec, 0, time, actor);
      for (let j = 0; j < rig.joints; j++) {
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 4; c++) {
            let v = 0;
            for (let m = 0; m < 3; m++) v += actor[r * 4 + m]! * skin[j * 12 + m * 4 + c]!;
            placed[j * 12 + r * 4 + c] = v + (c === 3 ? actor[r * 4 + 3]! : 0);
          }
        }
      }
      expect(s.actors.poseCpu(0, got, 'skin', time)).toBe(true);
      close(got, placed, rig.joints * 12);
    }
    // Between frames the pose interpolates; world space places nodes, not joints.
    const nodes = new Float32Array(rig.nodes * 12);
    s.actors.poseCpu(0, nodes, 'world', 0.1);
    expect(nodes[3]).toBeCloseTo(3.1, 5);
    expect(nodes[11]).toBeCloseTo(-1.95, 5);
    expect(s.actors.poseCpu(1, nodes)).toBe(false);
    expect(() => s.actors.poseCpu(0, new Float32Array(4))).toThrow(/needs/);
  });

  it('blends a second clip and holds a non-looping clip at its end', () => {
    const s = scene(0, 4);
    const out = new Float32Array(48);
    const rest = new Float32Array(48);
    s.actors.setRecord(0, { model: 0, position: [0, 0, 0], since: 0 });
    s.actors.poseCpu(0, rest, 'world', 0);
    // Half of the walk over the rest pose: the leg turns half as far.
    s.actors.setRecord(0, { clip: -1, clip2: 0, clip2Start: 0, blend: 0.5 });
    s.actors.poseCpu(0, out, 'world', 0.5);
    const leg = s.actors.rig(0).bone('legL') * 12;
    const half = Math.atan2(out[leg + 4]!, out[leg]!);
    expect(half).toBeCloseTo(0.3, 2);
    expect(s.actors.readF32(0, ACTOR_RECORD.blend)).toBe(0.5);
    s.actors.setRecord(0, { blend: 0 });
    s.actors.poseCpu(0, out, 'world', 0.5);
    close(out, rest, 48);
  });
});

describe('ActorSystem (ws/actors)', () => {
  it('costs the same GPU calls at 100 and 1,000 actors', () => {
    const small = scene(100);
    const big = scene(1000);
    // First frames record the bundle.
    frame(small, 0);
    frame(big, 0);
    const a = frame(small, 1 / 60);
    const b = frame(big, 1 / 60);
    expect(a).toBe(b);
    expect(small.actors.stats.calls).toBe(big.actors.stats.calls);
    expect(big.actors.stats.dispatched).toBe(1000);
    expect(small.fake.errors).toEqual([]);
    expect(big.fake.errors).toEqual([]);
    // One pose pass, one indirect draw per model mesh in one bundle.
    const pass = big.fake.passes.filter((p) => p.kind === 'compute').at(-1)!;
    expect(pass.commands.filter((c) => c.op === 'dispatch')).toHaveLength(1);
    const bundle = big.fake.bundles.at(-1)!;
    const draws = bundle.commands.filter((c) => c.op === 'drawIndexedIndirect');
    expect(draws).toHaveLength(2);
    // Records upload once; a held frame writes only the clock.
    expect(big.actors.stats.recordBytes).toBe(0);
    expect(a).toBeLessThan(40);
  });

  it('holds a frame without allocating, and uploads only the dirty range', () => {
    const s = scene(1000);
    frame(s, 0);
    frame(s, 0.016);
    const t = target(s.fake);
    const report = s.meter.run((i) => frame(s, 0.032 + i * 0.016, t), { frames: 20, warmup: 2 });
    expect(report.allocs.byType).toEqual({});
    expect(report.commandsPerFrame.every((c) => c === report.commandsPerFrame[0])).toBe(true);
    s.actors.setRecord(10, { velocity: [1, 0, 0] });
    s.actors.setRecord(12, { yaw: 1 });
    const move = countAllocs(() => s.actors.setRecord(11, { position: [1, 2, 3] }));
    expect(move.typedArrays).toBe(0);
    frame(s, 0.3, t);
    expect(s.actors.stats.recordBytes).toBe(3 * s.actors.stride * 4);
  });

  it('writes the indirect template: index ranges per mesh, no instances', () => {
    const s = scene(0, 4);
    const copy = s.fake.writes.filter((w) => w.buffer.label?.includes('args template')).at(-1)!;
    expect(copy).toBeDefined();
    const tpl = s.fake.buffers.find((b) => b.label === 'actors args template')!;
    s.fake.device.queue.submit([]);
    const words = new Uint32Array(tpl.data.buffer);
    const rig0 = s.actors.rig(0);
    expect(words[0]).toBe(rig0.meshes[0]!.indices.length);
    expect(words[1]).toBe(0);
    // Model 1 starts at draw 1 (the walker has one mesh).
    expect(words[5]).toBe(s.actors.rig(1).meshes[0]!.indices.length);
    expect(words[7]).toBe(rig0.meshes[0]!.indices.length);
    expect(words[8]).toBe(rig0.meshes[0]!.vertexCount);
  });

  it('refuses what does not fit', () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    expect(() => createActorSystem(core, { slots: 0 })).toThrow(/slots/);
    expect(() => createActorSystem(core, { slots: 4, bonesPerSlot: 65 })).toThrow(/bonesPerSlot/);
    expect(() => createActorSystem(core, { slots: 4, lods: [10, 5] })).toThrow(/rise/);
    const a = createActorSystem(core, { slots: 4, bonesPerSlot: 2, maxModels: 1 });
    expect(() => a.addModel(walkerRig())).toThrow(/4 bones/);
    const b = createActorSystem(core, { slots: 4, maxModels: 1, label: 'b' });
    b.addModel(walkerRig());
    expect(() => b.addModel(walkerRig())).toThrow(/full/);
    expect(() => b.setRecord(4, { model: 0 })).toThrow(/no slot/);
    expect(() => b.setRecord(0, { model: 3 })).toThrow(/no model/);
    expect(() => b.setRecord(0, { fields: { hp: 1 } })).toThrow(/no record field/);
    b.setRecord(0, { model: 0 });
    expect(b.has(0)).toBe(true);
    b.remove(0);
    expect(b.has(0)).toBe(false);
    b.destroy();
    expect(() => b.addModel(walkerRig())).toThrow(/destroyed/);
  });

  it('hides a slot with model -1 and samples the light hook', () => {
    const fake = createFakeDevice();
    const core = createRenderCore(fake.device as unknown as GPUDevice);
    const a = createActorSystem(core, {
      slots: 4,
      recordLayout: { hp: 'f32' },
      sampleLight: (x) => (x > 0 ? 0xff808080 : 0xffffffff),
    });
    a.addModel(walkerRig());
    a.setRecord(1, { model: 0, position: [2, 0, 0], fields: { hp: 7 } });
    expect(a.readF32(1, ACTOR_HEADER_WORDS)).toBe(7);
    expect(a.readU32(1, ACTOR_RECORD.light)).toBe(0xff808080);
    a.setRecord(1, { model: -1 });
    expect(a.has(1)).toBe(false);
    expect(a.readU32(1, ACTOR_RECORD.model)).toBe(ACTOR_NONE);
  });
});
