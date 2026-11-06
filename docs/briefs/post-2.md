# Brief: ws/post-2

Read `docs/briefs/common.md` first, then DECISIONS E-015 (quality bar), E-021; `src/post/README.md` whole, `src/post/post-stack.ts` (pass order, half-res targets, how a pass is enabled from settings, how the composite reads its inputs), `src/post/shaders.ts` (one pass's WGSL end to end plus the composite), `src/post/settings.ts` (`PostSettings` sections, `defaultPostSettings`, the merge in `set`), `src/post/quality.ts`, `src/post/post-stack.test.ts` (fake-device pattern), `harness/depth-post.ts` and `e2e/depth-post.spec.ts` (how post-depth proved its passes on screen).

## Goal

The finishing passes a stylised or cinematic game reaches for after bloom and grade: an anti-aliasing pass, a colour LUT, film grain, chromatic aberration, a sharpen, and a depth/normal outline for toon looks. Each is a settings section, off by default, cheap, and provably on screen in the harness. Nothing changes in the renderer or the existing pass order; the new passes slot into the composite or follow it.

STATUS row, *done when*: `PostSettings` gains `fxaa: { enabled, subpixel?, edgeThreshold? }`, `lut: { texture: GPUTexture | null, size: 16 | 32, intensity }` with `createLutTexture(device, size, fn(r, g, b) → [r, g, b])` and `identityLut(device, size)`, `grain: { intensity, size, luminanceResponse, animated }`, `aberration: { intensity, radialOnly? }`, `sharpen: { amount }`, `outline: { color, thickness (px), depthThreshold, normalThreshold, intensity }` (outline needs depth; fall back to off with a one-time warn when the stack has no depth input); pass order documented: outline into the composite's colour before fog, grain/aberration/LUT/sharpen in the composite after grade and before vignette, FXAA as one extra full-res pass after the composite (only when enabled; zero cost otherwise); `PostQuality` caps `fxaa` and `outline` off on `low`; unit tests; harness `post2.html` on the matrix with a probe per pass; documented.

## Scope

- `src/post/shaders.ts`: WGSL for FXAA 3.11 (console quality preset, luma from the composite output), 3D LUT sample (texture_3d, trilinear, `intensity` lerp), grain (hash noise in screen space, scaled by `size`, less in highlights via `luminanceResponse`, time-seeded when `animated`), aberration (three radial offsets by `intensity`, `radialOnly` keeps the centre clean), sharpen (unsharp mask 5-tap, clamped), outline (Roberts cross on linear depth plus normals-from-depth, as post-depth's AO derives them; `thickness` samples the cross at that px distance). Keep every existing shader string byte-identical when its section is off: the 2D harness goldens and `depth-post.spec` probes must not move.
- `src/post/post-stack.ts`: an extra full-res target only when `fxaa.enabled`; the composite's bind group gains the LUT texture + sampler (a 1×1×1 identity when `lut.texture` is null) and a uniform block for the new sections; one `dt`-driven seed for grain.
- `src/post/settings.ts`: sections, defaults, merge; `quality.ts` caps. `src/post/README.md` *Passes, in order* rows and a *Finishing* subsection; *Easing between looks* notes which new fields ease (`intensity`, `amount`, `thickness`) and which switch.
- Tests: `post-stack.test.ts` (pass count with each section toggled, FXAA target allocation only when enabled, outline warns once without depth), `settings.test.ts` additions (merge, caps), `lut.test.ts` (`createLutTexture` writes `size³` texels, identity round trip on the CPU side).
- Harness `harness/post2.html` + `post2.ts` + `post2-state.ts`: a 3D scene with a hard-edged cube over a gradient; `?pass=fxaa|lut|grain|aberration|sharpen|outline` enables one; state exposes `edgeContrast` (pixel-pair contrast on a cube edge: FXAA lowers it, sharpen raises it), `lutShift` (a probe pixel moved by a red→blue LUT), `grainVariance` (variance over a flat patch), `aberrationSplit` (R vs B offset at a corner), `outlineHits` (dark px along the cube silhouette). `e2e/post2.spec.ts`: one assertion per pass against the `?pass=` off baseline, polled.
- Docs: post README, CHANGELOG one line, ARCHITECTURE *Post* one clause, root README harness list item.

## Files owned

`src/post/shaders.ts`, `post-stack.ts`, `settings.ts`, `quality.ts`, `lut.ts`, their tests, `src/post/index.ts` (append), `src/post/README.md`, `harness/post2.*`, `e2e/post2.spec.ts`, root `README.md` (harness list item), `ARCHITECTURE.md` (one clause), `CHANGELOG.md`.

Branch from `main` (0a07069 or later; post-depth is on main). Nothing else in flight touches `src/post`. Do not edit `src/render/*` (pbr-lights, nav, anim-graph, retarget are landing there); if a renderer hook is needed, document the wish. Running alongside: ws/geom-2, ws/ui-widgets, ws/audio-2, ws/save-2.
