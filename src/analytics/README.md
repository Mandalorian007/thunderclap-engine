# engine/analytics

Typed, batched game events handed to a **sink the game supplies**. The engine has no network sink: no `fetch`, no `sendBeacon` (VISION rule 4: the engine makes no network calls; the game decides where data goes, or whether it goes at all). No dependencies.

## Quick use

<!-- snippet:check -->
```ts
import { createAnalytics } from '@thunderclap-engine/engine/analytics';

type MyEvents = { level_start: { level: string }; level_complete: { level: string; ms: number } };

const analytics = createAnalytics<MyEvents>({
  sink: (events) => console.log(events), // the game decides where events go
  context: { build: '0.4.1' },
});
analytics.emit('level_start', { level: 'intro' }); // props are type-checked
```

## Entry points

| Name | What it is for |
| --- | --- |
| `createAnalytics<E>(opts)` | the batched event client; `sink` is the game's |
| `analytics.emit(name, props)` | queue one typed event |
| `analytics.attach(ctx)` | `game_start` now, `session_end` and a flush when the page hides |
| `analytics.flush()` | hand the queued batch to the sink now |
| `AnalyticsSink` | `(events) => void | Promise<void>`: where the batch goes |
| `EngineEvents` | the events the engine itself emits |

## Usage

```ts
import { createAnalytics } from '@thunderclap-engine/engine/analytics';

type MyEvents = {
  level_start: { level: string };
  level_complete: { level: string; ms: number };
};

const analytics = createAnalytics<MyEvents>({
  sink: (events) => { navigator.sendBeacon('/collect', JSON.stringify(events)); },
  context: { build: '0.4.1' },          // on every event; `build` also lands in game_start
  onError: (e) => console.warn(e),      // sink failures land here, never thrown
});

const ctx = await createGame({ /* ... */ });
if (ctx) analytics.attach(ctx);         // game_start now; session_end + flush on hide

analytics.emit('level_start', { level: 'intro' });   // props are type-checked
```

## A sendBeacon sink is three lines

```ts
sink: (events) => {
  if (!navigator.sendBeacon('https://example.com/collect', JSON.stringify(events))) {
    throw new Error('beacon refused'); // reported through onError
  }
}
```

The engine will not ship this for you. Delivery is a product decision (consent, endpoint, privacy), so it lives in the game. `templates/puzzle/src/analytics.ts` has it as `createBeaconSink(url)`, built only when the template's `COLLECT_URL` is set.

## Convention: `level_start` and `level_complete`

Games name their own events, but two names are the convention so dashboards and the template agree:

| Event | Props | When |
| --- | --- | --- |
| `level_start` | `level: string` (a stable name: `'intro'`, `'4x4'`, a seed) | a level, board or round begins (including the first one after `game_start`) |
| `level_complete` | `level: string`, `ms: number` (since `level_start`), plus the game's score fields (the template adds `moves`) | the goal is reached |

Restarting a level emits a fresh `level_start`; an abandoned level has no `level_complete` (session_end's `durationMs` covers the time). `templates/puzzle` emits both from `main.ts` (the deal) and `scenes/board.ts` (the win).

## Events

Each `AnalyticsEvent` is `{ name, props, session, seq, t, context? }`. `session` is random per page load; `seq` counts from 1; `t` is `clock()` (default `Date.now`, injectable for tests).

| Built-in | Props | When |
| --- | --- | --- |
| `game_start` | `formFactor`, `deviceKind` (host kind), `dpr`, `viewport`, `embed`, `build` | `attach` |
| `session_end` | `durationMs`, `reason`: `hidden`, `pagehide`, `freeze`, `deviceLost` | page hides (once per hidden stretch), or device lost |
| `device_lost` | `reason`, `message` | `ctx.hooks.deviceLost` |

Games add their own through the generic `E`. A batch is flushed on `flush()`, on every `session_end`, and automatically at `maxBatch` (default 20).

## Types

`createAnalytics<E>(opts: AnalyticsOptions): Analytics<E>`. `AnalyticsOptions` is `{ sink, session?, clock?, context?, onError?, maxBatch? }`; `AnalyticsSink` is `(events: AnalyticsEvent[]) => void | Promise<void>`; `AnalyticsContext` is the read-only record of strings, numbers and booleans attached to every event. `Analytics<E>` has `session`, `pending` (queued, not yet flushed), `emit`, `flush` and `attach`. `EngineEvents` types the three built-in events above; `SessionEndReason` is `HideReason | 'deviceLost'`. `AttachTarget` is the part of `EngineCtx` that `attach` reads (`hooks` and `host`, and `ui` and `surface` when present).

## `attach(ctx)`

It wraps `ctx.hooks.hide`, `ctx.hooks.show` and `ctx.hooks.deviceLost` (your own hooks still run, after it). `createGame` calls `hide(reason)` with the lifecycle reason (`hidden`, `pagehide`, `freeze`), which becomes `session_end.reason`; `show` re-arms it for the next hidden stretch. It adds no listeners of its own. The returned function restores the hooks (unless something wrapped them since).

`emit` and `flush` never throw. A failing sink is reported to `onError` and its batch is dropped (no retry, no persistence).
