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
  promoting to 32-bit indices when the total passes 65535 vertices. Inputs are untouched. Any
  layout whose position (`@location(0)`, `float32x3`) sits at float 0 gets bounds (the 3D, tangent
  and skinned layouts, or a game's own); any other layout is left unbounded.
- `transformGeometry(g, world)` **mutates `g` in place** (see *Operations* for the copy-first
  recipe, `cloneGeometry`): it applies a 3×4 row-major matrix (`Transform.world`) to positions and its inverse
  transpose to normals (renormalised, flipped under a mirroring matrix), recomputes `bounds` and
  returns the same `g`. It takes any layout with the position at float 0 and finds the normal
  (`@location(10)`) and tangent (`@location(13)`) lanes from the layout's attributes wherever they
  sit (ws/geom-3; `VERTEX_LAYOUT_3D`, `VERTEX_LAYOUT_3D_TANGENT`, the skinned layout): a
  tangent's xyz is rotated by the 3×3 part and renormalised, its w kept, negated under a mirror so
  the bitangent still follows `w · cross(n, t)`. Other lanes (uv, colour, joints) are untouched.

## Clone

`cloneGeometry(g)` is a deep copy (ws/geom-3): new `vertices`, `indices` (same array type) and
`bounds`, the same `layout` object (layouts compare by identity). It is the copy step before an
in-place op when the source is reused, and what a baker keeps when it hands one geometry to two
consumers.

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

> **In place.** `transformGeometry`, `flipWinding`, `projectUv`, `fitBounds` and `recenter`
> write into the geometry they are given and return that same object; `flatShade`, `weld` and
> `mergeGeometry` return a new one and leave their inputs alone. A builder's result placed twice
> (`transformGeometry(b, here)` then `transformGeometry(b, there)`) is moved twice, not copied,
> and a geometry that also backs a mesh or a collider moves under them. Copy first when the
> source is reused:
>
> ```ts
> transformGeometry(cloneGeometry(g), world); // g is untouched
> // or build one per placement: transformGeometry(box({ size }), world)
> ```

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

## Simplify and LODs

Build-time, CPU (ws/geom-3). Nothing here runs per frame except `selectLod`, which is pure
arithmetic.

- `simplifyGeometry(g, opts?: SimplifyOptions): SimplifyResult` is quadric-error edge collapse
  (Garland–Heckbert, half-edge: every kept vertex is an input vertex, so its uv, normal, colour
  and tangent come along). Positions within a tiny epsilon are welded first, so a uv seam or hard
  edge does not tear the surface. `SimplifyOptions { targetRatio?; targetTriangles?;
  preserveBorders?; preserveUvSeams?; errorLimit? }`: keep `targetRatio` (default 0.5) of the
  triangles or at most `targetTriangles`; `preserveBorders` pins open-border vertices,
  `preserveUvSeams` pins positions whose vertices disagree (seams, creases); `errorLimit` (world
  units, default unlimited) stops before a collapse that would move the surface further. A
  collapse that would flip a triangle or pinch the surface is refused. `SimplifyResult {
  geometry; error }`: a new geometry in `g`'s layout (3D or tangent; `g` untouched) and the
  largest error made. Deterministic: two runs give identical bytes. A 10k-triangle sphere takes
  about a second.
- `createLodChain(g, ratios, opts?)` is `[g, simplify(g, ratios[0]), …]`, each level from the
  source (not the previous level), so the errors do not compound.
- `projectedSizePx(radius, distance, fovY, viewportHeight)` is the bounding sphere's projected
  diameter-ish size in pixels (`radius · height / (distance · tan(fovY / 2))`, infinite at or
  behind the eye). `selectLod(chain, boundsRadius, distance, fovY, viewportHeight, thresholdsPx)`
  returns the first level whose size is at least `thresholdsPx[i]`, else the last; `chain` is the
  levels (any array) or their count, and the result is clamped to it. `LodChain<M> {
  geometries; meshes?; thresholdsPx }` is storage for a chain and its meshes; the renderer does
  not pick levels itself. The loop:

```ts
const lod = { geometries: createLodChain(rock, [0.4, 0.15, 0.05]), thresholdsPx: [400, 160, 60] };
const meshes = lod.geometries.map((g) => renderer.createMesh(g));
// per frame, per instance:
const level = selectLod(meshes, rock.bounds.radius, distToEye, fovY, viewportHeight, lod.thresholdsPx);
frame.mesh(meshes[level], material, transform);
```

## Hull and collision proxy

- `convexHull(points: Float32Array | Geometry)` is the 3D convex hull (quickhull) of xyz
  triples or a geometry's positions, as a flat-shaded `VERTEX_LAYOUT_3D` geometry wound outward
  (three vertices per triangle, face normals, white). Points within a tolerance scaled to the
  cloud's extent count as on a face. Fewer than four points, or a flat cloud, gives an empty
  geometry.
- `collisionProxy(g, opts: CollisionProxyOptions)` is a cheap stand-in for a render mesh to hand
  `createStaticCollider` as `{ geometry }`: `CollisionProxyOptions { maxTriangles; kind? }`,
  `'hull'` (default: the convex hull, simplified further if it is over budget; fills
  concavities) or `'simplified'` (the mesh itself simplified to the budget; keeps them). A
  20k-triangle rock as a 1500-triangle simplified proxy raycasts within 2% of the full mesh.

## Split and slice

- `splitGeometry(g, by)` returns parts, each a compact new geometry in `g`'s layout. `by` is
  `'island'` (triangles connected through shared positions, so a uv seam does not split; parts in
  order of first triangle) or a function `(triangle) => group` (parts by ascending group, a
  negative group dropped).
- `sliceGeometry(g, plane: SlicePlane, opts?: SliceOptions): SliceResult` cuts by the plane
  `SlicePlane { nx, ny, nz, d }` (points with `n · p = d`; "above" is the side `n` points to)
  into `SliceResult { above; below }`. Triangles crossing it are split, the new corners' lanes
  interpolated (normals and tangents renormalised). `SliceOptions { cap? }`: with `cap: true` the
  cut's closed loops are triangulated into a cap on each half (below faces `+n`, above `-n`;
  planar uvs), so a closed mesh gives two closed halves; nested loops (a cut through a hollow
  shape) are capped as separate solids, not as holes. A plane missing the mesh returns a copy on
  one side and an empty part on the other. 3D and tangent layouts.

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
  `Transform.world` or a 4×4 column-major matrix: `ColliderTransform`; the `{ geometry }` form
  is `GeometryMeshSource`, and `PositionsSource { positions; indices; transform?; layer?;
  userData? }` is the positions-only form, three floats per vertex, for bakers and proxies that
  never had a render layout: ws/geom-3), `HeightfieldSource
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
  `raycastReg(c, ox, oy, oz, dx, dy, dz, maxDist, out, layerMask?)` is the same query in
  register form (eight numbers, nothing to allocate for the origin and direction; `raycast` and
  `slide`'s ground probe call it). `raycast2(c, ox, oz, dx, dz, maxDist, out, layerMask?)` casts
  in xz at the collider's mid height.
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
  reattached by source index); exporting an import gives identical bytes. `pnpm bake
  <config>` (`scripts/bake.mjs`, see the root README's *Baking*) runs this at build time from
  glTF or geometry JSON into `<name>.coll`; the game fetches the bytes and calls
  `importCollider`.
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

## Tile slide

`slide2` moves a shape against triangles; a platformer wants an axis-aligned box against tiles,
with one-way platforms and platforms that carry it. `slideTiles` is that (ws/geom-3), in screen
convention: **y grows downward**, so `+dy` falls and the ground is at `y + h`.

- `slideTiles(tiles, box: TileBox, dx, dy, out: TileSlideResult, opts?: TileSlideOptions)`.
  `tiles` is a `GridSource` (column `x`, row `z` as tile `(cx, cy)`, `origin` `[x, z]` as world
  x, y) or a `TileQuery { cellSize; origin?; solidAt(cx, cy): TileKind }`, `TileKind` being
  `TILE_EMPTY`, `TILE_SOLID` or `TILE_ONE_WAY`. `TileBox { x, y, w, h }` is the top-left corner
  and size; it is not changed (copy `out.x`, `out.y` back). Axis-separated, x then y, in
  sub-steps of at most half a tile (no tunnelling); each axis tests only the tiles past its
  leading edge, inset by a small epsilon, so a box sliding along a floor or wall of separate tiles
  never snags on their seams. A one-way tile holds a box only moving down whose bottom was at or
  above the tile's top; rising or sideways it passes. Allocation-free.
- `TileSlideOptions { oneWay?; stepUp?; movers? }`: `oneWay: false` drops through one-way tiles;
  `stepUp` (world units, default 0) lets a grounded box climb a ledge that low; `movers` are
  `TileMover` boxes (`TileBox` plus this tick's `dx`, `dy`), solid, and a box landing on one rides
  it.
- `TileSlideResult { x, y, dx, dy, onGround, hitCeiling, hitWall, riding, carried }` from
  `createTileSlideResult()`: `riding` is the mover index stood on, or -1. `carryBy(out, mover)`
  queues a mover's motion into `out.carried`, which the next `slideTiles` with that result applies
  first (still blocked by walls), then clears.

```ts
for (const m of movers) { m.dx = …; m.dy = …; m.x += m.dx; m.y += m.dy; } // platforms first
if (out.riding >= 0) carryBy(out, movers[out.riding]);
slideTiles(tiles, player, vx * dt, vy * dt, out, { movers, stepUp: 0.25 });
player.x = out.x; player.y = out.y;
if (out.onGround || out.hitCeiling) vy = 0;
```

## Geometry pipeline harness

`harness/geom3.html` (ws/geom-3): `?lod` (default) four rocks at rising distances, each drawn
at the level `selectLod` picks; `?hull` a torus beside its `convexHull`; `?slice` a cube cut by
a sweeping plane, capped; `?tiles` a box landing on a moving platform over a tile map and carried
by it; `?still` parks the animation. `e2e/geom3.spec.ts` checks the levels step with distance,
the hull is drawn, every cut is capped and closed, and the box rides the platform.

## Iso

The 2:1 diamond projection and its inverse (ws/ergo-2d-2), pure arithmetic in whatever 2D
space the caller works in (a tile layer's px, a camera's world px):

```ts
const iso = createIso({ tileW: 64, tileH: 32, elevH: 16, originX: 960, originY: 200 });
iso.toScreen(tx, ty, elev, pt);           // diamond centre of a tile (fractions allowed)
iso.toTile(sx, sy, elev, pt);             // fractional tile under a point, ground at elev
dp.order = base + iso.depth(tx, ty, elev); // painter's key: tx + ty, then elevation
if (isoInverseProbe(iso, px, py, heightAt, maxElev, pt)) hover(pt.x, pt.y);
```

- `createIso(opts: IsoOptions)` → `Iso`: `x = originX + (tx - ty) × tileW / 2`,
  `y = originY + (tx + ty) × tileH / 2 - elev × elevH` (`elevH` default `tileH / 2`; `originX`,
  `originY` are tile `(0, 0)`'s centre at elevation 0 and are live). `toScreen` / `toTile` fill
  an `IsoPoint` (`{ x, y }`: any `Vec2`, `CameraPoint`, `DrawParams`) and return it; no
  allocation. `depth(tx, ty, elev)` = `tx + ty + elev × ISO_ELEV_DEPTH` (`1 / 256`): monotone
  along the diagonals, elevation a tie-break inside one, equal for the tiles of one diagonal
  (they never overlap on screen).
- `isoInverseProbe(iso, sx, sy, heightAt: IsoHeightAt, maxElev, out)` is the pointer-to-tile
  rule of a map with elevation: it tries `maxElev` down to 0 and keeps the first tile whose
  `heightAt(tx, ty)` is that elevation, so a pointer over a raised tile's top lands on it and
  not on the flat tile the same pixel would cover at ground level. Returns true with the tile in
  `out`, or false with `(-1, -1)` (off the map, where `heightAt` returns a negative number, or
  over a riser between levels).
- `isoHiddenBy(iso, tx, ty, heightAt)` is true when the tile's whole top is covered by taller
  front neighbours: a column whose top is at least `tileH` above it (`tileH / elevH` steps; two
  with the defaults) covers its half of the diamond, so `(tx + 1, ty + 1)` hides it alone and
  `(tx + 1, ty)` with `(tx, ty + 1)` hide it together.

Harness: `harness/tiles.html?iso` lays a 12 × 12 map with a two-level ramp through a painter
`TileLayer` (`render/README.md`), walks a sprite between the tiles and resolves the hovered tile
with `isoInverseProbe`; `e2e/tiles.spec.ts` hovers every row of the ramp.
