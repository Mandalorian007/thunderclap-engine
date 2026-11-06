# Brief: ws/ui-hud

Read `docs/briefs/common.md` first, then DECISIONS E-013, E-015; `src/ui/README.md` whole (overlay, layers, regions, units, widgets, anchors, theme, accessibility checklist); `src/ui/widgets.ts` or wherever the small widgets live, `src/ui/theme.ts`, `src/ui/layout.ts`; `templates/first-person/src/hud.ts` (or wherever `ctx.hud` is built on ws/template-first-person: `git show ws/template-first-person --stat`) for what a 3D template hand-wrote; `harness/ui.ts`, `harness/layout.ts`.

## Goal

A first- or third-person game needs a reticle, a few meters, a slot strip and a heading indicator, built on the overlay in the engine's theme and units, reading like the rest of `ui`. No game nouns: a *meter* is a meter, not health; a *slot strip* is a strip, not an inventory.

STATUS row, *done when*: `ui.reticle({ style: 'dot' | 'cross' | 'circle'; size?; gap?; color? })` returns `Reticle { show(); hide(); pulse(); setStyle(); el }` centred on the frame in the `hud` layer, hidden by default when a modal is open; `ui.meter({ label?; max?; value?; region?; order?; tone? })` returns `Meter { set(value, max?); el }` with an accessible `role="meter"` and `aria-valuenow`; `ui.slots({ count; region?; order?; hints?: string[] })` returns `Slots { select(i); setContent(i, text | HTMLElement); el; selected }` with key-hint badges and a selected highlight; `ui.heading({ region?; width? })` returns `Heading { setYaw(radians); el }` a sliding cardinal strip (N E S W + ticks); all respond to `ui.units`, the theme tokens and the modal rule; harness `hud.html`; tests; documented.

## Scope

- `src/ui/hud.ts` (or four small files) exporting the four factories and types; register them on the overlay object (`ui.reticle`, `ui.meter`, `ui.slots`, `ui.heading`) following how `toasts`/`anchors` are attached. CSS in the overlay's injected stylesheet with `--tc-*` tokens only. Reticle lives in `ui.layers.hud` at frame centre; meters/slots/heading go through `ui.layout` regions like other widgets.
- Tests (`src/ui/hud.test.ts`, jsdom like the existing ui tests): DOM shape, aria attributes, `set` clamps, `select` wraps or clamps (document), heading strip translation for yaw 0 / π/2 / −π, reticle hidden while `ui.stack.hasModal`, `pulse` adds and removes a class.
- Harness `harness/hud.html|ts|-state.ts`: the mesh page's lit scene under a reticle, two meters (one draining on a timer), a 6-slot strip cycling selection, a heading strip driven by an orbiting camera's yaw; state exposes `meterValue`, `selected`, `yaw`, `reticleVisible`. `e2e/hud.spec.ts`: widgets present with aria roles, meter value changes (poll), selected slot changes, heading translates with yaw, reticle hides when a test opens a modal panel via the existing stack API.
- Snapshot gate: `pnpm snap:check` covers the 2D pages; `hud.html` is a 3D page and excluded. Do not touch `e2e/golden/*`.
- Docs: `src/ui/README.md` *HUD widgets* section, ARCHITECTURE *UI* one sentence, CHANGELOG, root README harness item.

## Files owned

`src/ui/hud.ts` (+ `hud.test.ts`, and optional `hud.css.ts` if styles are split), `src/ui/overlay.ts` (attach the four factories only), `src/ui/index.ts` (append), `src/ui/README.md` (*HUD widgets*), `harness/hud.*`, `e2e/hud.spec.ts`, `ARCHITECTURE.md` (one sentence), `CHANGELOG.md`, root `README.md` (harness item).

Branch from `main` (cb245ff or later). Running alongside: ws/geom, ws/ik, ws/anim-graph, ws/flake-input (`e2e/ui.spec.ts` menuNav polling: stay out of that file); three integrator chains touching render, input, fx, anim, templates and the doc lists.
