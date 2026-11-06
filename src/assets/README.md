# engine/assets

Asset formats the engine turns into its own objects. Today: glTF 2.0 geometry, skins and
animations. No dependencies, no network: the game fetches the bytes, the engine parses and
uploads them.

## glTF in one call

```ts
import { loadGltf, parseGltf } from '@thunderclap/engine/assets';

const bytes = await (await fetch('scene.glb')).arrayBuffer(); // the game's fetch, not ours
const doc = parseGltf(bytes);                                  // engine-free document
const scene = await loadGltf(renderer, doc);                   // meshes, transforms, textures, materials

// each frame, inside render:
frame.lights = lights;
scene.draw(frame);          // one frame.mesh(...) per node × primitive, no allocation
```

`parseGltf(source: ArrayBuffer | GltfJsonSource): GltfDocument` reads a `.glb` (GLB container,
JSON + BIN chunk) or a `.gltf` (UTF-8 JSON bytes, or `{ json, buffers? }` where `buffers[i]` is the
`ArrayBuffer` for `buffers[i].uri`). `data:` URIs decode in place (`decodeDataUri(uri)` is the
helper, returning `{ bytes, mimeType }`). Anything still external is listed in
`doc.externalUris`; a buffer that is external and not supplied throws naming the uri, an image
that is external is left for the loader.

`loadGltf(renderer: Renderer, doc: GltfDocument, opts?: LoadGltfOptions): Promise<GltfScene>` builds
one `Mesh` per primitive in `VERTEX_LAYOUT_3D` (`interleave3d(primitive)` makes the float
buffer: `x y z nx ny nz u v r g b a`), one `Transform` per node (parented like the file), one
`Texture` per image a texture uses (`rgba8unorm-srgb`, full mip chain through `generateMipmaps`
unless `mips: false`), and one lit `Material` per glTF material (`GLTF_LIT_WGSL`: base colour
texture × vertex colour × base colour factor as the instance tint, `engine_lambert` plus a touch of
sky, `MASK` cutoff in `params.x`, `BLEND` as alpha blend). Options:

| `LoadGltfOptions` | |
| --- | --- |
| `resources` | `Record<uri, ArrayBuffer | GltfImageSource>` for `doc.externalUris`; a missing image uri throws `image i: missing external resource "uri"` |
| `material` | one `Material` for every draw; `scene.materials` stays empty and the file's materials are only read for tint and cutoff |
| `label` | prefix for GPU labels (default `gltf`) |
| `mips` | mip chains on (default true) |
| `decodeImage` | `(bytes, mimeType) => Promise<GltfImageSource>`; default `createImageBitmap` on a `Blob`, so Workers and tests can supply their own |

`GltfImageSource` is `ImageBitmap | HTMLCanvasElement | OffscreenCanvas`.

`GltfScene` owns what it made: `meshes`, `textures`, `materials`, `transforms` (one per node,
file order), `nodes: GltfSceneNode[]` (the draw list: `{ node, transform, mesh, material, params,
skin }` with `params` an `InstanceParams` built once and `skin` the node's skin index or null),
`skins` and `animations` (the document's, passed through), `bounds: { center, radius }` in world
space, `draw(frame)` and `destroy()` (meshes, textures, its own materials; not `opts.material`).

## The document

`GltfDocument` is plain data, usable without a GPU (a Worker can parse and post it):

- `version`, `scene` (root node indices), `sceneNodes` (every node in the scene, parents first),
  `warnings` (`extension ignored: X` for each `extensionsUsed`), `externalUris`, `bounds`
  (`GltfBounds`: `min`, `max`, `center`, `radius`, in world space).
- `nodes: GltfNode[]`: `name`, `parent`, `children`, `mesh`, `skin`, `translation`, `rotation`,
  `scale` (`Vec3`/`Vec4`; a `matrix` node is decomposed), `local` and `world` as the engine's 3×4
  row-major `Float32Array` (`composeTrs(t, q, s, out)` builds one the way `Transform` does).
- `meshes: GltfMesh[]`: `name`, `primitives: GltfPrimitive[]` with `vertexCount`, `position`,
  `normal` (flat normals computed when the file has none: `hadNormals` false, the primitive
  unwelded), `uv0` (zeros when missing), `color0` (ones when missing, `VEC3` padded), `indices`
  (`Uint16Array` or `Uint32Array`, generated when missing), `material`, `bounds`, and for skinned
  primitives `joints` and `weights` (below). Triangles only.
- `skins: GltfSkin[]` and `animations: GltfAnimation[]`: see *Skins and animations*.
- `materials: GltfMaterial[]`: `name`, `baseColorFactor`, `baseColorTexture` (texture index),
  `texCoord`, `doubleSided`, `alphaMode: GltfAlphaMode` (`'OPAQUE' | 'MASK' | 'BLEND'`),
  `alphaCutoff`. The engine's 3D pipelines cull nothing, so `doubleSided` is informational.
- `textures: GltfTexture[]`: `name`, `source` (image index), `wrapS`, `wrapT`, `magFilter`;
  `images: GltfImage[]`: `name`, `bytes` (embedded or `data:`), `mimeType`, `uri` (external).

Accessors: every `GltfComponentType` (5120–5126), every `GltfAccessorType`, `byteStride`,
`normalized` integers. Sparse accessors, non-triangle modes, `extensionsRequired`, a missing
`POSITION`, a buffer too short for its view, a node with two parents or in a cycle, and anything
else the parser cannot honour throw `GltfError` (message prefixed `gltf: `).

The JSON shapes the parser reads are exported for writers and tests: `GltfJson`,
`GltfJsonAccessor`, `GltfJsonBufferView`, `GltfJsonPrimitive`, `GltfJsonNode`,
`GltfJsonMaterial`, `GltfJsonSkin`, `GltfJsonAnimation`, `GltfJsonAnimationChannel`,
`GltfJsonAnimationSampler`, `GltfJsonInterpolation`, `GltfJsonSource`.

## Skins and animations

A rigged character from a DCC tool parses straight into the shapes `@thunderclap/engine/anim`
samples and `VERTEX_LAYOUT_SKINNED` draws, with no converter. `assets` does not import `anim`:
the types below restate `AnimationClip`, `AnimationChannel` and `Skeleton` structurally, so a
`GltfAnimation` is an `AnimationClip` and a `GltfSkeleton` is a `Skeleton`.

- `GltfSkin` (`doc.skins[i]`, `node.skin`): `name`, `joints` (node index per joint), `skeleton`
  (the root node the file named, or null) and `inverseBind`: 12 floats per joint, the engine's
  3×4 row-major layout (`anim`'s `skinMatrices` and `render/skin.ts` read it), converted from the
  file's column-major `MAT4`; identity when the file has none.
- `GltfAnimation` (`doc.animations[i]`): `name` (the file's, or `animation<i>`), `duration` (the
  last keyframe over every channel) and `channels: GltfAnimationChannel[]`, each `{ node, path,
  interpolation, times, values }` with `path: GltfAnimationPath` (`'translation' | 'rotation' |
  'scale' | 'weights'`), `interpolation: GltfInterpolation` (`'STEP' | 'LINEAR' | 'CUBICSPLINE'`),
  `times` ascending seconds and `values` 3, 4 or `k` floats per key (quaternions exactly as
  stored, xyzw), or in-tangent, value, out-tangent triplets per key for `CUBICSPLINE`, glTF
  sampler semantics throughout. A channel without a target node is skipped with a warning.
- `GltfPrimitive.joints`: `JOINTS_0` from any unsigned integer type, 4 per vertex, a
  `Uint8Array` when every index fits a byte, else a `Uint16Array`; `GltfPrimitive.weights`:
  `WEIGHTS_0` as 4 floats per vertex (normalised integers divided). Both or neither, else
  `GltfError`; both follow the unwelding when flat normals are generated.
- `interleaveSkinned(primitive): SkinnedVertices` (`{ vertices: ArrayBuffer; layout: 'skinned' }`)
  packs `SKINNED_VERTEX_STRIDE` (56) bytes per vertex: the 12 `VERTEX_LAYOUT_3D` floats, the four
  joint bytes at `SKINNED_JOINTS_OFFSET` (48), the four weights as `unorm8` at
  `SKINNED_WEIGHTS_OFFSET` (52), renormalised and rounded so they sum to exactly 255. Throws for
  an unskinned primitive or joint indices above 255.
- `skeletonFromSkin(doc, skinIndex): GltfSkeleton` spans every node of the document, so a
  channel's `node` indexes the pose directly: `parents: Int16Array` (-1 for a root), `rest`
  (10 floats per node from its TRS: `tx ty tz qx qy qz qw sx sy sz`), `inverseBind` (the skin's
  array, shared) and `joints: Uint16Array` (node per joint).

`loadGltf` passes `skins` and `animations` through on the `GltfScene` and sets `skin` on each
draw. A skinned primitive is built in the skinned layout once `VERTEX_LAYOUT_SKINNED` exists in
`render/mesh.ts`; until then it is built in `VERTEX_LAYOUT_3D` and the joints and weights stay on
the document.

## Bundles

A manifest is a typed map of keys to entries, and a bundle loads it from bytes the game supplies.
The engine never fetches: the only I/O is the game's `read(uri)` (VISION rule 4), so a bundle works
the same over `fetch`, a zip in memory, IndexedDB, or an Electron file read.

```ts
import { createBundle, defineManifest } from '@thunderclap/engine/assets';

const manifest = defineManifest({
  hero: { kind: 'texture', uri: 'hero.png', options: { mips: false } },
  tiles: { kind: 'texture-array', uris: ['grass.png', 'stone.png'] },
  level: { kind: 'gltf', uri: 'level.gltf', resources: { 'level.bin': 'bin/level.bin' } },
  jump: { kind: 'audio', uri: 'jump.wav' },
  config: { kind: 'json', uri: 'config.json' },
  credits: { kind: 'text', uri: 'credits.txt' },
  raw: { kind: 'bytes', uri: 'table.bin' },
  icon: { kind: 'image', uri: 'icon.png' },
  sprites: { kind: 'atlas', uris: { coin: 'coin.png', gem: 'gem.png' }, options: { padding: 2 } },
});

const bundle = createBundle(manifest, {
  read: async (uri) => (await fetch(`assets/${uri}`)).arrayBuffer(),
  renderer,
  audio: audioEngine, // or an OfflineAudioContext, to decode before the first gesture
});
bundle.on('progress', (p) => bar.set(p.fraction));
await bundle.load();
const hero = bundle.get('hero'); // Texture
const sprites = bundle.get('sprites'); // AtlasAsset<'coin' | 'gem'>
```

**Manifest.** `defineManifest(entries)` is an identity function that keeps the literal types, so
`bundle.get(key)` returns the right asset type (`AssetOf<Entry>`). `ManifestEntry` is one of
`TextureEntry` (`Texture`), `TextureArrayEntry` (`Texture` with layers, every uri the same size),
`GltfEntry` (`GltfScene`; `.gltf` buffers and images listed in `externalUris` are read through
`read` too, with `resources` mapping a relative uri to the one to read), `AudioEntry`
(`AudioBuffer`), `JsonEntry` (`unknown`), `TextEntry` (`string`), `BytesEntry` (`ArrayBuffer`),
`ImageEntry` (`ImageBitmap`) and `AtlasEntry` (`AtlasAsset`: `texture`, `rects`, `layout`, see
*Atlas*). `AssetKind` is the union of their `kind`s and `Manifest` the map type. A texture entry's
`options` are `LoadTextureOptions`; a gltf entry's are `LoadGltfOptions`.

**The `read` contract.** `AssetReader = (uri: string) => Promise<ReadResult>`, where `ReadResult`
is an `ArrayBuffer`, a `Blob`, an `ImageBitmap` (for the image kinds), or `{ data, total? }` with
`total` the size in bytes, so `progress.bytes` and `bytesTotal` can be reported. A thrown or
rejected `read` fails that key (after `retries` more attempts); the bundle never retries a decode.
One uri shared by several entries is read once per `load`, and its bytes are counted once.

**Options** (`BundleOptions`): `read` (required), `renderer` (needed by texture, texture-array,
gltf and atlas entries; without it those keys fail with a message naming the option), `audio`
(`AudioDecoder`: an `AudioEngine`, whose `context` is null before the first gesture, or any object
with `decodeAudioData` such as an `OfflineAudioContext`), `concurrency` (reads in flight, default
4), `retries` (default 0), `priority(key)` (higher first among queued reads), `strict` (reject
`load` on the first failure and cancel the rest), `decodeImage(blob)` (default
`createImageBitmap`).

**Bundle** (`Bundle<M>`): `load(keys?)` loads everything or the listed keys and resolves when they
have settled; `progress: BundleProgress` (`loaded`, `failed`, `total`, `bytes`, `bytesTotal`, which
is null until every read has reported a total, and `fraction = (loaded + failed) / total`);
`errors: BundleError[]` (`key`, `uri`, `message`, `cause`); `get`, `has`; `on(event, fn)` for
`BundleEvents` `progress`, `asset` (`{ key, asset }`), `error` and `done` (fired once per `load`
that was not cancelled); `cancel()` stops queued reads, lets in-flight ones finish and keeps the
cancelled keys in `total` so `fraction` stays below 1 until a later `load` resumes them;
`release(key?)` destroys a texture or scene, closes a bitmap and forgets the key; `dispose()` is
cancel, release all and drop listeners. Failed assets count toward `fraction` so a bar still
reaches 1; a failed key loads again on the next `load`.

## Atlas

`packAtlas(images, options?)` packs named images into one sheet with shelf packing and returns an
`AtlasLayout`: `width`, `height`, `rects: Record<name, AtlasRect>` (`x`, `y`, `w`, `h` in pixels
and `u0`, `v0`, `u1`, `v1` normalised) and `draw(ctx)`, which draws every image into a 2D context
(`AtlasDrawContext`: `drawImage`, `createImageData`, `putImageData`). An `AtlasSource` is an
`ImageBitmap`, a canvas, or `AtlasPixels` (`width`, `height`, RGBA `data`). `AtlasOptions`:
`padding` (gap between sprites, default 1), `extrude` (edge pixels repeated around each sprite so
bilinear sampling and mips do not bleed, default 1; `extrudePixels` does it for raw pixels),
`maxSize` (default 4096; packing throws naming the image that does not fit), `powerOfTwo`
(default true) and `sort` (tallest first, default true; `false` keeps input order). The sheet is
never taller than wide. Packing is deterministic for the same inputs.

`createAtlasTexture(device, layout, images, options?)` draws the layout into an `OffscreenCanvas`
and uploads it with `loadTexture`, returning an `AtlasTexture` (`texture`, `rects`);
`AtlasTextureOptions` are `LoadTextureOptions` plus `canvas` to supply the canvas. An `atlas`
manifest entry does all of this from the uris; draw a sprite from it with
`frame.sprite(material, { x, y, w, h, uv: [r.u0, r.v0, r.u1, r.v1] })`.

## Not yet

Morph targets (the `weights` channel parses; nothing consumes it), cameras, lights, `KHR_*`
extensions (`KHR_texture_transform`, `KHR_materials_*`, Draco, meshopt). `extensionsUsed` is
tolerated and warned about; `extensionsRequired` throws.

## Demo

`harness/gltf.html` builds a GLB in the page (`harness/gltf-writer.ts`: a textured cube placed by
a `matrix` node, an unlit-looking mossy plane with no normals placed by TRS) and draws it through
the two calls above; `e2e/gltf.spec.ts` checks the counts and the rendered pixels on the matrix.
`harness/assets.html` loads a 12-entry manifest of every kind from an in-memory map through
`createBundle` (`?slow` delays reads, `?fail=one` fails one, `?cancel` cancels after the first
asset) and draws the packed atlas as sprites; `e2e/assets.spec.ts` checks progress, the error
path, cancel and a sprite's colour.
