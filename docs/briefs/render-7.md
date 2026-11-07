# Brief: ws/render-7

Read `docs/briefs/common.md` first. Then read the ws/render-5, ws/render-6 and ws/adoption-3 rows and notes in `docs/STATUS.md`, including the wishes this closes: *LOD hysteresis keyed by a stable id rather than index* (adoption-3) and *per-instance velocity on LOD lists* (render-6, adoption-3). Then read `src/render/README.md` (*LOD*, *Instancing*, *Aux targets*) and `src/render/{lod,instance-list,frame,renderer}.ts` and their tests.

## Goal

Instanced LOD stays stable when instances come and go, and instanced objects show up in object motion blur.

STATUS row, *done when*:

- **Stable LOD keys.**
  - `InstanceList` LOD entries accept an optional `key` (number) per instance.
  - When a key is given, level memory (hysteresis) follows the key, not the index. Without keys, behaviour is as today.
  - Unit test: removing instance 0 of 10 does not change any other instance's chosen level for one frame (with keys); it does without keys, as today.
- **Per-instance velocity.**
  - When the velocity aux target is on, instanced draws, LOD lists included, write per-instance motion from each instance's previous transform, matched by key or, with no key, by index.
  - A new instance writes zero velocity on its first frame.
  - Unit test against the fake GPU: the instance buffer carries the previous model matrix and the shader variant is chosen.
  - Harness: a new `render7` page (`?lod-keys`, `?instanced-velocity`, `?still`) with state fields for the level-change count and the velocity mean of moving and static instances. Add `e2e/render7.spec.ts`.
- **No change without the features.** The 2D goldens stay pixel-identical. `render4`, `render5`, `post4` and `pbr` stay green.
- **Docs.** The render README sections, the types list, a CHANGELOG block, and one ARCHITECTURE sentence in the render clause.

## Files owned

You own:
- `src/render/**`
- new `harness/render7*`
- `e2e/render7.spec.ts`
- `CHANGELOG.md`
- the one ARCHITECTURE sentence

Do not edit:
- `src/post/**` (ws/post-6 is landing; post reads the velocity target as it is)
- `demos/**`
- `templates/**`

Branch from `main` (bd73c67 or later). Use `E2E_PORT_OFFSET=1070`. Gate per E-031 with render4, render5, render7, post4, pbr and views each run alone.
