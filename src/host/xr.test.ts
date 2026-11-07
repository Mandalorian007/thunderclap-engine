/**
 * `createXrHost`: frames come from the session and the `XRFrame` is readable for the length of
 * the callback; everything else is the wrapped host's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeXr, type FakeXrSession, installFakeXr } from '../platform/xr-fake';
import type { Host } from './types';
import { createXrHost } from './xr';

let xr: FakeXr | null = null;
afterEach(() => {
  xr?.uninstall();
  xr = null;
});

function stubHost(log: string[]): Host {
  return {
    kind: 'web',
    requestFrame: () => {
      log.push('base.requestFrame');
      return 1;
    },
    cancelFrame: () => log.push('base.cancelFrame'),
    get embed() {
      return 'top' as const;
    },
    openExternal: (url) => {
      log.push(`open ${url}`);
      return 'opened';
    },
    copyText: async (t) => {
      log.push(`copy ${t}`);
      return 'copied';
    },
    clipboardWriteAllowed: () => true,
    fullscreen: {
      available: () => false,
      active: false,
      toggle: async () => false,
      watch: () => () => {},
    },
    storage: { kind: 'local', open: () => null },
  };
}

describe('createXrHost', () => {
  it("is the 'xr' kind and schedules through the session, holding the frame during the callback", async () => {
    xr = installFakeXr();
    const session = (await xr.system.requestSession('immersive-vr')) as FakeXrSession;
    const log: string[] = [];
    const base = stubHost(log);
    const host = createXrHost(session, base);
    expect(host.kind).toBe('xr');
    expect(host.base).toBe(base);
    expect(host.session).toBe(session);
    expect(host.frame).toBeNull();
    const seen: (XRFrame | null)[] = [];
    const times: number[] = [];
    const cb = (t: number) => {
      times.push(t);
      seen.push(host.frame);
    };
    const h = host.requestFrame(cb);
    expect(session.pendingFrames).toBe(1);
    const frame = xr.step(10);
    expect(times).toEqual([10]);
    expect(seen).toEqual([frame]);
    expect(host.frame).toBeNull();
    // A cancelled frame never runs.
    const h2 = host.requestFrame(cb);
    expect(h2).not.toBe(h);
    host.cancelFrame(h2);
    xr.step(10);
    expect(times).toEqual([10]);
    expect(log).toEqual([]);
  });

  it('the frame is cleared even when the callback throws', async () => {
    xr = installFakeXr();
    const session = (await xr.system.requestSession('immersive-vr')) as FakeXrSession;
    const host = createXrHost(session, stubHost([]));
    host.requestFrame(() => {
      throw new Error('boom');
    });
    expect(() => xr!.step()).toThrow('boom');
    expect(host.frame).toBeNull();
  });

  it('delegates every other member to the base host', async () => {
    xr = installFakeXr();
    const session = (await xr.system.requestSession('immersive-vr')) as FakeXrSession;
    const log: string[] = [];
    const base = stubHost(log);
    const host = createXrHost(session, base);
    expect(host.embed).toBe('top');
    expect(host.openExternal('https://example.com', { activation: 'pointer' })).toBe('opened');
    expect(await host.copyText('hi')).toBe('copied');
    expect(host.clipboardWriteAllowed()).toBe(true);
    expect(host.fullscreen).toBe(base.fullscreen);
    expect(host.storage).toBe(base.storage);
    expect(host.window).toBeUndefined();
    expect(log).toEqual(['open https://example.com', 'copy hi']);
  });
});
