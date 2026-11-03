/**
 * Full-screen DOM message screens for fatal states (no WebGPU, device lost).
 * Styled dark slate + gold. Text is generic; the game passes its own title.
 */

export interface MessageScreenAction {
  label: string;
  onClick: () => void;
}

export interface MessageScreenOptions {
  /** Small caps line above the heading (e.g. the game's name). */
  eyebrow?: string;
  heading: string;
  /** Paragraphs of body text. */
  body: string[];
  /** A bulleted list after the body. */
  list?: string[];
  /** Paragraphs after the list, in small print. */
  footer?: string[];
  actions?: MessageScreenAction[];
}

const STYLE_ID = 'engine-message-screen-style';
const CSS = `
.engine-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at 50% 40%,#1c2130 0%,#0b0d14 70%);z-index:1000;
  font-family:Georgia,'Iowan Old Style','Palatino Linotype',serif;color:#d9d3c3;padding:24px;box-sizing:border-box}
.engine-msg__card{max-width:560px;width:100%;padding:36px 40px;border:1px solid #a8863a;border-radius:10px;
  background:linear-gradient(180deg,#191d29,#12151f);box-shadow:0 0 0 4px #0b0d14,0 0 0 5px #5a4a24,0 20px 60px #000a}
.engine-msg__eyebrow{letter-spacing:.25em;text-transform:uppercase;font-size:12px;color:#a8863a;margin:0 0 10px}
.engine-msg__heading{font-size:28px;line-height:1.2;margin:0 0 16px;color:#f0cf74;
  text-shadow:0 2px 0 #4b2a6b,0 0 18px #f0cf7433}
.engine-msg__body{font-size:16px;line-height:1.55;margin:0 0 12px}
.engine-msg__actions{margin-top:22px;display:flex;gap:12px}
.engine-msg__btn{font:inherit;font-size:16px;padding:10px 22px;border-radius:6px;cursor:pointer;
  color:#1a1408;background:linear-gradient(180deg,#f5d77f,#c99a2e);border:1px solid #7a5c1a}
.engine-msg__btn:focus-visible{outline:2px solid #f0cf74;outline-offset:3px}
.engine-msg__list{font-size:16px;line-height:1.5;margin:0 0 12px;padding-left:1.2em}
.engine-msg__list li{margin:0 0 6px}
.engine-msg__small{font-size:13px;color:#9a9484;overflow-wrap:anywhere}
@media (max-height:520px),(max-width:600px){
  .engine-msg{align-items:flex-start;overflow-y:auto;padding:12px}
  .engine-msg__card{padding:18px 20px;margin:auto}
  .engine-msg__heading{font-size:22px;margin-bottom:10px}
  .engine-msg__body,.engine-msg__list{font-size:15px;line-height:1.45;margin-bottom:8px}
  .engine-msg__eyebrow{margin-bottom:6px}
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** Show a modal message screen over `root`. Returns a function that removes it. */
export function showMessageScreen(root: HTMLElement, opts: MessageScreenOptions): () => void {
  ensureStyle();
  const wrap = document.createElement('div');
  wrap.className = 'engine-msg';
  wrap.setAttribute('role', 'alertdialog');
  wrap.setAttribute('aria-live', 'assertive');
  const card = document.createElement('div');
  card.className = 'engine-msg__card';
  if (opts.eyebrow) {
    const e = document.createElement('p');
    e.className = 'engine-msg__eyebrow';
    e.textContent = opts.eyebrow;
    card.appendChild(e);
  }
  const h = document.createElement('h1');
  h.className = 'engine-msg__heading';
  h.textContent = opts.heading;
  card.appendChild(h);
  for (const para of opts.body) {
    const p = document.createElement('p');
    p.className = 'engine-msg__body';
    p.textContent = para;
    card.appendChild(p);
  }
  if (opts.list?.length) {
    const ul = document.createElement('ul');
    ul.className = 'engine-msg__list';
    for (const item of opts.list) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }
  for (const para of opts.footer ?? []) {
    const p = document.createElement('p');
    p.className = 'engine-msg__body engine-msg__small';
    p.textContent = para;
    card.appendChild(p);
  }
  if (opts.actions?.length) {
    const row = document.createElement('div');
    row.className = 'engine-msg__actions';
    for (const a of opts.actions) {
      const b = document.createElement('button');
      b.className = 'engine-msg__btn';
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      row.appendChild(b);
    }
    card.appendChild(row);
  }
  wrap.appendChild(card);
  root.appendChild(wrap);
  wrap.querySelector('button')?.focus();
  return () => wrap.remove();
}

export type PlatformFamily = 'ios' | 'android' | 'desktop';

/** The visitor's platform, for advice only (never to gate anything). */
export function platformFamily(
  ua = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
): PlatformFamily {
  // iPadOS asks for desktop sites and reports itself as a Mac with touch.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** Where WebGPU runs (docs/design/mobile.md has the matrix and its sources). */
const WHERE: Record<PlatformFamily, string> = {
  ios: 'iPhone and iPad: Safari on iOS 26 or newer. Opened from inside another app? Open the link in Safari.',
  android:
    'Android: the latest Chrome on Android 12 or newer. Firefox and in-app browsers cannot run it yet, so open the link in Chrome.',
  desktop:
    'Computer: the latest Chrome or Edge, or Safari 26 or newer on a Mac. On Linux, Chrome may need hardware acceleration turned on.',
};

/** "Your browser can't run this" screen: where it does run, the visitor's platform first. */
export function showUnsupportedScreen(
  root: HTMLElement,
  opts: { title?: string; detail?: string } = {},
): () => void {
  const mine = platformFamily();
  const others = (['ios', 'android', 'desktop'] as const).filter((p) => p !== mine);
  return showMessageScreen(root, {
    eyebrow: opts.title,
    heading: 'WebGPU is not available',
    body: [
      'This game draws with WebGPU, and this browser (or this device) did not give us access to it. It runs on:',
    ],
    list: [WHERE[mine], ...others.map((p) => WHERE[p])],
    footer: opts.detail ? [`Details: ${opts.detail}`] : [],
  });
}

/** GPU device lost: offer a reload. */
export function showDeviceLostScreen(
  root: HTMLElement,
  opts: { title?: string; detail?: string; onReload?: () => void } = {},
): () => void {
  const body = ['The graphics device stopped responding. Your progress is saved locally.'];
  if (opts.detail) body.push(`Details: ${opts.detail}`);
  return showMessageScreen(root, {
    eyebrow: opts.title,
    heading: 'The lights went out',
    body,
    actions: [{ label: 'Reload', onClick: opts.onReload ?? (() => location.reload()) }],
  });
}
