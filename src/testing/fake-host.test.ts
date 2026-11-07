import { describe, expect, it } from 'vitest';
import { GameLoop } from '../core';
import type { Host, HostLifecycleState } from '../host';
import { createSaveStore, MemoryStorage, s } from '../save';
import { createFakeHost } from './fake-host';

describe('createFakeHost', () => {
  it('is a full Host with every optional facet', () => {
    const host: Host = createFakeHost();
    expect(host.kind).toBe('web');
    expect(host.embed).toBe('top');
    expect(host.lifecycle?.state).toBe('active');
    expect(host.haptics?.available()).toBe(true);
    expect(host.safeArea?.insets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(host.storage.open()).toBeInstanceOf(MemoryStorage);
    expect(host.clipboardWriteAllowed()).toBe(true);
  });

  it('fires lifecycle watchers on a change only, and stops after unsubscribe', () => {
    const host = createFakeHost();
    const seen: HostLifecycleState[] = [];
    const off = host.lifecycle.watch((st) => seen.push(st));
    host.setState('background');
    host.setState('background');
    host.setState('active');
    off();
    host.setState('background');
    expect(seen).toEqual(['background', 'active']);
    expect(host.lifecycle.state).toBe('background');
  });

  it('round-trips a save through its storage', () => {
    const host = createFakeHost();
    const open = () =>
      createSaveStore({
        game: 'g',
        slot: 'main',
        version: 1,
        defaults: () => ({ wins: 0 }),
        schema: s.object({ wins: s.number({ min: 0, int: true }) }),
        storage: host.storage.open()!,
        debounceMs: 0,
        autoFlush: false,
        now: () => 1,
      });
    const a = open();
    a.update((d) => ({ ...d, wins: 3 }));
    a.flush();
    expect(host.memory?.length).toBe(1);
    expect(open().get().wins).toBe(3);
  });

  it('can have no storage', () => {
    expect(createFakeHost({ storage: null }).storage.open()).toBeNull();
  });

  it('records haptics, links, copies, fullscreen and wake-lock calls', async () => {
    const host = createFakeHost({ copyResult: 'manual', openResult: 'blocked' });
    host.haptics.impact('light');
    host.haptics.notification('success');
    host.haptics.vibrate(30);
    expect(host.hapticCalls).toEqual([
      { op: 'impact', style: 'light' },
      { op: 'notification', kind: 'success' },
      { op: 'vibrate', ms: 30 },
    ]);
    expect(host.openExternal('https://example.com', { activation: 'gamepad' })).toBe('blocked');
    expect(host.opened).toEqual([{ url: 'https://example.com', activation: 'gamepad' }]);
    expect(await host.copyText('seed 42')).toBe('manual');
    expect(host.copied).toEqual(['seed 42']);

    const changes: boolean[] = [];
    host.fullscreen.watch((on) => changes.push(on));
    expect(await host.fullscreen.toggle({ lockLandscape: true })).toBe(true);
    expect(host.fullscreen.active).toBe(true);
    expect(await host.fullscreen.toggle()).toBe(false);
    expect(host.fullscreenCalls).toEqual([{ lockLandscape: true }, {}]);
    expect(changes).toEqual([true, false]);

    expect(await host.wakeLock.request()).toBe(true);
    expect(host.wakeLock.held).toBe(true);
    host.wakeLock.release();
    expect(host.wakeLock.held).toBe(false);
    expect(host.wakeLock.calls).toEqual(['request', 'release']);
  });

  it('refuses fullscreen when unavailable, but still records the call', async () => {
    const host = createFakeHost({ fullscreen: false });
    expect(await host.fullscreen.toggle()).toBe(false);
    expect(host.fullscreen.active).toBe(false);
    expect(host.fullscreenCalls).toHaveLength(1);
  });

  it('sets the safe area and tells watchers about real changes', () => {
    const host = createFakeHost({ safeArea: { top: 44 } });
    const seen: number[] = [];
    host.safeArea.watch((i) => seen.push(i.bottom));
    host.setSafeArea({ top: 44 });
    host.setSafeArea({ bottom: 34 });
    expect(host.safeArea.insets()).toEqual({ top: 44, right: 0, bottom: 34, left: 0 });
    expect(seen).toEqual([34]);
  });

  it('runs frames only on runFrame, one display frame per call', () => {
    const host = createFakeHost({ frameMs: 10 });
    const times: number[] = [];
    const tick = (t: number) => {
      times.push(t);
      host.requestFrame(tick);
    };
    host.requestFrame(tick);
    const dropped = host.requestFrame(() => times.push(-1));
    host.cancelFrame(dropped);
    expect(host.pendingFrames).toBe(1);
    expect(host.runFrame()).toBe(1);
    expect(host.runFrame()).toBe(1);
    expect(host.runFrame(100)).toBe(1);
    expect(times).toEqual([0, 10, 100]);
    expect(host.frameTime).toBe(100);
  });

  it('a callback can cancel a later one in the same frame', () => {
    const host = createFakeHost();
    const ran: string[] = [];
    let b = 0;
    host.requestFrame(() => {
      ran.push('a');
      host.cancelFrame(b);
    });
    b = host.requestFrame(() => ran.push('b'));
    expect(host.runFrame()).toBe(1);
    expect(ran).toEqual(['a']);
  });

  it('drives a GameLoop as its frame source', () => {
    const host = createFakeHost();
    let now = 0;
    let updates = 0;
    const loop = new GameLoop(
      { update: () => updates++, render: () => {} },
      { frames: host, now: () => now, step: 1 / 50 },
    );
    loop.start();
    for (let i = 0; i < 5; i++) {
      now += 20;
      host.runFrame(now);
    }
    expect(updates).toBe(5);
    loop.stop();
    expect(host.pendingFrames).toBe(0);
  });
});
