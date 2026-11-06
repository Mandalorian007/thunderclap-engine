import { describe, expect, it } from 'vitest';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { VERTEX_LAYOUT_3D, VERTEX_LAYOUT_3D_TANGENT, VERTEX_LAYOUT_SKINNED } from '../render/mesh';
import { Renderer } from '../render/renderer';
import { SkinPalette } from '../render/skin';
import { STANDARD_TEXTURE_SLOTS, STANDARD_UNIFORM_FLOATS } from '../render/standard';
import { type GltfJson, parseGltf } from './gltf';
import {
  type GltfImageSource,
  gltfSamplerKind,
  interleave3d,
  interleave3dTangent,
  loadGltf,
} from './gltf-load';
import { interleaveSkinned, skeletonFromSkin } from './gltf-skin';

/** A 4×4 "decoded image" for the fake GPU (`copyExternalImageToTexture` is a no-op there). */
const decodeImage = async (): Promise<GltfImageSource> =>
  ({ width: 4, height: 4, close() {} }) as unknown as ImageBitmap;

/**
 * Two nodes: a textured triangle (material 0 → texture 0 → image 0, embedded) and an untextured
 * quad (two primitives would be overkill; one with a colour factor) under a parent node.
 */
function sampleDoc(imageUri?: string) {
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const idx = new Uint16Array([0, 1, 2, 0]); // padded to 4 bytes
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0]);
  const parts = [tri, nrm, uv, idx, png].map(
    (p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength),
  );
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const bin = new Uint8Array(total);
  const views: GltfJson['bufferViews'] = [];
  let off = 0;
  for (const p of parts) {
    bin.set(p, off);
    views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength });
    off += p.byteLength;
  }
  const json: GltfJson = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: total }],
    bufferViews: views,
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
          },
        ],
      },
      { primitives: [{ attributes: { POSITION: 0 }, material: 1 }] },
    ],
    images: [imageUri ? { uri: imageUri } : { bufferView: 4, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      {
        pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1] },
        alphaMode: 'MASK',
        alphaCutoff: 0.25,
      },
    ],
    nodes: [
      { name: 'root', translation: [0, 1, 0], children: [1, 2] },
      { name: 'tri', mesh: 0, translation: [2, 0, 0] },
      { name: 'quad', mesh: 1, scale: [3, 3, 3] },
    ],
    scenes: [{ nodes: [0] }],
  };
  return parseGltf({ json, buffers: [bin.buffer] });
}

describe('loadGltf on the fake GPU', () => {
  it('creates one mesh per primitive, one texture per image, one material per glTF material', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const doc = sampleDoc();
    const scene = await loadGltf(r, doc, { decodeImage, label: 'test' });
    expect(scene.meshes).toHaveLength(2);
    expect(scene.textures).toHaveLength(1);
    expect(scene.materials).toHaveLength(2);
    expect(scene.transforms).toHaveLength(3);
    expect(scene.nodes).toHaveLength(2);
    expect(scene.meshes[0]!.layout).toBe(VERTEX_LAYOUT_3D);
    expect(scene.meshes[0]!.vertexCount).toBe(3);
    expect(scene.meshes[0]!.indexCount).toBe(3);
    expect(scene.meshes[1]!.vertexCount).toBe(3);
    expect(scene.meshes[1]!.indexCount).toBe(3);
    // The texture is sRGB with a mip chain, labelled by image.
    const tex = scene.textures[0]!;
    expect(tex.format).toBe('rgba8unorm-srgb');
    expect(tex.mipLevels).toBe(3);
    expect(fake.textures.some((t) => t.label === 'test:image0')).toBe(true);
    // The parent chain is on the transforms; the leaf's world matrix includes the root's offset.
    const tri = scene.transforms[1]!;
    expect(tri.parent).toBe(scene.transforms[0]);
    expect([...tri.world]).toEqual([1, 0, 0, 2, 0, 1, 0, 1, 0, 0, 1, 0]);
    // Draw entries: node index, material; the factors live in the standard material, so the
    // instance is white with zero params.
    expect(scene.nodes.map((n) => n.node)).toEqual([1, 2]);
    expect(scene.nodes[0]!.material).toBe(scene.materials[0]);
    expect(scene.nodes[1]!.material).toBe(scene.materials[1]);
    expect([...(scene.nodes[1]!.params.tint as Float32Array)]).toEqual([1, 1, 1, 1]);
    expect([...(scene.nodes[1]!.params.params as Float32Array)]).toEqual([0, 0, 0, 0]);
    expect(scene.materialNames).toEqual([null, null]);
    // Standard materials: the base colour map on material 0, the factor and mask on 1.
    const g0 = scene.materials[0]!.bindings!.bindGroup as unknown as FakeGroup;
    expect(
      g0.entries.find((e) => e.binding === 2 + STANDARD_TEXTURE_SLOTS.baseColor)!.resource.texture
        ?.label,
    ).toBe('test:image0');
    const block1 = fake.writes.find(
      (w) => (w.buffer as unknown) === scene.materials[1]!.bindings!.uniformBuffer,
    )!;
    expect(block1.bytes).toBe(STANDARD_UNIFORM_FLOATS * 4);
    expect(scene.materials[0]!.blend).toBe('opaque');
    expect(scene.bounds.center[1]).toBeCloseTo(doc.bounds.center[1], 6);
    // Each mesh carries its primitive's bounding sphere, so `camera.cull` can skip it.
    const pb = doc.meshes[0]!.primitives[0]!.bounds;
    expect(scene.meshes[0]!.bounds).toEqual({
      center: [...pb.center],
      radius: pb.radius,
    });
    expect(fake.errors).toEqual([]);
  });

  it('interleaves VERTEX_LAYOUT_3D as x y z nx ny nz u v r g b a', async () => {
    const doc = sampleDoc();
    const v = interleave3d(doc.meshes[0]!.primitives[0]!);
    expect(v).toHaveLength(36);
    expect([...v.slice(12, 24)]).toEqual([1, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1]);
    // The upload is exactly those 36 floats (144 bytes) into the 3D-layout vertex buffer.
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const scene = await loadGltf(r, doc, { decodeImage });
    const write = fake.writes.find((w) => w.buffer.label === 'gltf:mesh0.0-vb');
    expect(write?.bytes).toBe(144);
    expect(fake.buffers.find((b) => b.label === 'gltf:mesh0.0-vb')!.size).toBe(3 * 48);
    scene.destroy();
  });

  it('draw pushes one instance per node and allocates nothing', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const scene = await loadGltf(r, sampleDoc(), { decodeImage });
    const f = r.beginFrame(0, 0);
    scene.draw(f);
    r.endFrame();
    expect(r.stats.instances).toBe(2);
    expect(r.stats.drawCalls).toBe(2);
    const pass = [...fake.passes].reverse().find((p) => p.label === 'scene')!;
    const pipes = pass.commands
      .filter((c) => c.op === 'setPipeline')
      .map((c) => (c as { pipeline: { label: string } }).pipeline.label);
    expect(pipes).toEqual(['material:gltf:material0:3d:d0', 'material:gltf:material1:3d:d0']);
    expect(fake.errors).toEqual([]);
  });

  it("lit: 'lit' keeps the base-colour material, tint and cutoff per draw", async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const scene = await loadGltf(r, sampleDoc(), { decodeImage, lit: 'lit' });
    expect(scene.textures).toHaveLength(1);
    expect(scene.materials).toHaveLength(2);
    expect([...(scene.nodes[1]!.params.tint as Float32Array)]).toEqual(
      [0.2, 0.4, 0.6, 1].map(Math.fround),
    );
    expect(scene.nodes[1]!.params.params![0]).toBe(0.25);
    expect(scene.nodes[0]!.params.params![0]).toBe(0);
    expect(scene.materials[0]!.bindings!.blockBytes).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('uses the given material for every draw and still decodes the textures', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const own = r.createMaterial({
      label: 'own',
      wgsl: '@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = in.color; o.emissive = vec4f(0.0); return o; }',
    });
    const scene = await loadGltf(r, sampleDoc(), {
      decodeImage,
      material: own,
    });
    expect(scene.materials).toEqual([]);
    expect(scene.nodes.every((n) => n.material === own)).toBe(true);
    expect(scene.textures).toHaveLength(1);
    scene.destroy();
    expect(fake.errors).toEqual([]);
  });

  it('passes skins and animations through and marks skinned draws with their skin', async () => {
    // One skinned triangle under a two-joint skin, one LINEAR translation channel on joint 1.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const jnt = new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]);
    const wgt = new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1, 0, 0]);
    const times = new Float32Array([0, 2]);
    const values = new Float32Array([0, 0, 0, 0, 1, 0]);
    const parts = [pos, nrm, jnt, wgt, times, values].map(
      (p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength),
    );
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const bin = new Uint8Array(total);
    const views: GltfJson['bufferViews'] = [];
    let off = 0;
    for (const p of parts) {
      bin.set(p, off);
      views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength });
      off += p.byteLength;
    }
    const json: GltfJson = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: total }],
      bufferViews: views,
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5121, count: 3, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 4, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 5, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1, JOINTS_0: 2, WEIGHTS_0: 3 },
            },
          ],
        },
      ],
      skins: [{ joints: [0, 1] }],
      nodes: [{ children: [1] }, { translation: [0, 1, 0] }, { mesh: 0, skin: 0 }],
      animations: [
        {
          samplers: [{ input: 4, output: 5 }],
          channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
        },
      ],
      scenes: [{ nodes: [0, 2] }],
    };
    const doc = parseGltf({ json, buffers: [bin.buffer] });
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const scene = await loadGltf(r, doc, { decodeImage });
    expect(scene.skins).toBe(doc.skins);
    expect(scene.animations).toBe(doc.animations);
    expect(scene.animations[0]!.name).toBe('animation0');
    expect(scene.animations[0]!.duration).toBe(2);
    expect(scene.nodes).toHaveLength(1);
    expect(scene.nodes[0]!.skin).toBe(0);
    // Without a palette the skinned primitive is built in the 3D layout at its bind pose.
    expect(scene.meshes[0]!.layout).toBe(VERTEX_LAYOUT_3D);
    expect(scene.meshes[0]!.vertexCount).toBe(3);
    expect(scene.palette).toBeNull();
    const sk = skeletonFromSkin(doc, 0);
    expect([...sk.parents]).toEqual([-1, 0, -1]);
    expect(sk.names).toEqual(['node0', 'node1', 'node2']);
    expect(interleaveSkinned(doc.meshes[0]!.primitives[0]!).vertices.byteLength).toBe(3 * 56);
    expect(fake.errors).toEqual([]);

    // With a palette: the skinned layout, and every material bound to it at binding 16.
    const palette = new SkinPalette(fake.device, { joints: 2, label: 'pal' });
    const skinned = await loadGltf(r, doc, { decodeImage, palette });
    expect(skinned.palette).toBe(palette);
    expect(skinned.meshes[0]!.layout).toBe(VERTEX_LAYOUT_SKINNED);
    expect(fake.buffers.filter((b) => b.label === 'gltf:mesh0.0-vb').at(-1)!.size).toBe(3 * 56);
    const g = skinned.nodes[0]!.material.bindings!.bindGroup as unknown as FakeGroup;
    const res = g.entries.find((e) => e.binding === 16)!.resource as {
      buffer?: { label?: string };
    };
    expect(res.buffer?.label).toBe('pal-buffer');
    expect(fake.errors).toEqual([]);
  });

  it('resolves external images from opts.resources and names a missing one', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const doc = sampleDoc('img/checker.png');
    expect(doc.externalUris).toEqual(['img/checker.png']);
    await expect(loadGltf(r, doc, { decodeImage })).rejects.toThrow(
      /image 0: missing external resource "img\/checker.png"/,
    );
    const bitmap = {
      width: 8,
      height: 2,
      close() {},
    } as unknown as ImageBitmap;
    const scene = await loadGltf(r, doc, {
      resources: { 'img/checker.png': bitmap },
      mips: false,
    });
    expect(scene.textures[0]!.width).toBe(8);
    expect(scene.textures[0]!.height).toBe(2);
    expect(scene.textures[0]!.mipLevels).toBe(1);
    let decoded: Uint8Array | null = null;
    const scene2 = await loadGltf(r, doc, {
      resources: { 'img/checker.png': new Uint8Array([7, 8, 9]).buffer },
      decodeImage: async (bytes) => {
        decoded = bytes;
        return bitmap;
      },
    });
    expect([...decoded!]).toEqual([7, 8, 9]);
    expect(scene2.textures).toHaveLength(1);
  });
});

interface FakeGroup {
  entries: {
    binding: number;
    resource: { texture?: { label?: string }; label?: string };
  }[];
}

/**
 * One quad with TANGENT under a material using every slot (image 0 as base colour, normal and
 * emissive; image 1 as metallic-roughness and occlusion), a `KHR_texture_transform` on the base
 * colour slot, a nearest clamped sampler on the base colour texture; plus a tangent-less
 * triangle under a second material whose base colour is image 1.
 */
function pbrDoc() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const tan = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0]);
  const parts = [pos, nrm, uv, tan, idx, png].map(
    (p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength),
  );
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const bin = new Uint8Array(total);
  const views: GltfJson['bufferViews'] = [];
  let off = 0;
  for (const p of parts) {
    bin.set(p, off);
    views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength });
    off += p.byteLength;
  }
  const json: GltfJson = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: total }],
    bufferViews: views,
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5126, count: 4, type: 'VEC4' },
      { bufferView: 4, componentType: 5123, count: 6, type: 'SCALAR' },
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TANGENT: 3 },
            indices: 4,
            material: 0,
          },
        ],
      },
      { primitives: [{ attributes: { POSITION: 5, NORMAL: 6 }, material: 1 }] },
    ],
    images: [
      { bufferView: 5, mimeType: 'image/png' },
      { bufferView: 5, mimeType: 'image/png' },
    ],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    textures: [{ source: 0, sampler: 0 }, { source: 1 }, { source: 0 }],
    materials: [
      {
        name: 'full',
        pbrMetallicRoughness: {
          baseColorFactor: [0.5, 0.5, 0.5, 1],
          baseColorTexture: {
            index: 0,
            extensions: {
              KHR_texture_transform: {
                offset: [0.5, 0],
                rotation: 1,
                scale: [2, 2],
              },
            },
          },
          metallicFactor: 0.25,
          roughnessFactor: 0.75,
          metallicRoughnessTexture: { index: 1 },
        },
        normalTexture: { index: 2, scale: 0.5 },
        occlusionTexture: { index: 1 },
        emissiveTexture: { index: 2 },
        emissiveFactor: [1, 1, 1],
        extensions: {
          KHR_materials_emissive_strength: { emissiveStrength: 2 },
        },
        alphaMode: 'BLEND',
        doubleSided: true,
      },
      {
        name: 'plain',
        pbrMetallicRoughness: { baseColorTexture: { index: 1 } },
      },
    ],
    nodes: [{ mesh: 0 }, { mesh: 1 }],
    scenes: [{ nodes: [0, 1] }],
  };
  return parseGltf({ json, buffers: [bin.buffer] });
}

describe('loadGltf standard materials on the fake GPU', () => {
  it('uploads one texture per (image, colour space) and binds every map', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    // The fake queue records byte counts only: capture each material's block as it is written.
    const blocks = new Map<string, Float32Array>();
    const create = r.createMaterial.bind(r);
    r.createMaterial = (desc) => {
      const m = create(desc);
      const set = m.setUniforms.bind(m);
      m.setUniforms = (data, off) => {
        blocks.set(m.label, new Float32Array(data as Float32Array));
        set(data, off);
      };
      return m;
    };
    const scene = await loadGltf(r, pbrDoc(), { decodeImage, label: 't' });
    // Image 0: sRGB (base colour, emissive) and linear (normal). Image 1: sRGB (material 1's
    // base colour) and linear (metallic-roughness, occlusion).
    expect(scene.textures.map((t) => [t.texture.label, t.format])).toEqual([
      ['t:image0', 'rgba8unorm-srgb'],
      ['t:image0:linear', 'rgba8unorm'],
      ['t:image1', 'rgba8unorm-srgb'],
      ['t:image1:linear', 'rgba8unorm'],
    ]);
    expect(scene.materialNames).toEqual(['full', 'plain']);
    const g = scene.materials[0]!.bindings!.bindGroup as unknown as FakeGroup;
    const label = (slot: number) =>
      g.entries.find((e) => e.binding === 2 + slot)!.resource.texture?.label;
    expect(label(STANDARD_TEXTURE_SLOTS.baseColor)).toBe('t:image0');
    expect(label(STANDARD_TEXTURE_SLOTS.metallicRoughness)).toBe('t:image1:linear');
    expect(label(STANDARD_TEXTURE_SLOTS.normal)).toBe('t:image0:linear');
    expect(label(STANDARD_TEXTURE_SLOTS.occlusion)).toBe('t:image1:linear');
    expect(label(STANDARD_TEXTURE_SLOTS.emissive)).toBe('t:image0');
    // The base colour texture's sampler: nearest, clamped, and level 0 only (its minFilter
    // 9728 names no mipmap mode).
    const sampler = g.entries.find((e) => e.binding === 1)!.resource as {
      label?: string;
    };
    expect(sampler.label).toBe('nearest-clamp');
    // Factors, flags (double-sided | blend) and the base colour slot's transform in the block.
    const block = blocks.get('t:material0')!;
    expect([...block.slice(0, 12)].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([
      0.5, 0.5, 0.5, 1, 0.25, 0.75, 0.5, 0.5, 2, 2, 2, 5,
    ]);
    expect([...block.slice(12, 16)]).toEqual([2, 2, 0.5, 0]);
    expect(block[16]).toBeCloseTo(Math.cos(1), 6);
    expect(block[17]).toBeCloseTo(Math.sin(1), 6);
    expect(scene.materials[0]!.blend).toBe('alpha');
    // Material 1: linear-mip-repeat default sampler, identity transform.
    const g1 = scene.materials[1]!.bindings!.bindGroup as unknown as FakeGroup;
    expect(
      (g1.entries.find((e) => e.binding === 1)!.resource as { label?: string }).label,
    ).toContain('linear-mip-repeat');
    expect([...blocks.get('t:material1')!.slice(12, 18)]).toEqual([1, 1, 0, 0, 1, 0]);
    expect(fake.errors).toEqual([]);
  });

  it('wires per-slot texCoord and transforms, the occlusion strength and the name (ws/render-4)', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const blocks = new Map<string, Float32Array>();
    const names = new Map<string, string | undefined>();
    const create = r.createMaterial.bind(r);
    r.createMaterial = (desc) => {
      const m = create(desc);
      names.set(m.label, desc.name);
      const set = m.setUniforms.bind(m);
      m.setUniforms = (data, off) => {
        blocks.set(m.label, new Float32Array(data as Float32Array));
        set(data, off);
      };
      return m;
    };
    const doc = pbrDoc();
    const full = doc.materials[0]!;
    full.occlusion!.texCoord = 1;
    full.occlusionStrength = 0.5;
    full.emissive!.transform = { offset: [0.25, 0], rotation: 0, scale: [3, 3] };
    await loadGltf(r, doc, { decodeImage, label: 't' });
    const block = blocks.get('t:material0')!;
    expect(names.get('t:material0')).toBe('full');
    expect(block[18]).toBe(0.5);
    // Base colour: the material transform, texCoord 0.
    expect([...block.slice(20, 24)]).toEqual([2, 2, 0.5, 0]);
    expect(block[26]).toBe(0);
    // Occlusion: texCoord 1 on the material transform.
    const occ = 20 + STANDARD_TEXTURE_SLOTS.occlusion * 8;
    expect([...block.slice(occ, occ + 4)]).toEqual([2, 2, 0.5, 0]);
    expect(block[occ + 6]).toBe(1);
    // Emissive: its own transform.
    const em = 20 + STANDARD_TEXTURE_SLOTS.emissive * 8;
    expect([...block.slice(em, em + 6)]).toEqual([3, 3, 0.25, 0, 1, 0]);
    expect(block[em + 6]).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  it('builds tangent-layout meshes for primitives with TANGENT', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const doc = pbrDoc();
    const scene = await loadGltf(r, doc, { decodeImage });
    expect(scene.meshes[0]!.layout).toBe(VERTEX_LAYOUT_3D_TANGENT);
    expect(scene.meshes[1]!.layout).toBe(VERTEX_LAYOUT_3D);
    expect(fake.buffers.find((b) => b.label === 'gltf:mesh0.0-vb')!.size).toBe(4 * 64);
    const v = interleave3dTangent(doc.meshes[0]!.primitives[0]!);
    expect([...v.slice(32, 48)]).toEqual([1, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, -1]);
    // A primitive without tangents gets the +x tangent.
    const plain = interleave3dTangent(doc.meshes[1]!.primitives[0]!);
    expect([...plain.slice(12, 16)]).toEqual([1, 0, 0, 1]);
    const f = r.beginFrame(0, 0);
    scene.draw(f);
    r.endFrame();
    const pass = [...fake.passes].reverse().find((p) => p.label === 'scene')!;
    const pipes = pass.commands
      .filter((c) => c.op === 'setPipeline')
      .map((c) => (c as { pipeline: { label: string } }).pipeline.label);
    // No depth on this camera: both at d0, in draw order.
    expect(pipes).toEqual([
      'material:gltf:material0:3d-tangent:d0',
      'material:gltf:material1:3d:d0',
    ]);
    expect(fake.errors).toEqual([]);
  });

  it('gltfSamplerKind maps glTF samplers to the engine set', () => {
    const base = {
      minFilter: 'linear',
      mipmapFilter: 'linear',
      wrapS: 'repeat',
      wrapT: 'repeat',
    } as const;
    expect(gltfSamplerKind({ ...base, magFilter: 'linear' }, true)).toBe('linear-mip-repeat');
    expect(gltfSamplerKind({ ...base, magFilter: 'linear' }, false)).toBe('linear-repeat');
    expect(gltfSamplerKind({ ...base, magFilter: 'linear', mipmapFilter: null }, true)).toBe(
      'linear-repeat',
    );
    expect(gltfSamplerKind({ ...base, magFilter: 'nearest' }, true)).toBe('nearest-mip-clamp');
    expect(gltfSamplerKind({ ...base, magFilter: 'nearest' }, false)).toBe('nearest-clamp');
    expect(
      gltfSamplerKind(
        {
          ...base,
          magFilter: 'linear',
          wrapS: 'clamp-to-edge',
          wrapT: 'clamp-to-edge',
        },
        true,
      ),
    ).toBe('linear-clamp');
    expect(gltfSamplerKind({ ...base, magFilter: 'linear', wrapS: 'mirror-repeat' }, true)).toBe(
      'linear-mip-repeat',
    );
  });
});

/**
 * Two meshes: mesh 0 is a triangle with two morph targets (0: lift z by 1 with a normal tilt;
 * 1: stretch vertex 1 by 2 in x, positions only) and default weights `[0, 0.5]`; mesh 1 is the
 * same triangle without targets. Two nodes draw mesh 0, one draws mesh 1.
 */
function morphDoc() {
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const t0p = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const t0n = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]);
  const t1p = new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 0]);
  const parts = [tri, nrm, t0p, t0n, t1p];
  const bin = new Uint8Array(parts.length * 36);
  const views: GltfJson['bufferViews'] = [];
  parts.forEach((p, i) => {
    bin.set(new Uint8Array(p.buffer), i * 36);
    views.push({ buffer: 0, byteOffset: i * 36, byteLength: 36 });
  });
  const vec3 = (bufferView: number) => ({
    bufferView,
    componentType: 5126 as const,
    count: 3,
    type: 'VEC3' as const,
  });
  const json: GltfJson = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: views,
    accessors: [vec3(0), vec3(1), vec3(2), vec3(3), vec3(4)],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            targets: [{ POSITION: 2, NORMAL: 3 }, { POSITION: 4 }],
          },
        ],
        weights: [0, 0.5],
      },
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] },
    ],
    nodes: [{ mesh: 0 }, { mesh: 0, translation: [3, 0, 0] }, { mesh: 1 }],
    scenes: [{ nodes: [0, 1, 2] }],
  };
  return parseGltf({ json, buffers: [bin.buffer] });
}

describe('loadGltf morph targets on the fake GPU', () => {
  it('builds one morph per mesh with targets, shared by its nodes, at the file weights', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const scene = await loadGltf(r, morphDoc(), { decodeImage });
    expect(scene.morphs).toHaveLength(1);
    const m = scene.morph(0)!;
    expect(m).not.toBeNull();
    expect(scene.morph(1)).toBe(m);
    expect(scene.morph(2)).toBeNull();
    expect(scene.morph(7)).toBeNull();
    expect(m.mesh).toBe(0);
    expect(m.targetCount).toBe(2);
    expect([...m.weights]).toEqual([0, 0.5]);
    // One blender per primitive of the mesh, all over the shared weights; none elsewhere.
    expect(m.blenders).toHaveLength(1);
    expect(m.blenders[0]!.weights).toBe(m.weights);
    expect(m.blenders[0]!.vertexCount).toBe(3);
    expect(fake.errors).toEqual([]);
  });

  it('apply blends into a second buffer that draw uploads once, recomputing bounds', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const scene = await loadGltf(r, morphDoc(), { decodeImage });
    const m = scene.morph(0)!;
    const mesh = scene.meshes[0]!;
    const writes = () => fake.writes.filter((w) => w.buffer.label === 'gltf:mesh0.0-vb');
    expect(writes()).toHaveLength(1); // the base upload
    const baseRadius = mesh.bounds.radius;

    // No apply: draw uploads nothing new.
    let f = r.beginFrame(0, 0);
    scene.draw(f);
    r.endFrame();
    expect(writes()).toHaveLength(1);
    expect(r.stats.instances).toBe(3);

    // The first apply writes (the file's weights: target 1 at 0.5 moves vertex 1 to x = 2).
    expect(m.apply()).toBe(true);
    expect(m.apply()).toBe(false);
    f = r.beginFrame(1, 0);
    scene.draw(f);
    r.endFrame();
    expect(writes()).toHaveLength(2);
    expect(writes()[1]!.bytes).toBe(3 * 48);
    // Bounds followed the upload: the triangle now reaches x = 2.
    expect(mesh.bounds.radius).toBeGreaterThan(baseRadius);
    expect(mesh.bounds.center[0]).toBeCloseTo(1, 6);

    // Drawing again without a change uploads nothing; a changed weight uploads once more.
    f = r.beginFrame(2, 0);
    scene.draw(f);
    r.endFrame();
    expect(writes()).toHaveLength(2);
    m.weights[0] = 1;
    expect(m.apply()).toBe(true);
    f = r.beginFrame(3, 0);
    scene.draw(f);
    r.endFrame();
    expect(writes()).toHaveLength(3);
    expect(mesh.bounds.center[2]).toBeCloseTo(1, 6);
    // The untargeted mesh never re-uploads.
    expect(fake.writes.filter((w) => w.buffer.label === 'gltf:mesh1.0-vb')).toHaveLength(1);
    expect(fake.errors).toEqual([]);
  });
});
