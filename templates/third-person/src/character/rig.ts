/**
 * The character, generated: a 14-joint biped as a skinned glTF 2.0 binary (`.glb`) with five
 * clips, built in memory at startup so the template commits no binary asset. Pure: no engine, no
 * DOM, no randomness. `parseGltf` reads what `buildCharacterGlb()` returns like any file from a
 * DCC tool, so swapping this for a real asset is one `fetch`.
 *
 * Joints hang in a relaxed A-pose with every rotation the identity, so a joint's local axes are
 * the world axes at rest: X right, Y up, the character faces -Z. Every limb is a box from its
 * joint to its child; the ring at the child end is blended between the two joints so elbows and
 * knees bend smoothly.
 */

/** Joint (node) indices, parents first. The mesh node follows them as `MESH_NODE`. */
export const J = {
  hips: 0,
  head: 1,
  upperArmL: 2,
  foreArmL: 3,
  handL: 4,
  upperArmR: 5,
  foreArmR: 6,
  handR: 7,
  thighL: 8,
  shinL: 9,
  footL: 10,
  thighR: 11,
  shinR: 12,
  footR: 13,
} as const;
export const JOINT_COUNT = 14;
export const MESH_NODE = JOINT_COUNT;
export const JOINT_NAMES: readonly string[] = [
  'hips',
  'head',
  'upperArm.L',
  'foreArm.L',
  'hand.L',
  'upperArm.R',
  'foreArm.R',
  'hand.R',
  'thigh.L',
  'shin.L',
  'foot.L',
  'thigh.R',
  'shin.R',
  'foot.R',
];

/** Rest heights and bone lengths (metres). The feet's soles sit at y 0. */
export const HIPS_Y = 0.92;
export const THIGH = 0.42;
export const SHIN = 0.42;
export const ANKLE_Y = HIPS_Y - THIGH - SHIN;
export const UPPER_ARM = 0.28;
export const FORE_ARM = 0.26;
export const SHOULDER = [0.24, 0.42] as const;
export const HIP_X = 0.12;
export const HEAD_Y = 0.55;
/** Height of the whole figure, for bounds and name plates. */
export const HEIGHT = HIPS_Y + HEAD_Y + 0.28;

export const CLIP_NAMES = ['idle', 'walk', 'run', 'attack', 'hit'] as const;
export type ClipName = (typeof CLIP_NAMES)[number];
export const CLIP_DURATIONS: Record<ClipName, number> = {
  idle: 2.4,
  walk: 1.0,
  run: 0.6,
  attack: 0.7,
  hit: 0.45,
};
/** How far the attack clip carries the hips forward (-Z), the root motion the game extracts. */
export const ATTACK_LUNGE = 1.1;

/** `[parent, tx, ty, tz]` per joint, in `J` order. */
const JOINTS: readonly (readonly [number, number, number, number])[] = [
  [-1, 0, HIPS_Y, 0],
  [J.hips, 0, HEAD_Y, 0],
  [J.hips, -SHOULDER[0], SHOULDER[1], 0],
  [J.upperArmL, 0, -UPPER_ARM, 0],
  [J.foreArmL, 0, -FORE_ARM, 0],
  [J.hips, SHOULDER[0], SHOULDER[1], 0],
  [J.upperArmR, 0, -UPPER_ARM, 0],
  [J.foreArmR, 0, -FORE_ARM, 0],
  [J.hips, -HIP_X, 0, 0],
  [J.thighL, 0, -THIGH, 0],
  [J.shinL, 0, -SHIN, 0],
  [J.hips, HIP_X, 0, 0],
  [J.thighR, 0, -THIGH, 0],
  [J.shinR, 0, -SHIN, 0],
];

/** World (rest) position of every joint: parents are earlier in the table. */
export function restPositions(): Float32Array {
  const out = new Float32Array(JOINT_COUNT * 3);
  for (let j = 0; j < JOINT_COUNT; j++) {
    const [p, x, y, z] = JOINTS[j]!;
    const px = p < 0 ? 0 : out[p * 3]!;
    const py = p < 0 ? 0 : out[p * 3 + 1]!;
    const pz = p < 0 ? 0 : out[p * 3 + 2]!;
    out[j * 3] = px + x;
    out[j * 3 + 1] = py + y;
    out[j * 3 + 2] = pz + z;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────── the mesh

type Rgb = readonly [number, number, number];
const SKIN: Rgb = [0.86, 0.66, 0.52];
const TUNIC: Rgb = [0.62, 0.2, 0.16];
const TROUSERS: Rgb = [0.22, 0.24, 0.32];
const BOOT: Rgb = [0.18, 0.12, 0.08];
const BELT: Rgb = [0.3, 0.2, 0.1];

interface MeshBuffers {
  position: number[];
  normal: number[];
  uv: number[];
  color: number[];
  joints: number[];
  weights: number[];
  indices: number[];
}

/** The six faces of a box: normal, right and up axes, in the engine's winding. */
const FACES: readonly (readonly [Rgb, Rgb, Rgb])[] = [
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

/**
 * A box from `min` to `max` in rest space, coloured `color`. `skin(y)` gives the joint and
 * weight pairs for a vertex at height `y` (so the two ends of a limb can differ); at most two
 * joints are used, the remaining slots are zero.
 */
function box(
  m: MeshBuffers,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  color: Rgb,
  skin: (y: number) => readonly [number, number, number, number],
): void {
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const h = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  for (const [n, r, u] of FACES) {
    const base = m.position.length / 3;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const p = [0, 0, 0];
      for (let k = 0; k < 3; k++) p[k] = c[k]! + (n[k]! + sx * r[k]! + sy * u[k]!) * h[k]!;
      m.position.push(p[0]!, p[1]!, p[2]!);
      m.normal.push(n[0], n[1], n[2]);
      m.uv.push((sx + 1) / 2, (1 - sy) / 2);
      m.color.push(color[0], color[1], color[2], 1);
      const [ja, wa, jb, wb] = skin(p[1]!);
      m.joints.push(ja, jb, 0, 0);
      m.weights.push(wa, wb, 0, 0);
    }
    m.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** A vertex that follows one joint. */
const only = (j: number) => (): readonly [number, number, number, number] => [j, 1, 0, 0];

/**
 * A limb hanging from `joint` (at height `top`) to its child (at `bottom`): the lower ring of
 * vertices is shared with the child so the elbow or knee bends as one surface.
 */
function limb(
  m: MeshBuffers,
  joint: number,
  child: number,
  x: number,
  z: number,
  top: number,
  bottom: number,
  half: number,
  color: Rgb,
  blend = 0.35,
): void {
  box(m, [x - half, bottom, z - half], [x + half, top, z + half], color, (y) =>
    y <= bottom + 1e-4 ? [joint, 1 - blend, child, blend] : [joint, 1, 0, 0],
  );
}

function buildMesh(): MeshBuffers {
  const m: MeshBuffers = {
    position: [],
    normal: [],
    uv: [],
    color: [],
    joints: [],
    weights: [],
    indices: [],
  };
  const P = restPositions();
  const at = (j: number) => [P[j * 3]!, P[j * 3 + 1]!, P[j * 3 + 2]!] as const;
  const hips = at(J.hips);
  const head = at(J.head);

  // Torso: hips to the shoulders, a belt at the hips.
  box(m, [-0.22, hips[1] - 0.1, -0.12], [0.22, hips[1] + 0.46, 0.12], TUNIC, only(J.hips));
  box(m, [-0.23, hips[1] - 0.14, -0.13], [0.23, hips[1] - 0.08, 0.13], BELT, only(J.hips));
  // Head: a box on the neck, a touch forward of the spine.
  box(m, [-0.12, head[1] - 0.02, -0.13], [0.12, head[1] + 0.26, 0.11], SKIN, only(J.head));
  box(m, [-0.08, head[1] - 0.06, -0.07], [0.08, head[1], 0.07], SKIN, only(J.head));

  for (const side of ['L', 'R'] as const) {
    const ua = J[`upperArm${side}`];
    const fa = J[`foreArm${side}`];
    const ha = J[`hand${side}`];
    const th = J[`thigh${side}`];
    const sh = J[`shin${side}`];
    const ft = J[`foot${side}`];
    const [ax, ay] = at(ua);
    limb(m, ua, fa, ax, 0, ay + 0.04, ay - UPPER_ARM, 0.07, TUNIC);
    limb(m, fa, ha, ax, 0, ay - UPPER_ARM, ay - UPPER_ARM - FORE_ARM, 0.055, SKIN);
    const hy = ay - UPPER_ARM - FORE_ARM;
    box(m, [ax - 0.05, hy - 0.14, -0.05], [ax + 0.05, hy, 0.05], SKIN, only(ha));
    const [tx, ty] = at(th);
    limb(m, th, sh, tx, 0, ty + 0.02, ty - THIGH, 0.09, TROUSERS);
    limb(m, sh, ft, tx, 0, ty - THIGH, ANKLE_Y, 0.07, TROUSERS);
    // The foot: from the ankle to the sole, reaching forward (-Z).
    box(m, [tx - 0.075, 0, -0.22], [tx + 0.075, ANKLE_Y + 0.02, 0.08], BOOT, only(ft));
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────── the clips

interface Channel {
  node: number;
  path: 'translation' | 'rotation';
  times: number[];
  values: number[];
}
interface Clip {
  name: ClipName;
  channels: Channel[];
}

const KEYS = 17;

function axisAngle(ax: number, ay: number, az: number, a: number): number[] {
  const s = Math.sin(a / 2);
  return [ax * s, ay * s, az * s, Math.cos(a / 2)];
}

/** A LINEAR rotation channel about `axis` by `angle(u)` over `u` in 0..1. */
function rot(
  node: number,
  axis: readonly [number, number, number],
  duration: number,
  angle: (u: number) => number,
): Channel {
  const times: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < KEYS; k++) {
    const u = k / (KEYS - 1);
    times.push(u * duration);
    values.push(...axisAngle(axis[0], axis[1], axis[2], angle(u)));
  }
  return { node, path: 'rotation', times, values };
}

/** A LINEAR translation channel on the hips: rest plus `offset(u)`. */
function move(duration: number, offset: (u: number) => readonly [number, number, number]): Channel {
  const times: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < KEYS; k++) {
    const u = k / (KEYS - 1);
    const [x, y, z] = offset(u);
    times.push(u * duration);
    values.push(x, HIPS_Y + y, z);
  }
  return { node: J.hips, path: 'translation', times, values };
}

const X: readonly [number, number, number] = [1, 0, 0];
const Y: readonly [number, number, number] = [0, 1, 0];
const Z: readonly [number, number, number] = [0, 0, 1];
const TAU = Math.PI * 2;
const sin = (u: number, phase = 0) => Math.sin(u * TAU + phase);

/** The locomotion cycle: legs antiphase, knees bend on the back swing, arms counter the legs. */
function gait(name: ClipName, duration: number, stride: number, knee: number, bob: number): Clip {
  return {
    name,
    channels: [
      move(duration, (u) => [0, bob * Math.abs(sin(u)) - bob * 0.5, 0]),
      rot(J.hips, X, duration, () => (name === 'run' ? 0.18 : 0.04)),
      rot(J.thighL, X, duration, (u) => stride * sin(u)),
      rot(J.thighR, X, duration, (u) => stride * sin(u, Math.PI)),
      rot(J.shinL, X, duration, (u) => -knee * Math.max(0, sin(u, Math.PI / 2))),
      rot(J.shinR, X, duration, (u) => -knee * Math.max(0, sin(u, Math.PI * 1.5))),
      rot(J.footL, X, duration, (u) => -0.25 * sin(u, Math.PI)),
      rot(J.footR, X, duration, (u) => -0.25 * sin(u)),
      rot(J.upperArmL, X, duration, (u) => stride * 0.8 * sin(u, Math.PI)),
      rot(J.upperArmR, X, duration, (u) => stride * 0.8 * sin(u)),
      rot(J.foreArmL, X, duration, () => (name === 'run' ? 1.2 : 0.3)),
      rot(J.foreArmR, X, duration, () => (name === 'run' ? 1.2 : 0.3)),
      rot(J.head, Y, duration, (u) => 0.03 * sin(u * 2)),
    ],
  };
}

function buildClips(): Clip[] {
  const idle: Clip = {
    name: 'idle',
    channels: [
      move(CLIP_DURATIONS.idle, (u) => [0, -0.015 + 0.015 * sin(u), 0]),
      rot(J.hips, Z, CLIP_DURATIONS.idle, (u) => 0.02 * sin(u)),
      rot(J.head, X, CLIP_DURATIONS.idle, (u) => 0.04 * sin(u, Math.PI / 2)),
      rot(J.upperArmL, Z, CLIP_DURATIONS.idle, (u) => 0.12 + 0.04 * sin(u)),
      rot(J.upperArmR, Z, CLIP_DURATIONS.idle, (u) => -0.12 - 0.04 * sin(u)),
      rot(J.foreArmL, X, CLIP_DURATIONS.idle, (u) => 0.2 + 0.05 * sin(u, 1)),
      rot(J.foreArmR, X, CLIP_DURATIONS.idle, (u) => 0.2 + 0.05 * sin(u, 2)),
    ],
  };
  const walk = gait('walk', CLIP_DURATIONS.walk, 0.55, 0.9, 0.035);
  const run = gait('run', CLIP_DURATIONS.run, 0.95, 1.6, 0.07);
  // Attack: wind up the right arm, lunge forward along -Z (the root motion), swing it down.
  const d = CLIP_DURATIONS.attack;
  const swing = (u: number) => (u < 0.35 ? -2.4 * (u / 0.35) : -2.4 + 3.6 * ((u - 0.35) / 0.65));
  const lunge = (u: number) => {
    const s = Math.min(1, Math.max(0, (u - 0.25) / 0.45));
    return s * s * (3 - 2 * s);
  };
  const attack: Clip = {
    name: 'attack',
    channels: [
      move(d, (u) => [
        0,
        -0.08 * Math.sin(Math.min(1, u / 0.8) * Math.PI),
        -ATTACK_LUNGE * lunge(u),
      ]),
      rot(J.hips, Y, d, (u) => -0.5 * Math.sin(u * Math.PI)),
      rot(J.hips, X, d, (u) => 0.25 * Math.sin(u * Math.PI)),
      rot(J.upperArmR, X, d, swing),
      rot(J.foreArmR, X, d, (u) => 0.9 * (1 - u)),
      rot(J.upperArmL, Z, d, (u) => 0.5 * Math.sin(u * Math.PI)),
      rot(J.thighR, X, d, (u) => 0.7 * Math.sin(u * Math.PI)),
      rot(J.thighL, X, d, (u) => -0.5 * Math.sin(u * Math.PI)),
      rot(J.shinL, X, d, (u) => -0.6 * Math.sin(u * Math.PI)),
      rot(J.head, X, d, (u) => -0.2 * Math.sin(u * Math.PI)),
    ],
  };
  const h = CLIP_DURATIONS.hit;
  const hit: Clip = {
    name: 'hit',
    channels: [
      move(h, (u) => [0, 0, 0.12 * Math.sin(u * Math.PI)]),
      rot(J.hips, X, h, (u) => -0.35 * Math.sin(u * Math.PI)),
      rot(J.head, X, h, (u) => -0.5 * Math.sin(u * Math.PI)),
      rot(J.upperArmL, X, h, (u) => -1.2 * Math.sin(u * Math.PI)),
      rot(J.upperArmR, X, h, (u) => -1.2 * Math.sin(u * Math.PI)),
      rot(J.foreArmL, X, h, (u) => 1.0 * Math.sin(u * Math.PI)),
      rot(J.foreArmR, X, h, (u) => 1.0 * Math.sin(u * Math.PI)),
    ],
  };
  return [idle, walk, run, attack, hit];
}

// ─────────────────────────────────────────────────────────────────── the GLB

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

/** A minimal GLB writer: one buffer, one view per accessor, 4-byte aligned. */
class Glb {
  readonly accessors: Accessor[] = [];
  readonly bufferViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  private readonly parts: Uint8Array[] = [];

  private view(bytes: Uint8Array): number {
    this.parts.push(bytes);
    this.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength });
    return this.bufferViews.length - 1;
  }

  floats(data: number[], type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4', minMax = false) {
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const f = new Float32Array(data);
    const acc: Accessor = {
      bufferView: this.view(new Uint8Array(f.buffer)),
      componentType: 5126,
      count: data.length / n,
      type,
    };
    if (minMax) {
      acc.min = Array.from({ length: n }, () => Number.POSITIVE_INFINITY);
      acc.max = Array.from({ length: n }, () => Number.NEGATIVE_INFINITY);
      for (let i = 0; i < acc.count; i++) {
        for (let k = 0; k < n; k++) {
          acc.min[k] = Math.min(acc.min[k]!, data[i * n + k]!);
          acc.max[k] = Math.max(acc.max[k]!, data[i * n + k]!);
        }
      }
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  ubytes4(data: number[]): number {
    const u = new Uint8Array(data);
    this.accessors.push({
      bufferView: this.view(u),
      componentType: 5121,
      count: data.length / 4,
      type: 'VEC4',
    });
    return this.accessors.length - 1;
  }

  indices16(data: number[]): number {
    const u = new Uint16Array(data);
    this.accessors.push({
      bufferView: this.view(new Uint8Array(u.buffer)),
      componentType: 5123,
      count: data.length,
      type: 'SCALAR',
    });
    return this.accessors.length - 1;
  }

  finish(json: Record<string, unknown>): ArrayBuffer {
    const offsets: number[] = [];
    let binLength = 0;
    for (const p of this.parts) {
      offsets.push(binLength);
      binLength += Math.ceil(p.byteLength / 4) * 4;
    }
    this.bufferViews.forEach((bv, i) => {
      bv.byteOffset = offsets[i]!;
    });
    const bin = new Uint8Array(binLength);
    this.parts.forEach((p, i) => {
      bin.set(p, offsets[i]!);
    });
    const doc = {
      asset: { version: '2.0', generator: 'thunderclap-template-third-person' },
      ...json,
      accessors: this.accessors,
      bufferViews: this.bufferViews,
      buffers: [{ byteLength: binLength }],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(doc));
    const jsonLength = Math.ceil(jsonBytes.byteLength / 4) * 4;
    const total = 12 + 8 + jsonLength + 8 + binLength;
    const out = new ArrayBuffer(total);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    u8.set(jsonBytes, 20);
    u8.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
    const binAt = 20 + jsonLength;
    dv.setUint32(binAt, binLength, true);
    dv.setUint32(binAt + 4, 0x004e4942, true);
    u8.set(bin, binAt + 8);
    return out;
  }
}

/** The character as a `.glb`: 14 joint nodes, one skinned mesh node, one skin, five clips. */
export function buildCharacterGlb(): ArrayBuffer {
  const g = new Glb();
  const m = buildMesh();
  const P = restPositions();

  const inverseBind: number[] = [];
  for (let j = 0; j < JOINT_COUNT; j++) {
    // Column-major 4×4: the inverse of a pure translation to the joint's rest position.
    inverseBind.push(
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      -P[j * 3]!,
      -P[j * 3 + 1]!,
      -P[j * 3 + 2]!,
      1,
    );
  }

  const nodes: Record<string, unknown>[] = JOINTS.map(([, x, y, z], j) => ({
    name: JOINT_NAMES[j],
    translation: [x, y, z],
    children: JOINTS.flatMap(([p], c) => (p === j ? [c] : [])),
  }));
  for (const n of nodes) if ((n.children as number[]).length === 0) delete n.children;
  nodes.push({ name: 'body', mesh: 0, skin: 0 });

  const animations = buildClips().map((clip) => {
    const samplers: Record<string, unknown>[] = [];
    const channels: Record<string, unknown>[] = [];
    for (const ch of clip.channels) {
      samplers.push({
        input: g.floats(ch.times, 'SCALAR', true),
        output: g.floats(ch.values, ch.path === 'rotation' ? 'VEC4' : 'VEC3'),
        interpolation: 'LINEAR',
      });
      channels.push({ sampler: samplers.length - 1, target: { node: ch.node, path: ch.path } });
    }
    return { name: clip.name, samplers, channels };
  });

  return g.finish({
    scene: 0,
    scenes: [{ nodes: [J.hips, MESH_NODE] }],
    nodes,
    meshes: [
      {
        name: 'body',
        primitives: [
          {
            attributes: {
              POSITION: g.floats(m.position, 'VEC3', true),
              NORMAL: g.floats(m.normal, 'VEC3'),
              TEXCOORD_0: g.floats(m.uv, 'VEC2'),
              COLOR_0: g.floats(m.color, 'VEC4'),
              JOINTS_0: g.ubytes4(m.joints),
              WEIGHTS_0: g.floats(m.weights, 'VEC4'),
            },
            indices: g.indices16(m.indices),
            material: 0,
          },
        ],
      },
    ],
    materials: [
      { name: 'body', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.7 } },
    ],
    skins: [
      {
        name: 'biped',
        skeleton: J.hips,
        joints: Array.from({ length: JOINT_COUNT }, (_, j) => j),
        inverseBindMatrices: g.floats(inverseBind, 'MAT4'),
      },
    ],
    animations,
  });
}
