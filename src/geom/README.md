# `@thunderclap/engine/geom`

Procedural geometry: primitive builders, heightfields and the tools to combine them. Pure
arithmetic, no GPU; the only `render/` imports are types (`MeshBounds`, `VertexLayout`,
`VERTEX_LAYOUT_3D`). Every builder returns a `Geometry` in `VERTEX_LAYOUT_3D` (12 floats per
vertex: position, normal, uv, rgba), which is a `MeshDesc`, so `renderer.createMesh(geometry)`
takes it as it is.

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
sine bump map; `e2e/geom.spec.ts` checks the shape count, lit probe pixels and `heightAt`.
