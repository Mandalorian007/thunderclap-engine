/**
 * The three gear sets (helmet, shoulders, weapon), each piece a `geom` mesh in its socket's
 * frame: the helmet's origin is the head socket (the middle of the head box), a pauldron's is
 * the shoulder joint, a weapon's grip is the hand socket with the blade or haft down -y (how a
 * hanging hand holds it). The hero faces -z. Setup-time code: allocates freely.
 */
import {
  box,
  cylinder,
  type Geometry,
  icosphere,
  mergeGeometry,
  type Rgba,
  sphere,
  transformGeometry,
} from '@thunderclap/engine/geom';
import { Transform } from '@thunderclap/engine/render';

export type GearName = 'iron' | 'gilded' | 'bone';
export const GEAR_NAMES: readonly GearName[] = ['iron', 'gilded', 'bone'];

export interface GearMeshes {
  helmet: Geometry;
  shoulder: Geometry;
  weapon: Geometry;
  /** Grip to tip along -y, world units (the trail follows the tip). */
  reach: number;
}

interface Place {
  x?: number;
  y?: number;
  z?: number;
  sx?: number;
  sy?: number;
  sz?: number;
  /** Rotation about the axis `[ax, ay, az]` by `angle` radians. */
  axis?: readonly [number, number, number];
  angle?: number;
}

/** Scale, rotate, then move a fresh geometry (`transformGeometry` writes it in place). */
function place(g: Geometry, p: Place): Geometry {
  const t = new Transform({
    x: p.x ?? 0,
    y: p.y ?? 0,
    z: p.z ?? 0,
    scaleX: p.sx ?? 1,
    scaleY: p.sy ?? 1,
    scaleZ: p.sz ?? 1,
  });
  if (p.axis) t.setAxisAngle(p.axis[0], p.axis[1], p.axis[2], p.angle ?? 0);
  return transformGeometry(g, t.world);
}

const DARK: Rgba = [0.35, 0.33, 0.32, 1];
const LEATHER: Rgba = [0.3, 0.17, 0.09, 1];

/** Plain iron: a round cap with a nasal bar, domed pauldrons, a broadsword. */
function iron(): GearMeshes {
  const helmet = mergeGeometry(
    place(cylinder({ radius: [0.15, 0.155], height: 0.16, segments: [16, 1] }), { y: 0.04 }),
    place(sphere({ radius: 0.152, segments: [16, 8] }), { y: 0.11, sy: 0.7 }),
    place(box({ size: [0.03, 0.12, 0.03] }), { y: -0.02, z: -0.155 }),
    place(box({ size: [0.32, 0.025, 0.32], color: DARK }), { y: -0.035 }),
  );
  const shoulder = mergeGeometry(
    place(sphere({ radius: 0.13, segments: [12, 6] }), { y: 0.02, sy: 0.7 }),
    place(box({ size: [0.2, 0.03, 0.24], color: DARK }), { y: -0.06 }),
  );
  const weapon = mergeGeometry(
    place(box({ size: [0.04, 0.2, 0.04], color: LEATHER }), { y: 0.12 }),
    place(box({ size: [0.06, 0.04, 0.06] }), { y: 0.23 }),
    place(box({ size: [0.24, 0.035, 0.05] }), { y: -0.02 }),
    place(box({ size: [0.07, 0.8, 0.016] }), { y: -0.42 }),
    place(box({ size: [0.044, 0.14, 0.012] }), { y: -0.86 }),
  );
  return { helmet, shoulder, weapon, reach: 0.95 };
}

/** Gilded: a crested helm, winged pauldrons with spikes, a long rune-blade (emissive runes). */
function gilded(): GearMeshes {
  const helmet = mergeGeometry(
    place(cylinder({ radius: [0.16, 0.16], height: 0.2, segments: [16, 1] }), { y: 0.05 }),
    place(sphere({ radius: 0.162, segments: [16, 8] }), { y: 0.14, sy: 0.75 }),
    place(box({ size: [0.04, 0.16, 0.34] }), { y: 0.28 }),
    place(box({ size: [0.24, 0.035, 0.03] }), { y: 0.02, z: -0.16 }),
  );
  const shoulder = mergeGeometry(
    place(sphere({ radius: 0.15, segments: [12, 6] }), { y: 0.03, sy: 0.65 }),
    place(cylinder({ radius: [0, 0.035], height: 0.18, segments: [8, 1] }), { y: 0.16 }),
    place(box({ size: [0.3, 0.03, 0.26] }), { y: -0.05 }),
  );
  const weapon = mergeGeometry(
    place(box({ size: [0.045, 0.24, 0.045], color: LEATHER }), { y: 0.14 }),
    place(icosphere({ radius: 0.045, subdivisions: 1 }), { y: 0.28 }),
    place(box({ size: [0.34, 0.05, 0.06] }), { y: -0.02 }),
    place(box({ size: [0.09, 1.0, 0.02] }), { y: -0.53 }),
    place(cylinder({ radius: [0, 0.045], height: 0.18, segments: [4, 1] }), {
      y: -1.12,
      axis: [1, 0, 0],
      angle: Math.PI,
    }),
  );
  return { helmet, shoulder, weapon, reach: 1.2 };
}

/** Bone: a horned skull cap, tusk pauldrons, a jawbone axe on a haft. */
function bone(): GearMeshes {
  const horn = (side: 1 | -1) =>
    place(cylinder({ radius: [0, 0.04], height: 0.24, segments: [8, 1] }), {
      x: side * 0.17,
      y: 0.16,
      axis: [0, 0, 1],
      angle: side * -0.8,
    });
  const helmet = mergeGeometry(
    place(icosphere({ radius: 0.16, subdivisions: 1 }), { y: 0.08, sy: 0.85 }),
    place(box({ size: [0.2, 0.06, 0.04], color: DARK }), { y: 0.02, z: -0.15 }),
    horn(1),
    horn(-1),
  );
  const shoulder = mergeGeometry(
    place(icosphere({ radius: 0.12, subdivisions: 1 }), { y: 0.02, sy: 0.7 }),
    place(cylinder({ radius: [0, 0.035], height: 0.2, segments: [8, 1] }), {
      y: 0.08,
      z: -0.08,
      axis: [1, 0, 0],
      angle: -1.0,
    }),
    place(cylinder({ radius: [0, 0.03], height: 0.16, segments: [8, 1] }), {
      y: 0.08,
      z: 0.08,
      axis: [1, 0, 0],
      angle: 1.0,
    }),
  );
  const weapon = mergeGeometry(
    place(cylinder({ radius: [0.03, 0.03], height: 1.0, segments: [8, 1], color: LEATHER }), {
      y: -0.38,
    }),
    place(icosphere({ radius: 0.06, subdivisions: 1 }), { y: 0.14 }),
    place(box({ size: [0.05, 0.28, 0.26] }), { y: -0.78, z: -0.1 }),
    place(cylinder({ radius: [0, 0.03], height: 0.14, segments: [6, 1] }), {
      y: -0.72,
      z: -0.26,
      axis: [1, 0, 0],
      angle: -Math.PI / 2,
    }),
  );
  return { helmet, shoulder, weapon, reach: 0.95 };
}

/** The three sets in `GEAR_NAMES` order. Vertex colours stay white where the material colours it. */
export function createGearSets(): GearMeshes[] {
  return [iron(), gilded(), bone()];
}
