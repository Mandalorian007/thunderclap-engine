/**
 * Rigs: what an actor is drawn and posed with. `defineRig` turns a part model (each top-level
 * part one bone, a `'rigid'` rig) or a skinned mesh with its skeleton (`'linear'`, as a glTF
 * skin loads) into the same shape: a node hierarchy with a rest pose, joints with inverse
 * binds, meshes per LOD in the actor vertex format, and clips baked to frames.
 *
 * A rigid rig is linear skinning with one joint at full weight per vertex, so one shader and
 * one pose pass serve both kinds. Pure data: no GPU.
 */
import {
  type AnimationClip,
  createClipCursor,
  inverseBindFromRest,
  POSE_NODE_FLOATS,
  type Skeleton,
  sampleClip,
  validateSkeleton,
} from '../anim';
import { COLOR_MODE, MODEL_VERTEX_FLOATS } from '../models/builder';
import { compileModel } from '../models/compile';
import type { MaterialCodeTable, Part, PartModel, PartVec3 } from '../models/spec';
import { SKIN_JOINTS_BYTE_OFFSET, VERTEX_SKINNED_STRIDE } from '../render/mesh';

/** Bytes per actor vertex (`ACTOR_VERTEX_LAYOUT`). */
export const ACTOR_VERTEX_BYTES = 32;
/** Words of one baked TRS (`tx ty tz qx qy qz qw sx sy sz`), the anim pose layout. */
export const ACTOR_TRS_FLOATS = POSE_NODE_FLOATS;
/** Default rate clips are baked at, frames per second. */
export const ACTOR_CLIP_FPS = 30;

/** A clip an actor plays: an `anim` clip over the rig's nodes, looped or held at its end. */
export interface ActorClipDesc {
  clip: AnimationClip;
  /** Wrap at the end (default true); otherwise the last frame holds. */
  loop?: boolean;
}

/** One bone of a rigid rig: the part it moves with, its parent part and its pivot at rest. */
export interface RigidBoneDesc {
  /** The parent bone's part name; default none (a root, placed by the actor). */
  parent?: string;
  /** Model-space point the bone turns about (default the origin). */
  pivot?: PartVec3;
}

/** A rig built from a part model: every top-level part is one bone (named by `Part.name`). */
export interface RigidRigDesc {
  kind: 'rigid';
  model: PartModel;
  materials: MaterialCodeTable;
  /** Bone parents and pivots by part name; parts not named here are roots pivoting at 0. */
  bones?: Readonly<Record<string, RigidBoneDesc>>;
  /** Coarser part models for LOD 1, 2, …: their top-level parts match bones by name. */
  lods?: readonly PartModel[];
  /**
   * Clips whose channels target top-level parts by their index in `model.parts` (declaration
   * order; the rig reorders bones parent-first and remaps them).
   */
  clips?: readonly ActorClipDesc[];
  /** Bake rate (default `ACTOR_CLIP_FPS`). */
  fps?: number;
  /** Bounding-sphere radius over every pose (default the rest mesh's, with a margin). */
  radius?: number;
}

/**
 * A skinned mesh in the engine's skinned vertex layout (`VERTEX_LAYOUT_SKINNED`, 56 bytes: what
 * `interleaveSkinned` makes from a glTF primitive), with optional `uint32` indices.
 */
export interface SkinnedMeshDesc {
  vertices: ArrayBuffer;
  indices?: ArrayLike<number>;
  /** Multiply the vertex colour by the actor's tint (default false). */
  tint?: boolean;
}

/** A rig built from a skin: a skeleton (`skeletonFromSkin`, or built by hand) and its meshes. */
export interface LinearRigDesc {
  kind: 'linear';
  /** Nodes, rest pose, joints and inverse binds (from the rest pose when absent). */
  skeleton: Skeleton;
  /** LOD 0 first. Vertex joint indices index `skeleton.joints`. */
  meshes: readonly SkinnedMeshDesc[];
  /** Clips whose channels target skeleton nodes. */
  clips?: readonly ActorClipDesc[];
  fps?: number;
  radius?: number;
}

export type RigDesc = RigidRigDesc | LinearRigDesc;

/** One mesh of a rig: `ACTOR_VERTEX_BYTES` per vertex (draw word 0) and `uint32` indices. */
export interface ActorMesh {
  readonly vertices: Uint8Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly vertexCount: number;
}

/** A clip baked to frames: `frameCount × nodes` TRS of `ACTOR_TRS_FLOATS`. */
export interface BakedClip {
  readonly name: string;
  readonly frames: Float32Array<ArrayBuffer>;
  readonly frameCount: number;
  /** Frames per second of clip time. */
  readonly fps: number;
  readonly loop: boolean;
  readonly duration: number;
}

/** A compiled rig, ready for `ActorSystem.addModel`. */
export interface ActorRig {
  readonly kind: 'rigid' | 'linear';
  /** Nodes the pose covers (bones of a rigid rig). */
  readonly nodes: number;
  /** Joints vertices index (equal to `nodes` for a rigid rig). */
  readonly joints: number;
  /** Parent per node, -1 for a root (`parents[i] < i`). */
  readonly parents: Int16Array;
  /** Rest TRS per node (`ACTOR_TRS_FLOATS` each). */
  readonly rest: Float32Array<ArrayBuffer>;
  /** Node per joint. */
  readonly jointNodes: Uint16Array<ArrayBuffer>;
  /** 3×4 row-major inverse bind per joint. */
  readonly inverseBind: Float32Array<ArrayBuffer>;
  /** LOD 0 first. */
  readonly meshes: readonly ActorMesh[];
  /** Bounding sphere in rig space: centre and radius. */
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly clips: readonly BakedClip[];
  /** Node names (part names of a rigid rig). */
  readonly names: readonly string[];
  /** A node's index by name, or -1. */
  bone(name: string): number;
  /** A clip's index by name, or -1. */
  clip(name: string): number;
}

// ------------------------------------------------------------------ vertices

/** Packs actor vertices and dedupes them into indices. */
class MeshWriter {
  private readonly bytes: number[] = [];
  private readonly indices: number[] = [];
  private readonly seen = new Map<string, number>();
  private readonly f32 = new Float32Array(3);
  private readonly u8 = new Uint8Array(this.f32.buffer);
  count = 0;
  readonly min = [Infinity, Infinity, Infinity];
  readonly max = [-Infinity, -Infinity, -Infinity];

  /** One vertex: position, normal, rgb (0..1), tint flag, four joints and four weights (0..255). */
  push(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    r: number,
    g: number,
    b: number,
    tint: boolean,
    joints: ArrayLike<number>,
    weights: ArrayLike<number>,
  ): void {
    this.f32[0] = px;
    this.f32[1] = py;
    this.f32[2] = pz;
    const v: number[] = Array.from(this.u8);
    const sn = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 127) & 0xff;
    const un = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
    v.push(sn(nx), sn(ny), sn(nz), 0, un(r), un(g), un(b), tint ? 255 : 0);
    for (let k = 0; k < 4; k++) v.push(joints[k]! & 0xff);
    for (let k = 0; k < 4; k++) v.push(weights[k]! & 0xff);
    v.push(0, 0, 0, 0);
    const key = v.join(',');
    let at = this.seen.get(key);
    if (at === undefined) {
      at = this.count++;
      this.seen.set(key, at);
      for (const x of v) this.bytes.push(x);
      const p = [px, py, pz];
      for (let k = 0; k < 3; k++) {
        this.min[k] = Math.min(this.min[k]!, p[k]!);
        this.max[k] = Math.max(this.max[k]!, p[k]!);
      }
    }
    this.indices.push(at);
  }

  done(): ActorMesh {
    return {
      vertices: Uint8Array.from(this.bytes),
      indices: Uint32Array.from(this.indices),
      vertexCount: this.count,
    };
  }
}

/** Farthest vertex of `meshes` from `c`. */
function reach(meshes: readonly ActorMesh[], c: readonly number[]): number {
  let r = 0;
  for (const m of meshes) {
    const f = new Float32Array(m.vertices.buffer);
    for (let i = 0; i < m.vertexCount; i++) {
      const o = (i * ACTOR_VERTEX_BYTES) / 4;
      r = Math.max(r, Math.hypot(f[o]! - c[0]!, f[o + 1]! - c[1]!, f[o + 2]! - c[2]!));
    }
  }
  return r;
}

// ------------------------------------------------------------------ clips

/** Bake `desc` over `nodes` nodes from `rest` at `fps`. */
export function bakeClip(
  desc: ActorClipDesc,
  nodes: number,
  rest: Float32Array,
  fps: number,
): BakedClip {
  const loop = desc.loop ?? true;
  const duration = Math.max(0, desc.clip.duration);
  const steps = Math.max(1, Math.round(duration * fps));
  const frameCount = loop ? steps : steps + 1;
  const rate = duration > 0 ? steps / duration : fps;
  const frames = new Float32Array(frameCount * nodes * ACTOR_TRS_FLOATS);
  const pose = new Float32Array(nodes * ACTOR_TRS_FLOATS);
  const cursor = createClipCursor(desc.clip);
  for (let k = 0; k < frameCount; k++) {
    pose.set(rest);
    sampleClip(desc.clip, k / rate, pose, 1, 'override', cursor);
    frames.set(pose, k * nodes * ACTOR_TRS_FLOATS);
  }
  return { name: desc.clip.name, frames, frameCount, fps: rate, loop, duration };
}

// ------------------------------------------------------------------ rigs

function rigOf(
  kind: 'rigid' | 'linear',
  parents: Int16Array,
  rest: Float32Array<ArrayBuffer>,
  jointNodes: Uint16Array<ArrayBuffer>,
  inverseBind: Float32Array<ArrayBuffer>,
  meshes: ActorMesh[],
  bounds: { min: number[]; max: number[] },
  names: string[],
  clips: readonly ActorClipDesc[],
  fps: number,
  radius: number | undefined,
): ActorRig {
  if (meshes.length === 0) throw new Error('defineRig: a rig needs at least one mesh');
  const center: [number, number, number] = [0, 1, 2].map((k) =>
    Number.isFinite(bounds.min[k]!) ? (bounds.min[k]! + bounds.max[k]!) / 2 : 0,
  ) as [number, number, number];
  const nodes = parents.length;
  const baked = clips.map((c) => bakeClip(c, nodes, rest, fps));
  // Clips swing parts out of their rest reach: a margin unless the caller knows better.
  const r = radius ?? reach(meshes, center) * 1.35 + 0.05;
  return {
    kind,
    nodes,
    joints: jointNodes.length,
    parents,
    rest,
    jointNodes,
    inverseBind,
    meshes,
    center,
    radius: r,
    clips: baked,
    names,
    bone: (name) => names.indexOf(name),
    clip: (name) => baked.findIndex((c) => c.name === name),
  };
}

function defineRigid(desc: RigidRigDesc): ActorRig {
  const parts = desc.model.parts;
  const names = parts.map((p, i) => p.name ?? String(i));
  if (new Set(names).size !== names.length) {
    throw new Error(`defineRig ${desc.model.name}: two top-level parts share a name`);
  }
  const bones = desc.bones ?? {};
  for (const n of Object.keys(bones)) {
    if (!names.includes(n)) throw new Error(`defineRig ${desc.model.name}: no part '${n}'`);
  }
  // Bones in parent-before-child order.
  const order: number[] = [];
  const placed = new Set<number>();
  const visit = (i: number, depth: number): void => {
    if (placed.has(i)) return;
    if (depth > names.length) throw new Error(`defineRig ${desc.model.name}: a parent cycle`);
    const parent = bones[names[i]!]?.parent;
    if (parent !== undefined) {
      const p = names.indexOf(parent);
      if (p < 0) throw new Error(`defineRig ${desc.model.name}: no parent part '${parent}'`);
      visit(p, depth + 1);
    }
    placed.add(i);
    order.push(i);
  };
  for (let i = 0; i < names.length; i++) visit(i, 0);
  const n = order.length;
  const boneOfPart = new Map<number, number>();
  for (let b = 0; b < n; b++) boneOfPart.set(order[b]!, b);
  const boneNames = order.map((i) => names[i]!);
  const parents = new Int16Array(n);
  const rest = new Float32Array(n * ACTOR_TRS_FLOATS);
  const pivots = order.map((i) => bones[names[i]!]?.pivot ?? ([0, 0, 0] as const));
  for (let b = 0; b < n; b++) {
    const parent = bones[boneNames[b]!]?.parent;
    const p = parent === undefined ? -1 : boneOfPart.get(names.indexOf(parent))!;
    parents[b] = p;
    const pv = pivots[b]!;
    const pp = p < 0 ? [0, 0, 0] : pivots[p]!;
    const o = b * ACTOR_TRS_FLOATS;
    rest[o] = pv[0] - pp[0]!;
    rest[o + 1] = pv[1] - pp[1]!;
    rest[o + 2] = pv[2] - pp[2]!;
    rest[o + 6] = 1;
    rest[o + 7] = rest[o + 8] = rest[o + 9] = 1;
  }
  const skeleton: Skeleton = { parents, rest };
  const inverseBind = new Float32Array(inverseBindFromRest(skeleton));
  const jointNodes = Uint16Array.from({ length: n }, (_, i) => i);

  const lodModels = [desc.model, ...(desc.lods ?? [])];
  const meshes: ActorMesh[] = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const joints = [0, 0, 0, 0];
  const weights = [255, 0, 0, 0];
  const table = desc.materials;
  const codes = Object.keys(table);
  for (let l = 0; l < lodModels.length; l++) {
    const model = lodModels[l]!;
    const w = new MeshWriter();
    model.parts.forEach((part, i) => {
      const name = part.name ?? String(i);
      const b = boneNames.indexOf(name);
      if (b < 0) throw new Error(`defineRig ${model.name}: part '${name}' matches no bone`);
      const { motion: _motion, glow: _glow, ...still } = part as Part;
      const units = compileModel({ name: model.name, parts: [still] }, table);
      const v = units.verts;
      joints[0] = b;
      for (let o = 0; o < v.length; o += MODEL_VERTEX_FLOATS) {
        const mode = v[o + 11]!;
        const shade = v[o + 7]!;
        let r = 1;
        let g = 1;
        let bl = 1;
        if (mode === COLOR_MODE.RGB) {
          r = v[o + 8]!;
          g = v[o + 9]!;
          bl = v[o + 10]!;
        } else if (mode === COLOR_MODE.MATERIAL) {
          const m = table[codes[v[o + 3]!]!]!;
          r = m.color[0];
          g = m.color[1];
          bl = m.color[2];
        }
        w.push(
          v[o]!,
          v[o + 1]!,
          v[o + 2]!,
          v[o + 4]!,
          v[o + 5]!,
          v[o + 6]!,
          r * shade,
          g * shade,
          bl * shade,
          mode === COLOR_MODE.INSTANCE || mode === COLOR_MODE.INSTANCE2,
          joints,
          weights,
        );
      }
    });
    meshes.push(w.done());
    if (l === 0) {
      bounds.min = w.min;
      bounds.max = w.max;
    }
  }
  return rigOf(
    'rigid',
    parents,
    rest,
    jointNodes,
    inverseBind,
    meshes,
    bounds,
    boneNames,
    (desc.clips ?? []).map((c) => ({
      ...c,
      clip: {
        ...c.clip,
        channels: c.clip.channels.map((ch) => {
          const b = boneOfPart.get(ch.node);
          if (b === undefined) {
            throw new Error(
              `defineRig ${desc.model.name}: clip '${c.clip.name}' targets part ${ch.node}`,
            );
          }
          return { ...ch, node: b };
        }),
      },
    })),
    desc.fps ?? ACTOR_CLIP_FPS,
    desc.radius,
  );
}

function defineLinear(desc: LinearRigDesc): ActorRig {
  const sk = desc.skeleton;
  validateSkeleton(sk);
  const nodes = sk.parents.length;
  const jointNodes = sk.joints
    ? Uint16Array.from(sk.joints)
    : Uint16Array.from({ length: nodes }, (_, i) => i);
  const joints = jointNodes.length;
  if (joints > 256) throw new Error(`defineRig: ${joints} joints exceed the 256 a vertex can name`);
  const ib = sk.inverseBind ?? inverseBindFromRest(sk);
  const stride = ib.length / joints;
  const inverseBind = new Float32Array(joints * 12);
  for (let j = 0; j < joints; j++) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        // 16 floats: glTF's column-major 4×4; 12: row-major 3×4 already.
        inverseBind[j * 12 + r * 4 + c] =
          stride === 16 ? ib[j * 16 + c * 4 + r]! : ib[j * 12 + r * 4 + c]!;
      }
    }
  }
  const meshes: ActorMesh[] = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const jv = [0, 0, 0, 0];
  const wv = [0, 0, 0, 0];
  for (let l = 0; l < desc.meshes.length; l++) {
    const m = desc.meshes[l]!;
    const count = m.vertices.byteLength / VERTEX_SKINNED_STRIDE;
    if (!Number.isInteger(count)) throw new Error('defineRig: vertices are not 56-byte skinned');
    const f = new Float32Array(m.vertices);
    const u8 = new Uint8Array(m.vertices);
    const fs = VERTEX_SKINNED_STRIDE / 4;
    const w = new MeshWriter();
    const emit = (i: number): void => {
      const o = i * fs;
      const b = i * VERTEX_SKINNED_STRIDE + SKIN_JOINTS_BYTE_OFFSET;
      for (let k = 0; k < 4; k++) {
        jv[k] = u8[b + k]!;
        wv[k] = u8[b + 4 + k]!;
        if (wv[k]! > 0 && jv[k]! >= joints) {
          throw new Error(`defineRig: a vertex names joint ${jv[k]} of ${joints}`);
        }
      }
      w.push(
        f[o]!,
        f[o + 1]!,
        f[o + 2]!,
        f[o + 3]!,
        f[o + 4]!,
        f[o + 5]!,
        f[o + 8]!,
        f[o + 9]!,
        f[o + 10]!,
        !!m.tint,
        jv,
        wv,
      );
    };
    if (m.indices) for (let i = 0; i < m.indices.length; i++) emit(m.indices[i]!);
    else for (let i = 0; i < count; i++) emit(i);
    meshes.push(w.done());
    if (l === 0) {
      bounds.min = w.min;
      bounds.max = w.max;
    }
  }
  const names = sk.names ? [...sk.names] : Array.from({ length: nodes }, (_, i) => `node${i}`);
  return rigOf(
    'linear',
    Int16Array.from(sk.parents),
    new Float32Array(sk.rest),
    jointNodes,
    inverseBind,
    meshes,
    bounds,
    names,
    desc.clips ?? [],
    desc.fps ?? ACTOR_CLIP_FPS,
    desc.radius,
  );
}

/**
 * Compile a rig: a part model (`kind: 'rigid'`, each top-level part one bone) or a skinned mesh
 * and skeleton (`kind: 'linear'`). Bakes the clips. Allocates; call at load. Throws on unknown
 * part names, parent cycles and joints out of range.
 */
export function defineRig(desc: RigDesc): ActorRig {
  return desc.kind === 'rigid' ? defineRigid(desc) : defineLinear(desc);
}
