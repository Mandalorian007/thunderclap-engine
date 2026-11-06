import { describe, expect, it } from 'vitest';
import { parseGltf } from '../assets/gltf';
import { type AnimationChannel, type AnimationClip, sampleChannel, sampleClip } from './clip';
import { clipBytes, compressClip, packQuat, quantizeClip } from './compress';
import { POSE_NODE_FLOATS, type Skeleton } from './pose';
import { quatFromAxisAngle } from './quat';

function skeleton(nodes: number): Skeleton {
  const rest = new Float32Array(nodes * POSE_NODE_FLOATS);
  for (let i = 0; i < nodes; i++) {
    const o = i * POSE_NODE_FLOATS;
    rest[o + 6] = 1;
    rest[o + 7] = 1;
    rest[o + 8] = 1;
    rest[o + 9] = 1;
  }
  const parents = new Int16Array(nodes);
  for (let i = 0; i < nodes; i++) parents[i] = i - 1;
  return { parents, rest };
}

/** A dense 60 Hz clip: node 0 swings about y (sine), node 1 slides on x (smooth), node 2 holds. */
function dense(duration = 2, hz = 60): AnimationClip {
  const n = Math.round(duration * hz) + 1;
  const times = new Float32Array(n);
  const rot = new Float32Array(n * 4);
  const pos = new Float32Array(n * 3);
  const constRot = new Float32Array(n * 4);
  const restRot = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * duration;
    times[i] = t;
    quatFromAxisAngle(rot, i * 4, 0, 1, 0, Math.sin(t * 3) * 0.9);
    pos[i * 3] = Math.cos(t * 2) * 0.5;
    pos[i * 3 + 1] = 1;
    quatFromAxisAngle(constRot, i * 4, 1, 0, 0, 0.3);
    restRot[i * 4 + 3] = 1;
  }
  return {
    name: 'dense',
    duration,
    channels: [
      { node: 0, path: 'rotation', interpolation: 'LINEAR', times, values: rot },
      { node: 1, path: 'translation', interpolation: 'LINEAR', times, values: pos },
      { node: 2, path: 'rotation', interpolation: 'LINEAR', times, values: constRot },
      { node: 3, path: 'rotation', interpolation: 'LINEAR', times, values: restRot },
    ],
    events: [{ time: 0.5, name: 'step' }],
  };
}

function rand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function sampleAt(clip: AnimationClip, nodes: number, t: number): Float32Array {
  const pose = skeleton(nodes).rest.slice();
  sampleClip(clip, t, pose, 1, 'override', new Uint32Array(clip.channels.length));
  return pose;
}

/** Angle between two quaternions from the chord, precise near zero. */
function angle(a: Float32Array, ao: number, b: Float32Array, bo: number): number {
  const dot =
    a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]!;
  const s = dot < 0 ? -1 : 1;
  const chord = Math.hypot(
    a[ao]! - s * b[bo]!,
    a[ao + 1]! - s * b[bo + 1]!,
    a[ao + 2]! - s * b[bo + 2]!,
    a[ao + 3]! - s * b[bo + 3]!,
  );
  return 2 * Math.asin(Math.min(1, chord / 2));
}

describe('compressClip', () => {
  const src = dense();

  it('removes keys a linear fit reproduces and stays within tolerance at 100 random times', () => {
    const { clip, before, after } = compressClip(src, {
      positionError: 2e-3,
      rotationError: 2e-3,
      skeleton: skeleton(4),
    });
    expect(before).toBe(clipBytes(src));
    expect(after).toBe(clipBytes(clip));
    expect(after).toBeLessThan(before / 2);
    expect(clip.channels[0]!.times.length).toBeLessThan(src.channels[0]!.times.length / 2);
    expect(clip.channels[0]!.times.length).toBeGreaterThan(5);
    expect(clip.events).toEqual(src.events);
    const r = rand(7);
    for (let i = 0; i < 100; i++) {
      const t = r() * src.duration;
      const a = sampleAt(src, 4, t);
      const b = sampleAt(clip, 4, t);
      // Rotation error: angle between quaternions; position: component gap.
      expect(angle(a, 3, b, 3)).toBeLessThanOrEqual(2e-3 + 1e-6);
      const o = POSE_NODE_FLOATS;
      expect(Math.abs(a[o]! - b[o]!)).toBeLessThanOrEqual(2e-3 + 1e-6);
      expect(Math.abs(a[o + 1]! - b[o + 1]!)).toBeLessThanOrEqual(2e-3 + 1e-6);
    }
  });

  it('collapses constant channels to one key and drops those equal to the rest', () => {
    const { clip } = compressClip(src, { skeleton: skeleton(4) });
    expect(clip.channels.map((c) => c.node)).toEqual([0, 1, 2]);
    const c2 = clip.channels[2]!;
    expect(c2.times.length).toBe(1);
    expect(c2.interpolation).toBe('STEP');
    expect(c2.values.length).toBe(4);
    // Without a skeleton the rest-valued channel stays (collapsed).
    const kept = compressClip(src).clip;
    expect(kept.channels.length).toBe(4);
    expect(kept.channels[3]!.times.length).toBe(1);
    // dropConstant false keeps the dense keys (they fit a line, so RDP still thins them).
    const raw = compressClip(src, { dropConstant: false, skeleton: skeleton(4) }).clip;
    expect(raw.channels.length).toBe(4);
    expect(raw.channels[2]!.interpolation).toBe('LINEAR');
  });

  it('copies CUBICSPLINE channels and STEP channels keep every value change', () => {
    const cubic: AnimationChannel = {
      node: 0,
      path: 'translation',
      interpolation: 'CUBICSPLINE',
      times: new Float32Array([0, 1]),
      values: new Float32Array(18),
    };
    const step: AnimationChannel = {
      node: 1,
      path: 'scale',
      interpolation: 'STEP',
      times: new Float32Array([0, 1, 2, 3]),
      values: new Float32Array([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]),
    };
    const { clip } = compressClip({ name: 'c', duration: 3, channels: [cubic, step] });
    expect(clip.channels[0]!.values.length).toBe(18);
    expect(Array.from(clip.channels[1]!.times)).toEqual([0, 1, 2, 3].filter((t) => t !== 1));
    expect(clip.channels[1]!.values.length).toBe(9);
  });
});

describe('quantizeClip', () => {
  it('packs rotations into three uint16 per key within ~1e-4 rad, float channels untouched', () => {
    const src = dense();
    const q = quantizeClip(src, { rotation: 'smallest-three' });
    const c0 = q.channels[0]!;
    expect(c0.packed).toBeInstanceOf(Uint16Array);
    expect(c0.packed!.length).toBe(c0.times.length * 3);
    expect(c0.values.length).toBe(0);
    expect(q.channels[1]!.packed).toBeUndefined();
    expect(q.channels[1]!.values).toEqual(src.channels[1]!.values);
    expect(clipBytes(q)).toBeLessThan(clipBytes(src));
    const r = rand(11);
    for (let i = 0; i < 100; i++) {
      const t = r() * src.duration;
      const a = sampleAt(src, 4, t);
      const b = sampleAt(q, 4, t);
      expect(angle(a, 3, b, 3)).toBeLessThan(2e-4);
      expect(angle(a, 2 * POSE_NODE_FLOATS + 3, b, 2 * POSE_NODE_FLOATS + 3)).toBeLessThan(2e-4);
    }
    expect(quantizeClip(src, { rotation: 'none' }).channels[0]!.packed).toBeUndefined();
  });

  it('round-trips every largest-component case and negative quaternions', () => {
    const out = new Float32Array(4);
    const packed = new Uint16Array(3);
    const r = rand(3);
    for (let i = 0; i < 200; i++) {
      const q = new Float32Array([r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5]);
      const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
      for (let k = 0; k < 4; k++) q[k] = q[k]! / len;
      packQuat(q, 0, packed, 0);
      const ch: AnimationChannel = {
        node: 0,
        path: 'rotation',
        interpolation: 'STEP',
        times: new Float32Array([0]),
        values: new Float32Array(0),
        packed,
      };
      sampleChannel(ch, 0, out, 0);
      expect(angle(q, 0, out, 0)).toBeLessThan(2e-4);
    }
  });

  it('compressClip accepts a quantized clip (decodes first)', () => {
    const src = dense();
    const q = quantizeClip(src, { rotation: 'smallest-three' });
    const { clip } = compressClip(q, { rotationError: 2e-3, skeleton: skeleton(4) });
    expect(clip.channels[0]!.packed).toBeUndefined();
    expect(clip.channels[0]!.times.length).toBeLessThan(src.channels[0]!.times.length / 2);
  });
});

describe('a glTF clip', () => {
  function gltfFixture(): ArrayBuffer {
    // A 60 Hz, 2 s swing of node 1 about x plus a constant translation: dense, as exporters
    // bake them.
    const n = 121;
    const times = new Float32Array(n);
    const rot = new Float32Array(n * 4);
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 2;
      times[i] = t;
      quatFromAxisAngle(rot, i * 4, 1, 0, 0, Math.sin(t * Math.PI) * 0.7);
      pos[i * 3 + 1] = 1;
    }
    const bytes = new Uint8Array(times.byteLength + rot.byteLength + pos.byteLength);
    bytes.set(new Uint8Array(times.buffer), 0);
    bytes.set(new Uint8Array(rot.buffer), times.byteLength);
    bytes.set(new Uint8Array(pos.buffer), times.byteLength + rot.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1] }, { translation: [0, 1, 0] }],
      buffers: [
        { byteLength: bytes.length, uri: `data:application/octet-stream;base64,${btoa(bin)}` },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: times.byteLength },
        { buffer: 0, byteOffset: times.byteLength, byteLength: rot.byteLength },
        { buffer: 0, byteOffset: times.byteLength + rot.byteLength, byteLength: pos.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: n, type: 'SCALAR', min: [0], max: [2] },
        { bufferView: 1, componentType: 5126, count: n, type: 'VEC4' },
        { bufferView: 2, componentType: 5126, count: n, type: 'VEC3' },
      ],
      animations: [
        {
          name: 'swing',
          samplers: [
            { input: 0, output: 1, interpolation: 'LINEAR' },
            { input: 0, output: 2, interpolation: 'LINEAR' },
          ],
          channels: [
            { sampler: 0, target: { node: 1, path: 'rotation' } },
            { sampler: 1, target: { node: 1, path: 'translation' } },
          ],
        },
      ],
    };
    return new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
  }

  it('from the parser compresses by a reported ratio', () => {
    const doc = parseGltf(gltfFixture());
    const clip = doc.animations[0]!;
    expect(clip.channels.length).toBe(2);
    const { before, after } = compressClip(clip, { rotationError: 1e-3, positionError: 1e-3 });
    const ratio = before / after;
    expect(before).toBe(121 * 4 + 121 * 16 + 121 * 4 + 121 * 12);
    expect(ratio).toBeGreaterThan(3);
    const packed = quantizeClip(compressClip(clip).clip, { rotation: 'smallest-three' });
    expect(clipBytes(packed)).toBeLessThan(after);
  });
});
