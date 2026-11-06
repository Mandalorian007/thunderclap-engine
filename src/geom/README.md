# `@thunderclap/engine/geom`

Procedural geometry: primitive builders, sweeps (extrude, lathe, sweep, tube, polygon, stairs,
arch), heightfields, tangents and the operations to combine and reshape them. Pure arithmetic, no
GPU; the only `render/` imports are types and layout constants (`MeshBounds`, `VertexLayout`,
`VERTEX_LAYOUT_3D`, `VERTEX_LAYOUT_3D_TANGENT`). Every builder returns a `Geometry` in
`VERTEX_LAYOUT_3D` (12 floats per vertex: position, normal, uv, rgba), which is a `MeshDesc`, so
`renderer.createMesh(geometry)` takes it as it is; `computeTangents` turns one into the 16-float
tangent layout.

```ts
import { box, heightfieldGeometry, createHeightfield, heightAt } from '@thunderclap/engine/geom';

const crate = renderer.createMesh(box({ size: [1, 1, 2], color: [0.8, 0.5, 0.2, 1] }));
const ground = createHeightfield(65, 65, { scale: [0.5, 1, 0.5], origin: [-16, 0, -16] });
// fill ground.heights (row-major, heights[z * width + x]) ...
const terrain = renderer.createMesh(heightfieldGeometry(ground));
const y = heightAt(ground, player.x, player.z);
```

## Geometry

- `Geometry { vertices: Float32Array; indices: Uint16Array | Uint32Array; bounds: MeshBounds; layout: VertexLayout }`.
  Indices are `Uint16Array` up to `UINT16_MAX_VERTICES` (65535) vertices and `Uint32Array` past
  it (`createIndices(vertexCount, indexCount)` picks). `bounds` is the AABB centre and the
  farthest vertex, the same rule `Mesh` uses (`computeBounds(vertices, floats?, out?)`).
- `GeometryOptions { color?: Rgba; uvScale?: number | [u, v] }` is accepted by every builder:
  `color` (`Rgba` = `[r, g, b, a]`, default white) fills the vertex colour, `uvScale` multiplies
  the uvs. `GEOMETRY_FLOATS` is the floats per vertex (12).
- `GeometryWriter(vertexCount, indexCount, opts?)` builds a geometry by hand: `vertex(x, y, z, nx, ny, nz, u, v)`
  returns the index, `tri(a, b, c)` and `quad(a, b, c, d)` write indices, `finish()` checks the
  counts and computes the bounds. The builders below use it.
- `mergeGeometry(...parts)` concatenates geometries of one layout, offsetting indices and
  promoting to 32-bit indices when the total passes 65535 vertices. Inputs are untouched.
- `transformGeometry(g, world)` applies a 3×4 row-major matrix (`Transform.world`) to positions
  and its inverse transpose to normals (renormalised, flipped under a mirroring matrix) in place,
  recomputes `bounds` and returns `g`.

## Builders

All shapes are centred on the origin, wound counter-clockwise from outside, with normals of
unit length. Segment counts below their minimum throw.

| Builder | Options | Vertices / triangles |
| --- | --- | --- |
| `box(opts?)` | `BoxOptions`: `size` (number or `[x, y, z]`, default 1), `segments` (number or `[x, y, z]`, default 1) | 4 per face quad, flat normals; 24 / 12 by default |
| `plane(opts?)` | `PlaneOptions`: `size` (number or `[x, z]`), `segments` (number or `[x, z]`) | an xz grid at y 0 facing +y, u along +x, v along +z |
| `sphere(opts?)` | `SphereOptions`: `radius` (0.5), `segments` `[around, rows]` (`[32, 16]`) | UV sphere, `(around + 1) × (rows + 1)`, smooth normals |
| `icosphere(opts?)` | `IcosphereOptions`: `radius` (0.5), `subdivisions` (2) | `10 · 4ⁿ + 2` vertices, `20 · 4ⁿ` triangles, smooth normals, spherical uvs |
| `capsule(opts?)` | `CapsuleOptions`: `radius` (0.25), `height` (total, 1), `segments` `[around, rings per cap]` (`[16, 8]`) | two hemispheres joined by a tube, smooth; a `height ≤ 2 · radius` is a sphere |
| `cylinder(opts?)` | `CylinderOptions`: `radius` (number or `[top, bottom]`, 0.5), `height` (1), `segments` `[around, height]` (`[24, 1]`), `caps` (true) | smooth sides (a zero radius makes a cone), flat discs for the caps |
| `torus(opts?)` | `TorusOptions`: `radius` (ring, 0.5), `tube` (0.2), `segments` `[radial, tubular]` (`[12, 24]`) | ring in the xz plane, smooth normals |
| `extrude(profile, opts?)` | `ExtrudeOptions`: `depth` (1), `segments` (rows along z, 1), `caps` (true), `bevel` (0) | a 2D outline swept along z, flat sides, ear-clipped caps, optional 45° bevel; see *Sweeps* |
| `lathe(profile, opts?)` | `LatheOptions`: `segments` (around, 24), `angle` (2π) | an open (radius, y) profile revolved about +y, smooth normals |
| `sweep(profile, path, opts?)` | `SweepOptions`: `closed` (false), `frames` (`'rmf'` or `'frenet'`) | the outline carried along a polyline, one ring per path point |
| `tube(path, opts?)` | `TubeOptions`: `SweepOptions` plus `radius` (0.1), `segments` (around, 12) | `sweep` of a circle |
| `polygon(points, opts?)` | `PolygonOptions`: `y` (0), `doubleSided` (false) | a flat ear-clipped outline in the xz plane facing +y |
| `stairs(opts?)` | `StairsOptions`: `steps` (4), `width` (1), `rise` (0.25), `run` (0.3), `sides` (true) | a sawtooth prism climbing along +z, recentred |
| `arch(opts?)` | `ArchOptions`: `width` (1), `height` (1), `depth` (0.25), `thickness` (0.15), `segments` (16) | a semicircular lintel on two legs, recentred |

## Sweeps

A `Profile2D` is a closed 2D outline as x, y pairs (`Float32Array | number[]`), counter-clockwise;
a clockwise outline is accepted and reversed (`profileArea2(profile)` is twice its signed area,
positive counter-clockwise). Outlines must be simple (no self-intersection); fewer than three
points throw. Every sweep lays u around the outline and v along the sweep, so `computeTangents`
gives a right-handed frame (`w = +1`) on every vertex it makes.

- `triangulate(profile)` ear-clips a simple polygon into up to `n − 2` counter-clockwise triangles
  over the profile's indices (`Uint16Array`, `Uint32Array` past 65535 points); concave outlines
  are handled, collinear or repeated points are dropped as zero-area ears. Convex outlines fan in
  O(n); the cost grows with the number of reflex corners.
- `extrude(profile, opts?: ExtrudeOptions)` sweeps the outline along z, centred on z 0: one flat
  strip per edge (`segments` rows, u by arc length around, v along +z), ear-clipped caps at
  ±`depth / 2` with uvs over the outline's box (the back cap mirrors u), and with `bevel > 0` a 45°
  chamfer of that size between each cap (inset by a mitre) and the sides. `caps: false` leaves an
  open tube (no bevel then).
- `lathe(profile, opts?: LatheOptions)` revolves an open (radius, y) profile (at least two points)
  about +y through `angle` in `segments` steps: `(points) × (segments + 1)` vertices, smooth
  normals, u around (0 at +z), v along the profile. A partial angle leaves an open shell.
- `sweep(profile, path, opts?: SweepOptions)` carries the outline along a polyline (`path`: x, y, z
  triples, at least two points) with one ring of `n + 1` vertices per path point. Frames are
  rotation-minimising by default (`frames: 'rmf'`, double reflection) or Frenet
  (`frames: 'frenet'`, which flips on straight runs and inflections); `closed: true` joins the last
  ring to the first and spreads the frame's end-to-start twist over the rings so the seam matches.
  u runs around the outline, v along the path (0..1 by span count).
- `tube(path, opts?: TubeOptions)` is `sweep` of a circle of `radius` with `segments` points.
- `polygon(points, opts?: PolygonOptions)` is one flat ear-clipped outline in the xz plane
  (profile x → x, profile y → −z) at height `y`, facing +y, uvs over its box; `doubleSided: true`
  adds a mirrored back face.
- `stairs(opts?: StairsOptions)` extrudes a sawtooth of `steps` steps (`rise` high, `run` deep)
  across `width` so the steps climb along +z, recentred on the origin; `sides: false` drops the
  two side walls.
- `arch(opts?: ArchOptions)` is a lintel of `thickness` with a semicircular underside (`segments`
  around the curve) over two legs, `width` wide, `height` tall, `depth` deep and recentred; a
  `height` of `thickness + width / 2` leaves no legs, and a `thickness` of `width / 2` or more
  throws.

## Tangents

- `computeTangents(g)` takes `VERTEX_LAYOUT_3D` geometry and returns a `GeometryTangent` (a
  `Geometry` in `VERTEX_LAYOUT_3D_TANGENT`, `TANGENT_FLOATS` = 16 per vertex: the 12 floats as
  they were, then `tangent: vec4f`). Per triangle the tangent and bitangent are solved from the
  uv edges (Lengyel), accumulated on each vertex weighted by area over uv area (MikkTSpace-style,
  so uv seams and mirrored islands do not bleed), then Gram-Schmidt orthonormalised against the
  vertex normal; `w` is the handedness, `+1` where (T, B, N) is right-handed and `−1` where the
  uvs are mirrored. A vertex without uv area gets a unit perpendicular tangent and `w = +1`.
  Indices are shared with the input, bounds copied. The standard PBR material still derives its
  frame from derivatives; this layout is for materials that read `@location(13)`.

## Operations

All operations accept `VERTEX_LAYOUT_3D` or `VERTEX_LAYOUT_3D_TANGENT` geometry.

- `flatShade(g)` returns a new geometry with one vertex per triangle corner (`indices.length`
  vertices, sequential indices) carrying its face normal; a degenerate triangle keeps the source
  normals.
- `weld(g, epsilon = 1e-5)` returns a new geometry in which vertices whose position, normal and
  uv all agree within `epsilon` share one vertex (the first occurrence kept, found by a spatial
  hash), indices remapped and shrunk to 16-bit when the welded count allows.
- `flipWinding(g)` reverses every triangle, negates the normals (and the tangent handedness `w`
  in the tangent layout) in place, and returns `g`; the bounds are unchanged.
- `projectUv(g, mode: UvProjection, opts?: ProjectUvOptions)` rewrites the uvs in place from the
  positions over the geometry's AABB (0..1 then × `scale`, a number or `[u, v]`) and returns `g`.
  `'planar'` projects along `axis` (`'x' | 'y' | 'z'`, default `'y'`: u along x, v along z);
  `'box'` picks the planar projection per vertex from the dominant normal axis; `'cylindrical'`
  wraps u around +y (`atan2`, 0.5 at +z) with v the height; `'spherical'` wraps u around +y and
  takes v from the top pole (`acos`). `axis` applies to `'planar'` only.
- `fitBounds(g, size)` scales positions uniformly about the origin so the longest AABB side is
  `size`, recomputes `bounds` and returns `g`.
- `recenter(g)` translates positions so the AABB centre is the origin, recomputes `bounds` and
  returns `g`.

## Heightfields

- `Heightfield { width; depth; heights: Float32Array; scale: [sx, sy, sz]; origin: [x, y, z] }`:
  `width × depth` samples, `heights[z * width + x]`, placed at `origin + (x · sx, h · sy, z · sz)`.
  `createHeightfield(width, depth, opts?: HeightfieldOptions)` (`scale`, `origin`, `heights`)
  allocates one (at least 2×2).
- `heightAt(hf, x, z)` is the bilinear height at a world x, z (clamped to the edge outside).
- `normalAt(hf, x, z, out)` writes the unit surface normal (central differences) into `out`, a
  `HeightfieldVec3` (`[x, y, z]`, `Float32Array` or `Float64Array`), and returns it.
- `raycastHeightfield(hf, ray, out?)` walks the cells the ray crosses (DDA) and solves each cell's
  bilinear patch exactly, so the hit lies on `heightAt`. Returns the distance along the ray and
  writes the hit point into `out`, or returns -1 on a miss (above the field, or never reaching its
  footprint). `HeightfieldRay { origin; dir }` is `input/rays.ts`'s `Ray` shape; `dir` is unit
  length. No allocation.
- `heightfieldGeometry(hf, opts?: HeightfieldGeometryOptions)` builds one vertex per sample
  with smooth normals, uvs over the footprint, 32-bit indices past 65535 samples; `flat: true`
  builds six vertices per cell with face normals. `color` and `uvScale` as for the builders.

Harness: `harness/geom.html` draws every builder, turning and lit, over a heightfield from a
sine bump map: the primitives in front, an extruded star, a lathed vase, a tube along a helix,
stairs and an arch behind; `e2e/geom.spec.ts` checks the shape count, lit probe pixels, that
`computeTangents` over the star is right-handed throughout and `heightAt`.
