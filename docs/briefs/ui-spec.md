# Brief: ws/ui-spec (C5)

Read `common.md`, `wave-2.0-1.md`, E-041, `docs/design/2.0/architecture.md` P7 and **§2.14**, `src/ui/README.md`, ARCHITECTURE UI sections. Forge source (read only): `FW:ui/spec/` (words.ts, layout.ts, model.ts, present.ts, present-html.ts, hud-layout.ts, measure.ts) and the generic notices/tags/panel manager it names; their tests under `FW:../test/`.

## Goal

UI described once as data, shown by presenters. This wave: the spec, the model, the layout and the **DOM presenter**, with a token look (world presenter and VR are C6, later). STATUS *done when*: "Forge's UI framework tests ported; today's `ui` widgets expressible as specs; the idle HUD scene allocates nothing once warm."

1. Words (stack, grid, list, text, slot, meter, icon, button, field, tabs, range…) bound to model keys; a model that marks changed keys; pure allocation-free layout; `panel(spec)`, `hud(spec)`.
2. DOM presenter: updates only changed keys; focus, ARIA and PadNav behave as the existing overlay does; layout regions and safe areas from today's `ui.layout`.
3. Tokens (`theme(tokens)`) as the look, not parsed CSS.
4. The existing `ctx.ui` overlay API is unchanged (The Last Rune uses it).
5. Harness page `harness/ui-spec.html`: an RPG-style HUD (bars, a hotbar, a quest list, a dialog) driven from a model; e2e on the matrix.
6. Port the generic half of Forge's spec tests.

## Files owned

New `src/ui/spec/**`, `src/ui/index.ts` (additive), `harness/ui-spec*`, its spec. Don't change existing `src/ui` widget files except to share a helper (say so).

## Gate

common.md, plus the ui and layout specs green on their own.
