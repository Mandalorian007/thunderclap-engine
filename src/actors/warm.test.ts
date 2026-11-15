/**
 * ws/forge-asks-fit: an actor system's pipelines are valid and warm at load. Every pipeline it
 * makes, the casters the core warms among them, reaches only the groups its layout holds (the
 * next.14 actor shadow pipeline did not); the pose pass gets its empty first dispatch.
 */
import { describe, expect, it } from 'vitest';
import type { MaterialCodeTable, PartModel } from '../models/spec';
import { createRenderCore, type RenderCoreOptions } from '../render/core/core';
import { pipelineGroupErrors, recordPipelines } from '../render/core/pipeline-groups.test-util';
import { createRenderView } from '../render/core/view';
import { createFakeDevice, type FakeDevice } from '../render/fake-gpu';
import { defineRig } from './rig';
import { type ActorSystemOptions, createActorSystem } from './system';

const MATS: MaterialCodeTable = { body: { color: [0.5, 0.5, 0.6] } };
const BOX: PartModel = {
  name: 'box',
  parts: [
    { name: 'body', shape: { type: 'box', from: [-0.4, 0, -0.3], to: [0.4, 1.6, 0.3] } },
    { name: 'head', shape: { type: 'box', from: [-0.2, 1.6, -0.2], to: [0.2, 2, 0.2] } },
  ],
} as PartModel;
const rig = () =>
  defineRig({
    kind: 'rigid',
    model: BOX,
    materials: MATS,
    bones: { body: { pivot: [0, 0.8, 0] }, head: { parent: 'body', pivot: [0, 1.6, 0] } },
    clips: [],
  });

const BODY =
  '@vertex fn body(in: VertexIn, @builtin(instance_index) inst: u32) -> @builtin(position) vec4f {\n' +
  '  let actor = actor_at(in.draw, inst);\n' +
  '  return view.viewProj * vec4f(actor_point(actor_skin(actor, in.joints, in.weights), in.position), 1.0);\n}\n' +
  '@fragment fn paint() -> @location(0) vec4f { return vec4f(0.0, 0.0, 0.0, 0.5); }';
const QUAD =
  '@vertex fn vs(in: VertexIn, @builtin(instance_index) inst: u32) -> @builtin(position) vec4f {\n' +
  '  let actor = actor_at(actor_draw_of(in.core_vertex), inst);\n' +
  '  return view.viewProj * vec4f(actor_position(actor), 1.0);\n}\n' +
  '@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0); }';

function frame(
  fake: FakeDevice,
  core: ReturnType<typeof createRenderCore>,
  prepare: (e: GPUCommandEncoder) => void,
) {
  const dev = fake.device as unknown as GPUDevice;
  const tex = dev.createTexture({
    size: [64, 64],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const enc = dev.createCommandEncoder();
  prepare(enc);
  core.prepare(enc, [createRenderView()]);
  core.draw(enc, 0, {
    view: tex.createView(),
    format: 'bgra8unorm',
    width: 64,
    height: 64,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  });
  dev.queue.submit([enc.finish()]);
}

function scene(core: RenderCoreOptions = {}, opts: Partial<ActorSystemOptions> = {}) {
  const fake = createFakeDevice();
  const made = recordPipelines(fake);
  const c = createRenderCore(fake.device as unknown as GPUDevice, core);
  const actors = createActorSystem(c, { actorVertices: 6, ...opts, slots: opts.slots ?? 8 });
  actors.addModel(rig());
  return { fake, made, core: c, actors };
}

describe('actor pipelines fit their layouts and warm (ws/forge-asks-fit)', () => {
  it('every built-in set’s caster, warmed before any shadow is drawn, reaches only its groups', () => {
    const s = scene();
    s.actors.addDrawSet({
      label: 'outline',
      shader: { code: BODY, vertexEntry: 'body', fragmentEntry: 'paint' },
    });
    s.actors.addDrawSet({ label: 'contact', shader: { code: QUAD }, shape: 'actor' });
    s.actors.setRecord(0, { model: 0 });
    frame(s.fake, s.core, (e) => s.actors.prepare(e, 1, 0));
    const casters = s.made.filter((p) => p.shadow).map((p) => p.label);
    // The body set and both added sets cast by default; the core warmed each caster.
    expect(casters).toEqual(expect.arrayContaining(['actors', 'outline', 'contact']));
    expect(s.core.stats.warmed).toBeGreaterThan(0);
    expect(pipelineGroupErrors(s.made)).toEqual([]);
    expect(s.fake.errors).toEqual([]);
  });

  it('the check catches a caster whose entry reads a group its layout lacks (the next.14 bug)', () => {
    const s = scene();
    // Without a shadow fragment entry the caster binds the view group alone; this vertex entry
    // reads the actors' groups, as the next.14 actor sets' did.
    s.actors.addDrawSet({
      label: 'broken',
      shader: {
        code: BODY,
        vertexEntry: 'body',
        fragmentEntry: 'paint',
        shadowFragmentEntry: undefined,
      },
    });
    frame(s.fake, s.core, (e) => s.actors.prepare(e, 1, 0));
    const errors = pipelineGroupErrors(s.made);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/^broken: entry 'body' reaches @group\(1/);
  });

  it('gives the pose pass its empty first dispatch at load, bound to its group', () => {
    const s = scene();
    frame(s.fake, s.core, () => {});
    const warm = s.fake.warmPasses.filter((p) => p.kind === 'compute');
    expect(warm.length).toBe(1);
    const ops = warm[0]!.commands.map((c) => c.op);
    expect(ops.slice(0, 3)).toEqual(['setPipeline', 'setBindGroup', 'dispatch']);
    expect(warm[0]!.commands[2]).toMatchObject({ x: 0 });
    // Once: the next frame encodes no warm pass.
    frame(s.fake, s.core, () => {});
    expect(s.fake.warmPasses.filter((p) => p.kind === 'compute').length).toBe(1);
    expect(s.fake.errors).toEqual([]);
  });

  it('warms the pose pipeline made asynchronously when it is ready', async () => {
    const fake = createFakeDevice();
    const dev = fake.device as unknown as GPUDevice & {
      createComputePipelineAsync: (d: GPUComputePipelineDescriptor) => Promise<GPUComputePipeline>;
    };
    dev.createComputePipelineAsync = async (d) => dev.createComputePipeline(d);
    const core = createRenderCore(dev);
    const actors = createActorSystem(core, { slots: 8, asyncPipeline: true });
    await actors.ready;
    frame(fake, core, () => {});
    expect(fake.warmPasses.filter((p) => p.kind === 'compute').length).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('warms nothing with the core’s warming off, or once destroyed', () => {
    const off = scene({ warm: false });
    frame(off.fake, off.core, () => {});
    expect(off.fake.warmPasses.filter((p) => p.kind === 'compute')).toEqual([]);
    const gone = scene();
    gone.actors.destroy();
    frame(gone.fake, gone.core, () => {});
    const dispatches = gone.fake.warmPasses
      .flatMap((p) => p.commands)
      .filter((c) => c.op === 'dispatch');
    expect(dispatches).toEqual([]);
  });
  it('drawSet: false makes no body set: no pipeline of it, and every path copes (E27)', () => {
    const s = scene({}, { drawSet: false });
    expect(s.actors.hasDrawSet).toBe(false);
    expect(() => s.actors.drawSet).toThrow(/drawSet: false/);
    expect(s.core.drawSets.length).toBe(0);
    const outline = s.actors.addDrawSet({
      label: 'outline',
      shader: { code: BODY, vertexEntry: 'body', fragmentEntry: 'paint' },
    });
    s.actors.addModel(rig());
    s.actors.setRecord(0, { model: 0 });
    s.actors.setRecord(1, { model: 1 });
    s.actors.showModel(1, false);
    expect(s.actors.modelShown(1)).toBe(false);
    expect(s.actors.modelShown(0, outline)).toBe(true);
    for (let i = 0; i < 2; i++) frame(s.fake, s.core, (e) => s.actors.prepare(e, 1, 0));
    expect(s.made.filter((p) => p.label === 'actors')).toEqual([]);
    expect(s.made.some((p) => p.label === 'outline')).toBe(true);
    expect(s.actors.setInfo().map((x) => x.label)).toEqual(['outline']);
    s.actors.destroy();
    expect(s.fake.errors).toEqual([]);
  });
});
