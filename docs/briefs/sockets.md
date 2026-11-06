# Brief: ws/sockets

Read `docs/briefs/common.md` first, then DECISIONS E-015 (first/third-person characters with cosmetics is the target); `ARCHITECTURE.md` *Animation* (on ws/anim), *Transforms*; `src/anim/README.md`, `src/anim/pose.ts` (`Skeleton`, `Pose`, `poseToWorld`, `WORLD_NODE_FLOATS`, `multiplyAffine`, `invertAffine`), `src/anim/index.ts`; `src/render/transform.ts` (`Transform`, `multiplyMatrix3x4`, `MATRIX3X4_FLOATS`, how an instance world matrix reaches `frame.draw`); `src/assets/gltf-load.ts` (`skeletonFromSkin`, node names) for how a game would find a joint by name.

## Goal

Cosmetics: a sword in a hand, a hat on a head, a particle emitter at a staff tip. A socket is a joint plus a local offset; each frame it yields a world 3×4 for whatever is attached, so a second mesh (or a `Transform`) rides the animated skeleton with no code in the game beyond "attach here".

STATUS row, *done when*: in `@thunderclap/engine/anim`: `Socket { joint: number; offset: Float32Array /* 3×4 */ }`, `createSocket(skeleton, joint: number | string, local?: { position?; rotation? (quat); scale? }): Socket` (string joints resolve through `Skeleton.names?: string[]`, a new optional field; throw if absent), `socketWorld(socket, worldPose: Float32Array, instanceWorld: Float32Array | null, out: Float32Array): Float32Array` (joint world × offset × instance, zero allocations), `attachTransform(socket, worldPose, instanceWorld, transform: Transform)` writing the result into a `Transform` so the attached mesh draws through the normal path; tests; a harness page; documented.

## Scope

- `src/anim/socket.ts` + `socket.test.ts`: the three functions; `Skeleton.names` added to `pose.ts` types only (optional field; `validateSkeleton` checks its length when present). Tests: identity offset equals the joint world; offset applied in joint space (rotate the joint, the offset rotates with it); instance world composes last; string lookup and its errors; `attachTransform` round-trips through `Transform` reads; zero allocations per `socketWorld`.
- `Transform` write path: if `Transform` has no way to set a raw 3×4, add the smallest one (`Transform.setMatrix(m: Float32Array)` or write position/rotation/scale decomposed); if that needs `src/render/transform.ts`, do it there (you own one method) and note it. The 2D harness stays pixel-identical (`transform.ts` is shared by 2D).
- Harness `harness/sockets.html|ts|-state.ts`: the anim harness's procedural skeleton (or a three-joint arm you build with `createPose` + a sine clip) with a cube attached by `createSocket` to the end joint with an offset, and a second cube with a string joint; state exposes `socketWorldPos` and `jointWorldPos` per frame. `e2e/sockets.spec.ts`: socket position differs from joint position by the offset length (poll, E-017) and moves over time.
- Docs: `src/anim/README.md` *Sockets*, ARCHITECTURE *Animation* one sentence, CHANGELOG, root README harness item.

## Files owned

`src/anim/socket.ts`, `src/anim/socket.test.ts`, `src/anim/index.ts` (append), `src/anim/pose.ts` (`Skeleton.names` only, plus its check in `validateSkeleton`), `src/anim/README.md` (*Sockets*), `src/render/transform.ts` (one setter if needed), `harness/sockets.*`, `e2e/sockets.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`, root `README.md` (harness list item).

Branch from `ws/anim` (01af0cf): `anim` is not on `main` yet; it merges within the hour, and the integrator rebases nothing (your branch merges on top). Running alongside: ws/sky, ws/bench, ws/pick, ws/flake-input, ws/texture-registry; integrators landing anim, trails, snap-gate, doc-sweep-3, template-first-person, look-zoom (chain 2) and shadow-cull, xr-post, pbr, skinning, spot-lights (chain 1). Nothing under `src/render/` except the one `Transform` setter.
