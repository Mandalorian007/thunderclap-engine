/**
 * Analytics: the game's events and where they go. The engine batches typed events and hands
 * them to a sink; the sink is the game's (the engine makes no network call), and so is the
 * decision to have one at all. `COLLECT_URL` is `null` here, so the template sends nothing:
 * set it to an endpoint you own, with the consent your product needs, and the batches go out
 * through `navigator.sendBeacon` (it survives the page unloading, which is when the last batch
 * is flushed).
 *
 * Events, following the engine's convention (`@thunderclap/engine/analytics` README):
 * - `level_start`: a board was dealt (`level` names it; here the board size).
 * - `level_complete`: every pair was matched (`ms` since the deal, `moves` taken).
 */
import type { AnalyticsEvent, AnalyticsSink } from '@thunderclap/engine/analytics';

/** Where batches are posted; `null` means no analytics (the events are never queued). */
export const COLLECT_URL: string | null = null;

export type Events = {
  level_start: { level: string };
  level_complete: { level: string; ms: number; moves: number };
};

/**
 * A sink that posts each batch as JSON with `navigator.sendBeacon`. Throws when the browser
 * refuses the beacon (the queue is full or there is no `sendBeacon`), which `createAnalytics`
 * reports through `onError` and drops the batch: no retry, no persistence.
 */
export function createBeaconSink(url: string): AnalyticsSink {
  return (events: AnalyticsEvent[]) => {
    const beacon = typeof navigator === 'undefined' ? undefined : navigator.sendBeacon;
    if (!beacon) throw new Error('sendBeacon is not available');
    if (!beacon.call(navigator, url, JSON.stringify(events))) {
      throw new Error(`beacon to ${url} refused`);
    }
  };
}
