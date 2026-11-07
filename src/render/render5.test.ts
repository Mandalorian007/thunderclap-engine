/**
 * ws/render-5: compressed KTX2 upload and caps, per-instance LOD picking, the standard
 * material's dissolve (scene and shadow pass), and the render-4 debts it closes
 * (`occlusionStrength`, `inv_view_proj`, `'multiply'`) re-checked.
 */
import { describe, expect, it } from 'vitest';
import type { Ktx2Texture } from '../assets/ktx2';
import { blendState } from './blend';
import { CAMERA_INV_VIEW_PROJ_OFFSET, Camera } from './camera';
import {
  blockInfo,
  CompressedTextureError,
  compressionFeatures,
  ktx2LevelLayout,
  rendererCaps,
  uploadKtx2,
} from './compressed';
import { createFakeDevice, type FakeDevice, fakeRendererGpu, type PassCommand } from './fake-gpu';
import { lodSizePx, type MeshLod, pickLodLevel } from './lod';
import type { MaterialDesc } from './material';
import { type Mesh, VERTEX_LAYOUT_3D, VERTEX3D_FLOATS } from './mesh';
import { Renderer } from './renderer';
import {
  createStandardMaterial,
  packStandardUniforms,
  STANDARD_DISSOLVE_OFFSET,
  STANDARD_UNIFORM_FLOATS,
  STANDARD_WGSL,
} from './standard';
import { Transform } from './transform';

const BC_FEATURES = ['texture-compression-bc'];

function setup(features: string[] = []) {
  const fake = createFakeDevice({}, features);
  const r = new Renderer(fakeRendererGpu(fake));
  return { fake, r };
}

/** A KTX2 description as `parseKtx2` returns it, with zeroed level bytes. */
function ktx2(vkFormat: number, width: number, height: number, levels: number): Ktx2Texture {
  const block = vkFormat >= 131 && vkFormat <= 156 ? 16 : 4;
  const out: Ktx2Texture['levels'] = [];
  for (let i = 0; i < levels; i++) {
    const w = Math.max(1, width >> i);
    const h = Math.max(1, height >> i);
    const bytes = vkFormat >= 131 ? Math.ceil(w / 4) * Math.ceil(h / 4) * block : w * h * 4;
    out.push({ bytes: new Uint8Array(bytes), width: w, height: h });
  }
  return {
    vkFormat,
    typeSize: 1,
    width,
    height,
    depth: 0,
    layers: 0,
    faces: 1,
    levels: out,
    levelCount: levels,
    dataFormat: null,
    supercompression: 'none',
  };
}

// VkFormat 145 = BC7_UNORM_BLOCK, 146 = BC7_SRGB_BLOCK, 147 = ETC2_R8G8B8_UNORM_BLOCK.
const VK_BC7 = 145;
const VK_ETC2_RGB8 = 147;
const VK_ASTC_6X6 = 157 + 2 * 4;

describe('compressed textures', () => {
  it('caps reflect the device features', () => {
    expect(setup().r.caps.compressed).toEqual({ bc: false, etc2: false, astc: false });
    expect(setup(BC_FEATURES).r.caps.compressed).toEqual({ bc: true, etc2: false, astc: false });
    const all = setup([
      'texture-compression-bc',
      'texture-compression-etc2',
      'texture-compression-astc',
    ]);
    expect(all.r.caps.compressed).toEqual({ bc: true, etc2: true, astc: true });
    // A device without a feature set at all has none.
    expect(rendererCaps({}).compressed.bc).toBe(false);
  });

  it('compressionFeatures asks for what the adapter offers', () => {
    const adapter = { features: new Set(['texture-compression-astc', 'timestamp-query']) };
    expect(compressionFeatures(adapter)).toEqual(['texture-compression-astc']);
    expect(compressionFeatures({})).toEqual([]);
  });

  it('BC7 levels are written with their block-aligned row pitch', () => {
    const { fake, r } = setup(BC_FEATURES);
    const tex = uploadKtx2(r, ktx2(VK_BC7, 64, 32, 7), { label: 'bc7' });
    expect(tex.format).toBe('bc7-rgba-unorm');
    expect(tex.mipLevels).toBe(7);
    const t = fake.textures.find((x) => x.label === 'bc7')!;
    expect(t.mipLevelCount).toBe(7);
    expect(t.usage & GPUTextureUsage.RENDER_ATTACHMENT).toBe(0);
    const writes = fake.textureWrites.filter((w) => w.texture === t);
    expect(writes.map((w) => w.mipLevel)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // 16 bytes per 4×4 block: 64 → 16 blocks = 256 B, 32 → 128, 16 → 64, 8 → 32, then one block.
    expect(writes.map((w) => w.bytesPerRow)).toEqual([256, 128, 64, 32, 16, 16, 16]);
    expect(writes.map((w) => w.rowsPerImage)).toEqual([8, 4, 2, 1, 1, 1, 1]);
    // Sub-block mips copy one whole block.
    expect(writes[5]!.size).toEqual([4, 4, 1]);
    expect(writes[0]!.size).toEqual([64, 32, 1]);
    expect(fake.errors).toEqual([]);
  });

  it('srgb picks the colour-space twin of the file format', () => {
    const { r } = setup(BC_FEATURES);
    expect(uploadKtx2(r, ktx2(VK_BC7, 8, 8, 1), { srgb: true }).format).toBe('bc7-rgba-unorm-srgb');
    expect(uploadKtx2(r, ktx2(VK_BC7 + 1, 8, 8, 1), { srgb: false }).format).toBe('bc7-rgba-unorm');
    // BC4 has no sRGB form: unchanged.
    expect(uploadKtx2(r, ktx2(139, 8, 8, 1), { srgb: true }).format).toBe('bc4-r-unorm');
  });

  it('an unsupported format throws a typed error naming the format and the caps', () => {
    const { r } = setup(BC_FEATURES);
    let err: unknown;
    try {
      uploadKtx2(r, ktx2(VK_ETC2_RGB8, 8, 8, 1));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompressedTextureError);
    const e = err as CompressedTextureError;
    expect(e.format).toBe('etc2-rgb8unorm');
    expect(e.family).toBe('etc2');
    expect(e.caps.compressed.bc).toBe(true);
    expect(e.message).toContain('etc2-rgb8unorm');
    expect(e.message).toContain('texture-compression-etc2');
    expect(e.message).toContain('caps: bc');
    // No caps at all.
    expect(() => uploadKtx2(setup().r, ktx2(VK_BC7, 8, 8, 1))).toThrow(/caps: none/);
  });

  it('a Basis or supercompressed payload throws: no transcoder', () => {
    const { r } = setup(BC_FEATURES);
    const basis = { ...ktx2(VK_BC7, 8, 8, 1), vkFormat: 0, levels: [] };
    expect(() => uploadKtx2(r, basis)).toThrow(CompressedTextureError);
    const zstd = { ...ktx2(VK_BC7, 8, 8, 1), supercompression: 'zstd' as const, levels: [] };
    expect(() => uploadKtx2(r, zstd)).toThrow(/zstd payload needs a transcoder/);
  });

  it('rejects partial blocks at level 0 and short levels', () => {
    const { r } = setup(BC_FEATURES);
    expect(() => uploadKtx2(r, ktx2(VK_BC7, 6, 8, 1))).toThrow(/whole 4×4 blocks/);
    const short = ktx2(VK_BC7, 8, 8, 1);
    short.levels[0]!.bytes = new Uint8Array(16);
    expect(() => uploadKtx2(r, short)).toThrow(/level 0 holds 16 bytes, needs 64/);
  });

  it('uncompressed KTX2 formats upload without a feature', () => {
    const { fake, r } = setup();
    const tex = uploadKtx2(r, ktx2(37, 4, 2, 2), { label: 'plain' });
    expect(tex.format).toBe('rgba8unorm');
    const writes = fake.textureWrites.filter((w) => w.texture.label === 'plain');
    expect(writes.map((w) => w.bytesPerRow)).toEqual([16, 8]);
  });

  it('block info and level layout', () => {
    expect(blockInfo('bc1-rgba-unorm')).toEqual({ width: 4, height: 4, bytes: 8, family: 'bc' });
    expect(blockInfo('eac-rg11unorm')!.bytes).toBe(16);
    expect(blockInfo('etc2-rgb8a1unorm')!.bytes).toBe(8);
    expect(blockInfo('astc-10x8-unorm')).toEqual({
      width: 10,
      height: 8,
      bytes: 16,
      family: 'astc',
    });
    const astc = blockInfo('astc-6x6-unorm')!;
    // 36 px → 6 blocks; mip 1 = 18 px → 3 blocks; mip 3 = 4 px → 1 block of 6×6.
    expect(ktx2LevelLayout(36, 36, 1, astc).bytesPerRow).toBe(48);
    expect(ktx2LevelLayout(36, 36, 3, astc)).toMatchObject({
      width: 6,
      height: 6,
      rowsPerImage: 1,
    });
    const { r } = setup(['texture-compression-astc']);
    const file = ktx2(VK_ASTC_6X6, 36, 36, 1);
    file.levels[0]!.bytes = new Uint8Array(36 * 16);
    expect(uploadKtx2(r, file).format).toBe('astc-6x6-unorm');
  });
});

// ------------------------------------------------------------------ LOD

const WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> u: vec4f;
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = u; o.emissive = u; return o; }`;
const OPAQUE: MaterialDesc = { label: 'o', wgsl: WGSL, uniformBytes: 16, blend: 'opaque' };

function lodMesh(r: Renderer, label: string): Mesh {
  return r.createMesh({
    vertices: new Float32Array(VERTEX3D_FLOATS * 3),
    indices: new Uint16Array([0, 1, 2]),
    layout: VERTEX_LAYOUT_3D,
    bounds: { center: [0, 0, 0], radius: 1 },
    label,
  });
}

function lodSetup() {
  const { fake, r } = setup();
  r.resize(1000, 1000);
  const cam = Camera.perspective(Math.PI / 2, 1, 0.1, 1000);
  cam.lookAt([0, 0, 0], [0, 0, -1]);
  cam.cull = false;
  r.camera = cam;
  const meshes = [lodMesh(r, 'lod0'), lodMesh(r, 'lod1'), lodMesh(r, 'lod2')];
  // fovY 90°, viewport 1000 px: a unit sphere at distance d covers 1000 / d px.
  const lod: MeshLod = { meshes, thresholdsPx: [200, 50] };
  const a = r.createMaterial(OPAQUE);
  const b = r.createMaterial({ ...OPAQUE, label: 'b' });
  return { fake, r, cam, lod, a, b };
}

function scenePass(fake: FakeDevice) {
  return [...fake.passes].reverse().find((x) => x.label === 'scene')!;
}

/** The scene pass draws as `[mesh label, instances]`, read from the bound vertex buffer. */
function drawn(fake: FakeDevice): [string, number][] {
  const out: [string, number][] = [];
  let vb = '';
  for (const c of scenePass(fake).commands as PassCommand[]) {
    if (c.op === 'other' && c.name === 'setVertexBuffer' && c.slot === 0) {
      vb = ((c.buffer as { label?: string }).label ?? '').replace(/-vb$/, '');
    }
    if (c.op === 'drawIndexed') out.push([vb, c.instances]);
  }
  return out;
}

describe('LOD pick', () => {
  it('lodSizePx matches geom projectedSizePx for perspective, ignores distance for ortho', () => {
    const p = Camera.perspective(Math.PI / 3, 1, 0.1, 100).projection;
    const want = (1 * 600) / (10 * Math.tan(Math.PI / 6));
    expect(lodSizePx(1, 10, p, 600)).toBeCloseTo(want, 3);
    const o = Camera.ortho2d(100, 100).projection;
    expect(lodSizePx(5, 10, o, 100)).toBeCloseTo(lodSizePx(5, 1000, o, 100), 9);
  });

  it('pickLodLevel follows selectLod and holds inside the hysteresis band', () => {
    const thr = [200, 50];
    expect(pickLodLevel(500, thr, 3, -1, 0.1)).toBe(0);
    expect(pickLodLevel(100, thr, 3, -1, 0.1)).toBe(1);
    expect(pickLodLevel(10, thr, 3, -1, 0.1)).toBe(2);
    // At level 0, 190 px is inside the 10 % band below 200: stays; 179 drops.
    expect(pickLodLevel(190, thr, 3, 0, 0.1)).toBe(0);
    expect(pickLodLevel(179, thr, 3, 0, 0.1)).toBe(1);
    // At level 1, 210 px is above 200 but inside the band: stays; 221 goes finer.
    expect(pickLodLevel(210, thr, 3, 1, 0.1)).toBe(1);
    expect(pickLodLevel(221, thr, 3, 1, 0.1)).toBe(0);
    // From the last level straight to the finest when the size clears both bands.
    expect(pickLodLevel(1000, thr, 3, 2, 0.1)).toBe(0);
    // No hysteresis: plain selectLod.
    expect(pickLodLevel(190, thr, 3, 0, 0)).toBe(1);
  });

  it('picks a level per instance at three distances, one draw per non-empty level', () => {
    const { fake, r, lod, a } = lodSetup();
    // Interleaved distances: near (500 px), mid (100 px), far (10 px), three times over.
    const ts: Transform[] = [];
    for (let i = 0; i < 9; i++) ts.push(new Transform({ z: -[2, 10, 100][i % 3]! }));
    const f = r.beginFrame(0, 0);
    for (const t of ts) f.mesh(lod, a, t);
    r.endFrame();
    expect(r.stats.lodCounts).toEqual([3, 3, 3]);
    expect(r.stats.drawCalls).toBe(3);
    expect(drawn(fake)).toEqual([
      ['lod0', 3],
      ['lod1', 3],
      ['lod2', 3],
    ]);
    expect(fake.errors).toEqual([]);
  });

  it('an empty level draws nothing; lodBias scales the size', () => {
    const { fake, r, cam, lod, a } = lodSetup();
    const ts = [new Transform({ z: -2 }), new Transform({ z: -3 })];
    const frame = () => {
      const f = r.beginFrame(0, 0);
      for (const t of ts) f.mesh(lod, a, t);
      r.endFrame();
    };
    frame();
    expect(r.stats.lodCounts).toEqual([2]);
    expect(drawn(fake)).toEqual([['lod0', 2]]);
    // Bias 0.1: 500 → 50 px (level 1), 333 → 33 px (below the band under 50: level 2).
    cam.lodBias = 0.1;
    frame();
    expect(r.stats.lodCounts).toEqual([0, 1, 1]);
    expect(r.stats.drawCalls).toBe(2);
  });

  it('holds the level on a boundary across frames (hysteresis), per transform', () => {
    const { r, lod, a } = lodSetup();
    const t = new Transform({ z: -4 }); // 250 px: level 0
    const frame = () => {
      const f = r.beginFrame(0, 0);
      f.mesh(lod, a, t);
      r.endFrame();
      return r.stats.lodCounts.indexOf(1);
    };
    expect(frame()).toBe(0);
    t.setPosition(0, 0, -5.2); // 192 px: below 200 but inside the band
    expect(frame()).toBe(0);
    t.setPosition(0, 0, -5.7); // 175 px: out of the band
    expect(frame()).toBe(1);
    t.setPosition(0, 0, -4.9); // 204 px: back above 200, inside the band above
    expect(frame()).toBe(1);
    t.setPosition(0, 0, -4.4); // 227 px
    expect(frame()).toBe(0);
    r.lodHysteresis = 0;
    t.setPosition(0, 0, -5.1); // 196 px: no band, drops
    expect(frame()).toBe(1);
  });

  it('groups by mesh then material', () => {
    const { fake, r, lod, a, b } = lodSetup();
    const f = r.beginFrame(0, 0);
    f.mesh(lod, a, new Transform({ z: -100 }));
    f.mesh(lod, b, new Transform({ z: -2 }));
    f.mesh(lod, a, new Transform({ z: -2.5 }));
    f.mesh(lod, b, new Transform({ z: -120 }));
    r.endFrame();
    expect(r.stats.lodCounts).toEqual([2, 0, 2]);
    // Each level's two material runs are contiguous: four draws, each mesh bound in one run.
    const order = drawn(fake).map((d) => d[0]);
    expect([...order].sort()).toEqual(['lod0', 'lod0', 'lod2', 'lod2']);
    expect(order[0]).toBe(order[1]);
    expect(order[2]).toBe(order[3]);
    expect(r.stats.drawCalls).toBe(4);
  });

  it('plain frames report no lodCounts; LOD frames do not allocate in steady state', () => {
    const { fake, r, lod, a } = lodSetup();
    const plain = lodMesh(r, 'plain');
    let f = r.beginFrame(0, 0);
    f.mesh(plain, a, new Transform({ z: -2 }));
    r.endFrame();
    expect(r.stats.lodCounts).toEqual([]);
    const ts = Array.from({ length: 50 }, (_, i) => new Transform({ x: i, z: -2 - i * 3 }));
    const frame = () => {
      f = r.beginFrame(0, 0);
      for (const t of ts) f.mesh(lod, a, t);
      r.endFrame();
    };
    frame();
    const counts = () => [fake.buffers.length, fake.textures.length, fake.bindGroups.length];
    const before = counts();
    for (let i = 0; i < 3; i++) frame();
    expect(counts()).toEqual(before);
    f = r.beginFrame(0, 0);
    expect(() => f.mesh({ meshes: [], thresholdsPx: [] }, a, new Transform())).toThrow();
    r.endFrame();
  });
});

// ------------------------------------------------------------------ dissolve

describe('standard dissolve', () => {
  it('packs the dissolve block at STANDARD_DISSOLVE_OFFSET and sets flag 8', () => {
    expect(STANDARD_UNIFORM_FLOATS).toBe(68);
    const off = STANDARD_DISSOLVE_OFFSET;
    const u = packStandardUniforms({
      dissolve: { amount: 0.4, edgeColor: [0, 1, 0], edgeWidth: 0.1, noise: 3 },
    });
    expect(u[11]! & 8).toBe(8);
    expect([...u.subarray(off, off + 8)].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([
      0.4, 0.1, 3, 0, 0, 1, 0, 0,
    ]);
    const plain = packStandardUniforms({});
    expect(plain[11]! & 8).toBe(0);
    expect(plain[off]).toBe(0);
    // occlusionStrength (a render-4 debt, already on main) still packs at 18.
    expect(packStandardUniforms({ occlusionStrength: 0.25 })[18]).toBe(0.25);
  });

  it('the WGSL discards above the threshold in the scene and the shadow entry', () => {
    expect(STANDARD_WGSL).toContain('fn standard_dissolved(');
    expect(STANDARD_WGSL).toMatch(/@fragment fn fs_shadow\(in: VSOut\)/);
    expect(STANDARD_WGSL).toMatch(/if \(masked \|\| standard_dissolved\(in\)\) \{\s*discard;/);
  });

  function shadowSetup(dissolve: boolean) {
    const { fake, r } = setup();
    r.camera = Camera.perspective(Math.PI / 2, 1, 0.1, 100);
    r.camera.lookAt([0, 0, 5], [0, 0, 0]);
    const mesh = lodMesh(r, 'cube');
    const m = createStandardMaterial(r, dissolve ? { dissolve: { amount: 0.5 } } : {});
    const f = r.beginFrame(0, 0);
    f.lights.sun.direction = [-0.4, -1, -0.3];
    f.lights.sun.color = [1, 1, 1];
    f.lights.sun.shadow = { extent: 20 };
    f.mesh(mesh, m, new Transform());
    r.endFrame();
    const sp = fake.passes.filter((p) => p.label === 'shadow')[0]!;
    const pipes = sp.commands
      .filter((c): c is Extract<PassCommand, { op: 'setPipeline' }> => c.op === 'setPipeline')
      .map((c) => (c.pipeline as { desc: GPURenderPipelineDescriptor }).desc);
    const groups = sp.commands.flatMap((c) => (c.op === 'setBindGroup' ? [c.index] : []));
    return { fake, pipes, groups };
  }

  it('dissolving shadow casters discard the same pixels: the material shadow entry', () => {
    const { fake, pipes, groups } = shadowSetup(true);
    expect(pipes).toHaveLength(1);
    expect(pipes[0]!.fragment?.entryPoint).toBe('fs_shadow');
    expect([...(pipes[0]!.fragment?.targets ?? [])]).toEqual([]);
    expect(pipes[0]!.depthStencil?.depthWriteEnabled).toBe(true);
    // Group 1 (the material's uniforms) is bound so fs_shadow reads the same amount.
    expect(groups).toContain(1);
    expect(fake.errors).toEqual([]);
  });

  it('a plain standard material keeps the depth-only shadow pipeline', () => {
    const { pipes, groups } = shadowSetup(false);
    expect(pipes).toHaveLength(1);
    expect(pipes[0]!.fragment).toBeUndefined();
    expect(groups).not.toContain(1);
  });
});

// ------------------------------------------------------------------ render-4 debts

describe('render-4 debts already on main', () => {
  it("inv_view_proj in the camera block and the 'multiply' blend", () => {
    expect(CAMERA_INV_VIEW_PROJ_OFFSET).toBe(60);
    expect(blendState('multiply')?.color.srcFactor).toBe('dst');
  });
});
