# Brief: ws/anim-graph

Read `docs/briefs/common.md` first, then DECISIONS E-015; `src/anim/README.md`, `src/anim/mixer.ts` (`AnimationMixer`, `AnimationAction`, `play`, `crossFade`, `onEvent`, `update`), `src/anim/clip.ts`, `src/anim/pose.ts` (`blendPose`), `src/anim/index.ts`. ws/ik (`ik.ts`, `root-motion.ts`) and ws/sockets (`socket.ts`) are in the same module: do not touch their files.

## Goal

A third-person character has idle, walk, run, jump, land, attack. Today a game drives `crossFade` by hand from its own state. A small graph on top of the mixer: states hold a clip or a 1D blend space, transitions have a condition and a fade time, parameters are plain numbers and booleans the game sets each frame. Pure, allocation-free after construction.

STATUS row, *done when*: `@thunderclap-engine/engine/anim` exports `createAnimGraph(mixer, desc: AnimGraphDesc): AnimGraph`; `AnimGraphDesc { params: Record<string, number | boolean>; states: Record<string, { clip: AnimationClip; speed?; loop? } | { blend: { param: string; points: { at: number; clip: AnimationClip }[] } }>; transitions: { from: string | '*'; to: string; when: (p) => boolean; fade: number; exitTime?: number }[]; initial: string }`; `AnimGraph.set(param, value)`, `.state` (current), `.update(dt)` (evaluates transitions in order, first match wins, then the mixer), `.onEnter(state, fn)` / `.onExit`; 1D blend spaces weight the two nearest points and drive their actions' weights and speeds so a walk→run blend keeps feet in phase (`syncPhase?: boolean`, default true, normalises time across the blended clips); tests; harness; documented.

## Scope

- `src/anim/graph.ts`, `graph.test.ts`: states own mixer actions created at construction (`mixer.play` with weight 0 or whatever the mixer offers; add nothing to `mixer.ts` unless an action weight setter is missing: then add the smallest one and name it). `exitTime` (0..1 normalised) gates a transition until the clip passes that point. `'*'` transitions apply from any state except `to`. Conditions are user functions reading the params object (no allocation: pass the same object).
- Tests: transition on a boolean, exit time gate, first-match order, blend weights at, between and beyond points, phase sync keeps normalised time equal across blended clips, enter/exit callbacks once per change, no allocation in `update` over 1000 frames (Proxy count like sockets' test).
- Harness `harness/anim-graph.html|ts|-state.ts`: a three-joint figure (bones as boxes) with procedurally built idle (sway), walk (swing), run (faster swing) clips in a 1D `speed` blend space plus a `jump` state on a boolean; the page cycles speed 0→1→0 and pulses jump; state exposes `state`, `speed`, `weights`. `e2e/anim-graph.spec.ts`: state changes to `jump` and back, weights sum to 1 at a blended speed (poll per E-017).
- Docs: `src/anim/README.md` *Graph*, ARCHITECTURE *Animation* one sentence, CHANGELOG, root README harness item.

## Files owned

`src/anim/graph.ts`, `src/anim/graph.test.ts`, `src/anim/index.ts` (append), `src/anim/mixer.ts` (one setter only if needed), `src/anim/README.md` (*Graph*), `harness/anim-graph.*`, `e2e/anim-graph.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`, root `README.md` (harness item).

Branch from `main` (39df9e8 or later: `anim` has landed). Running alongside: ws/ik and ws/sockets (same module, other files; index.ts appends will conflict trivially), ws/sky, ws/bench, ws/geom, ws/flake-input; two integrator chains.
