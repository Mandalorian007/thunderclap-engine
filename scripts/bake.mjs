#!/usr/bin/env node
// Bake navmeshes and static colliders at build time (VISION pillar 3: shipping is a command).
//
//   pnpm bake [config] [--out <dir>] [--check] [--watch] [--verbose]
//
// Reads a bake.config.json (default: ./bake.config.json; paths inside it are relative to the
// config's directory):
//
//   {
//     "out": "public/baked",
//     "nav":       [{ "name": "level", "sources": ["assets/level.glb"], "options": NavBakeOptions }],
//     "colliders": [{ "name": "level", "sources": ["assets/level.glb"], "options": StaticColliderOptions }]
//   }
//
// A source is a .glb or .gltf (parsed by the engine's glTF parser, every mesh of the scene placed
// by its node's world matrix; a .gltf's external buffers are read from beside it), or a .json that
// is either a glTF document or a geometry JSON: `{ "positions": [x, y, z, ...], "indices": [...],
// "transform"?: [12 floats, 3×4 row-major] }` or an array of those. Each nav entry runs
// `bakeNavMesh` and writes <out>/<name>.navm (`exportNavMesh`); each collider entry runs
// `createStaticCollider` and writes <out>/<name>.coll (`exportCollider`); <out>/bake-manifest.json
// lists every entry with the SHA-256 of its inputs (the sources' bytes and the options), so
// `--check` can tell a stale bake (exit 1, naming the entries) from a current one (exit 0) in CI
// without rebaking. `--watch` rebakes when a source or the config changes; `--verbose` prints
// per-entry timing. The baked files are a pure function of the inputs: a second bake is byte-equal.
//
// Engine code is imported from the TypeScript sources through Node's own type stripping
// (`module.stripTypeScriptTypes` in transform mode, Node >= 22.13) plus a resolve hook for the
// engine's extensionless relative imports: no build step, no dependency, the same modules the
// browser runs. In this repo `@thunderclap/engine/*` self-references the package; in a game it is
// the installed package. Exit 1 on misuse with the usage text, 2 when a bake fails.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const MANIFEST_VERSION = 1;
export const MANIFEST_NAME = 'bake-manifest.json';

const USAGE = `usage: pnpm bake [config] [--out <dir>] [--check] [--watch] [--verbose]

  [config]        a bake.config.json (default: ./bake.config.json)
  --out <dir>     where the baked files go (overrides the config's "out")
  --check         exit 1 when any entry's inputs differ from the manifest; bake nothing
  --watch         rebake when the config or a source changes
  --verbose       print every entry's size and time`;

export class UsageError extends Error {}

/** Parse argv (after the node and script entries). Throws UsageError on misuse. */
export function parseArgs(argv) {
  const opts = { config: null, out: null, check: false, watch: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') throw new UsageError('');
    if (a === '--out') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError('--out needs a value');
      opts.out = v;
    } else if (a === '--check') opts.check = true;
    else if (a === '--watch') opts.watch = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (opts.config === null) opts.config = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (opts.check && opts.watch) throw new UsageError('--check and --watch exclude each other');
  return opts;
}

// ------------------------------------------------------------------ the engine

let engine = null;

/**
 * Install the TypeScript hooks once and import the engine modules the bake runs on:
 * `{ nav, geom, assets }`. Exported so the test can import the engine the same way.
 */
export async function loadEngine() {
  if (engine) return engine;
  const emit = process.emitWarning;
  // `stripTypeScriptTypes` warns once that it is experimental; the bake is where it is used.
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' || warning?.name === 'ExperimentalWarning') return;
    emit.call(process, warning, ...rest);
  };
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (e) {
        const relativeSpec = specifier.startsWith('./') || specifier.startsWith('../');
        if (!relativeSpec || !context.parentURL || extname(specifier) !== '') throw e;
        const base = new URL(specifier, context.parentURL);
        for (const url of [`${base.href}.ts`, `${base.href}/index.ts`]) {
          const path = fileURLToPath(url);
          if (existsSync(path) && statSync(path).isFile()) return { url, shortCircuit: true };
        }
        throw e;
      }
    },
    load(url, context, next) {
      if (!url.endsWith('.ts')) return next(url, context);
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
        mode: 'transform',
      });
      return { format: 'module', source, shortCircuit: true };
    },
  });
  const [nav, geom, assets] = await Promise.all([
    import('@thunderclap/engine/nav'),
    import('@thunderclap/engine/geom'),
    import('@thunderclap/engine/assets'),
  ]);
  engine = { nav, geom, assets };
  return engine;
}

// ------------------------------------------------------------------ config

/** Read and validate a config; every path resolved against the config's directory. */
export function loadConfig(path, outOverride = null) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new UsageError(`no config at ${path}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new UsageError(`${path}: ${e.message}`);
  }
  const dir = dirname(abs);
  const out = resolve(dir, outOverride ?? raw.out ?? 'public/baked');
  const entries = [];
  const names = new Set();
  const readList = (list, kind) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) throw new UsageError(`${path}: "${kind}" must be an array`);
    for (const e of list) {
      if (!e || typeof e.name !== 'string' || !/^[\w.-]+$/.test(e.name)) {
        throw new UsageError(`${path}: every ${kind} entry needs a "name" of [A-Za-z0-9_.-]`);
      }
      if (!Array.isArray(e.sources) || e.sources.length === 0) {
        throw new UsageError(`${path}: ${kind} "${e.name}" needs a non-empty "sources" list`);
      }
      const key = `${kind}:${e.name}`;
      if (names.has(key)) throw new UsageError(`${path}: ${kind} "${e.name}" is listed twice`);
      names.add(key);
      entries.push({
        name: e.name,
        kind,
        sources: e.sources.map(String),
        files: e.sources.map((s) => resolve(dir, String(s))),
        options: e.options ?? {},
      });
    }
  };
  readList(raw.nav, 'nav');
  readList(raw.colliders, 'collider');
  if (entries.length === 0) throw new UsageError(`${path}: no "nav" or "colliders" entries`);
  return { path: abs, dir, out, entries };
}

/** Hex SHA-256 over the entry's source bytes (in order) and its options. */
export function hashInputs(entry) {
  const h = createHash('sha256');
  for (const f of entry.files) {
    h.update(f.length.toString());
    h.update(readFileSync(f));
  }
  h.update(JSON.stringify(entry.options));
  return h.digest('hex');
}

export function outputName(entry) {
  return `${entry.name}.${entry.kind === 'nav' ? 'navm' : 'coll'}`;
}

// ------------------------------------------------------------------ sources

/** `m` (3×4 row-major) applied to `positions` (xyz triples) in place. */
function placePositions(positions, m) {
  if (!m) return positions;
  if (m.length !== 12) throw new Error('a "transform" has 12 floats (3×4 row-major)');
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    positions[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    positions[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    positions[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  return positions;
}

/** A geometry JSON object (`positions`, `indices`, `transform?`) as a world-space triangle set. */
function fromGeometryJson(obj, where) {
  if (!obj || !Array.isArray(obj.positions) || !Array.isArray(obj.indices)) {
    throw new Error(`${where}: a geometry JSON has "positions" and "indices" arrays`);
  }
  if (obj.positions.length % 3 !== 0) throw new Error(`${where}: positions are xyz triples`);
  if (obj.indices.length % 3 !== 0) throw new Error(`${where}: indices come in triangles`);
  const positions = placePositions(Float32Array.from(obj.positions), obj.transform);
  const indices = Uint32Array.from(obj.indices);
  const vertexCount = positions.length / 3;
  for (const i of indices) {
    if (!(i >= 0 && i < vertexCount)) throw new Error(`${where}: index ${i} is out of range`);
  }
  return { positions, indices };
}

/** Every placed primitive of a parsed glTF document as world-space triangle sets. */
function fromGltfDocument(doc) {
  const sets = [];
  for (const n of doc.sceneNodes) {
    const node = doc.nodes[n];
    if (node.mesh === null || node.mesh === undefined) continue;
    for (const prim of doc.meshes[node.mesh].primitives) {
      sets.push({
        positions: placePositions(Float32Array.from(prim.position), node.world),
        indices: Uint32Array.from(prim.indices),
      });
    }
  }
  return sets;
}

/** Read one source file into world-space triangle sets. */
export function loadSource(file, assets) {
  const ext = extname(file).toLowerCase();
  const where = relative(process.cwd(), file) || file;
  if (ext === '.glb') return fromGltfDocument(assets.parseGltf(toArrayBuffer(readFileSync(file))));
  if (ext === '.gltf' || ext === '.json') {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    if (ext === '.gltf' || (json && typeof json === 'object' && 'asset' in json)) {
      const buffers = (json.buffers ?? []).map((b) =>
        typeof b.uri === 'string' && !b.uri.startsWith('data:')
          ? toArrayBuffer(readFileSync(resolve(dirname(file), decodeURIComponent(b.uri))))
          : undefined,
      );
      return fromGltfDocument(assets.parseGltf({ json, buffers }));
    }
    const list = Array.isArray(json) ? json : [json];
    return list.map((g, i) => fromGeometryJson(g, list.length > 1 ? `${where}[${i}]` : where));
  }
  throw new Error(`${where}: not a .glb, .gltf or .json source`);
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ------------------------------------------------------------------ baking

/** Bake one entry to bytes (an ArrayBuffer). */
export function bakeEntry(entry, { nav, geom, assets }) {
  const sets = entry.files.flatMap((f) => loadSource(f, assets));
  if (sets.length === 0) throw new Error(`${entry.kind} "${entry.name}": the sources hold no mesh`);
  if (entry.kind === 'nav') {
    return nav.exportNavMesh(nav.bakeNavMesh(sets, entry.options));
  }
  // The builder reads the first three floats of each vertex at `layout.floats` per vertex.
  const layout = { floats: 3 };
  const bounds = { center: [0, 0, 0], radius: 0 };
  const sources = sets.map((s) => ({
    geometry: { vertices: s.positions, indices: s.indices, bounds, layout },
  }));
  return geom.exportCollider(geom.createStaticCollider(sources, entry.options));
}

/**
 * Bake every entry of a loaded config into `config.out` and write the manifest. Returns the
 * manifest. Throws on the first failing entry (nothing of it is written; earlier entries are).
 */
export function bake(config, { verbose = false, log = console.log } = {}) {
  const eng = engine;
  if (!eng) throw new Error('bake: loadEngine() first');
  mkdirSync(config.out, { recursive: true });
  const entries = [];
  const t0 = performance.now();
  for (const entry of config.entries) {
    const sha256 = hashInputs(entry);
    const start = performance.now();
    const bytes = bakeEntry(entry, eng);
    const ms = Math.round((performance.now() - start) * 100) / 100;
    const file = join(config.out, outputName(entry));
    writeFileSync(file, new Uint8Array(bytes));
    entries.push({
      name: entry.name,
      kind: entry.kind,
      sources: entry.sources,
      sha256,
      bytes: bytes.byteLength,
      ms,
    });
    if (verbose) {
      log(`bake: ${relative(process.cwd(), file)}  ${bytes.byteLength} bytes  ${ms.toFixed(2)} ms`);
    }
  }
  const manifest = { version: MANIFEST_VERSION, bakedAt: new Date().toISOString(), entries };
  writeFileSync(join(config.out, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  const total = Math.round(performance.now() - t0);
  log(
    `bake: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} to ${relative(process.cwd(), config.out) || '.'} in ${total} ms`,
  );
  return manifest;
}

/**
 * Compare every config entry's input hash with the manifest in `config.out`. Returns the list
 * of stale entries as `{ name, kind, reason }` (empty when the bake is current).
 */
export function check(config) {
  const path = join(config.out, MANIFEST_NAME);
  if (!existsSync(path)) {
    return config.entries.map((e) => ({ name: e.name, kind: e.kind, reason: 'no manifest' }));
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const stale = [];
  for (const entry of config.entries) {
    const m = manifest.entries?.find((e) => e.name === entry.name && e.kind === entry.kind);
    if (!m) stale.push({ name: entry.name, kind: entry.kind, reason: 'not in the manifest' });
    else if (!existsSync(join(config.out, outputName(entry))))
      stale.push({ name: entry.name, kind: entry.kind, reason: 'baked file missing' });
    else if (m.sha256 !== hashInputs(entry))
      stale.push({ name: entry.name, kind: entry.kind, reason: 'inputs changed' });
  }
  return stale;
}

// ------------------------------------------------------------------ main

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message) console.error(`bake: ${e.message}`);
      console.error(USAGE);
      return 1;
    }
    throw e;
  }
  const configPath = opts.config ?? 'bake.config.json';
  let config;
  try {
    config = loadConfig(configPath, opts.out);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`bake: ${e.message}`);
      console.error(USAGE);
      return 1;
    }
    throw e;
  }

  if (opts.check) {
    const stale = check(config);
    for (const s of stale) console.error(`bake: ${s.kind} "${s.name}" is stale: ${s.reason}`);
    if (stale.length > 0) {
      console.error(
        `bake: ${stale.length} stale; run \`pnpm bake ${isAbsolute(configPath) ? configPath : relative(process.cwd(), config.path)}\``,
      );
      return 1;
    }
    const n = config.entries.length;
    console.log(`bake: ${n} ${n === 1 ? 'entry' : 'entries'} current`);
    return 0;
  }

  await loadEngine();
  const run = () => {
    try {
      bake(config, { verbose: opts.verbose });
      return 0;
    } catch (e) {
      console.error(`bake: ${e.message}`);
      return 2;
    }
  };
  const code = run();
  if (!opts.watch) return code;

  // Watch the config and every source; a change rebakes after a short settle.
  let timer = null;
  const rebake = () => {
    timer = null;
    try {
      config = loadConfig(configPath, opts.out);
    } catch (e) {
      console.error(`bake: ${e.message}`);
      return;
    }
    run();
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebake, 150);
  };
  const watched = new Set([config.path, ...config.entries.flatMap((e) => e.files)]);
  for (const f of watched) {
    if (existsSync(f)) watch(f, { persistent: true }, schedule);
  }
  console.log(`bake: watching ${watched.size} files (Ctrl-C to stop)`);
  await new Promise(() => {});
  return 0;
}

// Executed directly (`pnpm bake`, or a game's `node node_modules/@thunderclap/engine/scripts/bake.mjs`,
// where argv[1] goes through the package symlink), not imported by the tests.
const self = fileURLToPath(import.meta.url);
const argv1 = process.argv[1] ? resolve(process.argv[1]) : '';
if (argv1 === self || (existsSync(argv1) && realpathSync(argv1) === self)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`bake: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
      process.exit(2);
    },
  );
}
