/**
 * A typed asset manifest: the keys a game loads by, each with a kind and the uri(s) the game's
 * `read` resolves. `defineManifest` is an identity function that keeps the literal types, so
 * `bundle.get('hero')` is typed by the entry's kind (`AssetOf`). Plain data: no GPU, no network.
 */
import type { LoadTextureArrayOptions, LoadTextureOptions, Texture } from '../render/texture';
import type { AtlasLayout, AtlasOptions, AtlasRect } from './atlas';
import type { GltfScene, LoadGltfOptions } from './gltf-load';

/** One 2D `Texture` through `loadTexture` (the image decoded with `createImageBitmap`). */
export interface TextureEntry {
  kind: 'texture';
  uri: string;
  options?: LoadTextureOptions;
}

/** One `texture_2d_array` through `loadTextureArray`, a layer per uri, in order. */
export interface TextureArrayEntry {
  kind: 'texture-array';
  uris: string[];
  options?: LoadTextureArrayOptions;
}

/**
 * A glTF scene: the uri is parsed with `parseGltf`, every `externalUris` entry is read through
 * `resources` (the uri the file names → the uri to read; an unmapped uri is read as is) and the
 * result goes through `loadGltf`.
 */
export interface GltfEntry {
  kind: 'gltf';
  uri: string;
  resources?: Record<string, string>;
  options?: LoadGltfOptions;
}

/** An `AudioBuffer`, decoded by the `audio` the bundle was given. */
export interface AudioEntry {
  kind: 'audio';
  uri: string;
}

/** `JSON.parse` of the bytes as UTF-8. */
export interface JsonEntry {
  kind: 'json';
  uri: string;
}

/** The bytes as a UTF-8 string. */
export interface TextEntry {
  kind: 'text';
  uri: string;
}

/** The bytes themselves. */
export interface BytesEntry {
  kind: 'bytes';
  uri: string;
}

/** An `ImageBitmap` (for a game that packs or inspects the pixels itself). */
export interface ImageEntry {
  kind: 'image';
  uri: string;
}

/** Loose images packed into one texture with `packAtlas` and `createAtlasTexture`. */
export interface AtlasEntry<N extends string = string> {
  kind: 'atlas';
  uris: Record<N, string>;
  options?: AtlasOptions;
}

export type ManifestEntry =
  | TextureEntry
  | TextureArrayEntry
  | GltfEntry
  | AudioEntry
  | JsonEntry
  | TextEntry
  | BytesEntry
  | ImageEntry
  | AtlasEntry;

export type AssetKind = ManifestEntry['kind'];

/** A manifest: asset keys to entries. */
export type Manifest = Record<string, ManifestEntry>;

/** What an `atlas` entry loads to: the texture, the uv rect per image name and the layout. */
export interface AtlasAsset<N extends string = string> {
  texture: Texture;
  rects: Record<N, AtlasRect>;
  layout: AtlasLayout;
}

/** The loaded value of a manifest entry, by its kind. */
export type AssetOf<E extends ManifestEntry> = E extends TextureEntry
  ? Texture
  : E extends TextureArrayEntry
    ? Texture
    : E extends GltfEntry
      ? GltfScene
      : E extends AudioEntry
        ? AudioBuffer
        : E extends JsonEntry
          ? unknown
          : E extends TextEntry
            ? string
            : E extends BytesEntry
              ? ArrayBuffer
              : E extends ImageEntry
                ? ImageBitmap
                : E extends AtlasEntry<infer N>
                  ? AtlasAsset<N>
                  : never;

/**
 * Identity with types: `const manifest = defineManifest({ hero: { kind: 'texture', uri: 'hero.png' } })`
 * keeps `hero` as a `TextureEntry`, so `createBundle(manifest).get('hero')` is a `Texture`.
 */
export function defineManifest<M extends Manifest>(entries: M): M {
  return entries;
}
