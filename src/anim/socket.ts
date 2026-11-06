/**
 * Attachment sockets: a joint plus a fixed local offset. Each frame a socket yields the world 3×4
 * of whatever rides it (a second mesh, a particle emitter, a `Transform`), so cosmetics follow an
 * animated skeleton with no code in the game beyond "attach here".
 *
 * `socketWorld = instanceWorld · world[joint] · offset`, all 3×4 row-major (`render/transform.ts`
 * layout); nothing here allocates after `createSocket`. The only tie to `render/` is the
 * `Transform` type `attachTransform` writes into, imported as a type.
 */
import type { Transform } from '../render/transform';
import {
  multiplyAffine,
  POSE_NODE_FLOATS,
  type Skeleton,
  WORLD_NODE_FLOATS,
  writeNodeMatrix,
} from './pose';

/** A joint (node index into the world array `poseToWorld` writes) and a 3×4 offset in joint space. */
export interface Socket {
  joint: number;
  /** 12 floats, 3×4 row-major: `T · R · S` of `SocketLocal`. */
  offset: Float32Array;
}

/** The offset of a socket in joint space; every part defaults to the identity. */
export interface SocketLocal {
  /** `[x, y, z]` along the joint's axes. */
  position?: ArrayLike<number>;
  /** Unit quaternion `[x, y, z, w]`. */
  rotation?: ArrayLike<number>;
  /** `[x, y, z]`, or one number for all three. */
  scale?: ArrayLike<number> | number;
}

/**
 * Build a socket on `joint` (a node index, or a name resolved through `Skeleton.names`) with the
 * local offset `local`. Throws when the index is out of range, when a name is given without
 * `names`, or when no node carries that name. Allocates (setup).
 */
export function createSocket(
  skeleton: Skeleton,
  joint: number | string,
  local?: SocketLocal,
): Socket {
  const n = skeleton.parents.length;
  let index: number;
  if (typeof joint === 'string') {
    const names = skeleton.names;
    if (!names)
      throw new Error(`createSocket: joint '${joint}' by name, but the skeleton has no names`);
    index = names.indexOf(joint);
    if (index < 0) throw new Error(`createSocket: no node named '${joint}'`);
  } else {
    index = joint;
  }
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new Error(`createSocket: joint ${index} is not a node (${n} nodes)`);
  }
  const node = new Float32Array(POSE_NODE_FLOATS);
  node[6] = 1;
  node[7] = node[8] = node[9] = 1;
  if (local) {
    const p = local.position;
    if (p) {
      node[0] = p[0]!;
      node[1] = p[1]!;
      node[2] = p[2]!;
    }
    const r = local.rotation;
    if (r) {
      const len = Math.hypot(r[0]!, r[1]!, r[2]!, r[3]!) || 1;
      node[3] = r[0]! / len;
      node[4] = r[1]! / len;
      node[5] = r[2]! / len;
      node[6] = r[3]! / len;
    }
    const s = local.scale;
    if (typeof s === 'number') {
      node[7] = node[8] = node[9] = s;
    } else if (s) {
      node[7] = s[0]!;
      node[8] = s[1]!;
      node[9] = s[2]!;
    }
  }
  const offset = new Float32Array(WORLD_NODE_FLOATS);
  writeNodeMatrix(offset, 0, node, 0);
  return { joint: index, offset };
}

const scratch = new Float32Array(WORLD_NODE_FLOATS);

/**
 * `out = instanceWorld · worldPose[joint] · offset`: the socket's world 3×4 for the node world
 * matrices `worldPose` (`poseToWorld` output) and the skeleton instance's own world matrix
 * (`null` when the pose is already in world space, or the attached transform has the instance as
 * its parent). Writes 12 floats at `out[0..12)` and returns `out`; `out` may not alias
 * `worldPose`. No allocation.
 */
export function socketWorld(
  socket: Socket,
  worldPose: Float32Array,
  instanceWorld: Float32Array | null,
  out: Float32Array,
): Float32Array {
  const jo = socket.joint * WORLD_NODE_FLOATS;
  if (instanceWorld) {
    multiplyAffine(scratch, 0, worldPose, jo, socket.offset, 0);
    multiplyAffine(out, 0, instanceWorld, 0, scratch, 0);
  } else {
    multiplyAffine(out, 0, worldPose, jo, socket.offset, 0);
  }
  return out;
}

const attached = new Float32Array(WORLD_NODE_FLOATS);

/**
 * Write `socketWorld(...)` into `transform` (`Transform.setMatrix`), so the attached mesh draws
 * through `frame.mesh(mesh, material, transform)` like any other. The transform should have no
 * parent, or the skeleton instance's transform as its parent with `instanceWorld` `null`. No
 * allocation.
 */
export function attachTransform(
  socket: Socket,
  worldPose: Float32Array,
  instanceWorld: Float32Array | null,
  transform: Transform,
): void {
  transform.setMatrix(socketWorld(socket, worldPose, instanceWorld, attached));
}
