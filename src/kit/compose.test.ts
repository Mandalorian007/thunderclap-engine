/**
 * ws/kit: `composeGame` builds the core and only the services passed; client mode
 * (`loop.frames: 'external'`) runs on the game's own timestamps and reads no clock. Plain Node
 * (`dom: false`) on the fake GPU and the fake host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameLoop } from '../core/loop';
import type { Host } from '../host';
import type { GpuContext } from '../platform';
import {
  createFakeDevice,
  type FakeDevice,
  fakeRendererGpu,
  installGpuGlobals,
} from '../render/fake-gpu';
import { createFakeHost } from '../testing/fake-host';
import { withAudio } from './audio';
import { composeGame, type KitOptions } from './compose';
import { createExternalFrames } from './frames';
import { withInput } from './input';
import { withParticles, withPost } from './post';
import { withXr } from './xr';

function fakeGpu(): { device: FakeDevice; gpu: GpuContext } {
  installGpuGlobals();
  const device = createFakeDevice();
  return {
    device,
    gpu: { ...fakeRendererGpu(device), adapter: {} as GPUAdapter, timestamps: false },
  };
}

/** The core options a headless kit needs, on a fresh fake GPU and host. */
function headless(): KitOptions & { gpu: GpuContext; dom: false; host: Host; device: FakeDevice } {
  const { device, gpu } = fakeGpu();
  return { gpu, dom: false, host: createFakeHost(), device };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composeGame (ws/kit)', () => {
  it('with no services builds only the core: no post, particles, ui, audio, input or xr', async () => {
    const { device: _d, ...kit } = headless();
    const ctx = (await composeGame(kit))!;
    for (const key of [
      'design',
      'surface',
      'gpu',
      'renderer',
      'camera',
      'host',
      'clock',
      'stack',
      'loop',
      'hooks',
    ]) {
      expect(ctx).toHaveProperty(key);
    }
    for (const key of [
      'post',
      'particles',
      'ui',
      'audio',
      'input',
      'gestures',
      'pointers',
      'padNav',
      'replay',
      'xr',
      'frame',
    ]) {
      expect(key in ctx).toBe(false);
    }
    expect(ctx.renderer.post).toBeNull();
    expect(ctx.save).toBeNull();
  });

  it('steps the clock, hooks and scenes in fixed steps, and renders through the built-in present', async () => {
    const { device, ...kit } = headless();
    const ctx = (await composeGame({ ...kit, loop: { sim: { step: 1 / 30 } } }))!;
    const log: string[] = [];
    ctx.hooks.update = (dt) => log.push(`h${dt.toFixed(4)}`);
    ctx.stack.push({ update: () => log.push('u'), render: () => log.push('r') });
    const t0 = ctx.clock.now();
    const submits = device.submits;
    ctx.loop.tickOnce(1 / 30);
    expect(log).toEqual(['h0.0333', 'u', 'r']);
    expect(ctx.clock.now() - t0).toBeCloseTo(1000 / 30, 6);
    expect(device.submits).toBeGreaterThan(submits);
  });

  it('`sim: false` calls `hooks.frame` with the real delta, never `hooks.update`', async () => {
    const { device: _d, ...kit } = headless();
    const ctx = (await composeGame({ ...kit, loop: { sim: false } }))!;
    const log: string[] = [];
    ctx.hooks.update = () => log.push('update');
    ctx.hooks.frame = (dt) => log.push(`frame ${dt}`);
    ctx.loop.tickOnce(0.02);
    expect(log).toEqual(['frame 0.02']);
  });

  it('adds exactly the fields of the services passed', async () => {
    const { device: _d, ...kit } = headless();
    const ctx = (await composeGame({
      ...kit,
      post: withPost(),
      input: withInput<'go'>({ bindings: { go: [{ key: 'Space' }] } }),
    }))!;
    expect(ctx.renderer.post).toBe(ctx.post);
    expect('particles' in ctx).toBe(false);
    // Input without an overlay: the pad stays the game's, the input works on fed keys.
    let held = 0;
    ctx.hooks.update = () => {
      if (ctx.input.held('go')) held++;
    };
    ctx.input.keyDown('Space');
    ctx.loop.tickOnce(1 / 60);
    ctx.loop.tickOnce(1 / 60);
    expect(held).toBe(2);
    expect(ctx.padNav).toBeDefined();
    expect(ctx.pointers).toBeDefined();
  });

  it('updates particles after the hooks and before the scenes', async () => {
    const { device: _d, ...kit } = headless();
    const ctx = (await composeGame({ ...kit, particles: withParticles(), audio: withAudio() }))!;
    const log: string[] = [];
    const update = ctx.particles.update.bind(ctx.particles);
    vi.spyOn(ctx.particles, 'update').mockImplementation((dt) => {
      log.push('particles');
      update(dt);
    });
    vi.spyOn(ctx.audio, 'update').mockImplementation(() => {
      log.push('audio');
    });
    ctx.hooks.update = () => log.push('hooks');
    ctx.stack.push({ update: () => log.push('scenes') });
    ctx.loop.tickOnce(1 / 60);
    expect(log).toEqual(['audio', 'hooks', 'particles', 'scenes']);
  });

  it('the lean core draws with fewer passes than the post stack does (fake-GPU count)', async () => {
    const lean = headless();
    const { device: leanDevice, ...leanKit } = lean;
    const leanCtx = (await composeGame(leanKit))!;
    const full = headless();
    const { device: fullDevice, ...fullKit } = full;
    const fullCtx = (await composeGame({ ...fullKit, post: withPost() }))!;
    const leanBefore = leanDevice.passes.length;
    const fullBefore = fullDevice.passes.length;
    leanCtx.loop.tickOnce(1 / 60);
    fullCtx.loop.tickOnce(1 / 60);
    const leanPasses = leanDevice.passes.length - leanBefore;
    const fullPasses = fullDevice.passes.length - fullBefore;
    expect(leanPasses).toBeGreaterThan(0);
    expect(leanPasses).toBeLessThanOrEqual(fullPasses);
  });

  it('flushes the save and halts on device loss', async () => {
    const { device, ...kit } = headless();
    let flushes = 0;
    const ctx = (await composeGame({ ...kit, save: () => ({ flush: () => void flushes++ }) }))!;
    const lost: string[] = [];
    ctx.hooks.deviceLost = (info) => lost.push(info.reason);
    device.loseDevice('unknown', 'gone');
    await device.lost;
    await Promise.resolve();
    expect(lost).toEqual(['unknown']);
    expect(ctx.loop.halted).toBe(true);
    expect(flushes).toBe(1);
  });

  it('`dom: false` without a host throws', async () => {
    const { gpu } = fakeGpu();
    await expect(composeGame({ gpu, dom: false })).rejects.toThrow(/dom: false.*gpu.*host/);
  });
});

describe('client mode: loop.frames external (ws/kit)', () => {
  it('runs a frame per `ctx.frame(now)` on the game timestamps, and schedules nothing', async () => {
    const { device: _d, host, ...kit } = headless();
    const requestFrame = vi.spyOn(host, 'requestFrame');
    const ctx = (await composeGame({ ...kit, host, loop: { sim: false, frames: 'external' } }))!;
    const dts: number[] = [];
    ctx.hooks.frame = (dt) => dts.push(dt);
    // Before start: ignored.
    ctx.frame(1000);
    expect(dts).toEqual([]);
    ctx.loop.start();
    ctx.frame(5000);
    ctx.frame(5016);
    ctx.frame(5050);
    expect(dts.map((d) => Math.round(d * 1000))).toEqual([0, 16, 34]);
    expect(ctx.loop.time.frame).toBe(3);
    expect(requestFrame).not.toHaveBeenCalled();
    // Stopped (a hide): frames are ignored; a restart begins a new run at delta 0.
    ctx.loop.stop();
    ctx.frame(9000);
    expect(dts).toHaveLength(3);
    ctx.loop.start();
    ctx.frame(20000);
    expect(dts[3]).toBe(0);
  });

  it('reads no clock: performance.now is never called by the loop', async () => {
    const { device: _d, ...kit } = headless();
    const ctx = (await composeGame({ ...kit, loop: { frames: 'external' } }))!;
    let steps = 0;
    ctx.hooks.update = () => steps++;
    const now = vi.spyOn(performance, 'now');
    ctx.loop.start();
    ctx.frame(100);
    ctx.frame(100 + 50);
    expect(steps).toBe(3);
    expect(now).not.toHaveBeenCalled();
  });

  it('refuses xr, which needs the session frames', async () => {
    const { device: _d, ...kit } = headless();
    await expect(
      composeGame({ ...kit, loop: { frames: 'external' }, xr: withXr() }),
    ).rejects.toThrow(/xr.*external/);
  });

  it('createExternalFrames drives a bare GameLoop', () => {
    const frames = createExternalFrames();
    const ticks: number[] = [];
    const loop = new GameLoop(
      { update: (dt) => ticks.push(dt), render: () => {} },
      { fixed: false, frames, now: () => 0 },
    );
    loop.start();
    frames.frame(loop, 10);
    frames.frame(loop, 30);
    expect(ticks.map((d) => Math.round(d * 1000))).toEqual([0, 20]);
  });
});
