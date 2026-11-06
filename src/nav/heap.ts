/**
 * A binary min-heap of cell indices keyed by a caller-owned float array, with decrease-key
 * through a position table. Sized to the grid once; nothing allocates afterwards. Internal to
 * A*, the flow field and `reachable`.
 */
export class CellHeap {
  private readonly items: Int32Array;
  /** Heap slot of each cell, or -1 when not in the heap. */
  private readonly where: Int32Array;
  private readonly key: Float64Array | Float32Array;
  private count = 0;

  constructor(cells: number, key: Float64Array | Float32Array) {
    this.items = new Int32Array(cells);
    this.where = new Int32Array(cells).fill(-1);
    this.key = key;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    for (let i = 0; i < this.count; i++) this.where[this.items[i]!] = -1;
    this.count = 0;
  }

  has(cell: number): boolean {
    return this.where[cell]! >= 0;
  }

  /** Inserts `cell`, or moves it up after its key decreased. */
  pushOrDecrease(cell: number): void {
    let i = this.where[cell]!;
    if (i < 0) {
      i = this.count++;
      this.items[i] = cell;
      this.where[cell] = i;
    }
    this.up(i);
  }

  /** Removes and returns the cell with the smallest key (-1 when empty). */
  pop(): number {
    if (this.count === 0) return -1;
    const top = this.items[0]!;
    this.where[top] = -1;
    const last = this.items[--this.count]!;
    if (this.count > 0) {
      this.items[0] = last;
      this.where[last] = 0;
      this.down(0);
    }
    return top;
  }

  private up(i: number): void {
    const items = this.items;
    const key = this.key;
    const cell = items[i]!;
    const k = key[cell]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pc = items[parent]!;
      if (key[pc]! <= k) break;
      items[i] = pc;
      this.where[pc] = i;
      i = parent;
    }
    items[i] = cell;
    this.where[cell] = i;
  }

  private down(i: number): void {
    const items = this.items;
    const key = this.key;
    const n = this.count;
    const cell = items[i]!;
    const k = key[cell]!;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= n) break;
      const right = child + 1;
      if (right < n && key[items[right]!]! < key[items[child]!]!) child = right;
      const cc = items[child]!;
      if (key[cc]! >= k) break;
      items[i] = cc;
      this.where[cc] = i;
      i = child;
    }
    items[i] = cell;
    this.where[cell] = i;
  }
}
