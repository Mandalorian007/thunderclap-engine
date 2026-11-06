import { afterEach, describe, expect, it } from 'vitest';
import { Transform } from '../render/transform';
import { AudioEngine, type OutputBus, type PlayOptions, type Voice } from './audio';
import { type AudioZoneDesc, type AudioZoneHost, AudioZones, zoneWeight } from './zones';

// ---------------------------------------------------------------- pure weights

const sphere: AudioZoneDesc = { shape: { sphere: { center: [10, 0, 0], radius: 2 } } };
const box: AudioZoneDesc = {
  shape: { box: { center: [0, 0, 0], halfExtents: [1, 2, 3] } },
  feather: 2,
};

describe('zoneWeight', () => {
  it('is 1 inside a sphere, 0 beyond the feather and smooth between', () => {
    expect(zoneWeight(sphere, [10, 0, 0])).toBe(1);
    expect(zoneWeight(sphere, [12, 0, 0])).toBe(1); // on the surface
    expect(zoneWeight(sphere, [12.5, 0, 0])).toBeCloseTo(0.5); // half way across feather 1
    expect(zoneWeight(sphere, [12.25, 0, 0])).toBeCloseTo(1 - 0.25 ** 2 * (3 - 0.5));
    expect(zoneWeight(sphere, [13, 0, 0])).toBe(0);
    expect(zoneWeight(sphere, [13.5, 0, 0])).toBe(0);
    expect(zoneWeight(sphere, [10, 5, 0])).toBe(0);
  });

  it('measures a box by the distance to its nearest face, edge or corner', () => {
    expect(zoneWeight(box, [0, 0, 0])).toBe(1);
    expect(zoneWeight(box, [1, 2, 3])).toBe(1);
    expect(zoneWeight(box, [2, 0, 0])).toBeCloseTo(0.5); // 1 outside, feather 2
    expect(zoneWeight(box, [0, 0, 5])).toBe(0);
    // Corner: (1, 1, 1) outside at the corner is √3 ≈ 1.73 away.
    const t = Math.sqrt(3) / 2;
    expect(zoneWeight(box, [2, 3, 4])).toBeCloseTo(1 - t * t * (3 - 2 * t));
  });

  it('treats feather 0 as a hard edge and tolerates short positions', () => {
    const hard: AudioZoneDesc = { shape: { sphere: { center: [0, 0, 0], radius: 1 } }, feather: 0 };
    expect(zoneWeight(hard, [1, 0, 0])).toBe(1);
    expect(zoneWeight(hard, [1.0001, 0, 0])).toBe(0);
    expect(zoneWeight(hard, [])).toBe(1);
  });
});

// ---------------------------------------------------------------- a recording host

class FakeVoice implements Voice {
  gains: number[] = [];
  stopped: number | null = null;
  playing = true;
  readonly position = new Float64Array(3);
  constructor(
    readonly sound: string,
    readonly opts: PlayOptions,
  ) {}
  stop(fade = 0) {
    this.stopped = fade;
    this.playing = false;
  }
  setGain(g: number) {
    this.gains.push(g);
  }
  setRate() {}
  setPosition() {}
  setDirection() {}
  follow() {}
}

class Host implements AudioZoneHost {
  readonly listener = { position: new Float64Array(3) };
  voices: FakeVoice[] = [];
  sends: [OutputBus, number][] = [];
  loop(sound: string, opts: PlayOptions = {}): Voice {
    const v = new FakeVoice(sound, opts);
    this.voices.push(v);
    return v;
  }
  setZoneReverbSend(bus: OutputBus, level: number) {
    this.sends.push([bus, level]);
  }
}

function at(host: Host, x: number, y = 0, z = 0) {
  host.listener.position[0] = x;
  host.listener.position[1] = y;
  host.listener.position[2] = z;
}

describe('AudioZones', () => {
  it('weights every zone against the listener, two overlapping zones included', () => {
    const host = new Host();
    const zones = new AudioZones(host);
    const a = zones.add({ shape: { sphere: { center: [0, 0, 0], radius: 2 } } });
    const b = zones.add({ shape: { box: { center: [2, 0, 0], halfExtents: [1, 1, 1] } } });
    const w = zones.weights();
    expect(w).toEqual([0, 0]);
    at(host, 1.5);
    zones.update(1 / 60);
    expect(w).toEqual([1, 1]);
    expect(a.weight).toBe(1);
    expect(b.weight).toBe(1);
    at(host, -2.5);
    zones.update(1 / 60);
    expect(w[0]).toBeCloseTo(0.5);
    expect(w[1]).toBe(0);
    // An explicit position wins over the listener.
    zones.update(1 / 60, [2, 0, 0]);
    expect(w[0]).toBe(1);
    expect(zones.weights()).toBe(w);
    zones.remove(a);
    expect(zones.size).toBe(1);
    expect(zones.weights()).toEqual([1]);
    zones.remove(a); // twice is fine
  });

  it('starts the ambient loop lazily, ramps its gain over fade and stops after fade of silence', () => {
    const host = new Host();
    const zones = new AudioZones(host);
    const z = zones.add({
      shape: { sphere: { center: [0, 0, 0], radius: 1 } },
      ambient: { sound: 'drip', bus: 'music', gain: 0.8 },
      fade: 0.5,
    });
    at(host, 10);
    zones.update(0.1);
    expect(host.voices).toHaveLength(0);
    expect(z.voice).toBeNull();
    at(host, 0);
    zones.update(0.1);
    expect(host.voices).toHaveLength(1);
    const v = host.voices[0]!;
    expect(v.sound).toBe('drip');
    expect(v.opts).toMatchObject({ bus: 'music', gain: 0, fadeIn: 0 });
    expect(z.voice).toBe(v);
    // Peak 0.8 over 0.5 s: 0.16 per 0.1 s.
    expect(z.ambientGain).toBeCloseTo(0.16);
    zones.update(0.1);
    zones.update(0.1);
    zones.update(0.1);
    zones.update(0.1);
    expect(z.ambientGain).toBeCloseTo(0.8);
    zones.update(0.1);
    expect(z.ambientGain).toBeCloseTo(0.8);
    expect(v.gains.at(-1)).toBeCloseTo(0.8);
    expect(v.gains).toHaveLength(5); // no write once settled
    // Half way out: the target follows the weight.
    at(host, 1.5);
    zones.update(0.1);
    expect(z.weight).toBeCloseTo(0.5);
    expect(z.ambientGain).toBeCloseTo(0.64);
    // Out: ramps to 0 and stops once silent for `fade`.
    at(host, 10);
    for (let i = 0; i < 4; i++) zones.update(0.1);
    expect(z.ambientGain).toBe(0);
    expect(v.stopped).toBeNull();
    zones.update(0.1);
    expect(v.stopped).toBe(0);
    expect(z.voice).toBeNull();
    // Back in: a fresh voice.
    at(host, 0);
    zones.update(0.1);
    expect(host.voices).toHaveLength(2);
    expect(z.voice).toBe(host.voices[1]);
    // Removing a zone fades its voice out.
    zones.remove(z);
    expect(host.voices[1]!.stopped).toBe(0.5);
  });

  it('sends the max of weight × send per bus and only when it moves by more than 1e-3', () => {
    const host = new Host();
    const zones = new AudioZones(host);
    zones.add({
      shape: { sphere: { center: [0, 0, 0], radius: 1 } },
      reverbSend: { sfx: 0.8, music: 0.4 },
    });
    zones.add({
      shape: { sphere: { center: [1, 0, 0], radius: 1 } },
      reverbSend: { sfx: 0.6, ui: 0.2 },
    });
    at(host, 0.5); // inside both
    zones.update(0.1);
    expect(host.sends).toEqual([
      ['music', 0.4],
      ['sfx', 0.8],
      ['ui', 0.2],
    ]);
    zones.update(0.1);
    expect(host.sends).toHaveLength(3); // unchanged: nothing written
    at(host, 2.5); // zone 1 at weight 0.5, zone 0 out
    zones.update(0.1);
    const last = host.sends.slice(3);
    expect(last.map(([b]) => b)).toEqual(['music', 'sfx', 'ui']);
    expect(last[0]![1]).toBe(0);
    expect(last[1]![1]).toBeCloseTo(0.3);
    expect(last[2]![1]).toBeCloseTo(0.1);
    // A change under 1e-3 is not written.
    at(host, 2.5005);
    zones.update(0.1);
    expect(host.sends).toHaveLength(6);
  });

  describe('allocation', () => {
    const Orig = globalThis.Float32Array;
    afterEach(() => {
      globalThis.Float32Array = Orig;
    });

    it('update allocates no typed arrays and keeps one weights array', () => {
      const host = new Host();
      const zones = new AudioZones(host);
      zones.add({
        shape: { sphere: { center: [0, 0, 0], radius: 2 } },
        ambient: { sound: 'a' },
        reverbSend: { sfx: 1 },
      });
      zones.add({
        shape: { box: { center: [3, 0, 0], halfExtents: [1, 1, 1] } },
        ambient: { sound: 'b' },
      });
      at(host, 0);
      zones.update(0.1);
      let allocs = 0;
      globalThis.Float32Array = class extends Orig {
        constructor(...a: unknown[]) {
          super(...(a as [number]));
          allocs++;
        }
      } as unknown as Float32ArrayConstructor;
      const w = zones.weights();
      for (let i = 0; i < 100; i++) {
        at(host, Math.sin(i * 0.1) * 5);
        zones.update(0.016);
        expect(zones.weights()).toBe(w);
      }
      expect(allocs).toBe(0);
    });
  });
});

// ---------------------------------------------------------------- through the engine

type FakePanner = {
  context: unknown;
  positionX: { value: number };
  positionY: { value: number };
  positionZ: { value: number };
  orientationX: { value: number };
  orientationY: { value: number };
  orientationZ: { value: number };
  connect(n: unknown): unknown;
  disconnect(): void;
} & Record<string, unknown>;

class Param {
  constructor(public value = 0) {}
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
}

/** The smallest context that builds buses, a reverb and panners. */
class Ctx {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  sampleRate = 8000;
  destination = this.node();
  panners: FakePanner[] = [];
  sends: { gain: Param }[] = [];
  onstatechange: (() => void) | null = null;
  listener = {
    positionX: new Param(),
    positionY: new Param(),
    positionZ: new Param(),
    forwardX: new Param(),
    forwardY: new Param(),
    forwardZ: new Param(-1),
    upX: new Param(),
    upY: new Param(1),
    upZ: new Param(),
  };
  node() {
    return { connect: () => {}, disconnect: () => {} };
  }
  createGain() {
    const g = { ...this.node(), gain: new Param(1) };
    this.sends.push(g);
    return g;
  }
  createBufferSource() {
    return {
      ...this.node(),
      buffer: null,
      loop: false,
      playbackRate: new Param(1),
      detune: new Param(0),
      onended: null as (() => void) | null,
      start() {},
      stop() {
        queueMicrotask(() => this.onended?.());
      },
    };
  }
  createPanner(): FakePanner {
    const p = {
      ...this.node(),
      context: this,
      positionX: new Param(),
      positionY: new Param(),
      positionZ: new Param(),
      orientationX: new Param(1),
      orientationY: new Param(),
      orientationZ: new Param(),
    } as unknown as FakePanner;
    this.panners.push(p);
    return p;
  }
  createConvolver() {
    return { ...this.node(), buffer: null, normalize: false };
  }
  createBuffer(channels: number, length: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, numberOfChannels: channels, copyToChannel: () => {}, data };
  }
  async resume() {
    this.state = 'running';
  }
  async suspend() {
    this.state = 'suspended';
  }
  async close() {}
}

const buffer = { duration: 1, length: 8000 } as unknown as AudioBuffer;

async function engine(reverb = true) {
  const ctx = new Ctx();
  const audio = new AudioEngine({
    createContext: () => ctx as unknown as AudioContext,
    limiter: false,
    reverb: reverb ? { seconds: 0.1 } : null,
  });
  audio.define('hum', async () => buffer);
  await audio.prepare();
  return { ctx, audio };
}

describe('AudioEngine zones and followers', () => {
  it('follow reads the translation of a 3×4 world matrix on update', async () => {
    const { ctx, audio } = await engine(false);
    await audio.unlock();
    const t = new Transform({ x: 1, y: 2, z: 3 });
    const v = audio.loop('hum', { at: [0, 0, 0] });
    v.follow(t);
    const p = ctx.panners[0]!;
    expect(p.positionX.value).toBe(0);
    audio.update(1 / 60);
    expect([p.positionX.value, p.positionY.value, p.positionZ.value]).toEqual([1, 2, 3]);
    expect(Array.from(v.position)).toEqual([1, 2, 3]);
    t.setPosition(-4, 2, 3);
    audio.update(1 / 60);
    expect(p.positionX.value).toBe(-4);
    // A hand-written matrix works too; `null` stops following.
    const m = new Float32Array([1, 0, 0, 7, 0, 1, 0, 8, 0, 0, 1, 9]);
    v.follow({ world: m });
    audio.update(1 / 60);
    expect([p.positionX.value, p.positionY.value, p.positionZ.value]).toEqual([7, 8, 9]);
    v.follow(null);
    m[3] = 100;
    audio.update(1 / 60);
    expect(p.positionX.value).toBe(7);
    // Non-spatial voices ignore follow.
    const flat = audio.loop('hum');
    flat.follow(t);
    audio.update(1 / 60);
    expect(Array.from(flat.position)).toEqual([0, 0, 0]);
    // A stopped follower is dropped.
    v.follow(t);
    v.stop();
    await new Promise((r) => setTimeout(r, 0));
    t.setPosition(50, 2, 3);
    audio.update(1 / 60);
    expect(p.positionX.value).toBe(7);
  });

  it('follow before unlock is applied when the voice starts', async () => {
    const { ctx, audio } = await engine(false);
    const t = new Transform({ x: 5, y: 6, z: 7 });
    const v = audio.loop('hum', { at: [0, 0, 0] });
    v.follow(t);
    audio.update(1 / 60);
    expect(Array.from(v.position)).toEqual([5, 6, 7]);
    await audio.unlock();
    await new Promise((r) => setTimeout(r, 0));
    const p = ctx.panners[0]!;
    expect([p.positionX.value, p.positionY.value, p.positionZ.value]).toEqual([5, 6, 7]);
  });

  it('zones raise the reverb send above the base and the base still works', async () => {
    const { ctx, audio } = await engine();
    await audio.unlock();
    const sfxSend = ctx.sends.find((g) => g.gain.value === 0.25)!;
    expect(sfxSend).toBeDefined();
    audio.zones.add({
      shape: { sphere: { center: [0, 0, 0], radius: 1 } },
      reverbSend: { sfx: 0.9 },
    });
    audio.listener.set([10, 0, 0], [0, 0, -1]);
    audio.update(0.1);
    expect(sfxSend.gain.value).toBe(0.25);
    audio.listener.set([0, 0, 0], [0, 0, -1]);
    audio.update(0.1);
    expect(sfxSend.gain.value).toBeCloseTo(0.9);
    expect(audio.effectiveReverbSendLevels.sfx).toBeCloseTo(0.9);
    expect(audio.reverbSendLevels.sfx).toBe(0.25);
    // The game's base send still applies while below the zone...
    audio.setReverbSend('sfx', 0.5);
    expect(sfxSend.gain.value).toBeCloseTo(0.9);
    // ...and wins once the listener leaves.
    audio.listener.set([10, 0, 0], [0, 0, -1]);
    audio.update(0.1);
    expect(sfxSend.gain.value).toBeCloseTo(0.5);
    expect(audio.reverbSendLevels.sfx).toBe(0.5);
    // A zone with a send below the base changes nothing.
    audio.zones.add({
      shape: { sphere: { center: [10, 0, 0], radius: 1 } },
      reverbSend: { sfx: 0.1 },
    });
    audio.update(0.1);
    expect(sfxSend.gain.value).toBeCloseTo(0.5);
  });

  it('ambient voices wait for unlock and start with the ramped gain', async () => {
    const { ctx, audio } = await engine(false);
    audio.zones.add({
      shape: { box: { center: [0, 0, 0], halfExtents: [1, 1, 1] } },
      ambient: { sound: 'hum', gain: 0.5 },
      fade: 0.2,
    });
    audio.update(0.1); // listener at the origin: inside
    expect(audio.voiceCount).toBe(1);
    expect(audio.zones.weights()[0]).toBe(1);
    audio.update(0.1);
    await audio.unlock();
    await new Promise((r) => setTimeout(r, 0));
    const gain = ctx.sends.at(-1)!;
    expect(gain.gain.value).toBeCloseTo(0.5);
    audio.update(0.1);
    expect(gain.gain.value).toBeCloseTo(0.5);
  });

  it('is safe when audio is unavailable', async () => {
    const audio = new AudioEngine({
      createContext: () => {
        throw new Error('no');
      },
    });
    await audio.unlock();
    expect(audio.state).toBe('unavailable');
    const z = audio.zones.add({
      shape: { sphere: { center: [0, 0, 0], radius: 1 } },
      ambient: { sound: 'x' },
      reverbSend: { sfx: 1 },
    });
    audio.update(0.1);
    expect(z.weight).toBe(1);
    expect(audio.voiceCount).toBe(0);
    expect(audio.effectiveReverbSendLevels.sfx).toBe(1);
  });
});
