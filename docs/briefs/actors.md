# Brief: ws/actors (C4)

Read these first:
- `common.md`
- `wave-2.0-1.md`
- `wave-2.0-2.md`: your start point. You need B1 (a237c57) and C3 (f8af713). Branch from main if main has both. Otherwise merge `ws/core-retained` and `ws/models` into your branch, and merge main again once they land.
- E-041
- `docs/design/2.0/architecture.md` **§2.7** and §3.3
- `src/models/` (C3)
- `src/render/core/` (B1)
- `src/render/skin.ts` and `src/anim/`

Forge source, read only:
- `FW:actors/actor-draw.ts`
- `FW:actors/pose-shader.ts`
- `FW:actors/pose-cpu.ts`
- `FW:actors/layout.ts`
- `FW:actors/rig.ts`
- `FW:actors/actor-light.ts`
- their tests

## Goal

Many animated characters at a fixed draw count, rigid or skinned. ROADMAP *done when*: "1,000 actors in a fixed number of GPU calls; characters scene S2 on it with a skinned and a rigid crowd."

1. `createActorSystem(renderer, { slots, bonesPerSlot, recordLayout, lods })`:
   - a slot table of game-declared records;
   - one compute pass that copies, culls per view, picks the LOD and poses the bones;
   - indirect draws per model and LOD on the core.
2. `defineRig(parts | gltfSkin)`:
   - `'rigid'` rigs come from C3 part models: each part is a bone.
   - `'linear'` rigs come from glTF skins, using TC's SkinPalette and anim clips as the CPU source.
3. `setRecord(slot, typed)`. `poseCpu(slot, out)` is a CPU mirror for picking and attachments, and must match the GPU pose (tested).
4. Lighting is a hook: the game supplies `sampleLight(pos)` or a WGSL function. The engine's default is plain.
5. A new subpath `./actors`. A harness page with a crowd of 1,000: walking toon robots built from part models, plus skinned glTF figures if a test asset exists in the repo (otherwise a procedural skinned mesh).
6. A counted test: GPU calls stay flat from 100 to 1,000 actors, and a held frame makes 0 allocations.

## Files owned

- new `src/actors/**`
- `package.json`: one `./actors` export plus its twin
- `harness/actors*` and its spec

If you need a change in `src/models/` or `src/render/core/`, keep it additive and name it in your report.

## Gate

common.md. The actors spec must be green on Chromium and WebKit.
