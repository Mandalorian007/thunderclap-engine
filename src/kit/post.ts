/**
 * The post and particle services (ws/kit). Each is one `with*` call: `composeGame` builds it on
 * the renderer only when the game passes it, so a game without them never imports `post` or `fx`.
 */

import { ParticleSystem, type ParticleSystemOptions } from '../fx';
import { type PostSettingsPatch, PostStack } from '../post';
import type { KitPart, KitService, KitStepPart } from './types';

/** `ctx.post`: the post stack, set as `renderer.post`. */
export interface KitPostFields {
  readonly post: PostStack;
}

/**
 * The post stack (`new PostStack(renderer, settings)`, then `renderer.post = post`). Without it
 * the renderer presents through its built-in pass.
 */
export function withPost(settings?: PostSettingsPatch): KitService<KitPostFields> {
  return {
    setup(core): KitPart<KitPostFields> {
      const post = new PostStack(core.renderer, settings);
      core.renderer.post = post;
      return { fields: { post } };
    },
  };
}

/** `ctx.particles`: the shared GPU particle pool, updated by the loop, drawn by views. */
export interface KitParticleFields {
  readonly particles: ParticleSystem;
}

/** The shared particle pool; the loop updates it after `hooks.update`, before the scenes. */
export function withParticles(
  opts?: ParticleSystemOptions,
): KitService<KitParticleFields, KitStepPart<KitParticleFields>> {
  return {
    setup(core) {
      const particles = new ParticleSystem(core.renderer, opts);
      return { fields: { particles }, update: (dt) => particles.update(dt) };
    },
  };
}
