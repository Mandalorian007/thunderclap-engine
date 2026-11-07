// A game still on 0.x names, type-checked against engine 1.0.0 (scripts/check-deprecated-game.test.mjs).
// Each 0.x name is now a type error; the platform's deprecated `execCommand` and the game's own
// mistakes are not engine names and must not be reported.
import { Hit } from '@thunderclap/engine';
import type { BlendMode } from '@thunderclap/engine/anim';
import type { SceneStack } from '@thunderclap/engine/core';
import type { Input } from '@thunderclap/engine/input';
import { defaultPostSettings, type PostStack } from '@thunderclap/engine/post';
import type {
  LoadTextureArrayOptions,
  Renderer,
  SunLight,
  Texture,
} from '@thunderclap/engine/render';

interface Own {
  frame: number;
}

export function useOld(
  stack: SceneStack,
  input: Input<'go'>,
  sun: SunLight,
  post: PostStack,
  own: Own,
  blend: BlendMode,
  renderer: Renderer,
  texture: Texture,
): unknown {
  stack.list();
  input.getBindings();
  sun.dir[0] = 1;
  post.set({ fog: { density: 1 } });
  const tex: LoadTextureArrayOptions = { mipFilter: 'linear' };
  const sprite = renderer.createSpriteMaterial(texture, 'hero');
  document.execCommand('copy');
  const wrong: number = 'not a number';
  return [Hit, defaultPostSettings(), own.missing, tex, wrong, blend, sprite];
}
