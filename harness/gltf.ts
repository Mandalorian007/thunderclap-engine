/**
 * glTF demo page (harness/gltf.html): a GLB built in the page (harness/gltf-writer.ts) goes
 * through `parseGltf` and `loadGltf` and draws with `scene.draw(frame)` under the engine's
 * lighting block. The camera orbits the scene's bounds: drag with any pointer, wheel to zoom.
 * Nothing here is engine code beyond the two calls a game would make.
 *
 * `?pbr` loads the PBR scene instead (`buildPbrGlb`): every material slot through the standard
 * material, a tangent-space normal map, a `KHR_texture_transform`, an emissive strip and a
 * skinned cylinder animated the way a game would (`skeletonFromSkin` → `anim` pose →
 * `SkinPalette` handed to `loadGltf` as `opts.palette`).
 */

import {
  type AnimationClip,
  createPose,
  poseToWorld,
  sampleClip,
  skinMatrices,
  WORLD_NODE_FLOATS,
} from '@thunderclap/engine/anim';
import {
  type GltfSkeleton,
  loadGltf,
  parseGltf,
  skeletonFromSkin,
} from '@thunderclap/engine/assets';
import { GameLoop } from '@thunderclap/engine/core';
import { Gestures } from '@thunderclap/engine/input';
import { boot } from '@thunderclap/engine/platform';
import {
  Camera,
  type CameraPoint,
  gpuDiagnostics,
  installGpuErrorLogging,
  JOINT_FLOATS,
  Lights,
  Renderer,
  SkinPalette,
  VERTEX_LAYOUT_3D_TANGENT,
  VERTEX_LAYOUT_SKINNED,
} from '@thunderclap/engine/render';
import type { HarnessGltfState } from './gltf-state';
import {
  buildPbrGlb,
  buildSampleGlb,
  PBR_GLOW_CENTER,
  PBR_GLOW_SURROUND,
  PBR_SPHERE_RADIUS,
  pbrSphereCenter,
  SAMPLE_CUBE_CENTER,
  SAMPLE_PLANE_SCALE,
} from './gltf-writer';

const PBR = new URLSearchParams(location.search).has('pbr');

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };
const CLEAR = [0.05, 0.07, 0.12] as const;

const state: HarnessGltfState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  logical: LOGICAL,
  counts: { nodes: 0, meshes: 0, textures: 0, materials: 0, transforms: 0 },
  warnings: [],
  externalUris: [],
  bounds: { center: [0, 0, 0], radius: 0 },
  materials: 0,
  maps: 0,
  skinned: false,
  tangentMeshes: 0,
  jointNames: [],
  probes: {
    cube: { x: 0, y: 0 },
    ground: { x: 0, y: 0 },
    emissive: { x: 0, y: 0 },
    emissiveSurround: { x: 0, y: 0 },
    metalSphere: { x: 0, y: 0 },
    matteSphere: { x: 0, y: 0 },
  },
  camera: { yaw: 0, pitch: 0, distance: 0 },
  clear: [CLEAR[0], CLEAR[1], CLEAR[2]],
  stats: { drawCalls: 0, instances: 0 },
  gpuErrors: 0,
};
window.__harnessGltf = { state };

const orbit = PBR
  ? { yaw: 0, pitch: 0.12, distance: 11.5 }
  : { yaw: 0.65, pitch: 0.42, distance: 7 };
// `?pbr`: the two probed spheres, full metal and dielectric at roughness 1 (column 2, rows 2 and 0).
const METAL_SPHERE = pbrSphereCenter(2, 2);
const MATTE_SPHERE = pbrSphereCenter(2, 0);

/** The `?pbr` cylinder's rig: the file's skin and clip driven through `anim`, into one palette. */
class Rig {
  readonly palette: SkinPalette;
  private readonly skeleton: GltfSkeleton;
  private readonly pose: Float32Array;
  private readonly world: Float32Array;
  private readonly matrices: Float32Array;
  constructor(
    device: GPUDevice,
    skeleton: GltfSkeleton,
    private readonly clip: AnimationClip | null,
  ) {
    this.skeleton = skeleton;
    this.palette = new SkinPalette(device, {
      joints: skeleton.joints.length,
      label: 'gltf-skin',
    });
    this.pose = createPose(skeleton);
    this.world = new Float32Array(skeleton.parents.length * WORLD_NODE_FLOATS);
    this.matrices = new Float32Array(skeleton.joints.length * JOINT_FLOATS);
  }
  /** Sample the clip at `t` (looping) and upload the joint matrices. No allocation. */
  update(t: number): void {
    const clip = this.clip;
    if (clip && clip.duration > 0) sampleClip(clip, t % clip.duration, this.pose);
    poseToWorld(this.skeleton, this.pose, this.world);
    skinMatrices(this.skeleton, this.world, this.matrices);
    this.palette.set(0, this.matrices);
    this.palette.flush();
  }
}
const ORBIT_PER_PX = 0.005;
const PITCH_MIN = 0.05;
const PITCH_MAX = 1.35;
const eye = new Float32Array(3);
const target = new Float32Array(3);
const probePoint: CameraPoint = { x: 0, y: 0, z: 0 };

function placeCamera(camera: Camera): void {
  const o = orbit;
  o.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, o.pitch));
  o.distance = Math.min(60, Math.max(2, o.distance));
  const cp = Math.cos(o.pitch);
  eye[0] = target[0]! + o.distance * Math.sin(o.yaw) * cp;
  eye[1] = target[1]! + o.distance * Math.sin(o.pitch);
  eye[2] = target[2]! + o.distance * Math.cos(o.yaw) * cp;
  camera.lookAt(eye, target);
  state.camera.yaw = o.yaw;
  state.camera.pitch = o.pitch;
  state.camera.distance = o.distance;
}

function probe(camera: Camera, x: number, y: number, z: number, out: { x: number; y: number }) {
  camera.worldToScreen(x, y, z, probePoint);
  out.x = probePoint.x;
  out.y = probePoint.y;
}

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine glTF demo' });
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

  // The game's part: bytes (here built in the page) → document → GPU scene.
  const doc = parseGltf(PBR ? buildPbrGlb() : buildSampleGlb());
  let rig: Rig | null = null;
  if (PBR && doc.skins.length > 0) {
    const skeleton = skeletonFromSkin(doc, 0);
    const clip = doc.animations[0] ?? null;
    rig = new Rig(renderer.device, skeleton, clip);
    state.jointNames = Array.from(skeleton.joints, (n) => skeleton.names[n]!);
  }
  const scene = await loadGltf(renderer, doc, {
    label: PBR ? 'pbr' : 'sample',
    ...(rig ? { palette: rig.palette } : {}),
  });
  state.materials = scene.materials.length;
  state.maps = scene.textures.length;
  state.skinned = scene.meshes.some((m) => m.layout === VERTEX_LAYOUT_SKINNED);
  state.tangentMeshes = scene.meshes.filter((m) => m.layout === VERTEX_LAYOUT_3D_TANGENT).length;
  state.counts.nodes = scene.nodes.length;
  state.counts.meshes = scene.meshes.length;
  state.counts.textures = scene.textures.length;
  state.counts.materials = scene.materials.length;
  state.counts.transforms = scene.transforms.length;
  state.warnings = [...doc.warnings];
  state.externalUris = [...doc.externalUris];
  state.bounds.center = [...scene.bounds.center];
  state.bounds.radius = scene.bounds.radius;
  target.set(scene.bounds.center);
  target[1] = PBR ? 1.7 : SAMPLE_CUBE_CENTER[1];

  const camera = Camera.perspective((50 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 200);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  renderer.camera = camera;
  placeCamera(camera);

  const lights = new Lights();
  lights.ambient.set([0.22, 0.22, 0.25]);
  // The PBR quads face +z, so its sun leans towards -z.
  lights.sun.dir = PBR ? [-0.35, -0.8, -0.7] : [-0.45, -1.0, -0.65];
  lights.sun.color = [0.9, 0.9, 0.85];

  const gestures = new Gestures();
  gestures.attach({ pointerTarget: surface.canvas });
  surface.canvas.addEventListener('wheel', (e) => {
    orbit.distance *= 1 + Math.sign(e.deltaY) * 0.08;
    e.preventDefault();
  });

  const loop = new GameLoop({
    update() {
      gestures.update();
      const pan = gestures.pan;
      if (pan && pan.pointers === 1 && (pan.phase === 'start' || pan.phase === 'move')) {
        orbit.yaw -= pan.dx * ORBIT_PER_PX;
        orbit.pitch += pan.dy * ORBIT_PER_PX;
      }
      const pinch = gestures.pinch;
      if (pinch && (pinch.phase === 'start' || pinch.phase === 'move') && pinch.delta > 0) {
        orbit.distance /= pinch.delta;
      }
      placeCamera(camera);
    },
    render(_alpha, time) {
      rig?.update(time.realTime);
      const frame = renderer.beginFrame(time.realTime, time.frameDt);
      frame.clear(CLEAR[0], CLEAR[1], CLEAR[2]);
      frame.lights = lights;
      scene.draw(frame);
      renderer.endFrame();
      state.frames++;
      state.stats.drawCalls = renderer.stats.drawCalls;
      state.stats.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
      probe(
        camera,
        SAMPLE_CUBE_CENTER[0],
        SAMPLE_CUBE_CENTER[1],
        SAMPLE_CUBE_CENTER[2],
        state.probes.cube,
      );
      // Beside the cube (perpendicular to the default view), so it stays on screen on every row.
      probe(camera, SAMPLE_PLANE_SCALE * 0.25, 0, SAMPLE_PLANE_SCALE * -0.2, state.probes.ground);
      if (PBR) {
        const p = state.probes;
        probe(camera, PBR_GLOW_CENTER[0], PBR_GLOW_CENTER[1], PBR_GLOW_CENTER[2], p.emissive);
        probe(
          camera,
          PBR_GLOW_SURROUND[0],
          PBR_GLOW_SURROUND[1],
          PBR_GLOW_SURROUND[2],
          p.emissiveSurround,
        );
        // The spheres' front faces, slightly below centre so the sun's highlight is not what we read.
        const r = PBR_SPHERE_RADIUS;
        probe(
          camera,
          METAL_SPHERE[0],
          METAL_SPHERE[1] - r * 0.2,
          METAL_SPHERE[2] + r,
          p.metalSphere,
        );
        probe(
          camera,
          MATTE_SPHERE[0],
          MATTE_SPHERE[1] - r * 0.2,
          MATTE_SPHERE[2] + r,
          p.matteSphere,
        );
      }
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
