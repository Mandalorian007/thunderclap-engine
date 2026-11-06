# engine/tween

Numbers over time: a menu slides in, a camera eases to a target, a hit flash fades. `@thunderclap/engine/tween` is a dependency-free tween engine: a full easing table, object-property and callback tweens, sequences and parallel groups, loops, yoyo, delays and springs, ticked by one manager that takes `dt` and allocates nothing after setup. It is not a clock: a game calls `tweens.update(dt)` from its frame or update hook (`hooks.frame` / `hooks.update` in `createGame`, or its own `GameLoop`).

## Quick start

```ts
import { createTweens, ease } from '@thunderclap/engine/tween';

const tweens = createTweens();
ctx.hooks.frame = (dt) => tweens.update(dt);

tweens.to(menu, { x: 0, 'style.opacity': 1 }, 0.4, { ease: ease.backOut });  // slide in
tweens.to(camera, { x: target.x, y: target.y }, 0, { ease: ease.spring(120, 18) }); // settles, no duration
tweens.value(1, 0, 0.3, (v) => (flash.alpha = v)).then(() => flash.hide());

tweens.sequence(
  tweens.to(door, { 'position.1': 3 }, 0.6, { ease: ease.cubicInOut }),
  tweens.delay(0.2),
  tweens.parallel(tweens.to(light, { intensity: 2 }, 0.5), tweens.to(fog, { density: 0 }, 1)),
).promise().then(() => scene.next());

tweens.kill(menu);   // every property tween on that object, inside groups too
tweens.active;       // how many root tweens are still running
```

## API

`createTweens(): Tweens`. One per game is plenty.

`Tweens`:

- `update(dt)`: advance every root tween by `dt` seconds (negative or NaN counts as 0). A tween that completes or is killed during the update, even from a callback, is dropped at the end of it; tweens created during an update start on the next one. Re-entry throws.
- `to(target, props, seconds, opts?): Tween`: animate number fields of `target` to the values in `props`. Keys are dotted paths into the object: `'x'`, `'position.0'` (a `Float32Array` or array index), `'style.opacity'`. Every path must exist and hold a number when the tween is created (it throws otherwise). Start values are read when the tween starts, after its delay.
- `value(from, to, seconds, onUpdate, opts?): Tween`: animate one number, calling `onUpdate(value, tween)` on every step; the last call is exactly `to`.
- `delay(seconds, opts?): Tween`: nothing for `seconds`. A gap in a sequence, or a timer: `tweens.delay(2).then(fn)`.
- `sequence(...tweens, opts?): Tween`: run the tweens one after another. The leftover of a child's last step carries into the next child, so a sequence drifts by nothing on a long frame. `parallel(...tweens, opts?): Tween`: run them together, ending with the longest. Both take a `TweenOptions` object as the last argument (delay, loops, yoyo, callbacks, timeScale) and are tweens themselves, so they nest. A tween handed to a group leaves the manager's root list and is driven by the group; it can join one group only.
- `kill(target)`: kill every property tween on `target`, inside groups too. `killAll()`.
- `active: number`: root tweens that have neither completed nor been killed (a group counts once).

`TweenOptions`:

| Field | Meaning |
|---|---|
| `ease?: Ease \| SpringEase` | Easing (default `ease.linear`), or `ease.spring(...)` for a duration-free spring. |
| `delay?: number` | Seconds before the first iteration starts. |
| `loops?: number` | Extra iterations after the first: `0` (default) plays once, `2` three times, `-1` forever. |
| `yoyo?: boolean` | Alternate direction on every other iteration. A group plays its children backwards on the way back. |
| `onStart?(tween)` | Once, when the first iteration starts (after the delay; start values are read just before). |
| `onUpdate?(tween)` | After every step that moved the tween, including the final one. |
| `onComplete?(tween)` | Once, when the last iteration ends. Not on `kill`. |
| `timeScale?: number` | Multiplies `dt`; `0` holds. Settable later through `tween.timeScale`. |

`Tween`, the handle every kind returns:

- `progress` (linear position of the current iteration, 0..1; a spring's position, which may overshoot), `elapsed` (seconds into the current iteration, delay excluded), `duration` (one iteration; a group's is the sum or max of its children's totals; `Infinity` for a spring), `complete`, `killed`, `paused`, `timeScale`.
- `pause()` / `resume()`: a paused tween holds; a sequence waits on a paused child.
- `kill()`: stop and drop with no further callbacks. `complete` stays false.
- `restart()`: back to the start, delay included, reading start values again; a finished or killed root tween rejoins its manager.
- `then(fn): Tween`: run `fn()` when the tween completes (at once if it already has); chains. The tween is thenable, so `await tween` works as well.
- `promise(): Promise<void>`: resolves on completion. A killed tween's promise never settles.

Loops apply the end value at every boundary before starting the next iteration, so `onUpdate` sees each extreme even on a frame that crosses several. A group looping replays its children from the start values they read on their first run; `restart()` reads them afresh.

## Easing (`ease.ts`)

`Ease` is `(t: number) => number` on 0..1, 0 at 0 and 1 at 1. The table `ease` holds:

- `linear`, `smoothstep` (`t²(3 − 2t)`, the default of `PostStack.blendTo`);
- `quadIn`, `quadOut`, `quadInOut`, and the same three for `cubic`, `quart`, `quint`, `sine`, `expo`, `circ`, `back`, `elastic`, `bounce` (the Penner set; `back` and `elastic` leave 0..1 in between, `bounce` is not monotonic);
- `steps(n)`: `n` equal steps, 0 until the first, 1 at `t = 1`;
- `cubicBezier(x1, y1, x2, y2)`: the CSS timing function (Newton with a bisection fallback; control points outside 0..1 overshoot);
- `spring(stiffness = 170, damping = 22): SpringEase`: not a function of `t` but a description `{ kind: 'spring', stiffness, damping }` of a unit-mass spring, `a = stiffness · (1 − x) − damping · v`. A tween given one ignores its `seconds`, `loops` and `yoyo`, integrates the spring (semi-implicit Euler in substeps of at most 1/240 s, so stiff springs survive a hitch) and completes when position and velocity are within 1e-3 of rest, snapping to the end value. Critical damping is `2·√stiffness`; the default overshoots slightly and settles in about half a second.

`@thunderclap/engine/post` re-exports `easeLinear`, `easeIn`, `easeOut` and `easeInOut` as aliases of `ease.linear`, `ease.quadIn`, `ease.quadOut` and `ease.smoothstep`.

## Types

- `Tween`, `TweenOptions`, `TweenProps` (`Record<string, number>`: dotted path to target value), `Ease`, `SpringEase`, `Tweens`.

## Notes

- After setup nothing allocates per update: property paths are resolved to holders and keys when the tween is created, start values go into typed arrays, groups keep their children in a fixed array, and the manager compacts its list in place.
- Start values are read when a tween starts, not when it is created, so two tweens queued on the same field in a sequence chain naturally.
- Not here: a clock (`GameLoop` / `createGame` own `dt`), colour or quaternion interpolation (tween the components; `anim` has `quatSlerp`), DOM style strings (tween a number and write the style in `onUpdate`).
