import { describe, expect, it } from 'vitest';
import { Camera } from '../render/camera';
import { createFakeDevice, fakeRendererGpu } from '../render/fake-gpu';
import type { Frame } from '../render/frame';
import type { Mesh } from '../render/mesh';
import { Renderer } from '../render/renderer';
import { createVoxelChunks } from './chunks';
import { createVoxelGrid } from './grid';

const FS = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut { var o: FragOut; o.color = in.color; o.emissive = vec4f(0.0); return o; }`;

function setup(slack = 1.5) {
  const fake = createFakeDevice();
  const renderer = new Renderer(fakeRendererGpu(fake));
  const material = renderer.createMaterial({ label: 'blocks', wgsl: FS });
  // 4 × 2 × 4 chunks, ground 8 deep: the bottom row of chunks is solid-topped, the top row empty.
  const grid = createVoxelGrid({ sizeX: 64, sizeY: 32, sizeZ: 64, chunk: 16 });
  grid.fill((_x, y) => (y < 8 ? 1 : 0));
  let clock = 0;
  const chunks = createVoxelChunks(renderer, grid, { material, slack, now: () => clock });
  const draws: { mesh: Mesh; x: number; y: number; z: number }[] = [];
  const frame = {
    mesh: (mesh: Mesh, _m: unknown, t: { position: { x: number; y: number; z: number } }) => {
      draws.push({ mesh, x: t.position.x, y: t.position.y, z: t.position.z });
    },
  } as unknown as Frame;
  const tick = async (ms = 1) => {
    clock += ms;
    chunks.update();
    await Promise.resolve();
    await Promise.resolve();
  };
  /** Request, let the in-thread mesher run, then apply. */
  const settle = async () => {
    await tick();
    await tick();
  };
  return { fake, renderer, grid, chunks, frame, draws, tick, settle };
}

describe('createVoxelChunks', () => {
  it('creates one mesh per non-empty chunk after the remeshes land, none per frame after', async () => {
    const { fake, chunks, settle } = setup();
    expect(chunks.meshes.every((m) => m === null)).toBe(true);
    expect(chunks.stats.chunks).toBe(0);
    await settle();
    expect(chunks.stats.chunks).toBe(16);
    expect(chunks.stats.remeshes).toBe(32);
    expect(chunks.stats.pending).toBe(0);
    expect(chunks.stats.remeshMs).toBe(1);
    expect(chunks.meshes.filter((m) => m !== null)).toHaveLength(16);
    const buffers = fake.buffers.length;
    await settle();
    expect(fake.buffers.length).toBe(buffers);
    expect(chunks.stats.remeshes).toBe(32);
    expect(fake.errors).toEqual([]);
  });

  it('draws every chunk a camera sees and culls the rest, drawn + culled = chunks', async () => {
    const { chunks, frame, draws, settle } = setup();
    await settle();
    const camera = Camera.perspective(1, 16 / 9, 0.1, 500);
    camera.lookAt([32, 40, 120], [32, 4, 32]);
    const all = chunks.draw(frame, camera);
    expect(all.drawn).toBe(16);
    expect(all.culled).toBe(0);
    expect(all.triangles).toBe(draws.reduce((n, d) => n + d.mesh.indexCount / 3, 0));
    expect(all.triangles).toBeGreaterThan(0);
    expect(draws.map((d) => [d.x, d.y, d.z])).toContainEqual([48, 0, 48]);
    draws.length = 0;
    camera.lookAt([32, 20, 32], [32, 20, -100]); // facing -z from the middle: the far half only
    const half = chunks.draw(frame, camera);
    expect(half.drawn + half.culled).toBe(chunks.stats.chunks);
    expect(half.culled).toBeGreaterThan(0);
    expect(half.drawn).toBeGreaterThan(0);
    expect(draws.every((d) => d.z < 32)).toBe(true);
    camera.lookAt([32, 20, 32], [32, 200, 32]); // straight up: nothing
    const none = chunks.draw(frame, camera);
    expect(none.drawn).toBe(0);
    expect(none.culled).toBe(16);
  });

  it('place and break rewrite the chunk in place: growths stays 0', async () => {
    const { chunks, grid, frame, settle } = setup();
    await settle();
    const camera = Camera.perspective(1, 16 / 9, 0.1, 500);
    camera.lookAt([32, 40, 120], [32, 4, 32]);
    const before = chunks.draw(frame, camera).triangles;
    grid.set(20, 8, 20, 2); // place on top
    expect(chunks.stats.pending).toBe(0);
    await settle();
    expect(chunks.stats.remeshes).toBe(32 + 1);
    const placed = chunks.draw(frame, camera).triangles;
    expect(placed).toBeGreaterThan(before);
    grid.set(20, 8, 20, 0); // break it
    grid.set(21, 7, 21, 0); // and dig into the ground: one remesh for both
    await settle();
    expect(chunks.stats.remeshes).toBe(34);
    const dug = chunks.draw(frame, camera).triangles;
    expect(dug).toBeGreaterThan(before);
    expect(chunks.stats.growths).toBe(0);
    // An edit on a chunk border remeshes the neighbour too.
    grid.set(31, 7, 31, 0);
    await settle();
    expect(chunks.stats.remeshes).toBe(34 + 4);
  });

  it('a chunk that empties stops drawing, one that fills in starts, and growths count', async () => {
    const { chunks, grid, frame, settle } = setup(1);
    await settle();
    expect(chunks.stats.chunks).toBe(16);
    // Hollow the first chunk out entirely.
    for (let z = 0; z < 16; z++)
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) grid.set(x, y, z, 0);
    await settle();
    expect(chunks.stats.chunks).toBe(15);
    const camera = Camera.perspective(1, 16 / 9, 0.1, 500);
    camera.lookAt([32, 40, 120], [32, 4, 32]);
    const s = chunks.draw(frame, camera);
    expect(s.drawn + s.culled).toBe(15);
    // Fill the air above with a checkerboard: the chunk above grows from nothing, and the
    // exact-fit (slack 1) ground chunk next door grows past its room.
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) if ((x + z) % 2 === 0) grid.set(x + 16, 20, z, 1);
    await settle();
    expect(chunks.stats.chunks).toBe(16);
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) if ((x + z) % 2 === 0) grid.set(x + 16, 8, z, 1);
    await settle();
    expect(chunks.stats.growths).toBeGreaterThan(0);
  });

  it('dispose destroys the meshes and drops late replies', async () => {
    const { fake, chunks, settle, tick } = setup();
    await settle();
    await tick(); // request nothing new
    chunks.dispose();
    expect(chunks.meshes.every((m) => m === null)).toBe(true);
    expect(fake.buffers.filter((b) => b.label?.startsWith('voxel-chunk') && !b.destroyed)).toEqual(
      [],
    );
  });

  it('origin offsets the chunk transforms', () => {
    const fake = createFakeDevice();
    const renderer = new Renderer(fakeRendererGpu(fake));
    const material = renderer.createMaterial({ label: 'blocks', wgsl: FS });
    const grid = createVoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 16, chunk: 16 });
    const chunks = createVoxelChunks(renderer, grid, { material, origin: [-16, 2, 0] });
    expect(chunks.transforms).toHaveLength(2);
    const t = chunks.transforms[1]!.position;
    expect([t.x, t.y, t.z]).toEqual([0, 2, 0]);
    expect(chunks.mesher.offThread).toBe(false);
  });
});
