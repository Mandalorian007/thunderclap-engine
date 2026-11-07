/**
 * `@thunderclap-engine/engine/tween`: numbers over time. An easing table, property and value tweens,
 * sequences and parallel groups, loops, yoyo, delays and springs, ticked by `Tweens.update(dt)`
 * with no allocation after setup. See README.md.
 */
export { type Ease, ease, type SpringEase } from './ease';
export { createTweens, Tweens } from './timeline';
export type { Tween, TweenOptions, TweenProps } from './tween';
