/**
 * The inert DOM behind `createTestGame({ overlay: false })` (ws/testing-2): just enough
 * `document`, `window`, `getComputedStyle` and `ResizeObserver` for `createGame` to mount its
 * surface, overlay, input and audio in plain Node, where there is no DOM at all. Nothing lays
 * out, paints or fires on its own: elements keep their children, attributes, classes and
 * listeners (on Node's own `EventTarget`), every box is 0×0 unless the kit sizes it, queries
 * find nothing, and media queries never match. Internal: not exported from the testing entry.
 */

/** Inline style: any property, plus the `CSSStyleDeclaration` methods the engine calls. */
class NullStyle {
  [prop: string]: unknown;
  setProperty(name: string, value: string | null): void {
    this[name] = value ?? '';
  }
  getPropertyValue(name: string): string {
    const v = this[name];
    return typeof v === 'string' ? v : '';
  }
  removeProperty(name: string): string {
    const v = this.getPropertyValue(name);
    delete this[name];
    return v;
  }
}

class NullClassList {
  private readonly names = new Set<string>();
  add(...names: string[]): void {
    for (const n of names) this.names.add(n);
  }
  remove(...names: string[]): void {
    for (const n of names) this.names.delete(n);
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.names.has(name);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
  replace(from: string, to: string): boolean {
    if (!this.names.delete(from)) return false;
    this.names.add(to);
    return true;
  }
  get length(): number {
    return this.names.size;
  }
}

type Child = NullNode | string;

class NullNode extends EventTarget {
  parentNode: NullElement | null = null;
  readonly childNodes: NullNode[] = [];
  constructor(readonly ownerDocument: NullDocument | null) {
    super();
  }
  get parentElement(): NullElement | null {
    return this.parentNode;
  }
  get firstChild(): NullNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): NullNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get isConnected(): boolean {
    let n: NullNode | null = this;
    while (n) {
      if (n === this.ownerDocument?.documentElement) return true;
      n = n.parentNode;
    }
    return false;
  }
  contains(other: unknown): boolean {
    for (let n = other as NullNode | null; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

class NullText extends NullNode {
  constructor(
    doc: NullDocument,
    public data: string,
  ) {
    super(doc);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(v: string) {
    this.data = v;
  }
}

class NullElement extends NullNode {
  readonly style = new NullStyle();
  readonly classList = new NullClassList();
  readonly dataset: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  id = '';
  hidden = false;
  tabIndex = -1;
  innerHTML = '';
  // A canvas's backbuffer size; any element may carry it.
  width = 0;
  height = 0;
  constructor(
    doc: NullDocument | null,
    readonly tagName: string,
  ) {
    super(doc);
  }
  get nodeName(): string {
    return this.tagName;
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', v);
  }
  get children(): NullElement[] {
    return this.childNodes.filter((n): n is NullElement => n instanceof NullElement);
  }
  get textContent(): string {
    return this.childNodes.map((n) => (n as { textContent?: string }).textContent ?? '').join('');
  }
  set textContent(v: string) {
    this.replaceChildren(v);
  }
  get clientWidth(): number {
    return 0;
  }
  get clientHeight(): number {
    return 0;
  }
  get offsetWidth(): number {
    return this.clientWidth;
  }
  get offsetHeight(): number {
    return this.clientHeight;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(name);
    if (on) this.attrs.set(name, '');
    else this.attrs.delete(name);
    return on;
  }
  private adopt(c: Child): NullNode {
    const n = typeof c === 'string' ? new NullText(this.ownerDocument as NullDocument, c) : c;
    n.remove();
    n.parentNode = this;
    return n;
  }
  appendChild<T extends NullNode>(n: T): T {
    this.childNodes.push(this.adopt(n));
    return n;
  }
  append(...nodes: Child[]): void {
    for (const c of nodes) this.childNodes.push(this.adopt(c));
  }
  prepend(...nodes: Child[]): void {
    this.childNodes.unshift(...nodes.map((c) => this.adopt(c)));
  }
  insertBefore<T extends NullNode>(n: T, ref: NullNode | null): T {
    const adopted = this.adopt(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(adopted);
    else this.childNodes.splice(i, 0, adopted);
    return n;
  }
  removeChild<T extends NullNode>(n: T): T {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...nodes: Child[]): void {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes.length = 0;
    this.append(...nodes);
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): NullElement[] {
    return [];
  }
  closest(): null {
    return null;
  }
  matches(): boolean {
    return false;
  }
  getBoundingClientRect(): DOMRect {
    const w = this.clientWidth;
    const h = this.clientHeight;
    const r = { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h };
    return { ...r, toJSON: () => r } as DOMRect;
  }
  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument?.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  hasPointerCapture(): boolean {
    return false;
  }
  getContext(): null {
    return null;
  }
  animate(): { cancel(): void; finished: Promise<void> } {
    return { cancel() {}, finished: Promise.resolve() };
  }
}

class NullDocument extends EventTarget {
  readonly documentElement: NullElement;
  readonly head: NullElement;
  readonly body: NullElement;
  activeElement: NullElement | null;
  readonly visibilityState = 'visible';
  readonly hidden = false;
  readonly fullscreenElement = null;
  defaultView: NullWindow | null = null;
  constructor() {
    super();
    this.documentElement = new NullElement(this, 'HTML');
    this.head = new NullElement(this, 'HEAD');
    this.body = new NullElement(this, 'BODY');
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string): NullElement {
    return new NullElement(this, tag.toUpperCase());
  }
  createElementNS(_ns: string, tag: string): NullElement {
    return new NullElement(this, tag);
  }
  createTextNode(data: string): NullText {
    return new NullText(this, data);
  }
  getElementById(): null {
    return null;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): NullElement[] {
    return [];
  }
}

const noMatch = (media: string) => ({
  media,
  matches: false,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

class NullWindow extends EventTarget {
  readonly devicePixelRatio = 1;
  innerWidth: number;
  innerHeight: number;
  readonly screen: { width: number; height: number };
  constructor(
    readonly document: NullDocument,
    view: { width: number; height: number },
  ) {
    super();
    this.innerWidth = view.width;
    this.innerHeight = view.height;
    this.screen = { width: view.width, height: view.height };
  }
  matchMedia(q: string): ReturnType<typeof noMatch> {
    return noMatch(q);
  }
  getComputedStyle(el: { style?: unknown }): NullStyle {
    return el?.style instanceof NullStyle ? el.style : new NullStyle();
  }
}

class NullResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Install the inert DOM on `globalThis` when there is no `document` (plain Node), and return
 * the document in use. Idempotent; a real DOM (happy-dom, a browser) is never replaced. Defines
 * only what is missing: `document`, `window`, `getComputedStyle`, `ResizeObserver`, and
 * `Node`, `Element`, `HTMLElement`, `HTMLInputElement` and `HTMLSelectElement` for the
 * engine's `instanceof` checks. They stay installed for the rest of the test file.
 */
export function installNullDom(view: { width: number; height: number }): Document {
  const g = globalThis as Record<string, unknown>;
  if (g.document) return g.document as Document;
  const doc = new NullDocument();
  const win = new NullWindow(doc, view);
  doc.defaultView = win;
  const define = (name: string, value: unknown) => {
    if (g[name] === undefined) {
      Object.defineProperty(g, name, { value, configurable: true, writable: true });
    }
  };
  define('document', doc);
  define('window', win);
  define('getComputedStyle', win.getComputedStyle.bind(win));
  define('ResizeObserver', NullResizeObserver);
  define('Node', NullNode);
  define('Element', NullElement);
  define('HTMLElement', NullElement);
  // Never a real input or select: nothing here is one.
  define('HTMLInputElement', class extends NullElement {});
  define('HTMLSelectElement', class extends NullElement {});
  return doc as unknown as Document;
}
