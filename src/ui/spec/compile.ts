/**
 * Compiling a panel (ws/ui-spec, from Forge Wilds' `ui/spec/layout.ts`): a spec (`words.ts`) is
 * flattened once into typed arrays (its words in pre-order, each one's parent, first child and next
 * sibling) with the index from each model key to the words it binds, so a presenter finds what a
 * changed key draws without a search, and `layoutSpec` (`boxes.ts`) runs over plain arrays with
 * nothing allocated.
 */

import {
  ALIGN,
  KIND,
  R_AGAIN,
  R_BADGE,
  R_COUNT,
  R_ENABLED,
  R_ITEM,
  R_KEY,
  R_LABEL,
  R_LINES,
  R_MARK,
  R_ON,
  R_PLACEHOLDER,
  R_RING,
  R_ROWS,
  R_SELECTED,
  R_SHOW,
  R_STATE,
  R_TEXT,
  R_TINT,
  R_VALUE,
  R_VALUETEXT,
} from './units';
import { type Bind, type PanelSpec, SPEC_LINE, type SpecNode } from './words';

/** A spec flattened for layout and presenting (`compileSpec`); it holds no state, so one serves many panels. */
export class CompiledSpec {
  readonly id: string;
  /** It says when a press is on it (`PanelSpec.held`). */
  readonly held: boolean;
  /** The nodes in pre-order (0 is the body). */
  readonly nodes: readonly SpecNode[];
  readonly n: number;
  readonly kind: Uint8Array;
  readonly parent: Int32Array;
  readonly first: Int32Array;
  readonly next: Int32Array;
  /** The list whose row a node is in (-1: none), and the list's ordinal. */
  readonly inList: Int32Array;
  /** A list's heading word (its second child: keys starting with "#"), or -1. */
  readonly head: Int32Array;
  /** Each node's fixed numbers: width and height (NaN: none), grow, gap, padding, alignment. */
  readonly fw: Float64Array;
  readonly fh: Float64Array;
  readonly grow: Float64Array;
  readonly gap: Float64Array;
  readonly padT: Float64Array;
  readonly padR: Float64Array;
  readonly padB: Float64Array;
  readonly padL: Float64Array;
  readonly align: Uint8Array;
  /** A text's lines and line height at text scale 1. */
  readonly lines: Uint8Array;
  readonly lineH: Float64Array;
  /** The model key a text's bound lines, or a list's bound `maxRows`, read (-1: fixed). */
  readonly linesKey: Int32Array;
  /** Its body fades in and out over this many ms (`PanelSpec.fade`; 0: at once). */
  readonly fade: number;
  /** The model key a node's `show` reads (-1: always shown). */
  readonly showKey: Int32Array;
  /** Each node's id ("" for none). */
  readonly ids: readonly string[];
  /** The model's keys, each one's index, the nodes and roles each binds ([node, role, ...]), and whether it moves boxes. */
  readonly keys: readonly string[];
  readonly keyIndex: ReadonlyMap<string, number>;
  readonly keyBinds: readonly Int32Array[];
  readonly keyLayout: Uint8Array;
  /** The lists (and tabs: a list of options), by ordinal: node, id, row fields, and each field's binds ([template node, role, ...]). */
  readonly listNodes: Int32Array;
  readonly listIds: readonly string[];
  readonly fields: readonly (readonly string[])[];
  readonly fieldBinds: readonly (readonly Int32Array[])[];
  /** A list node's ordinal (-1 for other nodes). */
  readonly listOrd: Int32Array;
  /** Nodes a press lands on, in pre-order. */
  readonly pressables: Int32Array;
  /** Whether a node is a scroll col (`StackNode.scroll`), and the scroll col a node is in (-1: none). */
  readonly scrolls: Uint8Array;
  readonly scroller: Int32Array;
  /** The wrap texts (`TextNode.wrap`), in pre-order; a text's bound text's key (-1: fixed); a wrap text's term's share of its width (0: none). */
  readonly wraps: Int32Array;
  readonly textKey: Int32Array;
  readonly termW: Float64Array;

  constructor(spec: PanelSpec) {
    this.id = spec.id;
    this.held = spec.held === true;
    this.fade = spec.fade ?? 0;
    const nodes: SpecNode[] = [];
    const parents: number[] = [];
    const lists: number[] = [];
    const scrollers: number[] = [];
    const walk = (node: SpecNode, parent: number, list: number, scroller: number): void => {
      const i = nodes.length;
      nodes.push(node);
      parents.push(parent);
      lists.push(list);
      scrollers.push(scroller);
      let inner = scroller;
      if ((node.k === 'col' || node.k === 'row') && node.scroll) {
        if (node.k !== 'col') throw new Error(`row ${node.id ?? i}: only a col scrolls`);
        if (scroller !== -1 || list !== -1)
          throw new Error(`col ${node.id ?? i}: a scroll col inside another, or in a list's row`);
        inner = i;
      }
      if (node.k === 'text' && node.wrap && list !== -1)
        throw new Error(`text ${node.id ?? i}: a wrap text in a list's row`);
      if (node.k === 'col' || node.k === 'row' || node.k === 'grid')
        for (const c of node.children) walk(c, i, list, inner);
      else if (node.k === 'list') {
        if (list !== -1) throw new Error(`list ${node.id} inside another list's row`);
        if (node.head && (node.cols ?? 1) !== 1)
          throw new Error(`list ${node.id}: headings need one column`);
        walk(node.row, i, i, inner);
        if (node.head) walk(node.head, i, i, inner);
      }
    };
    walk(spec.body, -1, -1, -1);
    const n = nodes.length;
    this.nodes = nodes;
    this.n = n;
    this.kind = new Uint8Array(n);
    this.parent = Int32Array.from(parents);
    this.first = new Int32Array(n).fill(-1);
    this.next = new Int32Array(n).fill(-1);
    this.inList = Int32Array.from(lists);
    this.scroller = Int32Array.from(scrollers);
    this.scrolls = new Uint8Array(n);
    this.head = new Int32Array(n).fill(-1);
    this.fw = new Float64Array(n);
    this.fh = new Float64Array(n);
    this.grow = new Float64Array(n);
    this.gap = new Float64Array(n);
    this.padT = new Float64Array(n);
    this.padR = new Float64Array(n);
    this.padB = new Float64Array(n);
    this.padL = new Float64Array(n);
    this.align = new Uint8Array(n);
    this.lines = new Uint8Array(n);
    this.lineH = new Float64Array(n);
    this.showKey = new Int32Array(n).fill(-1);
    this.linesKey = new Int32Array(n).fill(-1);
    this.listOrd = new Int32Array(n).fill(-1);
    this.textKey = new Int32Array(n).fill(-1);
    this.termW = new Float64Array(n);
    const wraps: number[] = [];
    const last = new Int32Array(n).fill(-1);
    const keys: string[] = [];
    const keyIndex = new Map<string, number>();
    const keyBinds: number[][] = [];
    const layoutKeys = new Set<number>();
    const listNodes: number[] = [];
    const listIds: string[] = [];
    const fields: string[][] = [];
    const fieldBinds: number[][][] = [];
    const ids: string[] = [];
    const pressables: number[] = [];
    const ordOf = (node: number): number => this.listOrd[node]!;
    // Lists first, so a row's binds find their list's ordinal.
    for (let i = 0; i < n; i++) {
      const node = nodes[i]!;
      if (node.k === 'list' || node.k === 'tabs') {
        this.listOrd[i] = listNodes.length;
        listNodes.push(i);
        listIds.push(node.id);
        fields.push(node.k === 'tabs' ? ['label'] : []);
        fieldBinds.push(node.k === 'tabs' ? [[]] : []);
      }
    }
    /** Records that node `i` binds `v` in role `role`; returns the top-level key's index (-1 for a row field). */
    const bind = (i: number, v: Bind, role: number, moves = false): number => {
      const key = v.b;
      const list = this.inList[i]!;
      if (key.startsWith('row.')) {
        if (list === -1) throw new Error(`${key} outside a list's row (${spec.id})`);
        const ord = ordOf(list);
        const field = key.slice(4);
        const fs = fields[ord]!;
        let f = fs.indexOf(field);
        if (f === -1) {
          if (fs.length >= 31) throw new Error(`too many row fields in list ${listIds[ord]}`);
          f = fs.length;
          fs.push(field);
          fieldBinds[ord]!.push([]);
        }
        fieldBinds[ord]![f]!.push(i, role);
        return -1;
      }
      let k = keyIndex.get(key);
      if (k === undefined) {
        k = keys.length;
        keys.push(key);
        keyIndex.set(key, k);
        keyBinds.push([]);
      }
      keyBinds[k]!.push(i, role);
      if (moves) layoutKeys.add(k);
      return k;
    };
    const isBind = (v: unknown): v is Bind => typeof v === 'object' && v !== null && 'b' in v;
    for (let i = 0; i < n; i++) {
      const node = nodes[i]!;
      const p = parents[i]!;
      if (p !== -1) {
        if (this.first[p] === -1) this.first[p] = i;
        else this.next[last[p]!] = i;
        last[p] = i;
      }
      this.kind[i] = KIND[node.k];
      this.fw[i] = node.w ?? NaN;
      this.fh[i] = node.h ?? NaN;
      this.grow[i] = node.grow ?? 0;
      ids.push(node.id ?? '');
      if (node.show) {
        if (this.inList[i] !== -1 && isBind(node.show) && node.show.b.startsWith('row.'))
          bind(i, node.show, R_SHOW);
        else this.showKey[i] = bind(i, node.show, R_SHOW, true);
      }
      if (node.state) bind(i, node.state, R_STATE);
      if (isBind(node.label)) bind(i, node.label, R_LABEL);
      if (isBind(node.tint)) bind(i, node.tint, R_TINT);
      if (node.again) bind(i, node.again, R_AGAIN);
      /** A bound number that moves boxes: a top-level key's (a row's own would give every row its own box). */
      const sizing = (v: Bind, role: number, what: string): void => {
        if (v.b.startsWith('row.'))
          throw new Error(
            `${what} bound to a row's field (${v.b} in ${spec.id}): bind it to a panel key`,
          );
        this.linesKey[i] = bind(i, v, role, true);
      };
      switch (node.k) {
        case 'col':
        case 'row': {
          this.gap[i] = node.gap ?? 0;
          const pad = node.pad ?? 0;
          const [t, r, b, l] = typeof pad === 'number' ? [pad, pad, pad, pad] : pad;
          this.padT[i] = t;
          this.padR[i] = r;
          this.padB[i] = b;
          this.padL[i] = l;
          this.align[i] = ALIGN[node.align ?? (node.k === 'col' ? 'stretch' : 'center')];
          // The body is the panel itself (a presenter's host), not a word inside it: it neither scrolls nor is pressed.
          if (i === 0 && (node.scroll || node.tap))
            throw new Error(
              `a panel's body can't be a scroll or a tap ${node.k}; put one inside it (${spec.id})`,
            );
          if (node.scroll) this.scrolls[i] = 1;
          if (node.tap) {
            if (!node.id) throw new Error(`a tap ${node.k} needs an id (${spec.id})`);
            pressables.push(i);
          }
          break;
        }
        case 'grid':
          this.gap[i] = node.gap ?? 0;
          break;
        case 'list':
          this.gap[i] = node.gap ?? 0;
          if (isBind(node.maxRows)) sizing(node.maxRows, R_ROWS, "a list's maxRows");
          break;
        case 'text':
          if (isBind(node.lines)) {
            if (node.wrap)
              throw new Error(
                `text ${node.id ?? i} in ${spec.id}: a wrap text counts its own lines (its \`lines\` is its least: a number)`,
              );
            sizing(node.lines, R_LINES, "a text's lines");
            this.lines[i] = 1;
          } else this.lines[i] = node.lines ?? 1;
          this.lineH[i] = SPEC_LINE[node.style];
          // A wrap text's words move boxes (its lines are its words').
          if (isBind(node.text)) this.textKey[i] = bind(i, node.text, R_TEXT, node.wrap === true);
          if (node.wrap) {
            wraps.push(i);
            if (node.term !== undefined) this.termW[i] = node.termW ?? 0.42;
          }
          break;
        case 'slot':
          bind(i, node.item, R_ITEM);
          if (node.count) bind(i, node.count, R_COUNT);
          if (isBind(node.keyLabel)) bind(i, node.keyLabel, R_KEY);
          if (node.enabled) bind(i, node.enabled, R_ENABLED);
          pressables.push(i);
          break;
        case 'meter':
          if (isBind(node.value)) bind(i, node.value, R_VALUE);
          node.marks?.forEach((m, j) => {
            if (isBind(m.at)) bind(i, m.at, R_MARK + 3 * j);
            if (m.state) bind(i, m.state, R_MARK + 3 * j + 1);
            if (m.label) bind(i, m.label, R_MARK + 3 * j + 2);
          });
          if (node.valueText) bind(i, node.valueText, R_VALUETEXT);
          break;
        case 'button':
          if (isBind(node.text)) bind(i, node.text, R_TEXT);
          if (node.on) bind(i, node.on, R_ON);
          if (node.enabled) bind(i, node.enabled, R_ENABLED);
          if (node.badge) bind(i, node.badge, R_BADGE);
          if (node.ring) bind(i, node.ring, R_RING);
          if (isBind(node.keyLabel)) bind(i, node.keyLabel, R_KEY);
          pressables.push(i);
          break;
        case 'field':
          if (isBind(node.placeholder)) bind(i, node.placeholder, R_PLACEHOLDER);
          if (node.value) bind(i, node.value, R_VALUE);
          if (node.enabled) bind(i, node.enabled, R_ENABLED);
          pressables.push(i);
          break;
        case 'tabs':
          bind(i, node.selected, R_SELECTED);
          if (node.enabled) bind(i, node.enabled, R_ENABLED);
          pressables.push(i);
          break;
        case 'range':
          bind(i, node.value, R_VALUE);
          if (node.enabled) bind(i, node.enabled, R_ENABLED);
          if (node.valueText) bind(i, node.valueText, R_VALUETEXT);
          pressables.push(i);
          break;
        default:
          break;
      }
    }
    for (let i = 0; i < n; i++)
      if (nodes[i]!.k === 'list' && (nodes[i] as { head?: SpecNode }).head)
        this.head[i] = this.next[this.first[i]!]!;
    // A tabs' options are a list of its own: its length moves boxes.
    this.ids = ids;
    this.keys = keys;
    this.keyIndex = keyIndex;
    this.keyBinds = keyBinds.map((a) => Int32Array.from(a));
    this.keyLayout = new Uint8Array(keys.length);
    for (const k of layoutKeys) this.keyLayout[k] = 1;
    this.listNodes = Int32Array.from(listNodes);
    this.listIds = listIds;
    this.fields = fields;
    this.fieldBinds = fieldBinds.map((l) => l.map((a) => Int32Array.from(a)));
    this.pressables = Int32Array.from(pressables);
    this.wraps = Int32Array.from(wraps);
  }
}

/** Compiles `spec` once: it throws on a malformed spec (a scroll col nested, a row field outside a list's row, a tap stack with no id, …). */
export function compileSpec(spec: PanelSpec): CompiledSpec {
  return new CompiledSpec(spec);
}
