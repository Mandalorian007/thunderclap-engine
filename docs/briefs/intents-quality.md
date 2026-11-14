# Brief: ws/intents-quality (C7)

Read `common.md`, `wave-2.0-1.md`, E-041, `docs/design/2.0/architecture.md` P8, **§2.12, §2.13**, `src/input/README.md`, `src/render/dynamic-resolution.ts`. Forge source (read only): `FW:play/gestures.ts`, `FW:play/actions.ts:1-60`, `FW:ui/touch.ts` (the WebKit pinch and stuck-pointer workarounds near :76 and :506), `FW:render/governor.ts`, `FW:settings/device.ts`, `FW:settings/adjust.ts`, and their tests.

## Goal

Two small foundations. STATUS *done when*: "Forge's intent and governor tests ported; a template uses intents; the governor steps a registered knob under a synthetic load."

1. **Intents** in `input`: `createIntents(spec, sink)`: the game declares intents (`press`, `hold`, `aim`, `release`, `tap`, `cycle`, `select(n)`), each bound to actions and carrying `Aim = Ray | null`; every scheme (mouse, touch, pad, XR controller) aims by ray; the aim ray is re-made as the view turns. Gesture primitives `stillHold({ tolerancePx, ms })`, `stickSideHold`. The WebKit workarounds become engine behaviour.
2. **quality** (new `@thunderclap-engine/engine/quality`): `detectTier()` → `{ tier, reason }`; `createGovernor({ rungs, targetMs, … })` with asymmetric, sticky hysteresis; `Knob { name, step(down), cost? }`; modules register knobs (dynamic resolution as the first). Tier *values* are the game's.
3. Wire one template (first-person) to intents.

## Files owned

New `src/input/intents*.ts`, `src/input/gestures-*` additions, `src/input/index.ts` (additive), new `src/quality/**`, `package.json` (one `./quality` export + twin), `templates/first-person` input wiring only.

## Gate

common.md.
