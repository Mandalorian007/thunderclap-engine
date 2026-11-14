# Brief: ws/core-passes (B4)

Read:
- `common.md` and `wave-2.0-3.md`
- `docs/design/2.0/architecture.md` (R1–R3: passes and drawables on the core)
- `src/render/core/README` / ARCHITECTURE "Immediate on the core" and "Views"
- the B2 and B3 CHANGELOG entries

Merge ws/core-views and ws/core-immediate first if they aren't on main yet.

## Goal

The full-screen and lighting passes run as passes on the render core, and everything the core owns survives a device loss.

1. **Post and anti-aliasing** (`src/post/**`) become core passes in the PassList:
   - the whole stack (exposure, LUT, AO, DOF, motion blur, lens dirt, blend) and TAA/FXAA;
   - each one per view, so stereo runs each pass once per eye (no shared history across eyes).
2. **Sky** (`src/fx/sky*`): a core pass drawn per view.
3. **Sun shadows** (`src/render/shadow.ts`):
   - a cascade pass that uses B3's `CullGroup` as its cull unit, so draw sets, models and actors cast shadows through the same bundles;
   - B2's runs encode in the shadow pass too (B2's "runs only in main pass" leftover).
4. **Device loss:**
   - The core keeps a rebuild list. Arenas, DrawSets, bundles, pipelines, passes, mesh-run pools and actor buffers (`src/actors`, register only) rebuild from their descriptors.
   - The game sees one `deviceRestored` event.
   - Test it on the fake GPU (forced loss) and in WebKit (`device.destroy()`).
5. **Leftovers:**
   - optional render targets (emissive etc.) created on first use (B2's deferred item);
   - `Renderer.buildDraws` grows `sortedData` when chunks enter view (renderer.ts ~2057). Make it pooled, so 0 allocations in A4's voxel ref scene.

6. **Core-in-Renderer and streaming** (C2's asks):
   - draw the core's sets inside a `Renderer` frame (its passes, depth and targets), so `demos/voxel` can move onto `createVoxelWorld`. Then move the demo and remove `src/voxel/chunks.ts` and the old mesher, with Breaking notes;
   - a real hidden bit per slot;
   - while streaming, at most one bundle rebuild per frame, coalesced (a rebuild every upload frame dominates the hitch).

## Done when

- All 3D harness pages are pixel-identical (`snap:check`, plus the ref scenes in A4's BENCH section), or each difference is named in the CHANGELOG with a reason.
- A forced device loss recovers on the fake GPU and in WebKit.
- The stereo page runs post and shadows per eye.
- The A4 ref-scene budgets are re-written (`TC_REF=write`) only where counts improve or are explained.

## Size

L. If it runs past about 4k lines, ship 1, 4 and 6 first, then 2, 3 and 5; report what's left.

## Not yours

Particles, water, decals and weather belong to B5. XR session code belongs to C8.
