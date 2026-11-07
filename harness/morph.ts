/**
 * Morph targets demo page (harness/morph.html): a `.gltf` built in the page (a UV sphere with
 * two morph targets, squash and bulge, and a `weights` clip that visits each in turn) goes
 * through `parseGltf` and `loadGltf`; every frame the game samples the clip with
 * `sampleWeights`, calls `morph.apply()` and draws with `scene.draw(frame)`, which uploads the
 * blended vertices when they changed. Fixed camera, engine lighting.
 */

import { sampleWeights } from '@thunderclap-engine/engine/anim';
import { type GltfJson, loadGltf, parseGltf } from '@thunderclap-engine/engine/assets';
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  Lights,
  Renderer,
} from '@thunderclap-engine/engine/render';
import type { HarnessMorphState } from './morph-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const CLEAR = [0.05, 0.07, 0.12] as const;
const PROBE_Y = 1.2;

const state: HarnessMorphState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  targetCount: 0,
  weights: [],
  applied: 0,
  duration: 0,
  time: 0,
  bounds: { center: [0, 0, 0], radius: 0 },
  probe: { x: 0, y: 0 },
  clear: [CLEAR[0], CLEAR[1], CLEAR[2]],
  gpuErrors: 0,
};
window.__harnessMorph = { state };

/**
 * A unit UV sphere with two morph targets as a `.gltf` JSON document plus its one buffer.
 * Target 0 (squash) scales y by 0.4 (position delta `(0, -0.6y, 0)`, normals re-aimed for the
 * flattened surface); target 1 (bulge) scales uniformly by 1.5 (position delta `0.5·p`, normals
 * unchanged). The animation holds the rest, squash, rest, bulge, rest over 9 seconds.
 */
function buildSphereGltf(): { json: GltfJson; buffers: ArrayBuffer[] } {
  const SEGMENTS = 32;
  const RINGS = 20;
  const pos: number[] = [];
  const nrm: number[] = [];
  const squashPos: number[] = [];
  const squashNrm: number[] = [];
  const bulgePos: number[] = [];
  for (let r = 0; r <= RINGS; r++) {
    const phi = (r / RINGS) * Math.PI;
    const y = Math.cos(phi);
    const ring = Math.sin(phi);
    for (let s = 0; s <= SEGMENTS; s++) {
      const theta = (s / SEGMENTS) * Math.PI * 2;
      const x = ring * Math.cos(theta);
      const z = ring * Math.sin(theta);
      pos.push(x, y, z);
      nrm.push(x, y, z);
      squashPos.push(0, -0.6 * y, 0);
      // The normal of y → 0.4y is (nx, ny / 0.4, nz) normalised; store the delta from (x, y, z).
      const ny = y / 0.4;
      const len = Math.hypot(x, ny, z) || 1;
      squashNrm.push(x / len - x, ny / len - y, z / len - z);
      bulgePos.push(0.5 * x, 0.5 * y, 0.5 * z);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = r * (SEGMENTS + 1) + s;
      const b = a + SEGMENTS + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const times = [0, 1.5, 3, 4.5, 6, 7.5, 9];
  const values = [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0];

  const parts: Uint8Array[] = [
    new Float32Array(pos),
    new Float32Array(nrm),
    new Uint16Array(idx),
    new Float32Array(squashPos),
    new Float32Array(squashNrm),
    new Float32Array(bulgePos),
    new Float32Array(times),
    new Float32Array(values),
  ].map((a) => new Uint8Array(a.buffer));
  const bufferViews: GltfJson['bufferViews'] = [];
  let total = 0;
  for (const p of parts) {
    bufferViews.push({ buffer: 0, byteOffset: total, byteLength: p.byteLength });
    total += Math.ceil(p.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(total);
  parts.forEach((p, i) => {
    bin.set(p, bufferViews[i]!.byteOffset);
  });
  const vertexCount = pos.length / 3;
  const vec3 = (bufferView: number) => ({
    bufferView,
    componentType: 5126 as const,
    count: vertexCount,
    type: 'VEC3' as const,
  });
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'thunderclap harness' },
    buffers: [{ byteLength: total }],
    bufferViews,
    accessors: [
      { ...vec3(0), min: [-1, -1, -1], max: [1, 1, 1] },
      vec3(1),
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
      vec3(3),
      vec3(4),
      vec3(5),
      { bufferView: 6, componentType: 5126, count: times.length, type: 'SCALAR' },
      { bufferView: 7, componentType: 5126, count: values.length, type: 'SCALAR' },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.95, 0.55, 0.2, 1] } }],
    meshes: [
      {
        name: 'sphere',
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            material: 0,
            targets: [{ POSITION: 3, NORMAL: 4 }, { POSITION: 5 }],
          },
        ],
        weights: [0, 0],
      },
    ],
    nodes: [{ name: 'sphere', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    animations: [
      {
        name: 'morph',
        channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }],
        samplers: [{ input: 6, output: 7, interpolation: 'LINEAR' }],
      },
    ],
  };
  return { json, buffers: [bin.buffer] };
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine morph targets demo' });
  if (!res.ok) {
    state.gpu = res.reason;
    state.ready = true;
    return;
  }
  const { surface, gpu } = res;
  installGpuErrorLogging(gpu.device);
  const renderer = new Renderer(gpu);
  renderer.resize(surface.backbuffer.width, surface.backbuffer.height);
  surface.onResize(({ backbuffer }) => renderer.resize(backbuffer.width, backbuffer.height));

  // The game's part: document → GPU scene; the sphere node's morph state and its clip.
  const doc = parseGltf(buildSphereGltf());
  const scene = await loadGltf(renderer, doc, { label: 'morph' });
  const morph = scene.morph(0);
  if (!morph) throw new Error('sphere has no morph targets');
  const clip = scene.animations[0]!;
  const mesh = scene.meshes[0]!;
  state.targetCount = morph.targetCount;
  state.weights = [...morph.weights];
  state.duration = clip.duration;

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 50);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  camera.lookAt(new Float32Array([0, 0, 4.5]), new Float32Array([0, 0, 0]));

  const lights = new Lights();
  lights.ambient.set([0.22, 0.22, 0.25]);
  lights.sun.direction = [-0.45, -1.0, -0.65];
  lights.sun.color = [0.9, 0.9, 0.85];

  const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };
  let elapsed = 0;
  const loop = new GameLoop({
    update(dt) {
      elapsed += dt;
      const t = elapsed % clip.duration;
      sampleWeights(clip, 0, t, morph.weights);
      if (morph.apply()) state.applied++;
      state.time = t;
      for (let i = 0; i < morph.weights.length; i++) state.weights[i] = morph.weights[i]!;
    },
    render(_alpha, time) {
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.lights = lights;
      scene.draw(frame);
      renderer.endFrame();
      state.frames++;
      state.gpuErrors = gpuDiagnostics.errorCount;
      state.bounds.center[0] = mesh.bounds.center[0]!;
      state.bounds.center[1] = mesh.bounds.center[1]!;
      state.bounds.center[2] = mesh.bounds.center[2]!;
      state.bounds.radius = mesh.bounds.radius;
      camera.worldToScreen(0, PROBE_Y, 0, probePoint);
      state.probe.x = probePoint.x;
      state.probe.y = probePoint.y;
    },
  });
  res.onDeviceLost(() => loop.stop());
  loop.start();
  state.gpu = 'ok';
  state.ready = true;
}

main().catch((err) => {
  console.error('[harness]', err);
  state.gpu = `error: ${err instanceof Error ? err.message : String(err)}`;
  state.ready = true;
});
