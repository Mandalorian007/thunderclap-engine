/**
 * Audio zones: regions of the world the listener can be in. Each zone weighs the listener
 * (1 inside its shape, smoothstep to 0 across `feather` outside it) and the weights drive an
 * ambient loop per zone and per-bus reverb sends. Pure bookkeeping over `AudioEngine`: no new
 * graph nodes, nothing allocated per `update`.
 */
import type { OutputBus, PlayOptions, Voice } from './audio';

/** A sphere or an axis-aligned box in world units. */
export type ZoneShape =
  | { sphere: { center: ArrayLike<number>; radius: number } }
  | { box: { center: ArrayLike<number>; halfExtents: ArrayLike<number> } };

export interface AudioZoneDesc {
  shape: ZoneShape;
  /** World units outside the shape over which the weight goes 1 → 0 (smoothstep). Default 1. */
  feather?: number;
  /**
   * A loop played while the listener is in or near the zone: one `Voice` per zone, started the
   * first time the weight rises above 0, gain = weight × `gain` (default 1) ramped over `fade`,
   * stopped once the weight has stayed 0 for `fade` seconds.
   */
  ambient?: { sound: string; bus?: OutputBus; gain?: number };
  /**
   * Reverb send per bus while inside (linear). Across zones the largest `weight × send` wins,
   * and the engine applies `max(base, zone)` where `base` is what `setReverbSend` set.
   */
  reverbSend?: Partial<Record<OutputBus, number>>;
  /** Seconds the ambient gain takes to ramp fully, and the silence before its voice stops. Default 0.5. */
  fade?: number;
}

/** A zone added to `audio.zones`; read-only bookkeeping, removed with `zones.remove(zone)`. */
export interface AudioZone {
  readonly desc: AudioZoneDesc;
  /** The listener's weight at the last `update`: 1 inside, 0 beyond the feather. */
  readonly weight: number;
  /** The ambient voice's current gain (0 when none plays). */
  readonly ambientGain: number;
  /** The ambient voice while one plays. */
  readonly voice: Voice | null;
}

/** What `AudioZones` needs from the engine (`AudioEngine` implements it). */
export interface AudioZoneHost {
  readonly listener: { readonly position: ArrayLike<number> };
  loop(sound: string, opts?: PlayOptions): Voice;
  /** The zones' contribution to one bus's reverb send (blended with the base by the host). */
  setZoneReverbSend(bus: OutputBus, level: number): void;
}

const DEFAULT_FEATHER = 1;
const DEFAULT_FADE = 0.5;
const ZONE_BUSES: readonly OutputBus[] = ['music', 'sfx', 'ui'];
/** Gain changes below this are not written to the voice. */
const GAIN_EPSILON = 1e-3;

/**
 * The listener's weight for `desc` at `position`: 1 inside the shape, smoothstep down to 0 at
 * `feather` world units outside it (a feather of 0 is a hard edge). Pure, allocation-free.
 */
export function zoneWeight(desc: AudioZoneDesc, position: ArrayLike<number>): number {
  const px = position[0] ?? 0;
  const py = position[1] ?? 0;
  const pz = position[2] ?? 0;
  let outside: number;
  const s = desc.shape;
  if ('sphere' in s) {
    const c = s.sphere.center;
    const dx = px - (c[0] ?? 0);
    const dy = py - (c[1] ?? 0);
    const dz = pz - (c[2] ?? 0);
    outside = Math.sqrt(dx * dx + dy * dy + dz * dz) - s.sphere.radius;
  } else {
    const c = s.box.center;
    const h = s.box.halfExtents;
    const dx = Math.max(0, Math.abs(px - (c[0] ?? 0)) - (h[0] ?? 0));
    const dy = Math.max(0, Math.abs(py - (c[1] ?? 0)) - (h[1] ?? 0));
    const dz = Math.max(0, Math.abs(pz - (c[2] ?? 0)) - (h[2] ?? 0));
    outside = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  if (outside <= 0) return 1;
  const feather = desc.feather ?? DEFAULT_FEATHER;
  if (outside >= feather) return 0;
  const t = outside / feather;
  return 1 - t * t * (3 - 2 * t);
}

class ZoneImpl implements AudioZone {
  weight = 0;
  ambientGain = 0;
  voice: Voice | null = null;
  /** Seconds the weight has been 0 while a voice plays. */
  silentFor = 0;
  constructor(readonly desc: AudioZoneDesc) {}
}

/**
 * The zones of one `AudioEngine` (`audio.zones`). `update(dt)` weighs the listener against
 * every zone, ramps the ambient voices and resolves the reverb sends; `AudioEngine.update`
 * calls it, and `createGame`'s loop calls that.
 */
export class AudioZones {
  private readonly list: ZoneImpl[] = [];
  private readonly _weights: number[] = [];
  private readonly sendMax: Record<OutputBus, number> = { music: 0, sfx: 0, ui: 0 };
  private readonly sendApplied: Record<OutputBus, number> = { music: 0, sfx: 0, ui: 0 };

  constructor(private readonly host: AudioZoneHost) {}

  /** Add a zone. Its weight is 0 until the next `update`. */
  add(desc: AudioZoneDesc): AudioZone {
    const z = new ZoneImpl(desc);
    this.list.push(z);
    this._weights.push(0);
    return z;
  }

  /** Remove a zone, stopping its ambient voice over the zone's `fade`. Unknown zones are ignored. */
  remove(zone: AudioZone): void {
    const i = this.list.indexOf(zone as ZoneImpl);
    if (i < 0) return;
    const z = this.list[i]!;
    z.voice?.stop(z.desc.fade ?? DEFAULT_FADE);
    z.voice = null;
    z.weight = 0;
    z.ambientGain = 0;
    this.list.splice(i, 1);
    this._weights.splice(i, 1);
  }

  /** The zones, in the order added. */
  get size(): number {
    return this.list.length;
  }

  /** The weight of every zone at the last `update`, in the order added (the same array each call). */
  weights(): ReadonlyArray<number> {
    return this._weights;
  }

  /**
   * Weigh the listener (default `host.listener.position`) against every zone, ramp the ambient
   * voices and apply the reverb sends. Allocates nothing; the only graph writes are `setGain`
   * on a voice whose gain changed and a send whose level changed by more than 1e-3.
   */
  update(dt: number, listenerPosition: ArrayLike<number> = this.host.listener.position): void {
    const sends = this.sendMax;
    sends.music = 0;
    sends.sfx = 0;
    sends.ui = 0;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const z = list[i]!;
      const d = z.desc;
      const w = zoneWeight(d, listenerPosition);
      z.weight = w;
      this._weights[i] = w;
      const rs = d.reverbSend;
      if (rs && w > 0) {
        for (let b = 0; b < ZONE_BUSES.length; b++) {
          const bus = ZONE_BUSES[b]!;
          const s = rs[bus];
          if (s !== undefined && w * s > sends[bus]) sends[bus] = w * s;
        }
      }
      if (d.ambient) this.updateAmbient(z, w, dt);
    }
    for (let b = 0; b < ZONE_BUSES.length; b++) {
      const bus = ZONE_BUSES[b]!;
      if (Math.abs(sends[bus] - this.sendApplied[bus]) > GAIN_EPSILON) {
        this.sendApplied[bus] = sends[bus];
        this.host.setZoneReverbSend(bus, sends[bus]);
      }
    }
  }

  private updateAmbient(z: ZoneImpl, w: number, dt: number): void {
    const a = z.desc.ambient!;
    const fade = z.desc.fade ?? DEFAULT_FADE;
    const peak = a.gain ?? 1;
    const target = w * peak;
    if (!z.voice) {
      if (target <= 0) return;
      z.voice = this.host.loop(a.sound, { bus: a.bus ?? 'sfx', gain: 0, fadeIn: 0 });
      z.ambientGain = 0;
      z.silentFor = 0;
    }
    // Linear ramp: the full peak takes `fade` seconds.
    const step = fade > 0 ? (peak * dt) / fade : Math.abs(target - z.ambientGain);
    const diff = target - z.ambientGain;
    const next = Math.abs(diff) <= step ? target : z.ambientGain + Math.sign(diff) * step;
    if (Math.abs(next - z.ambientGain) > GAIN_EPSILON || (next === 0 && z.ambientGain !== 0)) {
      z.ambientGain = next;
      z.voice.setGain(next);
    }
    if (w <= 0) {
      z.silentFor += dt;
      if (z.silentFor >= fade && z.ambientGain <= GAIN_EPSILON) {
        z.voice.stop();
        z.voice = null;
        z.ambientGain = 0;
      }
    } else {
      z.silentFor = 0;
    }
  }
}
