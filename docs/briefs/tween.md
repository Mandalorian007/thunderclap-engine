# Brief: ws/tween

Read `docs/briefs/common.md` first, then `docs/VISION.md`; `src/post/README.md` *Easing between looks* and the `Ease` type in `src/post` (reuse the name, do not duplicate the functions: tween re-exports `Ease` from post or post later imports from tween: pick tween as the home and leave post's exports as aliases); `src/core/loop.ts` and `src/core/game.ts` (how per-frame systems get `dt`; audio-zones just added `audio.update(dt)`: do not edit `game.ts`, games call `tweens.update(dt)` themselves or register through an existing hook if one exists); `src/anim/mixer.ts` (house style for time-driven state with no per-frame allocation); `scripts/check-boundaries.mjs`; `package.json` `exports`.

## Goal

Every game animates numbers over time: a menu slides in, a camera eases to a target, a hit flash fades. `@thunderclap-engine/engine/tween` is a dependency-free tween engine with a full easing table, object-property and callback tweens, sequences and parallel groups on a timeline, loops/yoyo, delays, and a `Tweens` manager that ticks them with zero allocation after setup. Not a game clock: it takes `dt`.

STATUS row, *done when*: `createTweens()` → `Tweens {update(dt), to(target, props, seconds, opts?): Tween, value(from, to, seconds, onUpdate, opts?): Tween, sequence(...tweens): Tween, parallel(...tweens): Tween, delay(seconds): Tween, killAll(), active: number}`; `TweenOptions {ease?: Ease, delay?: number, loops?: number (-1 forever), yoyo?: boolean, onStart?, onUpdate?, onComplete?, timeScale?}`; `Tween {progress, elapsed, duration, paused, pause(), resume(), kill(), restart(), then(fn): Tween (chain), promise(): Promise<void>}`; easing table `ease.linear/quadIn/Out/InOut/cubic*/quart*/quint*/sine*/expo*/circ*/back*/elastic*/bounce*` plus `ease.steps(n)`, `ease.cubicBezier(x1,y1,x2,y2)`, `ease.spring(stiffness, damping)` (duration-free spring handled as a special tween kind that ends on settle); property tweens accept nested number fields and `Float32Array` indices (`{ 'position.0': 1 }` or a `{target: arr, index}` form: choose one and document it); killing a target's tweens by `kill(target)`; a tween removed mid-update is safe; harness `tween.html` (a grid of easing curves drawn live + a moving sprite per ease; state exposes `active`, `elapsed`, `samples`), e2e checks every ease reaches 1 at t=1 and `active` returns to 0; documented.

## Scope

- `src/tween/`: `ease.ts`, `tween.ts`, `timeline.ts`, `index.ts`, `README.md`, tests (every ease at 0/0.5/1 and monotonic where it should be; delays; loops/yoyo counts; sequence timing with carry-over of leftover dt; pause/resume; kill during update; spring settles; promise resolves; `active` bookkeeping).
- `src/post`: `Ease`, `easeLinear`, `easeIn`, `easeOut`, `easeInOut` become re-exports from tween (one file edited, behaviour identical, post README one sentence pointing at tween). If `check-boundaries` forbids post→tween, make tween import nothing and let post keep its own copies; say which in the report.
- `package.json`: `"./tween": "./src/tween/index.ts"` (alphabetical after `./save`... keep the file's order: after `./testing`? No: after `./save`, before `./ui`). `scripts/check-boundaries.mjs` if it lists modules.
- Harness `tween.html` + `tween.ts` + `tween-state.ts`, `e2e/tween.spec.ts`.
- Docs: `ARCHITECTURE.md` one-paragraph *Tweens* section after *Animation*; root `README.md` module row + harness list item; `CHANGELOG.md` one line.

## Files owned

`src/tween/**`, `src/post/index.ts` (easing re-exports) and the one post file holding the ease functions, `src/post/README.md` (one sentence), `harness/tween.*`, `e2e/tween.spec.ts`, `package.json` (one export line), `scripts/check-boundaries.mjs` (if needed), `ARCHITECTURE.md` (new section), root `README.md` (one row, one item), `CHANGELOG.md`.

Branch from `main` (b75ce88 or later). Running alongside: ws/post-depth edits `src/post/post.ts`, `settings.ts`, `renderer.ts`: touch no post file except the easing one and `index.ts`; ws/i18n and ws/nav add `./i18n` and `./nav` exports and their own ARCHITECTURE sections; ws/geom landing. Use `E2E_PORT_OFFSET=180`.
