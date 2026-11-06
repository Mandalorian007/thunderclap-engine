import { describe, expect, it } from 'vitest';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import { VERTEX_LAYOUT_3D } from '../render/mesh';
import { Renderer } from '../render/renderer';
import { type GltfJson, parseGltf } from './gltf';
import { type GltfImageSource, interleave3d, loadGltf } from './gltf-load';
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
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
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
    // Draw entries: node index, material, base colour factor as tint, cutoff as params.x.
    expect(scene.nodes.map((n) => n.node)).toEqual([1, 2]);
    expect(scene.nodes[0]!.material).toBe(scene.materials[0]);
    expect(scene.nodes[1]!.material).toBe(scene.materials[1]);
    expect([...(scene.nodes[1]!.params.tint as Float32Array)]).toEqual(
      [0.2, 0.4, 0.6, 1].map(Math.fround),
    );
    expect(scene.nodes[1]!.params.params![0]).toBe(0.25);
    expect(scene.nodes[0]!.params.params![0]).toBe(0);
    expect(scene.bounds.center[1]).toBeCloseTo(doc.bounds.center[1], 6);
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

  it('uses the given material for every draw and still decodes the textures', async () => {
    const fake = createFakeDevice();
    const r = new Renderer(fakeRendererGpu(fake));
    const own = r.createMaterial({
      label: 'own',
      wgsl: '@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = in.color; o.emissive = vec4f(0.0); return o; }',
    });
    const scene = await loadGltf(r, sampleDoc(), { decodeImage, material: own });
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
          primitives: [{ attributes: { POSITION: 0, NORMAL: 1, JOINTS_0: 2, WEIGHTS_0: 3 } }],
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
    // Until VERTEX_LAYOUT_SKINNED lands, the skinned primitive is built in the 3D layout.
    expect(scene.meshes[0]!.layout).toBe(VERTEX_LAYOUT_3D);
    expect(scene.meshes[0]!.vertexCount).toBe(3);
    const sk = skeletonFromSkin(doc, 0);
    expect([...sk.parents]).toEqual([-1, 0, -1]);
    expect(interleaveSkinned(doc.meshes[0]!.primitives[0]!).vertices.byteLength).toBe(3 * 56);
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
    const bitmap = { width: 8, height: 2, close() {} } as unknown as ImageBitmap;
    const scene = await loadGltf(r, doc, { resources: { 'img/checker.png': bitmap }, mips: false });
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
