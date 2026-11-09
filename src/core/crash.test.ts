// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { installCrashScreen, isOwnError, isOwnRejection } from './crash';

const ORIGIN = 'https://example.github.io';

describe('which errors are the page’s own', () => {
  it('counts the bundle, inline code and a desktop shell’s file URLs', () => {
    expect(isOwnError({ message: 'x', filename: `${ORIGIN}/game/assets/i.js` }, ORIGIN)).toBe(true);
    expect(isOwnError({ message: 'x', filename: '' }, ORIGIN)).toBe(true);
    expect(isOwnError({ message: 'x', filename: 'file:///app/assets/i.js' }, 'null')).toBe(true);
  });

  it('ignores extensions, other origins and browser noise', () => {
    expect(isOwnError({ message: 'x', filename: 'chrome-extension://abc/c.js' }, ORIGIN)).toBe(
      false,
    );
    expect(isOwnError({ message: 'x', filename: 'https://ads.example/a.js' }, ORIGIN)).toBe(false);
    expect(isOwnError({ message: 'Script error.', filename: '' }, ORIGIN)).toBe(false);
    expect(
      isOwnError(
        { message: 'ResizeObserver loop completed with undelivered notifications.', filename: '' },
        ORIGIN,
      ),
    ).toBe(false);
  });

  it('sorts rejections by the first script in the stack, and drops benign aborts', () => {
    const ours = new Error('boom');
    ours.stack = `Error: boom\n    at f (${ORIGIN}/game/assets/i.js:1:2)`;
    expect(isOwnRejection(ours, ORIGIN)).toBe(true);
    const theirs = new Error('boom');
    theirs.stack = 'Error: boom\n    at g (moz-extension://abc/x.js:1:2)';
    expect(isOwnRejection(theirs, ORIGIN)).toBe(false);
    expect(isOwnRejection(new DOMException('stop', 'AbortError'), ORIGIN)).toBe(false);
    expect(isOwnRejection(new DOMException('no', 'NotAllowedError'), ORIGIN)).toBe(false);
    expect(isOwnRejection('a string', ORIGIN)).toBe(true);
  });
});

describe('installCrashScreen', () => {
  let dispose = () => {};
  afterEach(() => {
    dispose();
    document.body.innerHTML = '';
  });

  function setup(flushed: boolean | 'throws' = true) {
    const root = document.createElement('main');
    document.body.appendChild(root);
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    root.appendChild(canvas);
    let flushes = 0;
    let reloads = 0;
    const screen = installCrashScreen({
      root,
      title: 'A Game',
      flush: () => {
        flushes++;
        if (flushed === 'throws') throw new Error('storage');
        return flushed;
      },
      reload: () => {
        reloads++;
      },
    });
    dispose = () => screen.dispose();
    return { root, canvas, screen, flushes: () => flushes, reloads: () => reloads };
  }

  it('flushes the save, then shows one card with Reload and Keep playing', () => {
    const t = setup();
    t.screen.report(new Error('a'));
    t.screen.report(new Error('b'));
    expect(t.flushes()).toBe(1);
    expect(t.root.querySelectorAll('.engine-msg')).toHaveLength(1);
    expect(t.root.textContent).toContain('A Game');
    expect(t.root.textContent).toContain('Something went wrong');
    expect(t.root.textContent).toContain('Your progress is saved');
    const buttons = [...t.root.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Reload', 'Keep playing']);
    buttons[0]!.click();
    expect(t.reloads()).toBe(1);
    buttons[1]!.click();
    expect(t.root.querySelector('.engine-msg')).toBeNull();
    expect(document.activeElement).toBe(t.canvas);
    // Once per page: a later error does not bring it back.
    t.screen.report(new Error('c'));
    expect(t.root.querySelector('.engine-msg')).toBeNull();
  });

  it('a fatal (boot) error offers Reload only and does not promise a save it lacks', () => {
    const t = setup(false);
    t.screen.report(new Error('boot'), { fatal: true });
    expect([...t.root.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Reload']);
    expect(t.root.textContent).not.toContain('progress is saved');
  });

  it('a flush that throws counts as not saved', () => {
    const t = setup('throws');
    t.screen.report(new Error('x'));
    expect(t.flushes()).toBe(1);
    expect(t.root.textContent).toContain('Something went wrong');
    expect(t.root.textContent).not.toContain('progress is saved');
  });

  it('stays out of the way of the engine’s own fatal screens', () => {
    const t = setup();
    const lost = document.createElement('div');
    lost.className = 'engine-msg';
    t.root.appendChild(lost);
    t.screen.report(new Error('after device loss'));
    expect(t.root.querySelectorAll('.engine-msg')).toHaveLength(1);
    expect(t.screen.shown).toBe(false);
    expect(t.flushes()).toBe(0);
  });

  it('catches window errors and unhandled rejections, and ignores noise', () => {
    const t = setup();
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.', filename: '' }));
    expect(t.screen.shown).toBe(false);
    window.dispatchEvent(new ErrorEvent('error', { message: 'x', filename: '' }));
    expect(t.screen.shown).toBe(true);

    dispose();
    document.body.innerHTML = '';
    const u = setup();
    const rejection = (reason: unknown) => {
      const ev = new Event('unhandledrejection') as PromiseRejectionEvent;
      Object.defineProperty(ev, 'reason', { value: reason });
      window.dispatchEvent(ev);
    };
    rejection(new DOMException('stop', 'AbortError'));
    expect(u.screen.shown).toBe(false);
    rejection(new Error('ours'));
    expect(u.screen.shown).toBe(true);
  });

  it('dispose stops watching the window', () => {
    const t = setup();
    t.screen.dispose();
    window.dispatchEvent(new ErrorEvent('error', { message: 'x', filename: '' }));
    expect(t.screen.shown).toBe(false);
  });
});
