/**
 * ws/e24-gpu: `RenderCoreOptions.shadowCull`. A GPU-culled caster with `'cpu'` draws the shadow pass
 * from a CPU cull of the light's planes, only the casters inside, directly; `'gpu'` keeps the bundle
 * of an indirect draw per live slot; `'auto'` (the default) is `'cpu'` on WebKit. On the fake GPU.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../camera';
import { createFakeDevice, type FakePass } from '../fake-gpu';
import { Arena } from './arena';
import { createRenderCore, type RenderCoreOptions } from './core';
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
    label: 'casters',
    shader: { code: CODE },
    vertexLayout: PACKED,
    vertices,
    capacity: 16,
    cull: 'gpu',
    castShadow: true,
  });
  // Eight casters along x, 10 apart; the light looks straight down on the first alone.
  const ids: number[] = [];
  for (let i = 0; i < 8; i++) {
    ids.push(set.add({ vertices: box, indexCount: 36, bounds: [i * 10, 0, 0, 1] }));
  }
  const eyeCam = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
  eyeCam.lookAt([35, 40, -40], [35, 0, 0]);
  const eye = setViewFromCamera(createRenderView(), eyeCam);
  const sunCam = Camera.perspective(Math.PI / 8, 1, 0.1, 1000);
  sunCam.lookAt([0, 30, 0.001], [0, 0, 0]);
  const sun = setViewFromCamera(createRenderView(), sunCam);
  const map = fake.device.createTexture({
    size: [64, 64],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const shadowTarget = { view: map.createView(), format: 'depth32float' as const, clear: true };
  const frame = (): FakePass => {
    const enc = fake.device.createCommandEncoder() as unknown as GPUCommandEncoder;
    core.prepare(enc, [{ views: [eye] }, { views: [sun] }]);
    core.drawShadow(enc, 1, shadowTarget);
    fake.device.queue.submit([(enc as unknown as { finish(): never }).finish()]);
    return fake.passes.at(-1)!;
  };
  return { core, set, ids, frame };
}

describe('shadowCull (ws/e24-gpu)', () => {
  it("'cpu' draws only the casters inside the light's planes, directly", () => {
    const w = setup({ shadowCull: 'cpu' });
    const pass = w.frame();
    const draws = pass.commands.filter((c) => c.op === 'drawIndexed');
    expect(draws).toHaveLength(1);
    expect(pass.commands.some((c) => c.op === 'drawIndexedIndirect')).toBe(false);
    expect(pass.commands.some((c) => c.op === 'executeBundles')).toBe(false);
    expect(w.core.stats.shadowDraws).toBe(1);
    expect(w.core.stats.shadowCull).toBe('cpu');
  });

  it('a hidden caster is left out, and the next frame culls afresh', () => {
    const w = setup({ shadowCull: 'cpu' });
    w.set.setHidden(w.ids[0]!, true);
    expect(w.frame().commands.filter((c) => c.op === 'drawIndexed')).toHaveLength(0);
    expect(w.core.stats.shadowDraws).toBe(0);
    w.set.setHidden(w.ids[0]!, false);
    expect(w.frame().commands.filter((c) => c.op === 'drawIndexed')).toHaveLength(1);
  });

  it("'gpu' executes the set's bundle: an indirect draw per live slot", () => {
    const w = setup({ shadowCull: 'gpu' });
    expect(w.core.stats.shadowCull).toBe('gpu');
    const pass = w.frame();
    const exec = pass.commands.filter((c) => c.op === 'executeBundles');
    expect(exec).toHaveLength(1);
    expect(pass.commands.some((c) => c.op === 'drawIndexed')).toBe(false);
    expect(w.core.stats.shadowDraws).toBe(0);
    const bundle = (exec[0] as { bundles: { commands: { op: string }[] }[] }).bundles[0]!;
    expect(bundle.commands.filter((c) => c.op === 'drawIndexedIndirect')).toHaveLength(8);
  });

  describe("'auto' (the default)", () => {
    afterEach(() => vi.unstubAllGlobals());
    const WEBKIT =
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const CHROME =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    it("is 'cpu' on WebKit", () => {
      vi.stubGlobal('navigator', { userAgent: WEBKIT });
      const w = setup();
      expect(w.core.stats.shadowCull).toBe('cpu');
      expect(w.frame().commands.filter((c) => c.op === 'drawIndexed')).toHaveLength(1);
    });

    it("is 'gpu' on Chromium and off the web", () => {
      vi.stubGlobal('navigator', { userAgent: CHROME });
      expect(setup().core.stats.shadowCull).toBe('gpu');
      vi.stubGlobal('navigator', undefined);
      expect(setup().core.stats.shadowCull).toBe('gpu');
    });

    it('an explicit mode overrides it', () => {
      vi.stubGlobal('navigator', { userAgent: WEBKIT });
      expect(setup({ shadowCull: 'gpu' }).core.stats.shadowCull).toBe('gpu');
    });
  });
});
