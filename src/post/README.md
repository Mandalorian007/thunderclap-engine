# engine/post

`PostStack` turns the renderer's HDR colour and emissive targets into the final swapchain
image. Every pass can be toggled, and every parameter can change at runtime.

```ts
import { PostStack } from '@thunderclap/engine/post';

const post = new PostStack(renderer, {
  godRays: { x: 960, y: -60 },   // light point in logical px (may be off-screen)
  fog: { density: 0.7 },
});
renderer.post = post;

post.set({ bloom: { intensity: 1.2 }, grade: { saturation: 1.2 } }); // merges per section
post.settings.fog.enabled = false;                                   // or mutate directly
```

Settings are packed into one uniform buffer each frame. Changing them never rebuilds
pipelines or bind groups.

## Easing between looks

`post.blendTo(patch, seconds, ease?)` moves settings over time instead of switching them
at once, so a mood change needs no covering wash.

```ts
import { easeOut } from '@thunderclap/engine/post';

post.blendTo({ grade: { exposure: 0.6, gain: [1.1, 0.9, 0.8] }, fog: { density: 0.9 } }, 3);
post.set({ godRays: { intensity: 0 } }).blendTo({ godRays: { enabled: true, intensity: 0.5 } }, 2, easeOut);
post.blending;      // true while anything is still moving
post.finishBlend(); // jump to the end values
```

- Numbers and RGB colours interpolate from their values at the time of the call. The default
  ease is smoothstep (`easeInOut`); `easeLinear`, `easeIn`, `easeOut` or any `(t) => t` also
  work.
- `enabled: true` applies at once, so set the pass's strength to 0 first to fade it in.
  `enabled: false`, `tonemap`, `dither` and `bloom.levels` switch when the blend ends, so a
  pass can fade out first.
- A later `set` or `blendTo` that touches the same key takes over from its current value.
  Other keys keep blending.
- Blends advance with the frame time passed to `beginFrame`, inside `encode`. Each step counts
  at most 0.1 s, so a hitch or a hidden tab slows a blend rather than skipping it. Without
  rendering, call `post.advanceBlend(time)` yourself.
- `PostBlender` is the same logic as a pure class (no GPU) for custom processors.
- Finishing passes (ws/post-2): `lut.intensity`, `grain.intensity`, `grain.size`,
  `grain.luminanceResponse`, `aberration.intensity`, `sharpen.amount`, `outline.thickness`,
  `outline.intensity`, `outline.color` and the two thresholds ease; `fxaa.enabled`,
  `outline.enabled`, `lut.texture`, `lut.size`, `grain.animated` and `aberration.radialOnly`
  switch (`lut.texture` and the booleans at the end of the blend, like any non-number).
- Nothing allocates per frame.

## Passes, in order

| Pass | Where | Key settings |
|---|---|---|
| Outline (ws/post-2) | scene res, over the scene depth | `outline.thickness` (px), `depthThreshold`, `normalThreshold`. A Roberts cross over linear depth and normals-from-depth written as an edge mask the composite mixes toward `outline.color` × `intensity` before fog. Off by default; off with a one-time warning when the frame has no depth. |
| AO (ws/post-depth) | half res, over the scene depth | `ao.radius` (world units), `intensity`, `bias`, `power`. Normals from depth derivatives; 12 (`aoSamples`) spiral samples rotated per pixel by interleaved-gradient noise. Under an ortho projection the screen radius drops the depth divide (`aoProjectedRadius`, ws/post-4), so it holds across zoom and distance. Off by default. |
| AO blur | half res | 4×4 depth-aware blur of the AO term. |
| TAA (ws/post-3) | scene res, over the scene depth, into an `rgba16float` history pair | `taa.feedback` 0.9, `sharpen` 0.2, `clampMode` `aabb` \| `variance`. Reprojects last frame's resolve by the previous view-projection against the current depth, clamps it to the 3×3 neighbourhood, blends. Since ws/post-4 the camera's projection carries the frame's Halton (2, 3) jitter (`wantsJitter`) and the reprojection comes from `PostInputs.view`; the resolve un-jitters by `view.jitter`. Since ws/post-5, with a velocity target and `taa.reprojection` `'velocity'` (the default) each pixel finds its history at `uv - velocity` (the nearest depth's in its 3×3; the camera matrix where nothing wrote one) and drops it where last frame's depth or velocity there disagree (`depthReject` 0.1 of the depth, `velocityReject` 2 px), from an `rgba16float` aux pair the resolve writes beside its history; `'camera'`, or no target, is the ws/post-4 path. The resolve replaces the scene colour downstream. Off by default; needs depth. |
| Motion blur (ws/post-3) | scene res, over the scene depth | `motionBlur.mode` `'object'` \| `'camera'`, `intensity`, `maxSamples` 8. Per-pixel velocity from the velocity target in `'object'` mode (ws/post-4: moving instances blur under a still camera), else, and where nothing wrote one, the depth reprojected by the previous view-projection; the colour gathered along it. Off by default; needs depth. |
| DoF (ws/post-depth) | half res, over the scene depth and colour | `dof.focusDistance`, `focusRange` (world units), `maxBlur` (px at output res), `nearBlur`. Circle of confusion from linear depth; 24 (`dofTaps`) golden-angle disc taps weighted by each tap's own CoC. Off by default. |
| SSR (ws/post-3) | half res, over the scene depth and colour | `ssr.maxSteps` 32, `thickness`, `maxDistance`, `roughnessCutoff` 0.6, `intensity`, `fadeEdges`. A view-space ray march from normals-from-depth (the AO helper), faded by roughness (per surface from the rough-metal target since ws/post-4, else a mirror) and at the screen edges, weighted by metalness over Schlick Fresnel, added to the scene before bloom. Off by default; needs depth. |
| Exposure histogram, exposure average (ws/post-3) | two compute passes over the scene colour | `exposure.histogramLow` 0.4, `histogramHigh` 0.95, `keyValue` 0.18, `minEv`, `maxEv`, `speedUp`, `speedDown`. A 64-bin log-luminance histogram, then the mean log luminance between the percentiles, read back the next frame; the EV eases toward the target. Only while `exposure.mode` is `'auto'`. |
| Bloom prefilter | half res | `threshold`, `knee` (soft knee on scene colour), `emissiveWeight` (the emissive target always blooms). Karis average to stop fireflies. |
| Bloom down/up | half-res mip chain, `levels` deep | 13-tap downsample, 9-tap tent upsample blended by `scatter` |
| God rays | half res | `x, y` light point, `intensity`, `decay`, `density`, `weight`, `color`. Marches 64 samples radially over a light disc (`sourceRadius`, `sourceIntensity`) plus `bloomSource` × bloom, so bright things in the scene also cast shafts. |
| Composite | full res → swapchain | colour × AO, blended toward the DoF result by CoC, + SSR, + emissive (sampled three times along the radius for `aberration`, then `sharpen`ed), outline, + `bloom.intensity` × bloom (× (1 + lens dirt)) + rays, then fog, white balance, exposure, tonemap, grade, LUT, grain, vignette, dither |
| FXAA (ws/post-2) | one extra full-res pass over the composite's output | `fxaa.subpixel`, `edgeThreshold`. FXAA 3.11 console preset on the display-encoded output. Only recorded (and its target only allocated) while `fxaa.enabled`, and skipped while TAA runs (ws/post-3). |

- **Fog** is a screen-space floor mist: a height band from `top` to `bottom` (0..1 of the
  screen, measured down) shaped by `falloff`. Animated fbm sets `noiseScale` and `speed`.
  `lightScatter` tints the mist with nearby bloom so glowing objects light it up.
- **Tonemap** is `'aces'` (the default), `'reinhard'`, or `'none'`, applied after `exposure`.
- **Grade** applies `lift`, `gamma`, and `gain` (RGB each), then `saturation` and `contrast`.
  It runs in display space after tonemapping.
- **Vignette** takes `intensity`, `radius`, `softness`, and `color`.
- **Dither** adds ±½ LSB of noise to hide banding in dark gradients.
- **AO** (`AoSettings`) and **DoF** (`DofSettings`) need the scene depth: the renderer fills
  `PostInputs.depth` (the target's `depth24plus` attachment) and `PostInputs.projection`
  (`near`, `far`, the camera's `proj`) on frames a depth camera rendered, else both are `null`
  and the stack skips both passes with the composite unchanged, so 2D pages stay pixel-identical.
  The passes allocate their half-res textures the first time they run and free them on resize.
  AO multiplies the scene colour only (not the emissive target). Both blend through `blendTo`
  (`enabled` and `nearBlur` switch when the blend ends).

### Finishing (ws/post-2)

Six sections, all off by default and free while off: with every one off the composite's
output is unchanged and no extra pass or texture exists.

- **FXAA** (`FxaaSettings`: `enabled`, `subpixel` 0.75, `edgeThreshold` 0.125) is one full-res
  pass after the composite (after the upscale under `compositeAtScene`), reading the
  display-encoded output. `subpixel` scales the blend, `edgeThreshold` the relative luma
  contrast below which a pixel is left alone. `PostQuality.fxaa` caps it off.
- **LUT** (`LutSettings`: `texture` null, `size` 32, `intensity` 1) looks the graded colour up
  in a `size`³ `rgba8unorm` 3D texture (red along x, green y, blue z, trilinear at texel
  centres) and lerps toward the result by `intensity`, after the grade and before the vignette.
  `createLutTexture(device, size, fn)` builds one from `(r, g, b) => [r, g, b]` on 0..1,
  `identityLut(device, size)` the neutral one, `lutTexels(size, fn)` the bytes alone (red
  fastest) for CPU-side checks. `size` is `LutSize` (16 or 32) and must match the texture; the
  stack binds a 1×1×1 placeholder while `texture` is null and destroys none of them.
- **Grain** (`GrainSettings`: `intensity` 0, `size` 1 px, `luminanceResponse` 0.5, `animated`
  true) adds hash noise per `size`-px cell to the graded colour, scaled by `1 − luminanceResponse
  × luma` so highlights stay clean; `animated` reseeds it with the frame time (`PostInputs.dt`),
  off it is a fixed pattern.
- **Aberration** (`AberrationSettings`: `intensity` 0 px, `radialOnly` true) samples the scene
  term's red and blue `intensity` scene px either side of green along the radius from the
  centre, scaled by radius² when `radialOnly` (the centre stays clean) or constant otherwise.
  It, and sharpen, work on the scene term (colour × AO, DoF, emissive) before bloom and fog so
  the bloom and the mist are not fringed; the LUT and grain come after the grade.
- **Sharpen** (`SharpenSettings`: `amount` 0) is a 5-tap unsharp mask on the scene term,
  clamped at zero.
- **Outline** (`OutlineSettings`: `enabled`, `color` black, `thickness` 1.5 px, `depthThreshold`
  0.03, `normalThreshold` 0.4, `intensity` 1) needs the scene depth like AO: a scene-res
  `r8unorm` mask from a Roberts cross `thickness` px out over linear depth (relative to the
  nearest tap, so far edges count less; the sky is very far) and over normals from depth (1 −
  cos between the diagonal taps). The composite mixes the scene toward `color` by mask ×
  `intensity` before fog, so the mist softens outlines with distance. Enabled on a frame without
  depth it stays off and warns once. `PostQuality.outline` caps it off.

When bloom is disabled the bloom chain is skipped. It still runs if god rays need it
(`bloomSource > 0`).

### Post 3 (ws/post-3)

Temporal anti-aliasing, screen-space reflections, auto exposure, white balance, camera motion
blur and lens dirt. Everything is off by default and free while off: with every section off
the uniform block carries identity matrices and zero flags, no extra pass or texture exists
and the 2D goldens are unchanged. TAA, SSR and motion blur need a frame with depth and a view
(the 3D path) and stay off, with the passes unrecorded, on a flat frame.

- **TAA** (`TaaSettings`: `enabled`, `feedback` 0.9, `sharpen` 0.2, `clampMode` `'aabb' |
  'variance'`) keeps a pair of `rgba16float` histories at scene res. Each frame reprojects the
  last resolve by the previous frame's view-projection (`taaReprojection(out, prevViewProj,
  invViewProj)`: current clip → previous clip) against the current depth, clamps it to the raw
  colour's 3×3 neighbourhood (min/max, or mean ± σ) and blends by `taaBlendWeight(feedback)`
  (capped at `TAA_MAX_FEEDBACK`); `sharpen` is an unsharp mask on the result. The resolve
  replaces the scene colour for every later pass, and FXAA is skipped while TAA runs
  (`PostStack.taaActive`). The first frame and every resize reset the history
  (`PostStack.historyResets` counts them). Jitter: `PostStack.taa` is a `Taa(samples)`
  (8 or 16) whose `jitter(frame)` returns the frame's `[x, y]` offset in px from the Halton
  (2, 3) sequence (`halton(index, base)`), zero-mean over a cycle and within ±0.5; the stack
  samples the raw colour at that sub-pixel UV offset, which is the hand-off until the camera
  can jitter its projection (see the wishes).
- **SSR** (`SsrSettings`: `enabled`, `maxSteps` 32, `thickness`, `maxDistance`,
  `roughnessCutoff` 0.6, `intensity`, `fadeEdges`) marches a reflected view-space ray from
  normals-from-depth at half res, `ssrStep(maxDistance, maxSteps)` per step, accepting a hit
  within `thickness` of the depth, and writes the scene colour there faded by
  `ssrEdgeFade(u, v, fadeEdges)` and `ssrRoughnessFade(roughness, cutoff)` and scaled by
  `intensity`; the composite adds it before bloom. Roughness is one global value (0) for now:
  every surface the depth covers is a mirror, so the standard material's roughness has no say
  until a target carries it (see the wishes). `PostStack.ssrActive` reads whether it ran.
- **Auto exposure** (`ExposureSettings`: `mode` `'manual' | 'auto'`, `minEv` -4, `maxEv` 4,
  `speedUp` 3, `speedDown` 1, `keyValue` 0.18, `histogramLow` 0.4, `histogramHigh` 0.95). In
  manual mode `grade.exposure` is the multiplier as before. In auto mode two compute passes
  build a 64-bin (`EXPOSURE_BINS`) log-luminance histogram of the scene colour over
  `EXPOSURE_LOG_MIN`..`EXPOSURE_LOG_MAX` (`exposureBin(luminance)`, `exposureBinLog(i)`) and
  average the bins between the percentiles; the value is read back through a staging buffer
  on a later frame (never a stall), the EV target is `exposureTarget(averageLog, keyValue,
  minEv, maxEv)` and `adaptExposure(ev, target, dt, speedUp, speedDown)` eases toward it with
  `PostInputs.dt`. `PostStack.exposure` is the current EV (`2^EV` multiplies the image).
  `exposureHistogram(rgba, count)` and `exposureAverage(hist, low, high)` are the CPU
  references of the two kernels, for tests.
- **White balance** (`WhiteBalanceSettings`: `temperature` 6500, `tint` 0) applies a 3×3
  matrix before the exposure and grade: `whiteBalanceMatrix(out, kelvin, tint)` is the
  Bradford chromatic adaptation transform (Lam 1985, as in ICC) from the 6500 K white to the
  black body at `temperature` (its chromaticity from `planckianXy(out, kelvin)`, Kim et al.
  2002, 1667..25000 K) shifted by `tint`, in linear sRGB. 6500 / 0 is the identity; a lower
  temperature warms the image.
- **Motion blur** (`MotionBlurSettings`: `enabled`, `intensity` 1, `maxSamples` 8) gathers the
  scene colour along each pixel's velocity, `motionVelocity(out, reproj, u, v, depth)`: the
  depth reprojected by the previous view-projection (the matrix TAA keeps), so only the
  camera's movement blurs (`PostStack.motionBlurActive`).
- **Lens dirt** (`BloomSettings.dirt?: LensDirtSettings` `{ texture, intensity }`) multiplies
  the bloom term by `1 + dirt × intensity`. `createLensDirtTexture(device, size = 256, seed)`
  paints a procedural `rgba8unorm` map of soft discs and streaks, `lensDirtTexels(size,
  seed)` its bytes; `texture: null` leaves the composite path unchanged.
- **Quality tiers**: `PostQuality` gains `taa`, `ssr`, `autoExposure`, `motionBlur`.
  `lowPostQuality()` switches SSR and motion blur off and keeps TAA (it is the cheapest
  anti-aliasing a phone has). `postQualityFor(tier: PostQualityTier)` gives the caps for
  `'phone'` (the low tier), `'tablet'`, `'desktop'` and `'xr'` (see XR).
- The uniform block is one struct, grown in place (`POST_UNIFORM_FLOATS`), and the settings
  test asserts the packed size equals the WGSL struct's for every field. `PostFrameState` is
  the per-frame part the stack fills (jitter, reset flag, reprojection, auto exposure).

The renderer provides what these passes asked for (ws/render-4; see *Camera jitter and
history* and *Aux targets* in `src/render/README.md`), and since ws/post-4 the stack reads it
all from `PostInputs`; see *Post 4*.

The harness page `harness/post3.html` (a lit scene with a mirror floor, a grey block and a
bright sky patch over a dark backdrop; `?taa ?ssr ?autoexp ?wb=3200 ?mblur ?dirt ?still`)
publishes the passes, the EV and the probes `e2e/post3.spec.ts` reads.

### Post 4 (ws/post-4)

The stack reads the frame from `PostInputs` only: nothing in src/post reads `renderer.camera`
(a test greps for it).

- **TAA on camera jitter.** `PostStack.wantsJitter` is true while `taa.enabled` and
  `quality.taa`, so the renderer applies the camera's jitter to the projection. (Since
  ws/post-6 the stack drives the jitter through `renderer.setJitter`, see Post 6; the
  post-4 `addJitterCamera` / `removeJitterCamera` are deprecated no-ops.) The
  reprojection is `taaReprojection(out, view.previousViewProj, view.invViewProj)`, and the
  resolve samples the colour, the neighbourhood and the depth at `uv + view.jitter / size`,
  so the history holds the unjittered image. The old sample-UV jitter is gone. With no
  `view` (a flat frame) the reprojection is the identity.
- **SSR per surface.** When the target has a rough-metal attachment (`aux.roughMetal`),
  SSR reads each pixel's roughness for `ssrRoughnessFade(roughness, roughnessCutoff)` and
  weights the reflection by `ssrSurfaceWeight(metalness, cosView)`: Schlick Fresnel with F0
  0.04, mixed to 1 by metalness. Without the attachment every surface is a mirror, as before.
  The march also handles ortho projections.
- **Object motion blur.** `MotionBlurSettings.mode: MotionBlurMode` (`'object'` by default,
  or `'camera'`). In `'object'` mode, when the target has a velocity attachment, each pixel
  blurs along its own velocity, so a moving `InstanceList` blurs under a still camera. A pixel
  with zero velocity (nothing wrote one) falls back to the camera reprojection. `'camera'` is
  the post-3 behaviour. `mode` snaps at the end of a blend.
- **AO under ortho.** `PostDepthInfo.ortho` (from `proj[11] === 0`) drops the depth divide
  from the screen radius (`aoProjectedRadius(radius, projScale, z, ortho)`), so the term
  holds across zoom and distance.
- **Settings.** `clonePostSettings(s)` deep-copies a settings object (arrays and sections)
  and shares the GPU handles (`lut.texture`, `bloom.dirt.texture`). The blender's snap keys
  are qualified by section (`bloom.levels`, `lut.size`, `lut.texture`, `motionBlur.mode`).
- New uniform fields: `quality.z` (ortho), `taa2.xy` (jitter in uv), `ssr2.w` (rough-metal
  bound), `motionBlur.w` (object velocity bound). `POST_UNIFORM_FLOATS` is unchanged (188).

The harness page `harness/post4.html` (`?taa ?ssr ?blur ?ortho ?still`) measures each
feature against a reference stack with the feature off, read back from the GPU, for
`e2e/post4.spec.ts`.

### Post 5 (ws/post-5)

- **TAA velocity reprojection.** `TaaSettings.reprojection: TaaReprojection` (`'velocity'`
  default, `'camera'`), `depthReject` (0.1) and `velocityReject` (2 px). With
  `PostInputs.velocity` and `'velocity'`, the resolve takes the velocity of the nearest depth
  in the pixel's 3×3 and samples the history at `uv - velocity` (falling back to
  `view.previousViewProj` where the target is zero), so a moving or skinned object keeps its
  own history instead of the background's. The resolve writes a second target beside each
  history (`TAA_AUX_FORMAT` `rgba16float`: velocity in uv, linear depth) and drops the history
  where the aux at `uv - velocity` differs from the pixel by more than `depthReject` of the
  nearer depth or `velocityReject` px (`taaRejects(...)` is the CPU twin); the 3×3 clamp is
  unchanged. Without the target, or in `'camera'`, the ws/post-4 resolve runs unchanged.
  `PostStack.taaVelocityActive` says which path the last frame took.
- The internal `DepthPass` takes several target formats (`format: GPUTextureFormat | GPUTextureFormat[]`,
  `encode(..., extraTargets)`).
- New uniform fields: `taa2.w` (velocity reprojection) and, appended after `reproj`, `taa3`
  (`depthReject`, `velocityReject`); `POST_UNIFORM_FLOATS` is 192.
- `harness/post4.html?taa` adds a striped cube sliding through an `InstanceList` with
  velocity under the still camera, read against the TAA-off frame with `'camera'`
  (`ghostObjectCamera`) and `'velocity'` (`ghostObject`); `e2e/post4.spec.ts` wants the
  velocity ghost at most half the camera one.

### Post 6 (ws/post-6)

- **Jitter source.** While TAA runs (`wantsJitter`), the stack hands the renderer its Halton
  (2, 3) sequence through `renderer.setJitter(fn)` from its first TAA frame, so every camera
  the renderer draws is jittered. When TAA stops (`taa.enabled` or
  `quality.taa` off) or on `destroy()`, it calls `renderer.setJitter(null)` once, which clears
  the jitter and restarts the cycle. A hook someone else sets while TAA runs is left alone
  until TAA stops. Nothing in src/post calls `Camera.setJitter` (a test greps for it).
  `addJitterCamera` / `removeJitterCamera` are deprecated no-ops.
- **History filter.** `TaaSettings.historyFilter: TaaHistoryFilter` (`'catmull-rom'` default,
  or `'bilinear'`). `'catmull-rom'` samples the history with a 5-tap Catmull-Rom (the two
  middle taps per axis folded into one bilinear tap, the corners dropped, normalised by the
  weights; `taaCatmullRomWeights(f)` is the CPU twin of the weights) before the 3×3 clamp,
  so a sub-pixel move no longer softens the history a little every frame. `'bilinear'` is the
  ws/post-5 sample. Packed into `taa3.z`; `POST_UNIFORM_FLOATS` is unchanged (192).
- `harness/post4.html?taa` adds a sub-pixel phase: the striped cube creeps 0.37 px a frame
  with the jitter on, and a bilinear twin stack resolves the same frames as the Catmull-Rom
  one. `blurSubpixel*` is the share of horizontal gradient energy over the cube lost against
  the TAA-off frame, `ghostSubpixel*` the mean difference beside it. `e2e/post4.spec.ts`
  wants less blur with Catmull-Rom than bilinear and no more ghost.

## Notes

- `defaultPostSettings()` is tuned for a dark, jewel-toned scene: a strong emissive glow, a
  cool mist on the floor, and pale storm rays from above.
- Output is encoded to sRGB in the shader because the swapchain is `bgra8unorm`.
- All intermediate textures are reallocated only on resize (or a bloom level cap change).
- **Quality caps** (`PostQuality`, `post.quality`, `defaultPostQuality()`) are separate from
  the look: `post.setQuality({ maxBloomLevels, raySamples, fogOctaves, compositeAtScene, aoSamples, dofTaps, fxaa, outline })`
  (defaults 8, 64, 5, false, 12, 24, true, true; `compositeAtScene` composites at the scene's
  resolution and upscales when the scene is smaller than the output; `fxaa` and `outline` false
  cap those passes off whatever the settings say). `lowPostQuality()` is the low tier (4, 24, 3,
  true, 6, 12, false, false). Fewer ray samples rescale decay and weight
  per step so the shafts keep their reach; fewer fog octaves add back the dropped octaves'
  mean so the mist keeps its density. Bloom, rays, AO and DoF run at half the scene resolution;
  the composite runs at output resolution and samples the scene by UV. `aoSamples` is clamped
  to 4..16 and `dofTaps` to 8..32.
- Write your own processor by implementing `PostProcessor { resize(w, h); encode(encoder,
  inputs, outputView, viewport?) }` and assigning it to `renderer.post`. `viewport` (texture px)
  asks for the result in that part of the output only, loading the rest; the inputs may differ
  in size from the last `resize`, so size yourself to them (see XR).

## XR (ws/xr-post)

The stack runs per eye, so a headset sees the same bloom, tone map and grade as the screen.
`createGame`'s XR render step renders each eye into the surface's eye-sized HDR `scene` target
and calls `renderer.resolve(scene, eye.target.color.view, eye.viewport)`, which runs
`renderer.post` (this stack) from that target into the eye's part of the session's layer
texture; `renderer.endFrame({ present: false })` then only submits. Inside `encode`:

- Inputs of another size than the last `resize` (the eye, not the canvas) resize the stack
  first, once; leaving VR resizes it back on the first page frame. Steady state allocates nothing.
- With a `viewport` the composite (or the `compositeAtScene` upscale) sets viewport and scissor
  to it and loads the rest of the output instead of clearing, so the second eye keeps the first;
  `compositeAtScene` compares the scene size with the viewport, not the canvas.
- Both eyes share the bloom chain and ray textures (the passes run one eye after the other on
  one encoder), so VR costs no extra HDR allocation. Settings and blends apply to both eyes;
  `godRays.x/y` stay in logical px of the design space.
- Output is encoded to sRGB as on screen, so the layer is made in the swap-chain format
  (`XrSurfaceOptions.colorFormat = renderer.format`).
- `postQualityFor('xr')` keeps TAA, SSR and motion blur off (ws/post-3): the stack composites
  one eye at a time through a single history pair and one previous view-projection, so a TAA
  resolve or a velocity would mix the left eye's last frame into the right eye; per-eye
  histories are the step that lifts the cap. Auto exposure runs per eye on the same readback.

## Types

- `PostSettings` has one section per pass: `bloom: BloomSettings`, `fog: FogSettings`,
  `godRays: GodRaySettings`, `vignette: VignetteSettings`, `grade: GradeSettings` (which holds
  `tonemap: Tonemap`), `ao: AoSettings`, `dof: DofSettings`, and the finishing sections
  `fxaa: FxaaSettings`, `lut: LutSettings`, `grain: GrainSettings`, `aberration:
  AberrationSettings`, `sharpen: SharpenSettings`, `outline: OutlineSettings`, and the post-3
  sections `taa: TaaSettings` (its `reprojection` a `TaaReprojection`, `'camera' |
  'velocity'`, ws/post-5; its `historyFilter` a `TaaHistoryFilter`, `'bilinear' |
  'catmull-rom'`, ws/post-6), `ssr: SsrSettings`, `exposure: ExposureSettings`,
  `whiteBalance: WhiteBalanceSettings`, `motionBlur: MotionBlurSettings` (its `mode` a
  `MotionBlurMode`, `'camera' | 'object'`, ws/post-4). `RGB` is
  `[r, g, b]`. `LutSize` is `16 | 32`; `LutFn` is `(r, g, b) => readonly [r, g, b]`.
- `PostSettingsPatch` is a per-section partial of `PostSettings`, the argument of `new
  PostStack(renderer, patch?)`, `set` and `blendTo`. `applyPostPatch(target, patch)` merges one
  into a settings object in place (shallow per section); `defaultPostSettings()` returns a
  fresh default; `clonePostSettings(s)` a deep copy sharing GPU handles.
- `Ease` is `(t: number) => number` on 0..1.
  The easing functions (`easeLinear`, `easeIn`, `easeOut`, `easeInOut`) are aliases of the
  table in `@thunderclap/engine/tween` (`ease.linear`, `ease.quadIn`, `ease.quadOut`,
  `ease.smoothstep`), which also has the full set.
