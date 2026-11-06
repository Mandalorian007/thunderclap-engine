/**
 * The cosmetics table: three socket slots on the rig, two options each, every option a `geom`
 * build (no asset). A slot names its joint and where on the joint its socket sits; an option is a
 * geometry in socket space plus a surface. Pure: `geom` is arithmetic. The scene builds one mesh
 * and one material per option once and attaches the chosen one through `attachTransform`.
 *
 * Socket space is the joint's: at rest the joint axes are the world axes, the character faces -Z,
 * +Y is up, so "behind the back" is +Z and "down the hand" is -Y.
 */
import type { SocketLocal } from '@thunderclap/engine/anim';
import {
  box,
  cylinder,
  type Geometry,
  mergeGeometry,
  type Rgba,
  sphere,
  torus,
  transformGeometry,
} from '@thunderclap/engine/geom';
import { J } from './rig';

export type SlotName = 'head' | 'back' | 'hand-right';
export const SLOT_NAMES: readonly SlotName[] = ['head', 'back', 'hand-right'];

export interface CosmeticOption {
  readonly name: string;
  /** Builds the geometry in socket space (called once by the scene). */
  readonly build: () => Geometry;
  /** Linear RGBA the PBR material multiplies the vertex colour by. */
  readonly color: Rgba;
  readonly metallic: number;
  readonly roughness: number;
}

export interface CosmeticSlot {
  readonly slot: SlotName;
  /** The rig joint the socket hangs from. */
  readonly joint: number;
  /** Where on the joint the socket sits. */
  readonly local: SocketLocal;
  readonly options: readonly [CosmeticOption, CosmeticOption];
}

/** A 3×4 row-major matrix: translate, then rotate about `axis` by `angle`, then scale. */
function trs(
  pos: readonly [number, number, number],
  axis: readonly [number, number, number] = [0, 1, 0],
  angle = 0,
  scale: readonly [number, number, number] = [1, 1, 1],
): Float32Array {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2) / len;
  const x = axis[0] * s;
  const y = axis[1] * s;
  const z = axis[2] * s;
  const w = Math.cos(angle / 2);
  const [sx, sy, sz] = scale;
  return new Float32Array([
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y - z * w) * sy,
    2 * (x * z + y * w) * sz,
    pos[0],
    2 * (x * y + z * w) * sx,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z - x * w) * sz,
    pos[1],
    2 * (x * z - y * w) * sx,
    2 * (y * z + x * w) * sy,
    (1 - 2 * (x * x + y * y)) * sz,
    pos[2],
  ]);
}

const place = (g: Geometry, ...args: Parameters<typeof trs>) => transformGeometry(g, trs(...args));

export const COSMETICS: readonly CosmeticSlot[] = [
  {
    slot: 'head',
    joint: J.head,
    local: { position: [0, 0.2, 0] },
    options: [
      {
        name: 'Helm',
        color: [0.55, 0.57, 0.62, 1],
        metallic: 0.9,
        roughness: 0.35,
        build: () =>
          mergeGeometry(
            place(sphere({ radius: 0.165 }), [0, 0.03, -0.01], [0, 1, 0], 0, [1, 0.75, 1.05]),
            place(torus({ radius: 0.16, tube: 0.02 }), [0, 0.03, -0.01]),
          ),
      },
      {
        name: 'Horns',
        color: [0.9, 0.84, 0.7, 1],
        metallic: 0,
        roughness: 0.6,
        build: () =>
          mergeGeometry(
            place(cylinder({ radius: [0, 0.035], height: 0.28 }), [-0.14, 0.14, 0], [0, 0, 1], 0.6),
            place(cylinder({ radius: [0, 0.035], height: 0.28 }), [0.14, 0.14, 0], [0, 0, 1], -0.6),
            place(box({ size: [0.26, 0.05, 0.26] }), [0, 0.03, -0.01]),
          ),
      },
    ],
  },
  {
    slot: 'back',
    joint: J.hips,
    local: { position: [0, 0.3, 0.13] },
    options: [
      {
        name: 'Cape',
        color: [0.3, 0.12, 0.4, 1],
        metallic: 0,
        roughness: 0.9,
        build: () => place(box({ size: [0.44, 0.72, 0.03] }), [0, -0.22, 0.02]),
      },
      {
        name: 'Pack',
        color: [0.45, 0.32, 0.18, 1],
        metallic: 0,
        roughness: 0.8,
        build: () =>
          mergeGeometry(
            place(box({ size: [0.3, 0.36, 0.18] }), [0, -0.02, 0.1]),
            place(cylinder({ radius: 0.05, height: 0.34 }), [0, 0.2, 0.1], [0, 0, 1], Math.PI / 2),
          ),
      },
    ],
  },
  {
    slot: 'hand-right',
    joint: J.handR,
    local: { position: [0, -0.1, 0] },
    options: [
      {
        name: 'Sword',
        color: [0.8, 0.82, 0.88, 1],
        metallic: 1,
        roughness: 0.25,
        build: () =>
          mergeGeometry(
            place(box({ size: [0.05, 0.78, 0.015] }), [0, -0.47, 0]),
            place(box({ size: [0.2, 0.03, 0.05] }), [0, -0.08, 0]),
            place(cylinder({ radius: 0.025, height: 0.16 }), [0, 0, 0]),
          ),
      },
      {
        name: 'Axe',
        color: [0.5, 0.36, 0.22, 1],
        metallic: 0.2,
        roughness: 0.6,
        build: () =>
          mergeGeometry(
            place(cylinder({ radius: 0.025, height: 0.74 }), [0, -0.3, 0]),
            place(box({ size: [0.24, 0.16, 0.04], color: [0.6, 0.62, 0.66, 1] }), [0.1, -0.58, 0]),
          ),
      },
    ],
  },
];

/** The option index after `current` in `slot`, wrapping. */
export function nextOption(slot: CosmeticSlot, current: number): number {
  return (current + 1) % slot.options.length;
}
