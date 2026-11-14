# Brief: ws/models (C3)

Read `common.md`, `wave-2.0-1.md`, E-041, `docs/design/2.0/architecture.md` P6, P10 and **§2.6**, `src/geom/README.md`. Forge source (read only): `FW:render/models.ts`, `FW:render/model-scene.ts`, `FW:render/parts-shader.ts`, `FW:shaders/model-parts.ts`, and their tests (grep `FW:../test/`).

## Goal

Procedural part models as an engine module (`@thunderclap-engine/engine/models`): any asset-free 3D game builds machines, creatures and props from data. STATUS *done when*: "Forge's part-model tests ported; a non-Forge demo built from a part tree."

1. `PartModel` spec: shapes (box, cylinder, gear, ring, prism, frustum, wedge, plus `geom` primitives), grouping, turning, repeating; materials as a game-declared code table (Forge's 15 "MM" codes become one example table, not built in).
2. Motion bound to named state channels, evaluated in the shader from time and per-instance state.
3. `compileModel(spec, materials)` → packed units; a model scene placing instances by slot, writing instance data only on change. Draw through today's renderer for now (a Mesh per unit + instances, or a custom Drawable); B1's arenas will replace that later, so keep the packing separate from the draw.
4. A harness page `harness/models.html`: a toon windmill and a small walking machine (or similar) built from part trees, animated by channels.
5. Port the generic half of Forge's model tests.

## Files owned

New `src/models/**`, `package.json` (one `./models` export + publishConfig twin), `harness/models*`, its e2e spec.

## Gate

common.md.
