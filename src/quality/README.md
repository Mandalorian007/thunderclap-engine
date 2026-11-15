# engine/quality

What a device can do, and one service that keeps frames on time. `detectTier` picks a starting quality tier from the device; `createGovernor` sheds and restores work as frames run long, through knobs the game's modules register, so they never each adapt on their own and fight. No GPU, no DOM in the governor, no dependencies. Generalized from Forge Wilds' tier and frame governor (ws/intents-quality, D1 §2.12).

## Quick use

<!-- snippet:check -->
```ts
import { createGovernor, detectTier, dynamicResolutionKnob, readDevice, toggleKnob } from '@thunderclap-engine/engine/quality';
import { DynamicResolution } from '@thunderclap-engine/engine/render';

const { tier, reason } = detectTier(readDevice()); // 'low' | 'medium' | 'high', and why
const dr = new DynamicResolution({ minScale: 0.5 });
let shadows = true;
const governor = createGovernor({
  rungs: [
    dynamicResolutionKnob(dr),                                  // cost 1: stepped down first
    toggleKnob('shadows', (shed) => (shadows = !shed), 2),
  ],
});
// once per drawn frame: now, the interval since the last, main-thread ms, GPU latency when measured
governor.frame(performance.now(), 16.7, 4, null);
console.log(tier, reason, governor.line, shadows);
```

## Entry points

| Name | What it is for |
| --- | --- |
| `detectTier(device?)` | the starting `QualityTier` and the reason, from `readDevice()` |
| `readDevice(gpu?)`, `gpuInfo(adapter)` | what the page can tell about the device and its GPU adapter |
| `createGovernor(options?)` | the frame governor; `frame(...)` once per drawn frame |
| `Knob` | something the governor may turn down: `{ name, step(down), cost? }` |
| `toggleKnob`, `stepKnob`, `dynamicResolutionKnob` | ready knobs: on/off, a number between limits, a `DynamicResolution` scale |
| `TIER_FEATURES`, `startsLean(device)` | what each tier draws of the sun's shadows, actor shadows and anti-aliasing; whether a device starts with those shed |

## Tier

- `readDevice(gpu = null)` returns `DeviceInfo`: `touch`, `ipad` (an iPad that says it is a Mac), `phone`, `webkit`, `cores` (`hardwareConcurrency`), `headset` (`headsetBrowser(userAgent)`: Quest, Pico, Wolvic), `automated` (`navigator.webdriver`) and `gpu`. `gpuInfo(adapter)` reads a `GPUAdapter` (or any `AdapterLike`) into `GpuInfo`: its `description`, `fallback` and `maxTexture`.
- `detectTier(device)` in order: a fallback (software) adapter, a headset or an Adreno GPU → `low`; a `maxTexture` under 8192, or two honest cores on a non-WebKit browser → `medium`; else `high`. `reason` says which rule decided, for a debug overlay. A game maps the tier to its own settings, and lets the player override it.
- `TIER_FEATURES[tier]` (ws/e24-gpu): `{ sunShadows, actorShadows, antialias }`, the engine's defaults for the features a tiler pays most for. `low` and `medium`: no sun or actor shadows, `'fxaa'`; `high`: all of them, `'taa'`. Measured on Forge Wilds' iPad profile (WebKit, 2360×1640): the sun's shadow pass about 2.4 ms of GPU and TAA 0.7 ms over FXAA.
- `startsLean(device)` (ws/e24-gpu): true on a WebKit iPad or phone (no timestamp queries, a tiler sharing the chip's memory). The tier is not lowered; the game sheds the first knobs of its governor's `order` at the start (`governor.set(n)`), and the governor gives them back one at a time after 20 s clean spells, so a device with the headroom gets them back by itself.

## Governor

- **Judging.** Frames are judged per window (`windowMs`, 2000). A frame is late when its interval is over 1.25 × `targetMs` (1000/60). A late frame whose main-thread time (`cpuMs`) took 0.6 of a target or more is the main thread's (a GC, streaming) and does not count: shedding GPU work would not help. A window whose average measured latency (less main-thread time) stayed under half a target had a GPU with time to spare, so its misses are someone else's (a capped rate, the compositor). With `cpuMisses: true` (ws/input-fit, default false) the main thread's late frames count as well, against the same `downShare` and whatever the latency said, for a game whose knobs cut main-thread work (a draw distance, meshing); each shed then records its `cause` (`'gpu'` or `'cpu'`). Intervals over 250 ms (a hidden tab, a stall) start the window over; windows of under 10 frames say nothing. No GPU timestamps are needed (WebKit has none).
- **Stepping.** Over `downShare` (10%) of a window's frames late for the GPU: one step down on the cheapest knob that can still step (lowest `cost`, ties in registration order). After `upAfterMs` (20 s) under `upShare` (1%) late: the last step shed comes back (a LIFO stack, so a knob stepped three times comes back three times). At most one change per `minGapMs` (2 s) and `maxChanges` (4) per `rateWindowMs` (60 s). A step shed again `stickyFailures` (2) times within `stickyWithinMs` (2 min) of being restored stays shed `stickyForMs` (5 min).
- **Order (ws/e24-gpu).** `order` (an option, and a settable property) lists knob names to shed first, in that order: the game's data, the sun's shadows first where they cost the most. Knobs not named follow by `cost`. Four changes a minute make it matter: Forge Wilds' sun shadows, fifth by cost, waited a minute at 33 ms frames behind four cheap knobs that did not help.
- **GPU time (ws/e24-gpu).** `frame(now, interval, cpuMs, latencyMs, gpuMs)`: with timestamp queries, the frame's GPU ms. A window averaging three quarters of a target or more is the GPU's whatever the latency said (no veto); with GPU times, a step comes back only when the clean spell's GPU averaged under three quarters of a target (headroom). Without them (WebKit) late frames judge as before.
- **Reading.** `shed` (steps shed now), `knobs` (in stepping order), `stack` (one entry per step), `changes` (the last 16, `{ at, shed, knob, dir, cause? }`) and `line` (one line for an overlay, `governor: full quality` when nothing is shed). `frame()` returns the change it made, or `null`.
- **Knobs come and go.** `register(knob)` returns a remover that first restores every step that knob gave up. `set(count, now?)` sheds or restores to `count` steps at once (tests, a dev console). `enabled = false` stops judging; `targetMs` may change when the display's rate becomes known.
- Pure and allocation-free per frame (a change allocates its record): the caller passes the clock, so it runs on synthetic traces (`governor.test.ts`, `harness/quality.html`).

## Knobs

- `toggleKnob(name, apply(shed), cost?)`: one step; `apply(true)` when shed, `apply(false)` when restored.
- `stepKnob({ name, get, set, min, max, step, cost? })`: a number stepped down by `step` toward `min` and back up toward `max` (a particle budget, a draw distance).
- `dynamicResolutionKnob(dr, { step = 0.1, name = 'resolution', apply?, cost? })`: a `DynamicResolution`'s scale, through `dr.reset(scale)` within its `minScale` and `maxScale`; `apply(scale)` resizes the game's target. Give the `DynamicResolution` itself no budget-driven updates while the governor drives it.

## Types

`QUALITY_TIERS` (`['low', 'medium', 'high']`), `QualityTier`, `TierChoice` (`{ tier, reason }`), `TierFeatures`, `DeviceInfo`, `GpuInfo`, `AdapterLike`; `GovernorOptions` (the defaults above), `Governor`, `GovernorChange`, `Knob`; `StepKnobOptions`, `DynamicResolutionKnobOptions`.

## Demo

`harness/quality.html`: the tier for the device, and a governor over a resolution knob and a toggle under a synthetic GPU load (8 ms or 30 ms at full scale); 30 ms steps the scale to 0.7, 8 ms brings it back to 1 (`e2e/intents-quality.spec.ts` on every matrix row).
