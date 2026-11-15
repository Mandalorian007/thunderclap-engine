/**
 * ws/forge-asks-fit: a check the fake GPU cannot make by itself. A pipeline is invalid on a real
 * device when an entry point reaches a `@group(n)` variable its layout has no group `n` for (the
 * actor sets' depth-only shadow pipeline in next.14: its vertex entry read the actor groups, its
 * layout held the view group alone). `recordPipelines` keeps every pipeline a fake device makes;
 * `pipelineGroupErrors` lists those whose entries reach past their layout.
 */
import type { FakeDevice } from '../fake-gpu';

interface Recorded {
  label: string | undefined;
  kind: 'render' | 'compute';
  /** Bind group layouts in the pipeline layout (`'auto'`: unchecked). */
  groups: number | 'auto';
  /** Each stage: its module's code and entry point. */
  stages: { code: string; entry: string }[];
  /** A shadow pipeline: render, writing no colour (no fragment stage, or one with no targets). */
  shadow: boolean;
}

/** Keeps every render and compute pipeline `fake` makes from now on. */
export function recordPipelines(fake: FakeDevice): Recorded[] {
  const out: Recorded[] = [];
  const dev = fake.device as unknown as Record<string, (d: never) => unknown>;
  const groupsOf = (layout: unknown): number | 'auto' =>
    layout === 'auto'
      ? 'auto'
      : (layout as { bindGroupLayouts: readonly unknown[] }).bindGroupLayouts.length;
  const codeOf = (m: unknown) => String((m as { code: string }).code);
  const render = dev.createRenderPipeline!.bind(fake.device);
  dev.createRenderPipeline = ((d: GPURenderPipelineDescriptor) => {
    const stages = [{ code: codeOf(d.vertex.module), entry: d.vertex.entryPoint ?? 'vs' }];
    if (d.fragment)
      stages.push({ code: codeOf(d.fragment.module), entry: d.fragment.entryPoint ?? 'fs' });
    out.push({
      label: d.label,
      kind: 'render',
      groups: groupsOf(d.layout),
      stages,
      shadow: !d.fragment || [...d.fragment.targets].length === 0,
    });
    return render(d as never);
  }) as never;
  const compute = dev.createComputePipeline!.bind(fake.device);
  dev.createComputePipeline = ((d: GPUComputePipelineDescriptor) => {
    const stages = [{ code: codeOf(d.compute.module), entry: d.compute.entryPoint ?? 'main' }];
    out.push({
      label: d.label,
      kind: 'compute',
      groups: groupsOf(d.layout),
      stages,
      shadow: false,
    });
    return compute(d as never);
  }) as never;
  return out;
}

/** One line per pipeline whose entries reach a group its layout lacks; empty when all fit. */
export function pipelineGroupErrors(recorded: readonly Recorded[]): string[] {
  const errors: string[] = [];
  for (const p of recorded) {
    if (p.groups === 'auto') continue;
    for (const s of p.stages) {
      const reached = groupsReached(s.code, s.entry);
      const past = reached.filter((g) => g >= (p.groups as number));
      if (past.length > 0) {
        errors.push(
          `${p.label ?? p.kind}: entry '${s.entry}' reaches @group(${past.join(', ')}) ` +
            `but its layout has ${p.groups} group(s)`,
        );
      }
    }
  }
  return errors;
}

/** The `@group` numbers of the module-scope variables `entry` reaches (through the calls it makes). */
export function groupsReached(code: string, entry: string): number[] {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const vars = new Map<string, number>();
  const decl = /((?:@\w+\s*(?:\([^)]*\))?\s*)+)var\s*(?:<[^>]*>)?\s*([A-Za-z_]\w*)/g;
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    const g = /@group\s*\(\s*(\d+)\s*\)/.exec(m[1]!);
    if (g) vars.set(m[2]!, Number(g[1]));
  }
  const fns = new Map<string, string>();
  const head = /\bfn\s+([A-Za-z_]\w*)\s*\(/g;
  for (let m = head.exec(src); m; m = head.exec(src)) {
    let i = src.indexOf('{', m.index);
    const start = i;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    // The signature too: a parameter's type names no variable, but it costs nothing to scan.
    fns.set(m[1]!, src.slice(m.index + m[0].length, i + 1));
    head.lastIndex = Math.max(head.lastIndex, start);
  }
  if (!fns.has(entry)) throw new Error(`no fn '${entry}' in the module`);
  const seen = new Set<string>([entry]);
  const work = [entry];
  const groups = new Set<number>();
  while (work.length > 0) {
    const body = fns.get(work.pop()!)!;
    for (const id of body.match(/[A-Za-z_]\w*/g) ?? []) {
      const g = vars.get(id);
      if (g !== undefined) groups.add(g);
      if (fns.has(id) && !seen.has(id)) {
        seen.add(id);
        work.push(id);
      }
    }
  }
  return [...groups].sort((a, b) => a - b);
}
