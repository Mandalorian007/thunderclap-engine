// Interop with the section stream (crates/tc-stream): `createNet` over a real WebSocket fills
// the voxel `SectionStore` from the stream's `Section`, `Edit`, `Unload` and `UnloadBox`
// messages, and resumes after a reconnect holding what it had. Run by `cargo test -p tc-stream --test
// interop` (or `pnpm test:stream-interop`), which starts the server and sets
// TC_STREAM_INTEROP_URL; skipped otherwise.
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defineBlockTable } from '../voxel/blocks';
import { defineVoxelFormat, RAW_SECTION_CODEC, sectionKey } from '../voxel/format';
import { createSectionStore } from '../voxel/store';
import { defineSchema } from './envelope';
import { createNet } from './session';
import type { Connect } from './transport';

const url = process.env.TC_STREAM_INTEROP_URL;
const DEFLATE = 1;

const wsConnect =
  (to: string): Connect =>
  (events) => {
    const ws = new WebSocket(to);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => events.open();
    ws.onmessage = (e) => events.message(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => events.close(e.code, e.reason);
    return {
      send: (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame as Uint8Array<ArrayBuffer>);
      },
      close: () => ws.close(),
    };
  };

/** The stream's wire types, as tc-stream defines them. */
const streamSchema = () =>
  defineSchema({
    types: {
      SectionPos: { struct: { x: 'i32', y: 'i32', z: 'i32' } },
      Area: { struct: { center: 'SectionPos', rx: 'u8', ry: 'u8', rz: 'u8' } },
      Stamp: { struct: { hi: 'u32', lo: 'u32' } },
      Claim: { struct: { pos: 'SectionPos', stamp: 'Stamp' } },
      GroupClaim: {
        struct: {
          start: 'SectionPos',
          axis: 'u8',
          held: 'u32',
          digest: 'Stamp',
          layers: { vec: { option: 'Stamp' } },
        },
      },
      LayerClaim: { struct: { layer: 'u32', key: 'SectionPos', stamp: 'Stamp' } },
      StreamInterest: {
        struct: {
          area: 'Area',
          holding: { vec: 'Claim' },
          groups: { vec: 'GroupClaim' },
          layers: { vec: 'LayerClaim' },
        },
      },
      StreamMsg: {
        enum: {
          Section: { pos: 'SectionPos', stamp: 'Stamp', data: 'Bytes' },
          Edit: { pos: 'SectionPos', changes: { vec: 'u32' }, stamp: 'Stamp' },
          Unload: { positions: { vec: 'SectionPos' } },
          UnloadBox: { min: 'SectionPos', max: 'SectionPos' },
        },
      },
    },
    roles: { command: 'String', result: 'String', interest: 'StreamInterest', server: 'StreamMsg' },
  });

interface Pos {
  x: number;
  y: number;
  z: number;
}
interface Stamp {
  hi: number;
  lo: number;
}
type StreamMsg =
  | { type: 'Section'; pos: Pos; stamp: Stamp; data: Uint8Array }
  | { type: 'Edit'; pos: Pos; changes: number[]; stamp: Stamp }
  | { type: 'Unload'; positions: Pos[] }
  | { type: 'UnloadBox'; min: Pos; max: Pos };

/** Resolves once `test` holds, polling. */
async function until(test: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SIZE = 4;
const format = defineVoxelFormat({
  sectionSize: SIZE,
  blocks: defineBlockTable([{ class: 'none' }, { class: 'opaque' }, { class: 'opaque' }]),
});

describe.skipIf(!url)('tc-stream interop', () => {
  it('has the hash the server was built with', () => {
    expect(streamSchema().hash).toBe(process.env.TC_STREAM_INTEROP_HASH);
  });

  it('fills a section store, edits it, and resumes with only what changed', async () => {
    const net = createNet({
      schema: streamSchema(),
      connect: wsConnect(url!),
      hello: { token: 'ada' },
      bulk: DEFLATE,
      inflate: async (codec, data) => (codec === DEFLATE ? inflateRawSync(data) : data),
      reconnect: { initialDelay: 20, maxDelay: 100 },
    });
    const store = createSectionStore({ format, codec: RAW_SECTION_CODEC });
    // What it holds, with stamps: its claims on a reconnect.
    const held = new Map<number, { pos: Pos; stamp: Stamp }>();
    const seen = { sections: 0, edits: 0, welcomes: 0, boxes: 0 };
    net.on('game', (value) => {
      const m = value as StreamMsg;
      if (m.type === 'Section') {
        const key = sectionKey(m.pos.x, m.pos.y, m.pos.z);
        store.putSection(m.pos.x, m.pos.y, m.pos.z, m.data);
        held.set(key, { pos: m.pos, stamp: m.stamp });
        seen.sections++;
      } else if (m.type === 'Edit') {
        const key = sectionKey(m.pos.x, m.pos.y, m.pos.z);
        store.edit(key, m.changes);
        held.set(key, { pos: m.pos, stamp: m.stamp });
        seen.edits++;
      } else if (m.type === 'UnloadBox') {
        const { min, max } = m;
        const dropped: number[] = [];
        store.dropBox(min.x, min.y, min.z, max.x, max.y, max.z, dropped);
        for (const key of dropped) held.delete(key);
        seen.boxes++;
      } else {
        for (const p of m.positions) {
          const key = sectionKey(p.x, p.y, p.z);
          store.dropSection(key);
          held.delete(key);
        }
      }
    });
    net.on('welcome', () => seen.welcomes++);
    let area = { center: { x: 0, y: 0, z: 0 }, rx: 1, ry: 1, rz: 1 };
    // Dropped: ask again holding everything (sent first on the next connection).
    net.on('down', () =>
      net.setInterest({ area, holding: [...held.values()], groups: [], layers: [] }),
    );
    await net.ready;
    net.setInterest({ area, holding: [], groups: [], layers: [] });
    await until(() => held.size === 27, 'the area');
    expect(store.cellAt(0, 0, 0)).toBe(1);
    expect(store.cellAt(1, 0, 0)).toBe(0);
    expect(store.cellAt(0, -1, 0)).toBe(1);

    // A change while held: an Edit of that cell.
    expect(await net.command('set 0 0 0 1 2')).toBe('ok');
    await until(() => seen.edits === 1, 'the edit');
    expect(store.cellAt(1, 0, 0)).toBe(2);
    expect(seen.sections).toBe(27);

    // Dropped as a cell changes: back holding the rest, only that section comes again.
    expect(await net.command('drop 1 0 0 2 2')).toBe('ok');
    await until(() => seen.welcomes === 2, 'the reconnect');
    await until(() => seen.sections === 28, 'the changed section');
    expect(store.cellAt(SIZE + 2, 0, 0)).toBe(2);
    expect(store.cellAt(1, 0, 0)).toBe(2);
    // Nothing else follows.
    expect(await net.command('set 0 2 0 0 0')).toBe('ok');
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual({ sections: 28, edits: 1, welcomes: 2, boxes: 0 });
    expect(held.size).toBe(27);

    // Away: what it left goes in an UnloadBox, and the store holds only the new area.
    area = { ...area, center: { x: 10, y: 0, z: 0 } };
    net.setInterest({ area, holding: [...held.values()], groups: [], layers: [] });
    await until(() => seen.sections === 28 + 27 && held.size === 27, 'the new area');
    expect(seen.boxes).toBeGreaterThanOrEqual(1);
    expect(store.stats().sections).toBe(27);
    expect(store.cellAt(0, 0, 0)).toBe(undefined);
    expect(store.cellAt(10 * SIZE, 0, 0)).toBe(1);
    net.close();
  });
});
