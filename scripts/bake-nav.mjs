#!/usr/bin/env node
// Bake one navmesh file from one geometry file (ws/nav-5): the single-file form of `pnpm bake`.
//
//   pnpm bake:nav <input> <output> [--options <options.json>] [--verbose]
//
// <input> is a .glb, .gltf or .json source, read exactly as `pnpm bake` reads a source
// (scripts/bake.mjs `loadSource`: a glTF document with every mesh placed by its node's world
// matrix, or a geometry JSON `{ positions, indices, transform? }` or an array of those).
// `--options` names a JSON file holding the `NavBakeOptions` (`bakeNavMesh`'s second argument);
// `cellSize` defaults to 0.3 here (DEFAULT_OPTIONS) and every other field it leaves out takes the
// engine's own default (`resolveNavBakeOptions`, ws/nav-6), so the script and a runtime bake agree.
// A bad value exits 1 naming the option. <output> receives the navmesh in format 2
// (`exportNavMesh`), which `loadNavMesh(bytes)` reads back at runtime. The bytes are a pure
// function of the inputs. No network, no build step: the engine is imported from its TypeScript
// sources the way scripts/bake.mjs does it.
//
// Exit 0 on success, 1 on misuse (with the usage text), 2 when the bake fails.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine, loadSource, UsageError } from './bake.mjs';

/** The script's own default: `cellSize`, the one option the engine requires. The rest derive from it. */
export const DEFAULT_OPTIONS = Object.freeze({ cellSize: 0.3 });

const USAGE = 'usage: pnpm bake:nav <input> <output> [--options <options.json>] [--verbose]';

/** Parse argv (after the node and script entries). Throws UsageError on misuse. */
export function parseNavArgs(argv) {
  const positional = [];
  let options = null;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') throw new UsageError('');
    if (a === '--options') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError('--options needs a file');
      options = v;
    } else if (a === '--verbose') verbose = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) throw new UsageError('expected <input> and <output>');
  return { input: positional[0], output: positional[1], options, verbose };
}

/**
 * Resolve the options a file gives (or none) to the full `NavBakeOptions` the bake uses: the
 * script's `cellSize` default, then the engine's. Throws UsageError naming a bad option.
 */
export async function resolveNavOptions(json = {}, label = 'options') {
  const { nav } = await loadEngine();
  try {
    // `areas` (and any other non-numeric field) passes through to `bakeNavMesh` untouched.
    return { ...json, ...nav.resolveNavBakeOptions({ ...DEFAULT_OPTIONS, ...json }) };
  } catch (e) {
    if (e instanceof nav.NavBakeError) throw new UsageError(`${label}: ${e.message}`);
    throw e;
  }
}

/** Bake `input` with the options in `optionsFile` (or the defaults); returns the format-2 bytes. */
export async function bakeNavFile(input, optionsFile = null) {
  const { nav, assets } = await loadEngine();
  const file = resolve(input);
  if (!existsSync(file)) throw new UsageError(`no input at ${input}`);
  let json = {};
  if (optionsFile) {
    const path = resolve(optionsFile);
    if (!existsSync(path)) throw new UsageError(`no options file at ${optionsFile}`);
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new UsageError(`${optionsFile}: ${e.message}`);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new UsageError(`${optionsFile}: the options must be a JSON object`);
    }
  }
  const options = await resolveNavOptions(json, optionsFile ?? 'options');
  const sets = loadSource(file, assets);
  if (sets.length === 0) throw new Error(`${input}: the source holds no mesh`);
  const mesh = nav.bakeNavMesh(sets, options);
  return { bytes: nav.exportNavMesh(mesh), polyCount: mesh.polyCount };
}

async function main(argv) {
  let opts;
  try {
    opts = parseNavArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message) console.error(`bake:nav: ${e.message}`);
      console.error(USAGE);
      return 1;
    }
    throw e;
  }
  const t0 = performance.now();
  let result;
  try {
    result = await bakeNavFile(opts.input, opts.options);
  } catch (e) {
    console.error(`bake:nav: ${e.message}`);
    if (e instanceof UsageError) {
      console.error(USAGE);
      return 1;
    }
    return 2;
  }
  const out = resolve(opts.output);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, new Uint8Array(result.bytes));
  const ms = (performance.now() - t0).toFixed(0);
  console.log(
    `bake:nav: ${relative(process.cwd(), out) || out} (${result.polyCount} polygons, ${result.bytes.byteLength} bytes${opts.verbose ? `, ${ms} ms` : ''})`,
  );
  return 0;
}

const self = fileURLToPath(import.meta.url);
const argv1 = process.argv[1] ? resolve(process.argv[1]) : '';
if (argv1 === self || (existsSync(argv1) && realpathSync(argv1) === self)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`bake:nav: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
      process.exit(2);
    },
  );
}
