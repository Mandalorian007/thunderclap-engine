import { describe, expect, it } from 'vitest';
import { Emitter } from './events';
import { type Scene, SceneStack } from './scene';

function rec(name: string, log: string[], extra: Partial<Scene<string, string[], string>> = {}) {
  const s: Scene<string, string[], string> = {
    name,
    enter: (ctx) => log.push(`${name}.enter(${ctx})`),
    exit: () => log.push(`${name}.exit`),
    pause: () => log.push(`${name}.pause`),
    resume: () => log.push(`${name}.resume`),
    update: () => log.push(`${name}.update`),
    render: (frame, camera) => frame.push(`${name}@${camera}`),
    ...extra,
  };
  return s;
}

describe('SceneStack', () => {
  it('push/pop lifecycle', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('ctx');
    st.push(rec('a', log));
    st.push(rec('b', log));
    st.pop();
    expect(log).toEqual(['a.enter(ctx)', 'a.pause', 'b.enter(ctx)', 'b.exit', 'a.resume']);
    expect(st.size).toBe(1);
  });

  it('replace exits the top and enters the new one', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    st.push(rec('a', log));
    st.replace(rec('b', log));
    expect(log).toEqual(['a.enter(c)', 'a.exit', 'b.enter(c)']);
    expect(st.top?.name).toBe('b');
  });

  it('updates only the top scene', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    st.push(rec('a', log));
    st.push(rec('b', log));
    log.length = 0;
    st.update(1 / 60);
    expect(log).toEqual(['b.update']);
  });

  it('renders from the highest opaque scene upward', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    st.push(rec('a', log));
    st.push(rec('b', log));
    st.push(rec('menu', log, { transparent: true }));
    const frame: string[] = [];
    st.render(frame, 'cam');
    expect(frame).toEqual(['b@cam', 'menu@cam']);
  });

  it('defers stack ops issued during update', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    const b = rec('b', log);
    st.push(
      rec('a', log, {
        update: () => {
          st.replace(b);
          log.push(`top-during-update=${st.top?.name}`);
        },
      }),
    );
    st.update(0);
    expect(log).toEqual(['a.enter(c)', 'top-during-update=a', 'a.exit', 'b.enter(c)']);
  });

  it('clear exits all scenes top first', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    st.push(rec('a', log));
    st.push(rec('b', log));
    log.length = 0;
    st.clear();
    expect(log).toEqual(['b.exit', 'a.exit']);
    expect(st.size).toBe(0);
  });
});

/** A promise the test settles by hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe('SceneStack preload and transitions', () => {
  it('a slow preload keeps the old scene updating; the promise resolves after enter', async () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    const phases: string[] = [];
    st.onTransition((from, to, phase) => phases.push(`${phase}:${from?.name}>${to?.name}`));
    st.push(rec('old', log));
    const gate = deferred();
    const next = rec('next', log, {
      preload: (ctx) => {
        log.push(`next.preload(${ctx})`);
        return gate.promise;
      },
    });
    let entered = false;
    const p = st.push(next).then(() => {
      entered = true;
      log.push(`resolved top=${st.top?.name}`);
    });
    expect(st.transitioning).toBe(true);
    expect(st.top?.name).toBe('old');
    for (let i = 0; i < 5; i++) st.update(1 / 60);
    const frame: string[] = [];
    st.render(frame, 'cam');
    expect(frame).toEqual(['old@cam']);
    expect(log.filter((l) => l === 'old.update').length).toBe(5);
    // A pop queued during the preload waits behind it.
    st.pop();
    expect(st.size).toBe(1);
    await flushMicrotasks();
    expect(entered).toBe(false);
    gate.resolve();
    await p;
    expect(entered).toBe(true);
    expect(st.transitioning).toBe(false);
    // The push entered, then the queued pop removed it again.
    expect(log.slice(-5)).toEqual([
      'old.pause',
      'next.enter(c)',
      'next.exit',
      'old.resume',
      'resolved top=old',
    ]);
    expect(phases).toEqual([
      'enter:undefined>old',
      'preload:old>next',
      'enter:old>next',
      'exit:next>old',
    ]);
  });

  it('a rejected preload rejects and leaves the stack as it was', async () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    const a = rec('a', log);
    st.push(a);
    const boom = new Error('boom');
    const bad = rec('bad', log, { preload: () => Promise.reject(boom) });
    await expect(st.replace(bad)).rejects.toBe(boom);
    expect(st.scenes).toEqual([a]);
    // The getter is the live stack; the deprecated list() a copy (ws/api-core).
    expect(st.scenes).toBe(st.scenes);
    expect(st.list()).toEqual([a]); // deprecated-alias test
    expect(st.list()).not.toBe(st.scenes); // deprecated-alias test
    expect(st.transitioning).toBe(false);
    expect(log).toEqual(['a.enter(c)']);
    // A preload that throws synchronously behaves the same, and the queue keeps going.
    const thrower = rec('t', log, {
      preload: () => {
        throw boom;
      },
    });
    const after = st.push(rec('b', log));
    await expect(st.push(thrower)).rejects.toBe(boom);
    await after;
    expect(st.scenes.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('sync scenes resolve; replace reports exit then enter', async () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    const phases: string[] = [];
    const off = st.onTransition((from, to, phase) =>
      phases.push(`${phase}:${from?.name}>${to?.name}`),
    );
    await st.push(rec('a', log));
    expect(st.top?.name).toBe('a');
    await st.replace(rec('b', log));
    st.clear();
    off();
    await st.push(rec('c', log));
    expect(phases).toEqual(['enter:undefined>a', 'exit:a>b', 'enter:a>b', 'exit:b>undefined']);
  });

  it('a preloading replace issued during update waits for both update and preload', async () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[], string>('c');
    const gate = deferred();
    const next = rec('next', log, { preload: () => gate.promise });
    let p: Promise<void> | null = null;
    st.push(
      rec('a', log, {
        update: () => {
          if (!p) p = st.replace(next);
          log.push('a.update');
        },
      }),
    );
    st.update(0);
    st.update(0);
    expect(st.transitioning).toBe(true);
    gate.resolve();
    await p;
    expect(st.top).toBe(next);
    expect(log).toEqual(['a.enter(c)', 'a.update', 'a.update', 'a.exit', 'next.enter(c)']);
  });
});

describe('Emitter', () => {
  it('emits typed payloads and unsubscribes', () => {
    const e = new Emitter<{ hit: number; done: undefined }>();
    const got: number[] = [];
    const off = e.on('hit', (n) => got.push(n));
    e.emit('hit', 1);
    off();
    e.emit('hit', 2);
    expect(got).toEqual([1]);
    let done = 0;
    e.once('done', () => done++);
    e.emit('done');
    e.emit('done');
    expect(done).toBe(1);
    expect(e.listenerCount('done')).toBe(0);
  });

  it('tolerates unsubscribe during emit', () => {
    const e = new Emitter<{ x: undefined }>();
    const calls: string[] = [];
    const offA = e.on('x', () => {
      calls.push('a');
      offA();
    });
    e.on('x', () => calls.push('b'));
    e.emit('x');
    e.emit('x');
    expect(calls).toEqual(['a', 'b', 'b']);
  });
});
