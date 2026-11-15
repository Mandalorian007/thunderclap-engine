/**
 * E28: `RenderCoreOptions.drawCull`. A GPU-culled set with `'cpu'` draws a view's pass from a CPU
 * cull of the view's planes, only the slots inside, directly; `'gpu'` keeps the bundle of an
 * indirect draw per live slot; `'auto'` (the default) is `'cpu'` on WebKit. With `shadowCull`
 * `'cpu'` too, the GPU cull is not dispatched. On the fake GPU.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakePass } from '../fake-gpu';
import { Arena } from './arena';
import { type CoreTarget, createRenderCore, type RenderCoreOptions } from './core';
import { createVertexLayout } from './layout';
import { createRenderView, setViewFromCamera } from './view';

const PACKED = createVertexLayout({
  stride: 8,
  attributes: [{ name: 'packed', format: 'uint32x2', offset: 0 }],
});
const CODE =
  '@vertex fn vs(in: VertexIn) -> @builtin(position) vec4f { return vec4f(f32(in.packed.x)); }\n' +
  '@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }';

function setup(opts: RenderCoreOptions = {}) {
  const fake = createFakeDevice();
  const device = fake.device as unknown as GPUDevice;
  const core = createRenderCore(device, opts);
  const vertices = new Arena(device, { kind: 'vertex', blockBytes: 1 << 16 });
  const box = vertices.alloc(24 * 8, 8);
  const set = core.createDrawSet({
    label: 'terrain',
    shader: { code: CODE },
    vertexLayout: PACKED,
    vertices,
    capacity: 16,
    cull: 'gpu',
  });
  // Eight slots along x, 100 apart; the camera looks down on the first alone.
  const ids: number[] = [];
  for (let i = 0; i < 8; i++) {
    ids.push(set.add({ vertices: box, indexCount: 36, bounds: [i * 100, 0, 0, 1] }));
  }
  const cam = Camera.perspective(Math.PI / 8, 1, 0.1, 1000);
  cam.lookAt([0, 30, 0.001], [0, 0, 0]);
  const view = setViewFromCamera(createRenderView(), cam);
  const tex = fake.device.createTexture({
    size: [64, 64],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const target: CoreTarget = {
    view: tex.createView(),
    format: 'bgra8unorm',
    width: 64,
    height: 64,
    clear: { r: 0, g: 0, b: 0, a: 1 },
  };
  const frame = (): FakePass => {
    const enc = fake.device.createCommandEncoder() as unknown as GPUCommandEncoder;
    core.prepare(enc, [view]);
    core.draw(enc, 0, target);
    fake.device.queue.submit([(enc as unknown as { finish(): never }).finish()]);
    return fake.passes.at(-1)!;
  };
  return { core, set, ids, frame };
}

describe('drawCull (E28)', () => {
  it("'cpu' draws only the slots inside the view's planes, directly", () => {
    const w = setup({ drawCull: 'cpu', shadowCull: 'cpu' });
    const pass = w.frame();
    expect(pass.commands.filter((c) => c.op === 'drawIndexed')).toHaveLength(1);
    expect(pass.commands.some((c) => c.op === 'drawIndexedIndirect')).toBe(false);
    expect(pass.commands.some((c) => c.op === 'executeBundles')).toBe(false);
    expect(w.core.stats.drawCull).toBe('cpu');
    expect(w.core.stats.directDraws).toBe(1);
  });

  it("with shadowCull 'cpu' too, the GPU cull is not dispatched", () => {
    const w = setup({ drawCull: 'cpu', shadowCull: 'cpu' });
    w.frame();
    expect(w.core.stats.dispatches).toBe(0);
    const g = setup({ drawCull: 'cpu', shadowCull: 'gpu' });
    g.frame();
    expect(g.core.stats.dispatches).toBe(1);
  });

  it('a hidden slot is left out, and the next frame culls afresh', () => {
    const w = setup({ drawCull: 'cpu' });
    w.set.setHidden(w.ids[0]!, true);
    expect(w.frame().commands.filter((c) => c.op === 'drawIndexed')).toHaveLength(0);
    w.set.setHidden(w.ids[0]!, false);
    expect(w.frame().commands.filter((c) => c.op === 'drawIndexed')).toHaveLength(1);
  });

  it("'gpu' executes the set's bundle: an indirect draw per live slot", () => {
    const w = setup({ drawCull: 'gpu' });
    expect(w.core.stats.drawCull).toBe('gpu');
    const pass = w.frame();
    const exec = pass.commands.filter((c) => c.op === 'executeBundles');
    expect(exec).toHaveLength(1);
    expect(pass.commands.some((c) => c.op === 'drawIndexed')).toBe(false);
    const bundle = (exec[0] as { bundles: { commands: { op: string }[] }[] }).bundles[0]!;
    expect(bundle.commands.filter((c) => c.op === 'drawIndexedIndirect')).toHaveLength(8);
  });

  describe("'auto' (the default)", () => {
    afterEach(() => vi.unstubAllGlobals());
    const WEBKIT =
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const CHROME =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    it("is 'cpu' on WebKit, with no cull dispatched", () => {
      vi.stubGlobal('navigator', { userAgent: WEBKIT });
      const w = setup();
      expect(w.core.stats.drawCull).toBe('cpu');
      expect(w.frame().commands.filter((c) => c.op === 'drawIndexed')).toHaveLength(1);
      expect(w.core.stats.dispatches).toBe(0);
    });

    it("is 'gpu' on Chromium and off the web", () => {
      vi.stubGlobal('navigator', { userAgent: CHROME });
      expect(setup().core.stats.drawCull).toBe('gpu');
      vi.stubGlobal('navigator', undefined);
      expect(setup().core.stats.drawCull).toBe('gpu');
    });

    it('an explicit mode overrides it', () => {
      vi.stubGlobal('navigator', { userAgent: WEBKIT });
      expect(setup({ drawCull: 'gpu' }).core.stats.drawCull).toBe('gpu');
    });
  });
});
