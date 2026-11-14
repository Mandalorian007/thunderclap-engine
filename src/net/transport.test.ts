import { describe, expect, it } from 'vitest';
import { FakeTimers } from './fake-timers.test-util';
import { inPageHub, inPageLink, inPagePair, type TransportEvents } from './transport';

function recorder() {
  const log: string[] = [];
  const events: TransportEvents = {
    open: () => log.push('open'),
    message: (f) => log.push(`msg ${[...f].join(',')}`),
    close: (code, reason) => log.push(`close ${code} ${reason}`),
  };
  return { log, events };
}

describe('in-page transport', () => {
  it('opens both ends once both connect, and carries copies of frames both ways', async () => {
    const timers = new FakeTimers();
    const [a, b] = inPagePair({ timers });
    const ra = recorder();
    const rb = recorder();
    const ta = a(ra.events);
    await timers.advance(10);
    expect(ra.log).toEqual([]);
    const tb = b(rb.events);
    expect(rb.log).toEqual([]);
    await timers.advance(0);
    const frame = new Uint8Array([1, 2]);
    ta.send(frame);
    frame[0] = 9;
    tb.send(new Uint8Array([3]));
    await timers.advance(0);
    expect(ra.log).toEqual(['open', 'msg 3']);
    expect(rb.log).toEqual(['open', 'msg 1,2']);
    ta.close();
    ta.send(new Uint8Array([4]));
    await timers.advance(0);
    expect(ra.log.at(-1)).toBe('close 1000 closed');
    expect(rb.log.at(-1)).toBe('close 1000 closed');
  });

  it('delays by latency and jitter, keeps order, and makes lost frames late', async () => {
    const timers = new FakeTimers();
    let rolls: number[] = [];
    const link = inPageLink({
      timers,
      random: () => rolls.shift() ?? 0.5,
      conditions: { latencyMs: 0 },
    });
    const ra = recorder();
    const rb = recorder();
    const ta = link.ends[0](ra.events);
    link.ends[1](rb.events);
    await timers.advance(0);
    // Each send rolls jitter, then loss.
    rolls = [0.5, 0.99, 0.5, 0.01, 0.5, 0.99];
    link.conditions.latencyMs = 100;
    link.conditions.jitterMs = 20;
    link.conditions.loss = 0.1;
    link.conditions.rtoMs = 200;
    ta.send(new Uint8Array([1])); // 100 + 10, kept
    ta.send(new Uint8Array([2])); // 100 + 10, lost: +200
    ta.send(new Uint8Array([3])); // 100 + 10, kept, but waits behind 2
    await timers.advance(110);
    expect(rb.log).toEqual(['open', 'msg 1']);
    await timers.advance(200);
    expect(rb.log).toEqual(['open', 'msg 1', 'msg 2', 'msg 3']);
  });

  it('drop() closes both ends as a lost link, and a used end refuses', async () => {
    const timers = new FakeTimers();
    const link = inPageLink({ timers, conditions: { latencyMs: 50 } });
    const ra = recorder();
    const rb = recorder();
    const ta = link.ends[0](ra.events);
    link.ends[1](rb.events);
    await timers.advance(50);
    ta.send(new Uint8Array([1]));
    link.drop();
    await timers.advance(100);
    expect(ra.log).toEqual(['open', 'close 1006 dropped']);
    expect(rb.log).toEqual(['open', 'close 1006 dropped']);
    expect(link.closed).toBe(true);
    const again = recorder();
    link.ends[0](again.events);
    await timers.advance(0);
    expect(again.log).toEqual(['close 1006 link used']);
  });

  it('a hub makes a new link per connection, under shared conditions', async () => {
    const timers = new FakeTimers();
    const served: string[] = [];
    const hub = inPageHub(
      (connect) => {
        const t = connect({
          open: () => served.push('open'),
          message: (f) => t.send(f),
          close: () => served.push('close'),
        });
      },
      { timers },
    );
    const r1 = recorder();
    const c1 = hub.connect(r1.events);
    const r2 = recorder();
    hub.connect(r2.events);
    await timers.advance(0);
    expect(hub.links.size).toBe(2);
    c1.send(new Uint8Array([7]));
    await timers.advance(0);
    expect(r1.log).toEqual(['open', 'msg 7']);
    hub.conditions.latencyMs = 30;
    hub.dropAll();
    await timers.advance(0);
    expect(hub.links.size).toBe(0);
    expect(served).toEqual(['open', 'open', 'close', 'close']);
  });
});
