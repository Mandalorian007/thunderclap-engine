# Brief: ws/billboards

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `src/fx/particles.ts` (`ParticleSystem`: camera-facing quads, its instance buffer, `draw(pass, frame)`), `src/fx/trail.ts` (`TrailFacing`), `src/render/frame.ts` (camera block, `frame.depthFormat`), `src/render/texture.ts` and `src/render/README.md` *Textures* (`renderer.textureFromSource`, default textures via `defaultTextures(device)`), `src/ui/text-scale.ts` (how the UI sizes text), `harness/trails.ts`.

## Goal

The things that float over characters in an action RPG: name plates, damage numbers, health bars, quest markers, pickup icons. World-anchored quads that face the camera, scale with distance or stay a fixed pixel size, fade with age, and carry either a texture region or text rendered once into a canvas atlas. One batch, one draw.

STATUS row, *done when*: `createBillboards(renderer, opts?: { capacity?: number (default 1024, grows), atlas?: { size?: number (default 1024), font?: string } })` → `Billboards { add(desc: BillboardDesc): BillboardHandle, remove(handle), update(dt), draw(pass, frame), text(text, style?: TextStyle): AtlasRegion (rasterises once into the atlas canvas, cached by text+style, LRU evicts when full), bar(fraction, size, fg, bg): BillboardDesc helper (two quads: background and fill), count, atlasTexture }`; `BillboardDesc { position: Float32Array | [x,y,z]; offset?: [x,y,z] (world-space offset, for a head height); size: [w,h] in world units or `{ px: [w,h] }` for screen-constant size; region?: AtlasRegion (uv rect) | null (solid colour); color?: rgba; facing?: 'camera' | 'cameraY' (yaw only); depth?: 'test' | 'always'; life?: number (seconds; fades out and auto-removes) ; velocity?: [x,y,z] (damage numbers drift) }`; `BillboardHandle { set position/color/size/region, alive }`; a vertex shader that reads camera right/up from the camera block and, for `px` sizes, the viewport size the frame exposes (add it to the camera block only if it is not there; name the change); harness `billboards.html`: six capsules with name plates, health bars and periodic damage numbers rising and fading, with state `{ count, atlasUsed, draws }`; `e2e/billboards.spec.ts` asserts a plate pixel above a known capsule, a damage number's upward drift between two `advance` calls, and auto-removal after `life`; 2D goldens delta 0; documented.

## Scope

- `src/fx/billboard.ts`, `billboard-wgsl.ts`, `text-atlas.ts` (an `OffscreenCanvas` when available, else `HTMLCanvasElement`; `renderer.textureFromSource` uploads it when dirty, once per frame at most). No DOM except the canvas. Text goes through `CanvasRenderingContext2D.fillText` with `TextStyle { font, size, color, stroke?, strokeWidth?, padding? }`.
- Blended, depth-tested but not depth-writing when `depth: 'test'`; sorted back-to-front within the batch.
- Tests: fake-GPU tests for buffer growth, add/remove/life, `px` sizing math (a unit test of the CPU side; the shader is tested on the harness), atlas packing and eviction with a stub 2D context.
- Docs: `src/fx/README.md` *Billboards*, `ARCHITECTURE.md` *FX* one sentence, `CHANGELOG.md`, root README harness list item.

## Files owned

`src/fx/billboard.ts`, `src/fx/billboard-wgsl.ts`, `src/fx/text-atlas.ts`, their tests, `src/fx/index.ts` (append), `src/fx/README.md` (*Billboards*), `harness/billboards.*`, `e2e/billboards.spec.ts`, root `README.md` (one item), `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`. If the camera block needs the viewport size: `src/render/frame.ts` and `src/render/wgsl.ts` camera struct only, as an append at the end of the block (ws/pbr-lights edits the light loop in `wgsl.ts`, not the camera struct; ws/batch-submit edits `frame.ts` draw list, not the camera block): keep both and name the edit in the report.

Branch from `main` (c2b552d or later). Running alongside: ws/debug-draw (`src/fx/debug-*`), ws/perf-overlay (`src/ui`), ws/pbr-lights, ws/batch-submit, ws/tween, demos. Use `E2E_PORT_OFFSET=260`.
