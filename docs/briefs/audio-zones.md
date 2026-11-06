# Brief: ws/audio-zones

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `src/audio/README.md` whole (*Buses*, *Spatial audio*, *Voices*, *Testing*); `src/audio/audio.ts` (`AudioEngine.play/loop`, `Voice`, `SpatialListener`, `setReverbSend`, `reverbSends`, the fake-context pattern the tests use), `src/audio/audio.test.ts` (how the graph is tested in Node), `src/render/transform.ts` (3×4 `world`, translation at floats 3, 7, 11), `harness/mesh.ts` (a 3D page to copy the camera from).

## Goal

A 3D space sounds like a place: walking into a cave raises the reverb and brings in a drip loop, leaving it fades both out; a sound follows the thing that makes it without the game copying positions every frame. Pure bookkeeping over the existing engine: no new graph nodes.

STATUS row, *done when*: `audio.zones: AudioZones` with `add(desc: AudioZoneDesc): AudioZone`, `remove(zone)`, `update(dt, listenerPosition?: ArrayLike<number>)` (defaults to `audio.listener.position`), `weights(): ReadonlyArray<number>`; `AudioZoneDesc { shape: { sphere: { center, radius } } | { box: { center, halfExtents } }; feather?: number (world units over which weight goes 1→0 outside the shape, default 1); ambient?: { sound: string; bus?: OutputBus; gain?: number }; reverbSend?: Partial<Record<OutputBus, number>>; fade?: number (seconds, default 0.5) }`; the listener's weight per zone is 1 inside, smoothstep to 0 across `feather`, and the engine resolves ambient loops (one `Voice` per zone, started lazily, gain = weight × gain ramped over `fade`, stopped when weight stays 0 for `fade`) and per-bus reverb sends (max over zones of weight × send, blended with the base send the engine already holds, applied through `setReverbSend` only when the value changes by more than 1e-3); `Voice.follow(target: { world: Float32Array } | null)` makes a spatial voice read its position from a 3×4 world matrix on `audio.update(dt)`; `AudioEngine.update(dt)` exists (zones, followers; called by `createGame`'s loop before scenes); harness `zones.html`; documented.

## Scope

- `src/audio/zones.ts`: `AudioZones`, `AudioZone`, `AudioZoneDesc`, `ZoneShape`, `zoneWeight(desc, position): number` (pure, exported, tested). No allocation per `update`.
- `audio.ts`: `zones` field, `update(dt)`, `Voice.follow`; the base reverb send (what the game set) is kept separately from the zone contribution so `setReverbSend` from the game still works. Safe before unlock and when the context is unavailable (weights still compute; nothing plays).
- `core/game.ts`: one call `audio.update(dt)` in the loop after input and before scenes (both the fixed and `sim: false` paths). Nothing else.
- Tests `src/audio/zones.test.ts`: weights for sphere/box, feather edge, two overlapping zones, ambient voice starts/ramps/stops with the fake context, reverb send max rule, follow reads the matrix translation, `update` allocation-free (same pattern the existing tests use if one exists; otherwise skip that assertion).
- Harness `harness/zones.html|ts|-state.ts`: the mesh page's scene plus two zones (a sphere "room" and a box "corridor") drawn as wireframe-ish tinted boxes/spheres with existing geometry helpers, the camera orbiting through both; state exposes `weights`, `sends`, `ambientGains`, `followPos`. `e2e/zones.spec.ts`: weights change as the camera passes (poll), sends track the max rule, follow position equals the orbiting mesh's translation. Audio is locked in headless runs: assert the bookkeeping, not sound.
- Docs: `src/audio/README.md` *Zones* section and a line under *Voices* for `follow`; ARCHITECTURE *Audio* one sentence; CHANGELOG; root README harness item.

## Files owned

`src/audio/zones.ts`, `src/audio/zones.test.ts`, `src/audio/audio.ts` (`zones`, `update`, `Voice.follow`, send bookkeeping), `src/audio/index.ts` (append), `src/audio/README.md`, `src/core/game.ts` (one line per loop path), `harness/zones.*`, `e2e/zones.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`, root `README.md` (harness item).

Branch from `main` (ffd5cad or later). Running alongside: integrators landing render/input/fx/anim/template branches (none touch `src/audio`; `core/game.ts` is touched by ws/xr-post on chain 1, so keep your edit to one added line per path), ws/ui-hud, ws/gesture-longpress, ws/ik, ws/anim-graph. Use `E2E_PORT_OFFSET=100`.
