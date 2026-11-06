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
  promoting to 32-bit indices when the total passes 65535 vertices. Inputs are untouched. The
  3D and `VERTEX_LAYOUT_3D_TANGENT` layouts get bounds; any other layout is left unbounded.
- `transformGeometry(g, world)` applies a 3×4 row-major matrix (`Transform.world`) to positions
  and its inverse transpose to normals (renormalised, flipped under a mirroring matrix) in place,
  recomputes `bounds` and returns `g`. It takes `VERTEX_LAYOUT_3D` or `VERTEX_LAYOUT_3D_TANGENT`
  (ws/ergo-3d): a tangent's xyz is rotated by the 3×3 part and renormalised, its w kept, negated
  under a mirror so the bitangent still follows `w · cross(n, t)`.

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
- `rayHeightfield(hf, origin, dir, out?)` (ws/ergo-3d) is `raycastHeightfield` taking the ray as
  two arrays (a camera's eye and look direction, a `Ray`'s fields, or plain `[x, y, z]`s), no
  `HeightfieldRay` object and no allocation.
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

## Collision

A world of static triangles under a BVH, queried by shapes: the engine finds what a moving
thing touches and where it may go; what the game does about it stays the game's. Every query
is allocation-free after warm-up (the results go into objects the caller owns; the internals
work in typed-array registers, never in doubles passed between calls).

- `createStaticCollider(sources: ColliderSource[], opts?: StaticColliderOptions)` builds a
  `StaticCollider` from `GeometrySource { geometry; transform?; layer?; userData? }` (any
  `Geometry` whose first three floats per vertex are the position, optionally placed by a 3×4
  `Transform.world` or a 4×4 column-major matrix: `ColliderTransform`), `HeightfieldSource
  { heightfield; layer?; userData? }` (two triangles per cell) and `TileGridSource { grid; layer?;
  userData? }`. `leafSize` (default 4) is the most triangles per leaf. `layer` is a bit index
  0..31; every query takes a `layerMask` (default `ALL_LAYERS`). Each source gets its own subtree
  under a top level, so `c.refit(sourceIndex, transform)` moves a geometry source without
  rebuilding (leaves and inner nodes refitted bottom-up; the tree only gets looser) and
  `c.remove(sourceIndex)` drops one. `c.triangleCount`, `c.sourceCount`, `c.bounds:
  ColliderBounds { min; max }`, `c.userData(source)`, `c.sources: SourceRecord[]` (`kind:
  SourceKind` is `SOURCE_GEOMETRY` 0, `SOURCE_HEIGHTFIELD` 1 or `SOURCE_GRID` 2) and the flat
  arrays `c.tris` (nine floats per triangle; `colliderTriangle(c, index, out, offset?)` copies
  one out) and `c.triSource`. `applyTransform(m, x, y, z, out, o)` is the point transform the
  builder uses.
- `GridSource { width; height; cellSize; origin: [x, z]; solid; y?; wallHeight? }` is the 2D
  tile case: `solid` is a predicate over cell coordinates or a `width × height` `Uint8Array`
  (`solid[z * width + x]`; `gridSolid(grid, x, z)` reads either, open outside). Each solid cell
  is a box from `y` (default 0) to `y + wallHeight` (default `cellSize`); faces shared by two
  solid cells are left out, so a run of tiles is one flat wall and a circle sliding along it
  meets no interior edges. `gridTriangles(grid)` is that mesh, nine floats per triangle.
- Shapes: `Sphere { x, y, z, r }`, `Capsule { x, y, z, halfHeight, r }` (along y; `halfHeight`
  is centre to hemisphere centre, total height `2 × (halfHeight + r)`), `Aabb { min, max }`;
  `Shape` is any of them, `isCapsule(s)` and `isAabb(s)` tell them apart, `shapeBounds(s, min,
  max)` is the world AABB. The 2D shapes `Circle { x, z, r }` and `Box2 { x, z, hw, hh }` (`Shape2`,
  `isBox2(s)`) are lifted to the collider's full height by the `*2` queries, so a 2D game builds
  its collider from a `GridSource` or any geometry and never thinks about y. `Vec3Out` is
  `[x, y, z]`, `Float32Array` or `Float64Array`.
- `raycast(c, origin, dir, maxDist, out: Hit, layerMask?)`: the nearest triangle along the ray
  (`dir` any length; `t` in world units); back faces hit too, with the normal turned to face the
  ray. `Hit { t; x, y, z; nx, ny, nz; triangle; source; userData }`, from `createHit()`.
  `raycast2(c, ox, oz, dx, dz, maxDist, out, layerMask?)` casts in xz at the collider's mid
  height.
- `overlap(c, shape, out: Contact[], maxContacts?, layerMask?)`: every triangle the shape
  penetrates as contacts into `out` (from `createContact()`; `Contact { depth; nx, ny, nz; px,
  py, pz; triangle; source }`, the normal pointing from the triangle into the shape, `depth` how
  far along it to separate), returns the count; touching is not a contact. `overlap2` for a
  `Shape2`, normals in xz.
- `sweepShape(c, shape, dx, dy, dz, out: SweepHit, layerMask?)` moves the shape by a
  displacement and finds the first triangle it touches: `SweepHit` (a `Hit` plus `depth`, from
  `createSweepHit()`) with `t` in 0..1 along the displacement; a shape already overlapping reports
  `t` 0 and its `depth`; false when the whole move is free. (`sweep` is the profile sweep above;
  the shape sweep is `sweepShape` at this index.) `sweep2(c, shape, dx, dz, out, layerMask?)`.
- `slide(c, shape, dx, dy, dz, opts?: SlideOptions, out?: SlideResult)` is the move-and-slide
  loop a character controller would otherwise write: sweep, stop `skin` short, project the rest
  of the displacement onto the hit plane, repeat up to `maxIterations`. A hit within `maxSlope`
  degrees of up is ground (the downward part of the move is dropped there, the rest follows the
  surface); anything steeper is a wall the shape slides along horizontally, and a wall that blocks
  horizontal motion from the ground, or catches the shape no higher than `stepHeight` above its
  bottom, is tried again `stepHeight` higher and dropped back onto walkable ground (stairs; a
  rounded bottom landing on a step's lip counts when the ground under the centre is walkable).
  After the move a probe `2 × skin` below decides `grounded`; a shape that was grounded
  (`wasGrounded`, the previous result's `grounded`, default true) and moved down or flat looks
  `snapDown` below for ground to stay on. Defaults: `skin` 0.005, `maxSlope` 50, `stepHeight`
  0.35, `snapDown` 0.2, `maxIterations` 4, `layerMask` all. `SlideResult { x, y, z; grounded;
  groundNormal; hitWall; hits; remaining }` from `createSlideResult()`; the shape itself is not
  moved. `slide2(c, shape, dx, dz, opts?, out?)` is the flat case: every hit a wall, `y` 0,
  `grounded` false.
- The shape-vs-triangle tests the queries are built on, on nine triangle coordinates:
  `sphereTriangle`, `capsuleTriangle`, `aabbTriangle` and `shapeTriangle(s, ax, …, cz, out:
  Contact)` (true and `out` filled when they overlap), `closestPointTriangle(px, py, pz, ax, …,
  cz, out)`, `closestSegmentSegment(p0…, p1…, q0…, q1…, outP, outQ)` and
  `closestSegmentTriangle(p0…, p1…, a…, c…, outS, outT)` (squared distance), `triangleNormal(a…,
  c…, out)`.
- `exportCollider(c): ArrayBuffer` and `importCollider(buf, userData?)` bake a built collider
  (little-endian, versioned, the typed arrays whole; `userData` is not serialised and is
  reattached by source index); exporting an import gives identical bytes.
- `colliderWireframe(c, out?, mode?: WireframeMode)` writes line segments (six floats each) for
  every live triangle (`'triangles'`) or every BVH leaf box (`'leaves'`) for `createDebugDraw`;
  `colliderWireframeLength(c, mode?)` is the float count.

A controller is ten lines:

```ts
const collider = createStaticCollider([{ geometry: level }, { heightfield: ground }]);
const body: Capsule = { x: 0, y: 1, z: 0, halfHeight: 0.5, r: 0.3 };
const out = createSlideResult();
let vy = 0;
let grounded = false;
function step(dt: number, moveX: number, moveZ: number): void {
  vy = grounded ? 0 : vy - 9.8 * dt;
  slide(collider, body, moveX * dt, grounded ? -0.001 : vy * dt, moveZ * dt, { wasGrounded: grounded }, out);
  body.x = out.x; body.y = out.y; body.z = out.z;
  grounded = out.grounded;
}
```

Not here: response forces, physics integration and triggers belong to the game (gravity is the
`dy` it passes; a trigger is an `overlap` it asks for).

Harness: `harness/collide.html` is a level built from the builders (a floor, stairs onto a
platform, an arch, a tilted ramp, a wall and a heightfield patch) with a capsule walked by WASD
or the stick through `slide`, the collider's triangles or BVH leaves drawn through
`createDebugDraw`; `?grid` is a 2D corridor with a circle on `slide2`; `?still` steps only
through the page's `advance`. `e2e/collide.spec.ts` checks the wall stops the capsule, the stairs
lift it by rise × steps, the ramp grounds it with a tilted normal and the circle rounds the
corridor's bend.
