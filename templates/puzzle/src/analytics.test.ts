import type { AnalyticsEvent } from '@thunderclap-engine/engine/analytics';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBeaconSink } from './analytics';

const event: AnalyticsEvent = {
  name: 'level_start',
  props: { level: '4x4' },
  session: 's',
  seq: 1,
  t: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createBeaconSink', () => {
  it('posts the batch as JSON to the url', () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    createBeaconSink('https://example.test/collect')([event]);
    expect(sendBeacon).toHaveBeenCalledWith(
      'https://example.test/collect',
      JSON.stringify([event]),
    );
  });

  it('throws when the beacon is refused, so the engine reports it through onError', () => {
    vi.stubGlobal('navigator', { sendBeacon: () => false });
    expect(() => createBeaconSink('https://example.test/collect')([event])).toThrow(/refused/);
  });

  it('throws when sendBeacon is missing', () => {
    vi.stubGlobal('navigator', {});
    expect(() => createBeaconSink('https://example.test/collect')([event])).toThrow(/sendBeacon/);
  });
});
