/**
 * Animation graph page (ws/anim-graph): a three-joint figure (hips, torso, head, each bone a
 * box) driven by `createAnimGraph` over an `AnimationMixer`. The clips are built here: idle
 * (a slow sway), walk (a swing) and run (a faster, wider swing) sit in a 1D `speed` blend space
 * with phase sync; `jump` is a non-looping hop entered on a boolean and left at its exit time.
 * In `auto` the page cycles `speed` 0→1→0 over four seconds and pulses `jump` every three;
 * the spec parks that (E-017) and sets the parameters itself. Nothing here is engine code.
 */
import {
  type AnimationChannel,
  type AnimationClip,
  AnimationMixer,
  createAnimGraph,
  POSE_NODE_FLOATS,
  quatFromAxisAngle,
  quatIdentity,
  type Skeleton,
} from '@thunderclap-engine/engine/anim';
import { GameLoop } from '@thunderclap-engine/engine/core';
import { boot } from '@thunderclap-engine/engine/platform';
import {
  Camera,
  gpuDiagnostics,
  type InstanceParams,
  installGpuErrorLogging,
  Lights,
  Renderer,
  Transform,
  VERTEX_LAYOUT_3D,
} from '@thunderclap-engine/engine/render';
import type { HarnessAnimGraphApi, HarnessAnimGraphState } from './anim-graph-state';

const root = document.getElementById('root') as HTMLElement;
const LOGICAL = { width: 1920, height: 1080 };

const state: HarnessAnimGraphState = {
  ready: false,
  gpu: 'pending',
  frames: 0,
  updates: 0,
  state: 'move',
  speed: 0,
  weights: [1, 0, 0],
  jumpWeight: 0,
  phase: 0,
  jumps: 0,
  returns: 0,
  auto: true,
  instances: 0,
  gpuErrors: 0,
};

/** A unit cube centred on the origin, 24 vertices (12 floats each), 36 indices, white. */
function cubeGeometry(): { vertices: Float32Array; indices: Uint16Array } {
  const faces: [number[], number[], number[]][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const vertices = new Float32Array(24 * 12);
  const indices = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const [n, r, u] of faces) {
    const base = v / 12;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) vertices[v + k] = (n[k]! + sx * r[k]! + sy * u[k]!) * 0.5;
      vertices[v + 3] = n[0]!;
      vertices[v + 4] = n[1]!;
      vertices[v + 5] = n[2]!;
      vertices[v + 6] = (sx + 1) / 2;
      vertices[v + 7] = (1 - sy) / 2;
      vertices[v + 8] = vertices[v + 9] = vertices[v + 10] = vertices[v + 11] = 1;
      v += 12;
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i);
    i += 6;
  }
  return { vertices, indices };
}

const LIT_WGSL = /* wgsl */ `
@fragment fn fs_main(in: VSOut) -> FragOut {
  let n = normalize(in.normal);
  let sky = 0.5 + 0.5 * n.y;
  var o: FragOut;
  o.color = vec4f(in.color.rgb * (engine_lambert(n, in.worldPos) + 0.15 * sky), 1.0);
  o.emissive = vec4f(0.0);
  return o;
}`;

/** Bone lengths: hips → torso → head. The rest pose stacks them on +Y from y = HIPS_Y. */
const HIPS_Y = 1.0;
const BONE = [0.5, 0.6, 0.35] as const;

function buildSkeleton(): Skeleton {
  const parents = new Int16Array([-1, 0, 1]);
  const rest = new Float32Array(3 * POSE_NODE_FLOATS);
  for (let i = 0; i < 3; i++) {
    const o = i * POSE_NODE_FLOATS;
    rest[o + 1] = i === 0 ? HIPS_Y : BONE[i - 1]!;
    quatIdentity(rest, o + 3);
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  return { parents, rest };
}

/** A LINEAR rotation channel: `node` turns about `axis` by `amplitude × sin(phase)` over `n` keys. */
function swing(
  node: number,
  axis: [number, number, number],
  amplitude: number,
  duration: number,
  phaseOffset = 0,
  n = 17,
): AnimationChannel {
  const times = new Float32Array(n);
  const values = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1);
    times[k] = u * duration;
    const angle = amplitude * Math.sin(u * Math.PI * 2 + phaseOffset);
    quatFromAxisAngle(values, k * 4, axis[0], axis[1], axis[2], angle);
  }
  return { node, path: 'rotation', interpolation: 'LINEAR', times, values };
}

/** A LINEAR translation channel on the hips: y = HIPS_Y + `lift(u)` over `n` keys. */
function bob(lift: (u: number) => number, duration: number, n = 17): AnimationChannel {
  const times = new Float32Array(n);
  const values = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1);
    times[k] = u * duration;
    values[k * 3 + 1] = HIPS_Y + lift(u);
  }
  return { node: 0, path: 'translation', interpolation: 'LINEAR', times, values };
}

const idleClip: AnimationClip = {
  name: 'idle',
  duration: 2.4,
  channels: [swing(0, [0, 0, 1], 0.08, 2.4), swing(2, [1, 0, 0], 0.06, 2.4, Math.PI / 2)],
};
const walkClip: AnimationClip = {
  name: 'walk',
  duration: 1.0,
  channels: [
    swing(0, [1, 0, 0], 0.12, 1.0),
    swing(1, [1, 0, 0], 0.35, 1.0, Math.PI),
    swing(2, [0, 0, 1], 0.2, 1.0, Math.PI / 2),
    bob((u) => 0.04 * Math.abs(Math.sin(u * Math.PI * 2)), 1.0),
  ],
};
const runClip: AnimationClip = {
  name: 'run',
  duration: 0.6,
  channels: [
    swing(0, [1, 0, 0], 0.25, 0.6),
    swing(1, [1, 0, 0], 0.7, 0.6, Math.PI),
    swing(2, [0, 0, 1], 0.4, 0.6, Math.PI / 2),
    bob((u) => 0.12 * Math.abs(Math.sin(u * Math.PI * 2)), 0.6),
  ],
};
const jumpClip: AnimationClip = {
  name: 'jump',
  duration: 0.7,
  channels: [bob((u) => 1.2 * 4 * u * (1 - u), 0.7), swing(1, [1, 0, 0], -0.3, 0.7, Math.PI / 2)],
};

const SPEED_CYCLE_S = 4;
const JUMP_EVERY_S = 3;

async function main(): Promise<void> {
  const res = await boot(root, { title: 'Engine animation graph demo' });
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

  const camera = Camera.perspective((45 * Math.PI) / 180, LOGICAL.width / LOGICAL.height, 0.1, 100);
  Object.assign(camera.screen, { x: 0, y: 0, ...LOGICAL });
  camera.lookAt([2.6, 2.4, 5.2], [0, 1.5, 0]);
  renderer.camera = camera;

  const lit = renderer.createMaterial({ label: 'lit', blend: 'opaque', wgsl: LIT_WGSL });
  const cube = renderer.createMesh({ ...cubeGeometry(), layout: VERTEX_LAYOUT_3D, label: 'cube' });

  const groundT = new Transform({ y: -0.5, scaleX: 12, scaleY: 1, scaleZ: 12 });
  const groundP: InstanceParams = { tint: [0.38, 0.42, 0.36, 1] };

  // The figure: one Transform per bone, parented like the skeleton, and one box per bone drawn
  // along its +Y (the length of the bone) as a child of it.
  const skeleton = buildSkeleton();
  const bones = [new Transform({}), new Transform({}), new Transform({})];
  bones[1]!.parent = bones[0]!;
  bones[2]!.parent = bones[1]!;
  const widths = [0.5, 0.34, 0.3] as const;
  const boxes = bones.map(
    (b, i) =>
      new Transform({
        y: BONE[i]! / 2,
        scaleX: widths[i]!,
        scaleY: BONE[i]! * 0.92,
        scaleZ: widths[i]! * 0.7,
        parent: b,
      }),
  );
  const boxP: InstanceParams[] = [
    { tint: [0.85, 0.5, 0.2, 1] },
    { tint: [0.3, 0.6, 0.9, 1] },
    { tint: [0.95, 0.85, 0.7, 1] },
  ];

  const mixer = new AnimationMixer(skeleton);
  const graph = createAnimGraph(mixer, {
    params: { speed: 0, jump: false },
    states: {
      move: {
        blend: {
          param: 'speed',
          points: [
            { at: 0, clip: idleClip },
            { at: 0.5, clip: walkClip },
            { at: 1, clip: runClip },
          ],
        },
      },
      jump: { clip: jumpClip, loop: false },
    },
    transitions: [
      { from: '*', to: 'jump', when: (p) => p.jump === true, fade: 0.1 },
      { from: 'jump', to: 'move', when: () => true, fade: 0.25, exitTime: 0.9 },
    ],
    initial: 'move',
  });
  graph.onEnter('jump', () => {
    state.jumps++;
    graph.set('jump', false);
  });
  graph.onEnter('move', () => {
    state.returns++;
  });

  const lights = new Lights();
  lights.ambient.set([0.22, 0.22, 0.25]);
  lights.sun.direction = [-0.5, -1.0, -0.6];
  lights.sun.color = [0.85, 0.82, 0.78];

  const api: HarnessAnimGraphApi = {
    state,
    setAuto(on) {
      state.auto = on;
    },
    setSpeed(speed) {
      graph.set('speed', speed);
    },
    jump() {
      graph.set('jump', true);
    },
  };
  window.__harnessAnimGraph = api;

  const moveActions = graph.actions('move');
  const publish = () => {
    state.state = graph.state;
    state.speed = graph.get('speed') as number;
    for (let i = 0; i < 3; i++) state.weights[i] = moveActions[i]!.effectiveWeight;
    state.jumpWeight = graph.weight('jump');
    state.phase = graph.phase('move');
  };

  let time = 0;
  let nextJump = JUMP_EVERY_S;
  const loop = new GameLoop({
    update(dt) {
      if (state.auto) {
        time += dt;
        graph.set('speed', 0.5 - 0.5 * Math.cos((time / SPEED_CYCLE_S) * Math.PI * 2));
        if (time >= nextJump) {
          graph.set('jump', true);
          nextJump += JUMP_EVERY_S;
        }
      }
      graph.update(dt);
      const pose = mixer.pose;
      for (let i = 0; i < 3; i++) {
        const o = i * POSE_NODE_FLOATS;
        bones[i]!.setPosition(pose[o]!, pose[o + 1]!, pose[o + 2]!)
          .setQuaternion(pose[o + 3]!, pose[o + 4]!, pose[o + 5]!, pose[o + 6]!)
          .setScale(pose[o + 7]!, pose[o + 8]!, pose[o + 9]!);
      }
      state.updates++;
      publish();
    },
    render(_alpha, t) {
      const frame = renderer.beginFrame(t.realTime, t.frameDt);
      frame.clear(0.05, 0.06, 0.1);
      frame.lights = lights;
      frame.mesh(cube, lit, groundT, groundP);
      for (let i = 0; i < 3; i++) frame.mesh(cube, lit, boxes[i]!, boxP[i]!);
      renderer.endFrame();
      state.frames++;
      state.instances = renderer.stats.instances;
      state.gpuErrors = gpuDiagnostics.errorCount;
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
