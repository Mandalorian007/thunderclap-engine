/**
 * ws/kit: `composeGame` builds the core and only the services passed; client mode
 * (`loop.frames: 'external'`) runs on the game's own timestamps and reads no clock. Plain Node
 * (`dom: false`) on the fake GPU and the fake host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameLoop } from '../core/loop';
import type { Host } from '../host';
import type { GpuContext } from '../platform';
import { Camera } from '../render/camera';
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

describe('the loop maxFps on external frames (ws/kit-fit)', () => {
  it('skips a frame that comes too soon, and times the next from the last that ran', () => {
    const frames = createExternalFrames();
    const dts: number[] = [];
    const loop = new GameLoop(
      { update: (dt) => dts.push(Math.round(dt * 1000)), render: () => {} },
      { fixed: false, frames, now: () => 0 },
    );
    loop.maxFps = 30;
    loop.start();
    frames.frame(loop, 1000); // first: runs at 0
    frames.frame(loop, 1016.7); // 60 Hz vsync: too soon, skipped
    frames.frame(loop, 1033.3); // 33.3 ms: runs
    frames.frame(loop, 1050); // skipped
    frames.frame(loop, 1064); // 30.7 ms: inside the vsync slack, runs
    expect(dts).toEqual([0, 33, 31]);
    expect(loop.time.frame).toBe(3);
    // Uncapped again: every call runs.
    loop.maxFps = null;
    frames.frame(loop, 1070);
    expect(dts).toEqual([0, 33, 31, 6]);
  });

  it('applies through composeGame client mode', async () => {
    const { device: _d, ...kit } = headless();
    const ctx = (await composeGame({ ...kit, loop: { sim: false, frames: 'external' } }))!;
    let renders = 0;
    ctx.hooks.afterRender = () => renders++;
    ctx.loop.maxFps = 30;
    ctx.loop.start();
    for (let i = 0; i < 12; i++) ctx.frame(i * (1000 / 60));
    expect(renders).toBe(6);
  });
});

describe('composeGame with the game own renderer, or none (ws/kit-fit)', () => {
  /** A renderer of the game's own that logs what the kit hands it. */
  function ownRenderer(log: string[]) {
    return {
      drawn: 0,
      resize(w: number, h: number) {
        log.push(`resize ${w}x${h}`);
      },
      render(alpha: number) {
        this.drawn++;
        log.push(`render ${alpha}`);
      },
    };
  }

  it('hands each frame to the game renderer between the hooks; the engine renderer is never built', async () => {
    const { device, ...kit } = headless();
    const log: string[] = [];
    const mine = ownRenderer(log);
    const passes = device.passes.length;
    const ctx = (await composeGame({ ...kit, renderer: mine, loop: { sim: false } }))!;
    // Typed as the game's own.
    expect(ctx.renderer.drawn).toBe(0);
    expect(ctx.renderer).toBe(mine);
    expect(log).toEqual([
      `resize ${ctx.surface.backbuffer.width}x${ctx.surface.backbuffer.height}`,
    ]);
    log.length = 0;
    ctx.hooks.frame = () => log.push('frame');
    ctx.hooks.beforeRender = () => log.push('before');
    ctx.hooks.afterRender = () => log.push('after');
    ctx.stack.push({
      update: () => log.push('scene update'),
      render: () => log.push('scene render'),
    });
    ctx.loop.tickOnce(1 / 60);
    expect(log).toEqual(['frame', 'scene update', 'before', 'render 1', 'after']);
    // Nothing of the engine's drew.
    expect(device.passes.length).toBe(passes);
    // The kit keeps a camera of its own.
    const cam = ctx.camera;
    expect(cam).toBeDefined();
    const other = Camera.ortho2d(640, 360);
    expect(other).not.toBe(cam);
    ctx.setCamera(other);
    expect(ctx.camera).toBe(other);
  });

  it('builds it from a factory on the booted GPU and surface (async too)', async () => {
    const { device: _d, ...kit } = headless();
    const log: string[] = [];
    let got: unknown[] = [];
    const ctx = (await composeGame({
      ...kit,
      renderer: async (gpu, surface) => {
        got = [gpu, surface];
        return ownRenderer(log);
      },
    }))!;
    expect(got).toEqual([ctx.gpu, ctx.surface]);
    expect(ctx.renderer.drawn).toBe(0);
    ctx.loop.tickOnce(1 / 60);
    expect(ctx.renderer.drawn).toBe(1);
  });

  it('`renderer: null`: the game draws in hooks.render', async () => {
    const { device: _d, ...kit } = headless();
    const ctx = (await composeGame({ ...kit, renderer: null, loop: { sim: false } }))!;
    expect(ctx.renderer).toBeNull();
    const log: string[] = [];
    ctx.hooks.render = (alpha, time) => log.push(`render ${alpha} ${time.frame}`);
    ctx.loop.tickOnce(1 / 60);
    ctx.loop.tickOnce(1 / 60);
    expect(log).toEqual(['render 1 1', 'render 1 2']);
  });

  it('keeps input, the lifecycle and device loss; refuses the services that draw', async () => {
    const { device, ...kit } = headless();
    let flushes = 0;
    const ctx = (await composeGame({
      ...kit,
      renderer: null,
      save: () => ({ flush: () => void flushes++ }),
      input: withInput<'go'>({ bindings: { go: [{ key: 'Space' }] } }),
    }))!;
    let held = 0;
    ctx.hooks.update = () => {
      if (ctx.input.held('go')) held++;
    };
    ctx.input.keyDown('Space');
    ctx.loop.tickOnce(1 / 60);
    expect(held).toBe(1);
    device.loseDevice('unknown', 'gone');
    await device.lost;
    await Promise.resolve();
    expect(ctx.loop.halted).toBe(true);
    expect(flushes).toBe(1);
    for (const extra of [{ post: withPost() }, { particles: withParticles() }, { xr: withXr() }]) {
      const { device: _x, ...k } = headless();
      await expect(composeGame({ ...k, renderer: null, ...extra })).rejects.toThrow(
        /draws through the engine's renderer/,
      );
    }
  });
});
