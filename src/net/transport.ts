/**
 * The transport seam. The engine opens no connection of its own: the game or host hands a session a
 * `Connect`, which opens one connection and reports on it through the events it is given. A
 * WebSocket `Connect` is a few lines in the game or a host package.
 *
 * The engine ships only in-page transports, for tests and demos: `inPagePair` (one link between two
 * ends) and `inPageHub` (a server end that accepts many clients, each a new link), both with
 * adjustable latency, jitter and loss.
 */

/** One open connection. */
export interface Transport {
  /** Sends one frame (dropped once closed). */
  send(frame: Uint8Array): void;
  /** Closes it; `close` is reported to both ends. */
  close(): void;
}

/** What a connection reports. */
export interface TransportEvents {
  /** It opened: frames may be sent. */
  open(): void;
  /** A frame arrived. */
  message(frame: Uint8Array): void;
  /** It closed (once; after `open` or instead of it). 1000 is a clean close, 1006 a lost link. */
  close(code: number, reason: string): void;
}

/** Opens one connection. Events come later, never inside the call. */
export type Connect = (events: TransportEvents) => Transport;

/** Timers a transport or session uses; tests pass fakes. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A millisecond clock. */
  now(): number;
}

/** The page's own timers. */
export const pageTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

/** How an in-page link behaves; change it at any time. */
export interface LinkConditions {
  /** One-way delay, ms (default 0). */
  latencyMs: number;
  /** Extra random one-way delay, up to this, ms (default 0). */
  jitterMs: number;
  /** The chance a frame is lost, 0..1 (default 0). A reliable link resends it, so it comes late. */
  loss: number;
  /** How late a lost frame comes (the resend timeout), ms (default 200). */
  rtoMs: number;
}

/** Options for an in-page link. */
export interface InPageOptions {
  /** Starting conditions; the link's `conditions` object can be changed later. */
  readonly conditions?: Partial<LinkConditions>;
  /** A random number in [0, 1) (default `Math.random`). */
  readonly random?: () => number;
  /** Timers (default the page's). */
  readonly timers?: Timers;
}

/** An in-page link: its two `Connect`s, its conditions, and a way to cut it. */
export interface InPageLink {
  /** The two ends. Each may be connected once. */
  readonly ends: readonly [Connect, Connect];
  /** Conditions in both directions, live. */
  readonly conditions: LinkConditions;
  /** Cuts the link as a lost connection does (1006 at both ends, at once). */
  drop(): void;
  /** Whether it is closed. */
  readonly closed: boolean;
}

/** The default conditions: an instant, lossless link. */
export function linkConditions(c: Partial<LinkConditions> = {}): LinkConditions {
  return { latencyMs: 0, jitterMs: 0, loss: 0, rtoMs: 200, ...c };
}

interface End {
  events: TransportEvents | null;
  /** When the last frame towards this end arrives: frames arrive in order. */
  lastAt: number;
  opened: boolean;
  closed: boolean;
  /** What is on its way to this end, in arrival order; one timer for the head. */
  queue: { at: number; fn: () => void }[];
  timer: unknown;
}

/**
 * One in-page link between two ends. Both open once both have connected; closing either closes both.
 * Frames are copied on send and arrive in order, each after the latency, its jitter, and the resend
 * timeout if it was lost (later frames wait behind it, as on a reliable stream).
 */
export function inPageLink(options: InPageOptions = {}, conditions?: LinkConditions): InPageLink {
  const cond = conditions ?? linkConditions(options.conditions);
  const random = options.random ?? Math.random;
  const timers = options.timers ?? pageTimers;
  const ends: [End, End] = [
    { events: null, lastAt: 0, opened: false, closed: false, queue: [], timer: null },
    { events: null, lastAt: 0, opened: false, closed: false, queue: [], timer: null },
  ];
  let closed = false;
  let dropped = false;
  const handles = new Set<unknown>();

  const later = (ms: number, fn: () => void) => {
    const h = timers.setTimeout(() => {
      handles.delete(h);
      fn();
    }, ms);
    handles.add(h);
  };
  /**
   * Delivers `fn` at `to` after this link's delay, in order behind what is already on its way
   * there. One timer per end runs everything due, so timer rounding can't reorder frames.
   */
  const toward = (to: End, fn: () => void) => {
    const now = timers.now();
    let at = now + cond.latencyMs + cond.jitterMs * random();
    if (cond.loss > 0 && random() < cond.loss) at += cond.rtoMs;
    if (at < to.lastAt) at = to.lastAt;
    to.lastAt = at;
    to.queue.push({ at, fn });
    if (to.timer === null) schedule(to);
  };
  const schedule = (to: End) => {
    const head = to.queue[0];
    if (!head) return;
    to.timer = timers.setTimeout(
      () => {
        handles.delete(to.timer);
        to.timer = null;
        const now = timers.now();
        let n = 0;
        while (n < to.queue.length && to.queue[n]!.at <= now) n++;
        const due = to.queue.splice(0, Math.max(1, n));
        for (const d of due) {
          if (dropped) return;
          d.fn();
        }
        if (to.timer === null) schedule(to);
      },
      Math.max(0, head.at - timers.now()),
    );
    handles.add(to.timer);
  };
  const closeBoth = (code: number, reason: string, delayed: boolean) => {
    if (closed) return;
    closed = true;
    for (const end of ends) {
      const deliver = () => {
        if (end.closed) return;
        end.closed = true;
        end.events?.close(code, reason);
      };
      if (delayed) toward(end, deliver);
      else later(0, deliver);
    }
  };
  const open = () => {
    for (const end of ends) {
      toward(end, () => {
        if (closed || end.opened) return;
        end.opened = true;
        end.events?.open();
      });
    }
  };

  const connect =
    (i: 0 | 1): Connect =>
    (events) => {
      const me = ends[i];
      const other = ends[1 - i]!;
      if (me.events || closed) {
        // A link is one connection: a second connect on an end fails, as a refused socket does.
        const dead: TransportEvents = events;
        timers.setTimeout(() => dead.close(1006, 'link used'), 0);
        return { send() {}, close() {} };
      }
      me.events = events;
      if (other.events) open();
      return {
        send(frame) {
          if (closed || !me.opened) return;
          const copy = frame.slice();
          toward(other, () => {
            if (!other.closed && other.opened) other.events?.message(copy);
          });
        },
        close() {
          closeBoth(1000, 'closed', true);
        },
      };
    };

  return {
    ends: [connect(0), connect(1)],
    conditions: cond,
    drop() {
      if (closed) return;
      dropped = true;
      for (const h of handles) timers.clearTimeout(h);
      handles.clear();
      for (const end of ends) {
        end.queue.length = 0;
        end.timer = null;
      }
      closeBoth(1006, 'dropped', false);
    },
    get closed() {
      return closed;
    },
  };
}

/** Two ends of one in-page link, for tests: `const [a, b] = inPagePair()`. */
export function inPagePair(options: InPageOptions = {}): [Connect, Connect] {
  const link = inPageLink(options);
  return [link.ends[0], link.ends[1]];
}

/** An in-page server: clients connect through `connect`; each connection is a new link. */
export interface InPageHub {
  /** What a client is handed: each call is a new link to the server. */
  readonly connect: Connect;
  /** Conditions of every link, live. */
  readonly conditions: LinkConditions;
  /** The links open now. */
  readonly links: ReadonlySet<InPageLink>;
  /** Cuts every open link (1006). */
  dropAll(): void;
}

/**
 * An in-page server end. `accept` is called with the server end of each new link (connect it to
 * serve that client) and the link.
 */
export function inPageHub(
  accept: (serverEnd: Connect, link: InPageLink) => void,
  options: InPageOptions = {},
): InPageHub {
  const conditions = linkConditions(options.conditions);
  const links = new Set<InPageLink>();
  return {
    conditions,
    links,
    connect(events) {
      const link = inPageLink(options, conditions);
      links.add(link);
      const client = link.ends[0]({
        open: () => events.open(),
        message: (f) => events.message(f),
        close: (code, reason) => {
          links.delete(link);
          events.close(code, reason);
        },
      });
      accept(link.ends[1], link);
      return client;
    },
    dropAll() {
      for (const link of [...links]) link.drop();
    },
  };
}
