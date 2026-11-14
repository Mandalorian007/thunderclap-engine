# ui/spec: UI described as data

The public story (words, `panel`, `hud`, `presentDom`, `theme`) is in [../README.md](../README.md#ui-specs-panel-hud-presentdom-wsui-spec). This file maps the code.

| File | What it holds |
| --- | --- |
| `words.ts` | The spec types (`PanelSpec`, every `Spec*` word), `b(key)`, `SPEC_LINE`, `SPEC_TYPE`. |
| `units.ts` | Kinds, bind roles, alignments, `typeMeasure`, `wrapLines`, `tabShares`, `cut` (internal). |
| `compile.ts` | `compileSpec`: the tree flattened to typed arrays in pre-order, binds by key and role, list fields. Throws on a typo. |
| `boxes.ts` | `SpecBoxes`: the two-pass layout (natural sizes up, grow shares down in 1/64 px), list rows once in cell coordinates, `hit`, `rowAt`, `tops`. |
| `model.ts` | `SpecModel`: values by key with a dirty set; lists by key with a row bitmask of dirty fields. |
| `press.ts` | `SpecPressable`: tap, hold, slop and a context press on an injected timer. |
| `panel.ts` | `SpecPanel` and `panel(spec)`: one apply a frame, only when something changed. |
| `present-dom.ts` | `presentDom`: one element per word, pooled list rows, delegated events, one stylesheet. |
| `hud.ts` | `hud`, `presentHud` (through `ui.layout`), `presentModal` (through `ui.stack`), `specScale`. |
| `theme.ts` | `theme(tokens)`: `SpecTokens` as `--tcs-*` custom properties. |
| `measure.ts` | `wrapCount`, `wrapText`, `textWidth`, `measureWith`. |

Rules that keep it cheap:

- An idle `apply` returns before any presenter runs; the layout runs only when a box can have moved
  (a `show`, a list's length, a bound line count, a new frame).
- `SpecBoxes.layout` and a model set allocate nothing once warm (`spec.test.ts` budgets).
- The DOM presenter reads nothing back from the page while applying, writes only bound words of
  dirty keys and dirty row fields, and moves pooled rows on a resort; a scroll writes only
  `boxes.scroll` (for hit tests by a world presenter).

Not ported from Forge Wilds: the game-specific words (item art, aim, give-way), the world presenter
(the next step draws `SpecBoxes` on a world panel), list windowing.
