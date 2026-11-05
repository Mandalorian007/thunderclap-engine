// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { type AnalyticsEvent, type AttachTarget, createAnalytics } from './index';

type Game = { level_start: { level: string }; tick: undefined };

function setup(extra: Partial<Parameters<typeof createAnalytics>[0]> = {}) {
  const batches: AnalyticsEvent[][] = [];
  let t = 1000;
  const a = createAnalytics<Game>({
    sink: (b) => {
      batches.push(b);
    },
    clock: () => (t += 10),
    session: 's1',
    ...extra,
  });
  return { a, batches };
}

const host = { kind: 'web', embed: 'top' } as AttachTarget['host'];

describe('analytics', () => {
  it('batches until flush, with session and monotonic seq', async () => {
    const { a, batches } = setup();
    a.emit('level_start', { level: 'a' });
    a.emit('tick');
    expect(a.pending).toBe(2);
    expect(batches.length).toBe(0);
    await a.flush();
    expect(batches[0]!.map((e) => [e.name, e.seq, e.session])).toEqual([
      ['level_start', 1, 's1'],
      ['tick', 2, 's1'],
    ]);
    expect(a.pending).toBe(0);
  });

  it('flushes by itself at maxBatch', () => {
    const { a, batches } = setup({ maxBatch: 2 });
    a.emit('tick');
    a.emit('tick');
    expect(batches.length).toBe(1);
  });

  it('swallows sink errors (sync and async) into onError', async () => {
    const onError = vi.fn();
    const a = createAnalytics({
      sink: () => {
        throw new Error('boom');
      },
      onError,
    });
    a.emit('x');
    await expect(a.flush()).resolves.toBeUndefined();
    const b = createAnalytics({ sink: () => Promise.reject(new Error('no')), onError });
    b.emit('x');
    await b.flush();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('attach emits game_start, flushes on hidden, wraps hide, show and deviceLost', async () => {
    const own = vi.fn();
    const ownHide = vi.fn();
    const hooks: AttachTarget['hooks'] = { deviceLost: own, hide: ownHide };
    const { a, batches } = setup({ context: { build: '1.2.3' } });
    const detach = a.attach({ hooks, host });
    expect(a.pending).toBe(1);

    // createGame calls hooks.hide with the lifecycle reason.
    hooks.hide?.('hidden');
    hooks.hide?.('pagehide'); // second signal: no second session_end
    expect(ownHide).toHaveBeenCalledTimes(2);
    expect(ownHide).toHaveBeenLastCalledWith('pagehide');
    await a.flush();
    const names = batches.flat().map((e) => e.name);
    expect(names).toEqual(['game_start', 'session_end']);
    const start = batches[0]![0]!.props as { build: string; deviceKind: string };
    expect(start.build).toBe('1.2.3');
    expect(start.deviceKind).toBe('web');
    expect((batches[0]![1]!.props as { reason: string }).reason).toBe('hidden');

    // Back, then hidden again: a new session_end.
    hooks.show?.('visible');
    hooks.hide?.('freeze');
    await a.flush();
    expect((batches.flat().at(-1)!.props as { reason: string }).reason).toBe('freeze');

    hooks.show?.('visible');
    hooks.deviceLost?.({ reason: 'destroyed', message: 'gone' } as GPUDeviceLostInfo);
    expect(own).toHaveBeenCalledOnce();
    await a.flush();
    expect(batches.flat().map((e) => e.name)).toContain('device_lost');

    detach();
    expect(hooks.deviceLost).toBe(own);
    expect(hooks.hide).toBe(ownHide);
    expect(hooks.show).toBeUndefined();
  });

  it('typed props compile', () => {
    const { a } = setup();
    a.emit('level_start', { level: 'a' });
    // @ts-expect-error wrong prop type
    a.emit('level_start', { level: 1 });
    // @ts-expect-error unknown event
    a.emit('nope');
    // @ts-expect-error built-in props are required
    a.emit('session_end');
  });
});
