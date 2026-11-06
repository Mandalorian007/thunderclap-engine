import { describe, expect, it } from 'vitest';
import { Transform } from '../render/transform';
import {
  createPose,
  POSE_NODE_FLOATS,
  type Pose,
  poseToWorld,
  type Skeleton,
  validateSkeleton,
  WORLD_NODE_FLOATS,
} from './pose';
import { quatFromAxisAngle } from './quat';
import { attachTransform, createSocket, socketWorld } from './socket';

/** Apply a 3×4 row-major matrix at offset `o` to a point. */
function apply(m: ArrayLike<number>, o: number, x: number, y: number, z: number): number[] {
  return [0, 1, 2].map(
    (r) => m[o + r * 4]! * x + m[o + r * 4 + 1]! * y + m[o + r * 4 + 2]! * z + m[o + r * 4 + 3]!,
  );
}
const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i]!, digits);
};

/** Root at origin, child one unit up, grandchild another unit up; identity rotations; named. */
function chain(): Skeleton {
  const rest = new Float32Array(3 * POSE_NODE_FLOATS);
  for (let i = 0; i < 3; i++) {
    const o = i * POSE_NODE_FLOATS;
    rest[o + 1] = i === 0 ? 0 : 1;
    rest[o + 6] = 1;
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  return { parents: new Int16Array([-1, 0, 1]), rest, names: ['root', 'elbow', 'wrist'] };
}
function setRotation(pose: Pose, node: number, ax: number, ay: number, az: number, a: number) {
  quatFromAxisAngle(pose, node * POSE_NODE_FLOATS + 3, ax, ay, az, a);
}
function world(sk: Skeleton, pose: Pose): Float32Array {
  const out = new Float32Array(sk.parents.length * WORLD_NODE_FLOATS);
  poseToWorld(sk, pose, out);
  return out;
}

describe('createSocket', () => {
  it('identity offset equals the joint world', () => {
    const sk = chain();
    const socket = createSocket(sk, 2);
    expect(socket.joint).toBe(2);
    close(socket.offset, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    const w = world(sk, createPose(sk));
    const out = socketWorld(socket, w, null, new Float32Array(12));
    close(out, w.subarray(24, 36));
    close(apply(out, 0, 0, 0, 0), [0, 2, 0]);
  });

  it('builds T · R · S from position, rotation and scale (scalar or per axis)', () => {
    const sk = chain();
    const q = new Float32Array(4);
    quatFromAxisAngle(q, 0, 0, 0, 1, Math.PI / 2);
    const s = createSocket(sk, 0, { position: [1, 2, 3], rotation: q, scale: 2 });
    // Rotate (1, 0, 0) by 90° about Z → (0, 1, 0), scale 2, then translate.
    close(apply(s.offset, 0, 1, 0, 0), [1, 4, 3]);
    const axes = createSocket(sk, 0, { scale: [1, 2, 3] });
    close(apply(axes.offset, 0, 1, 1, 1), [1, 2, 3]);
    // Rotation is normalised.
    const un = createSocket(sk, 0, { rotation: [0, 0, 2 * q[2]!, 2 * q[3]!] });
    close(
      un.offset,
      s.offset.map((v, i) => (i % 4 === 3 ? 0 : v / 2)),
    );
  });

  it('resolves a string joint through names and reports its errors', () => {
    const sk = chain();
    expect(createSocket(sk, 'wrist').joint).toBe(2);
    expect(createSocket(sk, 'root').joint).toBe(0);
    expect(() => createSocket(sk, 'hand')).toThrow(/no node named 'hand'/);
    const unnamed: Skeleton = { parents: sk.parents, rest: sk.rest };
    expect(() => createSocket(unnamed, 'wrist')).toThrow(/no names/);
    expect(() => createSocket(sk, 3)).toThrow(/not a node/);
    expect(() => createSocket(sk, -1)).toThrow(/not a node/);
    expect(() => createSocket(sk, 1.5)).toThrow(/not a node/);
  });

  it('validateSkeleton checks names length when present', () => {
    const sk = chain();
    expect(() => validateSkeleton(sk)).not.toThrow();
    sk.names = ['root'];
    expect(() => validateSkeleton(sk)).toThrow(/names has 1 entries, expected 3/);
    delete sk.names;
    expect(() => validateSkeleton(sk)).not.toThrow();
  });
});

describe('socketWorld', () => {
  it('applies the offset in joint space: rotating the joint rotates the offset', () => {
    const sk = chain();
    const socket = createSocket(sk, 2, { position: [1, 0, 0] });
    const pose = createPose(sk);
    // Rest: wrist at (0, 2, 0), socket one unit along the wrist's +x.
    let out = socketWorld(socket, world(sk, pose), null, new Float32Array(12));
    close(apply(out, 0, 0, 0, 0), [1, 2, 0]);
    // Rotate the wrist 90° about Z: its +x becomes world +y.
    setRotation(pose, 2, 0, 0, 1, Math.PI / 2);
    out = socketWorld(socket, world(sk, pose), null, out);
    close(apply(out, 0, 0, 0, 0), [0, 3, 0]);
    // Rotate the root instead: the whole arm folds onto -x, and the wrist's local +x points +y.
    setRotation(pose, 2, 0, 0, 1, 0);
    setRotation(pose, 0, 0, 0, 1, Math.PI / 2);
    out = socketWorld(socket, world(sk, pose), null, out);
    close(apply(out, 0, 0, 0, 0), [-2, 1, 0]);
    // The socket's own axes rotated too.
    close(apply(out, 0, 0, 1, 0), [-3, 1, 0]);
  });

  it('composes the instance world last', () => {
    const sk = chain();
    const socket = createSocket(sk, 2, { position: [1, 0, 0] });
    const w = world(sk, createPose(sk));
    const instance = new Transform({ x: 10, y: 0, z: 5 }).setAxisAngle(0, 0, 1, Math.PI / 2);
    const out = socketWorld(socket, w, instance.world, new Float32Array(12));
    // Socket at (1, 2, 0) in rig space → rotated 90° about Z → (-2, 1, 0) → translated.
    close(apply(out, 0, 0, 0, 0), [8, 1, 5]);
    // null instance: rig space unchanged.
    close(apply(socketWorld(socket, w, null, out), 0, 0, 0, 0), [1, 2, 0]);
  });

  it('returns out and allocates nothing per call', () => {
    const sk = chain();
    const socket = createSocket(sk, 'wrist', { position: [0, 0.5, 0], scale: 0.5 });
    const w = world(sk, createPose(sk));
    const instance = new Transform({ x: 1 }).world;
    const out = new Float32Array(12);
    expect(socketWorld(socket, w, instance, out)).toBe(out);
    const snapshot = Array.from(out);
    // Count typed-array constructions during the calls: the module scratch is pre-allocated.
    const Real = globalThis.Float32Array;
    let constructed = 0;
    const Counting = new Proxy(Real, {
      construct(target, args, newTarget) {
        constructed++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    const t = new Transform();
    globalThis.Float32Array = Counting as typeof Float32Array;
    try {
      for (let i = 0; i < 1000; i++) {
        socketWorld(socket, w, instance, out);
        socketWorld(socket, w, null, out);
        attachTransform(socket, w, instance, t);
      }
    } finally {
      globalThis.Float32Array = Real;
    }
    expect(constructed).toBe(0);
    socketWorld(socket, w, instance, out);
    close(out, snapshot);
  });
});

describe('attachTransform', () => {
  it('round-trips through Transform reads and world', () => {
    const sk = chain();
    const q = new Float32Array(4);
    quatFromAxisAngle(q, 0, 1, 0, 0, 0.7);
    const socket = createSocket(sk, 'wrist', { position: [0.3, 0, 0], rotation: q, scale: 0.5 });
    const pose = createPose(sk);
    setRotation(pose, 1, 0, 0, 1, 0.4);
    const w = world(sk, pose);
    const instance = new Transform({ x: 2, y: -1, z: 3 }).setAxisAngle(0, 1, 0, 1.1);
    const expected = socketWorld(socket, w, instance.world, new Float32Array(12));

    const t = new Transform();
    attachTransform(socket, w, instance.world, t);
    close(t.world, expected);
    close(t.localMatrix, expected);
    // Decomposed reads agree with the matrix.
    close([t.position.x, t.position.y, t.position.z], [expected[3]!, expected[7]!, expected[11]!]);
    close([t.scale.x, t.scale.y, t.scale.z], [0.5, 0.5, 0.5]);
    const { x, y, z, w: qw } = t.quaternion;
    expect(Math.hypot(x, y, z, qw)).toBeCloseTo(1, 6);
    // Re-setting position rebuilds T · R · S from the decomposition: same rotation and scale.
    t.setPosition(0, 0, 0);
    const rebuilt = t.world;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) expect(rebuilt[r * 4 + c]).toBeCloseTo(expected[r * 4 + c]!, 5);
      expect(rebuilt[r * 4 + 3]).toBeCloseTo(0, 6);
    }
  });

  it('with the instance as the parent and a null instance world, world matches', () => {
    const sk = chain();
    const socket = createSocket(sk, 2, { position: [1, 0, 0] });
    const w = world(sk, createPose(sk));
    const rig = new Transform({ x: 10, y: 0, z: 5 }).setAxisAngle(0, 0, 1, Math.PI / 2);
    const t = new Transform({ parent: rig });
    attachTransform(socket, w, null, t);
    close(apply(t.world, 0, 0, 0, 0), [8, 1, 5]);
  });
});

describe('Transform.setMatrix', () => {
  it('decomposes a mirrored matrix with a negative z scale', () => {
    const t = new Transform();
    t.setMatrix([2, 0, 0, 1, 0, 3, 0, 2, 0, 0, -4, 3]);
    close([t.position.x, t.position.y, t.position.z], [1, 2, 3]);
    close([t.scale.x, t.scale.y, t.scale.z], [2, 3, -4]);
    close(t.world, [2, 0, 0, 1, 0, 3, 0, 2, 0, 0, -4, 3]);
    expect(t.rotation).toBeCloseTo(0, 6);
  });

  it('reads at an offset and marks a parent chain dirty', () => {
    const parent = new Transform({ x: 1 });
    const child = new Transform({ parent });
    child.world; // cache
    const m = new Float32Array(24);
    m.set([1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7], 12);
    child.setMatrix(m, 12);
    close(apply(child.world, 0, 0, 0, 0), [6, 6, 7]);
  });
});
