/**
 * What the reference scenes' budget tests share (E-041 A4): a renderer on the counted fake
 * device, a run of a scene through the work meter on the fixed clock, and the kept JSON per
 * scene (`src/<module>/ref-<scene>.budget.json`) every row is held to.
 *
 * - A row holds each counter per frame (as `baseline.budget.test.ts` does); a scene must stay at
 *   or under it, counter by counter. `TC_REF=write` writes the JSON again (say why in the PR).
 * - `stats` pins `renderer.stats` at `REF_STATS_FRAME` exactly: e2e/ref-scenes.spec.ts checks the
 *   page draws the same frame, so the counted scene and the timed one cannot drift apart.
 * - `notes` keeps a scene's other numbers (DOM writes, ratios), held exactly.
 */
import { afterAll, expect } from 'vitest';
import {
  type BudgetLimits,
  budget,
  createWorkMeter,
  type WorkMeter,
  type WorkReport,
} from '../testing/budget';
import { createFakeDevice, type FakeDevice, fakeCanvasContext } from './fake-gpu';
import { REF_STATS_FRAME, type RefScene } from './ref-scenes.test-util';
import { Renderer } from './renderer';

/**
 * What `refBook` needs from node, passed in by the test: this file is a test helper the build
 * and the API checks still type without node's types.
 */
export interface RefHost {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, text: string): void;
  /** The repo root (vitest's working directory). */
  root: string;
  /** `TC_REF=write`: write the JSON instead of holding to it. */
  write: boolean;
}

/** The counters a row keeps (per frame). */
export const REF_KEYS = [
  'commands',
  'draw',
  'drawIndexed',
  'setPipeline',
  'setBindGroup',
  'setVertexBuffer',
  'beginRenderPass',
  'beginComputePass',
  'dispatch',
  'submit',
  'writeBuffer',
  'writeBufferBytes',
  'writeTexture',
  'copies',
  'createBuffer',
  'createTexture',
  'createBindGroup',
  'createOther',
  'typedArrays',
  'arrayBuffers',
  'clockReads',
] as const satisfies readonly (keyof BudgetLimits)[];

export type RefRow = Record<(typeof REF_KEYS)[number], number>;

/** `renderer.stats` at `REF_STATS_FRAME`. */
export interface RefStats {
  drawCalls: number;
  triangles: number;
  instances: number;
  culled: number;
  shadowDraws: number;
  passes: number;
}

export interface RefBudget {
  /** Rows by name: the scene at a size. */
  rows: Record<string, RefRow>;
  /** Per-part splits of a row (`update`, `view`, `left`, `right`, `present`, `hud`). */
  parts: Record<string, Record<string, RefRow>>;
  stats: Record<string, RefStats>;
  notes: Record<string, number>;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function rowOf(r: WorkReport): RefRow {
  const out = {} as RefRow;
  for (const k of REF_KEYS) {
    out[k] = round(
      k === 'clockReads'
        ? r.clockReads
        : k === 'typedArrays' || k === 'arrayBuffers'
          ? r.allocs[k]
          : r.gpu[k],
    );
  }
  return out;
}

function partRow(r: WorkReport, name: string): RefRow {
  const c = r.views[name];
  const out = {} as RefRow;
  for (const k of REF_KEYS) {
    out[k] =
      k === 'clockReads' || k === 'typedArrays' || k === 'arrayBuffers' || !c ? 0 : round(c[k]);
  }
  return out;
}

/** The kept JSON at `path` (from the repo root) and the holds against it. */
export function refBook(path: string, host: RefHost) {
  const file = `${host.root}/${path}`;
  const REF_WRITE = host.write;
  const kept: RefBudget = REF_WRITE
    ? { rows: {}, parts: {}, stats: {}, notes: {} }
    : (JSON.parse(host.readFileSync(file, 'utf8')) as RefBudget);
  const got: RefBudget = { rows: {}, parts: {}, stats: {}, notes: {} };
  afterAll(() => {
    if (REF_WRITE) host.writeFileSync(file, `${JSON.stringify(got, null, 2)}\n`);
  });
  return {
    got,
    /** Hold `r` (and each of its parts) to the kept row `name`: at or under, counter by counter. */
    hold(name: string, r: WorkReport): RefRow {
      const row = rowOf(r);
      got.rows[name] = row;
      const parts: Record<string, RefRow> = {};
      for (const part of Object.keys(r.views)) parts[part] = partRow(r, part);
      got.parts[name] = parts;
      if (REF_WRITE) return row;
      const want = kept.rows[name];
      expect(want, `${name}: no row; run with TC_REF=write`).toBeDefined();
      const limits: BudgetLimits = {};
      for (const k of REF_KEYS) limits[k] = want![k] + 0.0011;
      budget(r, limits, name);
      for (const [part, p] of Object.entries(parts)) {
        const w = kept.parts[name]?.[part];
        expect(w, `${name}/${part}: no row`).toBeDefined();
        for (const k of REF_KEYS)
          expect(p[k], `${name}/${part} ${k}`).toBeLessThanOrEqual(w![k] + 0.0011);
      }
      return row;
    },
    /** Pin `renderer.stats` of `name` exactly. */
    stats(name: string, s: RefStats): void {
      got.stats[name] = s;
      if (REF_WRITE) return;
      expect(s, `${name}: renderer.stats at frame ${REF_STATS_FRAME}`).toEqual(kept.stats[name]);
    },
    /** Pin another number exactly. */
    note(name: string, value: number): void {
      got.notes[name] = round(value);
      if (REF_WRITE) return;
      expect(round(value), name).toBe(kept.notes[name]);
    },
  };
}

/** A renderer on a counted fake device, a 1280×720 backbuffer (the e2e desktop size). */
export function countedRenderer(): { fake: FakeDevice; meter: WorkMeter; renderer: Renderer } {
  const fake = createFakeDevice();
  const meter = createWorkMeter(fake.device);
  const renderer = new Renderer({
    device: meter.device,
    context: fakeCanvasContext(fake),
    format: 'bgra8unorm',
  });
  renderer.resize(1280, 720);
  return { fake, meter, renderer };
}

/** Wait until `scene.prepare()` is true (voxel meshing), letting microtasks and timers run. */
export async function prepared(scene: RefScene): Promise<void> {
  for (let n = 0; n < 10_000; n++) {
    if (scene.prepare()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`ref ${scene.id}: never prepared`);
}

/**
 * Run `scene` on the meter from frame 0 for `warmup + frames` frames (the meter averages the
 * last `frames`), returning the report and `renderer.stats` at `REF_STATS_FRAME`.
 */
export function runScene(
  scene: RefScene,
  meter: WorkMeter,
  renderer: Renderer,
  frames = 40,
  warmup = 10,
): { report: WorkReport; stats: RefStats } {
  let i = 0;
  let stats: RefStats | null = null;
  const report = meter.run(
    () => {
      scene.step(i);
      if (i === REF_STATS_FRAME) stats = statsOf(renderer);
      i++;
    },
    { frames, warmup },
  );
  if (!stats) throw new Error('runScene: too few frames for REF_STATS_FRAME');
  return { report, stats };
}

export function statsOf(renderer: Renderer): RefStats {
  const s = renderer.stats;
  return {
    drawCalls: s.drawCalls,
    triangles: s.triangles,
    instances: s.instances,
    culled: s.culled,
    shadowDraws: s.shadowDraws,
    passes: s.passes,
  };
}
