/**
 * ADSR envelopes. One source of truth: `envelopeSegments` produces breakpoints, which
 * `envelopeValueAt` evaluates (pure, tested) and `scheduleEnvelope` writes to an `AudioParam`
 * with the matching automation calls, so what we test is what plays.
 */

export interface Envelope {
  /** Seconds from 0 to peak (always linear). */
  attack: number;
  /** Seconds held at peak. Default 0. */
  hold?: number;
  /** Seconds from peak to `sustain`. */
  decay: number;
  /** Sustain level, 0..1 of peak. */
  sustain: number;
  /** Seconds from the gate-off value to silence. */
  release: number;
  /** Shape of decay and release. `exp` sounds natural for percussive sounds. Default `exp`. */
  curve?: 'linear' | 'exp';
}

/** A breakpoint: reach `v` at time `t`, ramping from the previous point with `ramp`. */
export interface Segment {
  t: number;
  v: number;
  ramp: 'set' | 'linear' | 'exp';
}

/** Smallest level an exponential ramp can target (WebAudio can't ramp exponentially to 0). */
export const EXP_FLOOR = 1e-4;

/** Shorthand for a percussive envelope: instant-ish attack, exponential fall. */
export function pluck(decay: number, attack = 0.002): Envelope {
  return { attack, decay, sustain: 0, release: 0.01, curve: 'exp' };
}

/** Total audible length for a given gate (time from note-on to note-off). */
export function envelopeLength(env: Envelope, gate: number): number {
  return Math.max(0, gate) + env.release;
}

function interp(a: Segment, b: Segment, t: number): number {
  if (t >= b.t) return b.v;
  if (t <= a.t) return a.v;
  const p = (t - a.t) / (b.t - a.t);
  if (b.ramp === 'set') return a.v;
  if (b.ramp === 'linear') return a.v + (b.v - a.v) * p;
  const v0 = Math.max(a.v, EXP_FLOOR);
  const v1 = Math.max(b.v, EXP_FLOOR);
  return v0 * (v1 / v0) ** p;
}

/** Evaluate a breakpoint list at time `t` (relative to its start). */
export function evaluateSegments(segs: readonly Segment[], t: number): number {
  if (segs.length === 0 || t < segs[0]!.t) return 0;
  for (let i = 1; i < segs.length; i++) {
    if (t < segs[i]!.t) return interp(segs[i - 1]!, segs[i]!, t);
  }
  return segs[segs.length - 1]!.v;
}

/**
 * Breakpoints for `env` scaled by `peak`, starting at t=0, with note-off at `gate` seconds.
 * If the gate closes during attack/decay, release starts from the value at that moment.
 * The last point is exactly 0.
 */
export function envelopeSegments(env: Envelope, gate: number, peak = 1): Segment[] {
  const exp = (env.curve ?? 'exp') === 'exp';
  const a = Math.max(0, env.attack);
  const h = Math.max(0, env.hold ?? 0);
  const d = Math.max(0, env.decay);
  const r = Math.max(1e-4, env.release);
  const s = Math.min(1, Math.max(0, env.sustain)) * peak;
  const g = Math.max(0, gate);

  const full: Segment[] = [{ t: 0, v: 0, ramp: 'set' }];
  if (a > 0) full.push({ t: a, v: peak, ramp: 'linear' });
  else full[0] = { t: 0, v: peak, ramp: 'set' };
  if (h > 0) full.push({ t: a + h, v: peak, ramp: 'linear' });
  if (d > 0)
    full.push({ t: a + h + d, v: exp ? Math.max(s, EXP_FLOOR) : s, ramp: exp ? 'exp' : 'linear' });
  else if (s !== peak) full.push({ t: a + h, v: s, ramp: 'set' });

  // Keep points strictly before the gate, then a point at the gate with the curve's value there.
  const out = full.filter((p) => p.t < g || (p.t === 0 && g === 0));
  const atGate = evaluateSegments(full, g);
  const next = full.find((p) => p.t >= g);
  if (g > 0 || out.length === 0) {
    out.push({ t: g, v: atGate, ramp: next ? next.ramp : 'linear' });
  }
  // A 'set' point at the gate would jump; at the gate we already hold atGate, so mark it linear.
  const last = out[out.length - 1]!;
  if (last.ramp === 'set' && last.t > 0) last.ramp = 'linear';

  if (exp && atGate > EXP_FLOOR) {
    out.push({ t: g + r, v: EXP_FLOOR, ramp: 'exp' });
    out.push({ t: g + r, v: 0, ramp: 'set' });
  } else {
    out.push({ t: g + r, v: 0, ramp: 'linear' });
  }
  return out;
}

/** Peak-normalised value of `env` at time `t` for a note with the given gate. */
export function envelopeValueAt(env: Envelope, t: number, gate: number, peak = 1): number {
  return evaluateSegments(envelopeSegments(env, gate, peak), t);
}

/** The subset of `AudioParam` used for scheduling (lets tests record calls). */
export interface ParamLike {
  value: number;
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
  exponentialRampToValueAtTime(v: number, t: number): unknown;
  cancelScheduledValues(t: number): unknown;
}

/** Write breakpoints to an `AudioParam`, offset by `start` (context time). */
export function scheduleSegments(param: ParamLike, segs: readonly Segment[], start: number): void {
  param.cancelScheduledValues(start);
  for (const p of segs) {
    const t = start + p.t;
    if (p.ramp === 'set') param.setValueAtTime(p.v, t);
    else if (p.ramp === 'linear') param.linearRampToValueAtTime(p.v, t);
    else param.exponentialRampToValueAtTime(Math.max(EXP_FLOOR, p.v), t);
  }
}

/** Schedule `env` on `param` (usually a GainNode's gain). Returns the end time. */
export function scheduleEnvelope(
  param: ParamLike,
  env: Envelope,
  start: number,
  gate: number,
  peak = 1,
): number {
  const segs = envelopeSegments(env, gate, peak);
  scheduleSegments(param, segs, start);
  return start + segs[segs.length - 1]!.t;
}
