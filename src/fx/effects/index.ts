/** The built-in effect descriptors (`src/fx/effects/*.json`), typed as `EffectDesc`. */
import type { EffectDesc } from '../effect';
import hitSpark from './hit-spark.json';
import magicAura from './magic-aura.json';
import smokePuff from './smoke-puff.json';

/** A 2D impact: a burst of bright sparks and a short flash. */
export const HIT_SPARK_EFFECT: EffectDesc = hitSpark as unknown as EffectDesc;
/** A 2D alpha-blended smoke puff that grows, spins and fades. */
export const SMOKE_PUFF_EFFECT: EffectDesc = smokePuff as unknown as EffectDesc;
/** A looping world-space aura: rising motes that trail sparkles (sub-emission). */
export const MAGIC_AURA_EFFECT: EffectDesc = magicAura as unknown as EffectDesc;
