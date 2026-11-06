import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Texture } from '../render/texture';
import type { GltfScene } from './gltf-load';
import type { AssetOf, AtlasAsset } from './manifest';
import { defineManifest } from './manifest';

const manifest = defineManifest({
  hero: { kind: 'texture', uri: 'hero.png', options: { mips: false } },
  tiles: { kind: 'texture-array', uris: ['a.png', 'b.png'] },
  level: { kind: 'gltf', uri: 'level.glb', resources: { 'tex.png': 'level/tex.png' } },
  jump: { kind: 'audio', uri: 'jump.wav' },
  config: { kind: 'json', uri: 'config.json' },
  credits: { kind: 'text', uri: 'credits.txt' },
  blob: { kind: 'bytes', uri: 'blob.bin' },
  icon: { kind: 'image', uri: 'icon.png' },
  sprites: { kind: 'atlas', uris: { coin: 'coin.png', gem: 'gem.png' }, options: { padding: 2 } },
});

describe('defineManifest', () => {
  it('is the identity', () => {
    const entries = { a: { kind: 'text' as const, uri: 'a.txt' } };
    expect(defineManifest(entries)).toBe(entries);
  });

  it('types each key by its kind (AssetOf)', () => {
    expectTypeOf<AssetOf<typeof manifest.hero>>().toEqualTypeOf<Texture>();
    expectTypeOf<AssetOf<typeof manifest.tiles>>().toEqualTypeOf<Texture>();
    expectTypeOf<AssetOf<typeof manifest.level>>().toEqualTypeOf<GltfScene>();
    expectTypeOf<AssetOf<typeof manifest.jump>>().toEqualTypeOf<AudioBuffer>();
    expectTypeOf<AssetOf<typeof manifest.config>>().toEqualTypeOf<unknown>();
    expectTypeOf<AssetOf<typeof manifest.credits>>().toEqualTypeOf<string>();
    expectTypeOf<AssetOf<typeof manifest.blob>>().toEqualTypeOf<ArrayBuffer>();
    expectTypeOf<AssetOf<typeof manifest.icon>>().toEqualTypeOf<ImageBitmap>();
    expectTypeOf<AssetOf<typeof manifest.sprites>>().toEqualTypeOf<AtlasAsset<'coin' | 'gem'>>();
    expect(manifest.sprites.kind).toBe('atlas');
  });
});
