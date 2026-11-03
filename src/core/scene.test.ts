import { describe, expect, it } from 'vitest';
import { Emitter } from './events';
import { type Scene, SceneStack } from './scene';

function rec(name: string, log: string[], extra: Partial<Scene<string, string[]>> = {}) {
  const s: Scene<string, string[]> = {
    name,
    enter: (ctx) => log.push(`${name}.enter(${ctx})`),
    exit: () => log.push(`${name}.exit`),
    pause: () => log.push(`${name}.pause`),
    resume: () => log.push(`${name}.resume`),
    update: () => log.push(`${name}.update`),
    render: (frame) => frame.push(name),
    ...extra,
  };
  return s;
}

describe('SceneStack', () => {
  it('push/pop lifecycle', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[]>('ctx');
    st.push(rec('a', log));
    st.push(rec('b', log));
    st.pop();
    expect(log).toEqual(['a.enter(ctx)', 'a.pause', 'b.enter(ctx)', 'b.exit', 'a.resume']);
    expect(st.size).toBe(1);
  });

  it('replace exits the top and enters the new one', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[]>('c');
    st.push(rec('a', log));
    st.replace(rec('b', log));
    expect(log).toEqual(['a.enter(c)', 'a.exit', 'b.enter(c)']);
    expect(st.top?.name).toBe('b');
  });

  it('updates only the top scene', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[]>('c');
    st.push(rec('a', log));
    st.push(rec('b', log));
    log.length = 0;
    st.update(1 / 60);
    expect(log).toEqual(['b.update']);
  });

  it('renders from the highest opaque scene upward', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[]>('c');
    st.push(rec('a', log));
    st.push(rec('b', log));
    st.push(rec('menu', log, { transparent: true }));
    const frame: string[] = [];
    st.render(frame);
    expect(frame).toEqual(['b', 'menu']);
  });

  it('defers stack ops issued during update', () => {
    const log: string[] = [];
    const st = new SceneStack<string, string[]>('c');
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
    const st = new SceneStack<string, string[]>('c');
    st.push(rec('a', log));
    st.push(rec('b', log));
    log.length = 0;
    st.clear();
    expect(log).toEqual(['b.exit', 'a.exit']);
    expect(st.size).toBe(0);
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
