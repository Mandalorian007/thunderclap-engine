/**
 * An effect send: a parallel path from one bus through a reverb (`ConvolverNode` on a
 * procedural impulse) or a lowpass (`BiquadFilterNode`) back into master. A zone drives
 * `amount` (and `cutoff`) as the listener moves. Built with the context; safe before unlock.
 */
import type { AudioEngine, OutputBus } from './audio';
import { impulseResponse } from './dsp';

export type SendKind = 'reverb' | 'lowpass';

export interface SendOptions {
  kind: SendKind;
  /** Bus whose signal feeds the send. Default `sfx`. */
  bus?: OutputBus;
  /** Starting send level 0..1. Default 0 (silent until a zone raises it). */
  amount?: number;
  /** Reverb: impulse length in seconds. Default 2. */
  seconds?: number;
  /** Reverb: tail shape, `(1 - t)^decay`. Default 3. */
  decay?: number;
  /** Reverb: impulse noise seed. Default 1. */
  seed?: number;
  /** Lowpass: starting cutoff in Hz. Default 800. */
  cutoff?: number;
  /** Lowpass: resonance. Default 0.7. */
  q?: number;
}

export interface Send {
  readonly kind: SendKind;
  /** Send level 0..1 (linear, ramped over ~15 ms). */
  amount: number;
  /** Lowpass cutoff in Hz (ramped). Undefined on a reverb send. */
  cutoff: number | undefined;
  /** The effect node (`ConvolverNode` or `BiquadFilterNode`), once the context exists. */
  readonly node: ConvolverNode | BiquadFilterNode | null;
  /**
   * The send's input gain. Anything with `connect` (a voice's own node, another bus) can feed it
   * directly; the source bus is connected for you.
   */
  readonly input: GainNode | null;
  /** Disconnect everything. */
  dispose(): void;
}

export function createSend(mixer: AudioEngine, opts: SendOptions): Send {
  const kind = opts.kind;
  const bus: OutputBus = opts.bus ?? 'sfx';
  let amount = clamp01(opts.amount ?? 0);
  let cutoff = Math.max(10, opts.cutoff ?? 800);
  const q = opts.q ?? 0.7;
  let input: GainNode | null = null;
  let node: ConvolverNode | BiquadFilterNode | null = null;
  let ret: GainNode | null = null;
  let builtOn: AudioContext | null = null;
  let unsub: (() => void) | null = null;
  let disposed = false;

  function build(): void {
    const ctx = mixer.context;
    const from = mixer.busNode(bus);
    const master = mixer.busNode('master');
    if (disposed || !ctx || !from || !master || builtOn === ctx) return;
    let effect: ConvolverNode | BiquadFilterNode;
    if (kind === 'reverb') {
      if (typeof ctx.createConvolver !== 'function') return;
      const c = ctx.createConvolver();
      c.normalize = true;
      c.buffer = impulseResponse(ctx, {
        seconds: opts.seconds,
        decay: opts.decay,
        seed: opts.seed,
      });
      effect = c;
    } else {
      if (typeof ctx.createBiquadFilter !== 'function') return;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoff;
      f.Q.value = q;
      effect = f;
    }
    const g = ctx.createGain();
    g.gain.value = amount;
    const r = ctx.createGain();
    r.gain.value = 1;
    from.connect(g);
    g.connect(effect);
    effect.connect(r);
    r.connect(master);
    input = g;
    node = effect;
    ret = r;
    builtOn = ctx;
  }

  function teardown(): void {
    const from = mixer.busNode(bus);
    if (input) {
      try {
        from?.disconnect(input);
      } catch {
        // Not connected (context replaced).
      }
      input.disconnect();
    }
    node?.disconnect();
    ret?.disconnect();
    input = null;
    node = null;
    ret = null;
    builtOn = null;
  }

  build();
  if (!builtOn) {
    unsub = mixer.onStateChange((s) => {
      if (s === 'running') build();
    });
  }

  return {
    kind,
    get amount() {
      return amount;
    },
    set amount(v: number) {
      amount = clamp01(v);
      const ctx = mixer.context;
      if (input && ctx) input.gain.setTargetAtTime(amount, ctx.currentTime, 0.015);
    },
    get cutoff() {
      return kind === 'lowpass' ? cutoff : undefined;
    },
    set cutoff(v: number | undefined) {
      if (kind !== 'lowpass' || v === undefined) return;
      cutoff = Math.max(10, Number.isFinite(v) ? v : cutoff);
      const ctx = mixer.context;
      if (node && ctx)
        (node as BiquadFilterNode).frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.015);
    },
    get node() {
      return node;
    },
    get input() {
      return input;
    },
    dispose() {
      disposed = true;
      unsub?.();
      unsub = null;
      teardown();
    },
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}
