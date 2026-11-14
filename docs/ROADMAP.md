# ThunderClap 2.0: the foundation

*The program plan, 2026-11-14 (E-041). The PM owns this file and keeps its status current; [STATUS.md](STATUS.md) tracks each workstream's branch and merge. The pitch the user approved is [design/2.0/pitch.html](design/2.0/pitch.html); the target architecture is [design/2.0/architecture.md](design/2.0/architecture.md) ("D1"); the switch bar is [design/2.0/bar.md](design/2.0/bar.md) ("D2"); the evidence is in [design/2.0/evidence/](design/2.0/evidence/).*

## The goal

ThunderClap becomes the foundation for every game we make, 2D to varied 3D to VR, and Forge Wilds runs on it at **feature parity**: everything its client does today, it does on ThunderClap, with Forge's own client code reduced to its game (rules, content meaning, net and play, panels, the world's look).

The user, 2026-11-14: *"The target goal will be the evolved engine running forge wilds in a parity sense. I do not care if performance is 100% matched; the flexibility of the engine will matter greatly."*

So, in order of weight:

1. **Flexibility.** Every module serves more than Forge: each lands with a demo scene that is not Forge's style, and its API names nothing from Forge.
2. **Feature parity.** Forge's features, tests and controls all work on the engine; Forge's copy of each foundation is deleted.
3. **A playable floor.** On the iPad profile Forge holds 60 fps with no new hitch over 50 ms and loads its view in about the same time. Counted work (GPU calls, allocations, bytes per frame) is measured and kept from growing with what is visible; timing gaps are logged as tuning debt, not blockers.

## The user's calls (E-041)

| # | Question | Call |
| --- | --- | --- |
| 1 | Rule 5 | "Rendering, not mechanics" becomes **"foundations, not rules"** ([VISION.md](VISION.md)). |
| 2 | The server side | **Both sides, client first.** A `net` client module in this program; a server foundation (`thunderclap-server`, Rust, from Forge's engine with the game taken out) after it. The engine still opens no connection itself. |
| 3 | When Forge switches a module | **A playable floor, then tuning.** Softened further by the user: timing need not match. |
| — | Program authority | The PM runs the program autonomously, up to 10 top-level agents, cuts engine releases, and may take down Forge's play server (world data and saves don't matter). |

## The PM's calls (open to the user's override)

- **The Last Rune stays pixel-identical** and source-compatible through 2.0; it stays on `^1.3.0` until a 2.0 release has proven itself, then moves in its own repo.
- **VR is first-class in the core from day one.** Every render-core change runs a two-view (stereo) test on the fake GPU and the stereo harness page.
- **2.0 is one breaking release.** 1.x APIs that the retained core replaces keep working as adapters where cheap, else are listed under *Breaking* with a migration note. During the program, `main` publishes prereleases `2.0.0-next.N` to npm's `next` tag; `latest` stays 1.3.x until 2.0.0.
- **Forge consumes the engine from npm `next` prereleases** (exact pins), never a `link:`; an engine fix Forge needs means a new prerelease, cut by the PM the same day.
- **Forge's client foundations are frozen** (fixes only) while they move; game work in rules, content and the server may continue but none is planned during the program.
- **Old engine modules are replaced, not kept beside.** `voxel` (the demo grid) is rebuilt in place; its old API survives only if a template or demo still needs it after the rebuild.

## Phases

| Phase | What | Releases |
| --- | --- | --- |
| **A. Ground** | Rails (WebKit project, counted-work budgets, bundle budgets per subpath, tree-shaking check, `override` check, `next` publishing), the kit split of `createGame`, the reference scenes. | `2.0.0-next.0` |
| **B. Render core** | The retained, GPU-driven, view-plural core (D1 §3); the immediate API rebuilt on it; stereo once; passes and targets from use; camera-relative origin; device-loss rebuild. Critical path. | `next.1`, `next.2` |
| **C. Foundations** | Parallel with B: voxel worlds, models, actors, UI spec and presenters, intents and the quality governor, XR merged, the networking client. Each with a non-Forge demo. | `next.3`… |
| **D. Forge switches** | Forge adopts the engine module by module in seam order; each PR deletes Forge's copy. Ends with an evaluator playing Forge on the engine against the parity checklist. | `2.0.0` when D is done |
| **E. Server foundation** | `thunderclap-server` from Forge's Rust engine; Forge's server moves onto it. Research starts now (S0). | `2.1` |
| **F. Proof** | A second, small 3D game built on the kit in two weeks or less, holding only rules, content, scenes and shaders. | — |

## Steps

Sizes: S under ~1k lines, M ~1–3k, L ~3–4k (split past that). Branches are `ws/<name>` in this repo; Forge steps are PRs in forgewilds on `client/tc-<name>`.

### Phase A: ground

| Id | Step | Depends on | Done when | Status |
| --- | --- | --- | --- | --- |
| A1 | **ws/rails**: Playwright WebKit project (iPad Pro 11 profile) running a WebKit subset of the matrix; `check:wgsl` (no `override`); bundle budgets per subpath (`check:bundle`) and a tree-shaking check (importing `render` alone pulls no `ui`/`audio`); prereleases publish to npm dist-tag `next`. | — | WebKit project green on the subset; `check:bundle` and `check:wgsl` in `pnpm check`; publish.yml tags `-` versions `next`. | |
| A2 | **ws/budget**: counted-work framework (`testing/budget.ts`): per-frame GPU commands, bytes written, buffer/texture creations, typed-array allocations, clock reads, per view; budgets on the bench rungs; today's numbers recorded as the baseline. | — | `budget()` usable from any unit test; bench rungs carry budgets; baseline table in docs/BENCH.md. | |
| A3 | **ws/kit**: `createGame` becomes a composer of independent services (P4, D1 §2.19); every service also usable alone; a minimal game's bundle measured. | — | 1.x `createGame` calls unchanged; templates and The Last Rune harness pixel-identical; a 2D-only kit import measurably smaller. | |
| A4 | **ws/ref-scenes**: reference scenes S1–S6 (D2 §3) as harness pages with bench rungs: 2D guard, characters, lit arena, voxel world, XR stereo, idle HUD. | A2 | Six pages on the matrix; each has a counted budget. | after A2 |

### Phase B: render core (critical path)

| Id | Step | Depends on | Done when |
| --- | --- | --- | --- |
| B1 | **ws/core-retained**: DrawSets, vertex/index arenas with custom layouts (packed integers, a shared quad index), instance sources, render bundles of `drawIndexedIndirect`, GPU compute cull for large sets, the pass list, targets from use (D1 §3.1–3.4, 3.6, 3.7). New code beside today's path. | — | A 6,000-set scene draws in a flat number of GPU calls (same at 1,500 and 6,000), 0 allocations a frame, on the fake GPU and in WebKit. |
| B2 | **ws/core-immediate**: `frame.sprite`/`mesh`/`meshes`, `InstanceList`, `Drawable` rebuilt as transient sets on B1; the per-mesh path deleted; the emissive target only when used (D1 §3.9). | B1 | `snap:check` 0 px; e2e matrix green; call-trace diff for the 2D pages explained; bundle of a 2D game ≤ +2 KB. |
| B3 | **ws/core-views**: views plural from the bottom (one cull, one upload, one shadow pass for a stereo pair), two-views and XR on it, post per view, camera-relative origin (D1 §3.5, 3.8). | B1 (B2 for XR post) | Stereo costs one cull pass; the XR and views pages pass; a far-from-origin scene renders without jitter. |
| B4 | **ws/core-passes**: shadows, sky, water, particles, decals and post as drawables and passes on the core (R1–R3); device-loss rebuild of everything the core owns. | B2 | All 3D harness pages pixel-identical or each difference named; a forced device loss recovers on the fake GPU and in WebKit. |

### Phase C: foundations (parallel with B)

| Id | Step | Depends on | Done when |
| --- | --- | --- | --- |
| C1 | **ws/voxel-data**: sparse streamed section store, block and face classes as data, a vertex bitfield schema that generates the WGSL decode, the Worker mesher pool (Forge's mesher generalized: faces, AO, light), light propagation, raycast (D1 §2.8). CPU and Worker side. | — | Forge's mesher's tests ported and green on the generalized code; schema-generated decode matches a hand-written one; a non-Forge block table (e.g. a 2-material voxel-art set) meshes. |
| C2 | **ws/voxel-draw**: section meshes in B1 arenas, connectivity (cave) culling, streaming budgets, the old demo `voxel` API replaced; the voxel reference scene on it. | B1, C1 | Voxel scene S4 at radius 16 draws flat GPU calls; streaming adds no hitch over 50 ms. |
| C3 | **ws/models**: part trees as data → packed meshes, motion from named channels (D1 §2.6). | — | Forge's part-model tests ported; a non-Forge demo (a machine or a toon creature) built from a part tree. |
| C4 | **ws/actors**: many animated instances at a fixed draw count; rigid part rigs (from C3) and glTF skins; pose compute (D1 §2.7). | B1, C3 | 1,000 actors in a fixed number of GPU calls; characters scene S2 on it with a skinned and a rigid crowd. |
| C5 | **ws/ui-spec**: UI described once as data (specs, words, tokens), the DOM presenter, reconciled with today's layout regions and widgets (D1 §2.14). | — | Forge's UI framework tests ported; today's `ui` widgets expressible as specs; the idle HUD scene allocates nothing once warm. |
| C6 | **ws/ui-world**: the world presenter (spec → Canvas2D → texture), the head-following screen in VR, ray aim on panels. | C5, B3 | One spec shown on screen and in the stereo page with the same behaviour. |
| C7 | **ws/intents-quality**: input actions → game-declared intents, every scheme aims by ray; quality tiers and a load governor with knobs modules register (D1 §2.12, 2.13). | — | Forge's intent and governor tests ported; a template uses intents; the governor steps a registered knob under a synthetic load. |
| C8 | **ws/xr-merge**: Forge's XR (sessions, controllers, hands, comfort) merged with the engine's onto B3's views. | B3 | Fake-XR tests from both sides green; the stereo page on the emulator. |
| C9 | **ws/net**: the networking client: sessions over a host-supplied transport, message schemas declared by the game, snapshot buffers, interpolation, prediction and reconciliation, interest (from S0's design). | S0 | A two-client demo over an in-page transport; Forge's SDK tests' generic half ported. |
| S0 | **Research: the server foundation and the net seam** (scratchpad, no code): what of Forge's Rust engine is generic, the package shape, the protocol generation across Rust and TS, how C9 meets it. | — | ✅ Accepted 2026-11-14: [server.md](design/2.0/server.md), E-042. |

### Phase D: Forge switches (forgewilds PRs)

Seam order; each switch deletes Forge's own copy in the same PR and passes Forge's local gate.

| Id | Switch | Needs |
| --- | --- | --- |
| D0 | Forge takes `@thunderclap-engine/engine@2.0.0-next.N`; the loop in client mode, the GPU device and hosts from the engine | A3 |
| D1 | Post and anti-aliasing | B4 |
| D2 | Sky, weather, particles, sun shadows | B4 |
| D3 | Input intents, the quality governor | C7 |
| D4 | UI: spec framework, DOM and world presenters | C5, C6 |
| D5 | Audio | A3 |
| D6 | Render core and the voxel world | B2, B3, C2 |
| D7 | Actors and part models | C3, C4 |
| D8 | XR | C8 |
| D9 | The networking client | C9 |
| EV | An evaluator plays Forge on the engine against the parity checklist (every feature in [evidence/B-client.md](design/2.0/evidence/B-client.md)); its findings become fix steps | D0–D9 |

### Phase E and F

Planned when S0 lands and phase D is under way.

## How the work runs

- **Engine (this repo):** [PM.md](PM.md): engineers on `ws/` branches in worktrees, an integrator per merge, the PM fast-forwards a tested integrator head and cuts releases. The gate is `pnpm check` plus the e2e matrix.
- **Forge:** its PM handbook (`forgewilds/docs/PM.md`): PRs, `scripts/local-ci.sh --post`, `scripts/merge-pr.sh`. Its phase file is `forgewilds/docs/roadmap/phase-9.md`.
- **Agents:** up to 10 top-level, Opus. File ownership per wave; shared files (`renderer.ts`, `core/game.ts`, `package.json`, `fake-gpu.ts`) have a named owner per wave in STATUS.
- **Every module** lands with: a non-Forge demo page, a counted budget, a README, ARCHITECTURE *Today*, a CHANGELOG line, and `api/` updated.

## Log

- 2026-11-14: program approved (E-041). Wave 2.0-1 launched: A1, A2, A3, B1, C1, C3, C5, C7, S0.
- 2026-11-14: S0 accepted (E-042): Rust server crates live in this repo; the section codec moves in Forge's one protocol bump.
