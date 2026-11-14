/**
 * What the net harness page (harness/net.html) publishes on `window.__harnessNet` for
 * e2e/net.spec.ts. Shared by the page (harness/net.ts) and the spec.
 */

/** One client as the page sees it. */
export interface HarnessNetClient {
  /** `net.status`. */
  status: 'connecting' | 'open' | 'down' | 'closed';
  /** `welcome.player`, 0 before the first one. */
  player: number;
  /** Handshakes so far (one per connection). */
  welcomes: number;
  /** The predicted position (`predictor.state`). */
  x: number;
  y: number;
  /** Corrections and resets the predictor counted. */
  corrections: number;
  resets: number;
  /** Inputs in flight. */
  pending: number;
  /** The team score from the live query, -1 before the first result. */
  score: number;
  /** Things in the entity stream other than this client's own. */
  others: number;
  /** The other player drawn through the snapshot buffer (NaN while it has none). */
  otherX: number;
  otherY: number;
  /** The snapshot buffer's delay, ms. */
  delayMs: number;
  /** The server clock in steps (`net.clock.now()`). */
  clock: number;
}

export interface HarnessNetState {
  /** True once both clients are welcomed and have a score. */
  ready: boolean;
  /** The schema hash both sides use. */
  hash: string;
  /** The authority's step and score. */
  tick: number;
  score: number;
  /** Where the authority has each client's player, by `'a'` and `'b'`. */
  server: { a: { x: number; y: number }; b: { x: number; y: number } };
  a: HarnessNetClient;
  b: HarnessNetClient;
  /** The link conditions now. */
  latencyMs: number;
  jitterMs: number;
  loss: number;
  /** Frames drawn. */
  frames: number;
}

export interface HarnessNetApi {
  state: HarnessNetState;
  /** Sets the link conditions for every link, live. */
  setLink(conditions: { latencyMs?: number; jitterMs?: number; loss?: number }): void;
  /** The autopilot that walks both players to the beacon. */
  auto(on: boolean): void;
  /** Holds a direction for a client (each -1, 0 or 1); auto off to use it. */
  hold(client: 'a' | 'b', dx: number, dy: number): void;
  /** Drops every link: both clients reconnect. */
  drop(): void;
  /** Client a sends the `Reset` command; resolves with the score it returns. */
  reset(): Promise<number>;
}

declare global {
  interface Window {
    __harnessNet?: HarnessNetApi;
  }
}
