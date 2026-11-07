#!/usr/bin/env node
// Start a game from a template (VISION pillar 6: starting a game is one command).
//
//   pnpm create-game <dir> [--template <name>] [--name <pkg>] [--engine <spec>] [--force] [--dry-run]
//   pnpm create-game --list
//
// Copies templates/<name> (default: puzzle) to <dir> as a standalone project on the engine:
// node_modules, dist, .turbo and lockfiles stay behind; package.json is rewritten in place (name
// from --name or the directory's basename, private, @thunderclap/engine from "workspace:*" to
// --engine or the default below, monorepo-only scripts dropped); the repo's biome.json, a
// .gitignore and a README.md are written; the template's CLAUDE.md stays, minus its references to
// this repo. --engine takes any dependency spec ("^0.3.0", "github:...", "link:../engine",
// "file:../engine.tgz") or a directory, which becomes "link:<path relative to <dir>>".
//
// Default engine: a link to the clone this script runs from, because that is the engine a user
// can install today (the package is not on npm yet). The first publish flips PUBLISHED, and the
// default becomes "^<this repo's version>".
//
// Refuses a non-empty <dir> without --force (which overwrites files and keeps the rest). --dry-run
// prints the plan and writes nothing. --list prints the templates and their descriptions.
// Node built-ins only. Exit 1 on misuse with the usage text, 2 when the copy itself fails.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE = '@thunderclap/engine';
export const ENGINE_REPO = 'https://github.com/Mandalorian007/thunderclap-engine';
/**
 * Whether the engine is on the npm registry. While false, the default engine spec links the clone
 * this script runs from; set it true with the first publish so the default is `^<version>`.
 */
export const PUBLISHED = false;

/** Directory entries never copied out of a template (any depth). */
export const SKIP = new Set([
  'node_modules',
  'dist',
  '.turbo',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  '.DS_Store',
]);

/**
 * Per-template rewrites beyond package.json: [file, pattern, replacement]. The templates' CLAUDE.md
 * files point at this repo's root scripts and biome.json, which the standalone project does not have.
 */
const CLAUDE_MD_RULES = [
  ['CLAUDE.md', / \(from the repo root: `pnpm template:[\w-]+`\)/g, ''],
  ['CLAUDE.md', /Biome \(the repo's `biome.json`\)/g, 'Biome (`biome.json`)'],
  ['CLAUDE.md', /; the repo root's `pnpm check` runs it too \(`check:template-[\w-]+`\)/g, ''],
];
export const REWRITES = {
  puzzle: CLAUDE_MD_RULES,
  'first-person': CLAUDE_MD_RULES,
  'third-person': CLAUDE_MD_RULES,
  platformer: CLAUDE_MD_RULES,
};

const USAGE = `usage: pnpm create-game <dir> [--template <name>] [--name <pkg>] [--engine <spec>] [--force] [--dry-run]
       pnpm create-game --list

  <dir>              where to create the game (its basename is the default package name)
  --template <name>  a folder of templates/ (default: puzzle); --list shows them
  --name <pkg>       package.json "name"
  --engine <spec>    ${ENGINE} dependency: a version range, "github:..." , "link:<path>",
                     "file:<path>" or a directory holding the engine (becomes link:<relative path>);
                     default: a link to this clone (the engine is not on npm yet)
  --force            write into a non-empty <dir>, overwriting files that exist in the template
  --dry-run          print what would be written and change nothing
  --list             print the templates with their descriptions`;

/** pnpm flags that only make sense inside this workspace; scripts using them are dropped. */
const MONOREPO_FLAG = /(^|\s)(--filter(=\S+)?|-F|-r|--recursive|-w|--workspace-root)(\s|$)/;

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatesDir = join(root, 'templates');

export class UsageError extends Error {}

/** Parse argv (after the node and script entries). Throws UsageError on misuse. */
export function parseArgs(argv) {
  const opts = {
    dir: null,
    template: 'puzzle',
    name: null,
    engine: null,
    force: false,
    dryRun: false,
    list: false,
  };
  const valued = { '--template': 'template', '--name': 'name', '--engine': 'engine' };
  const flags = { '--force': 'force', '--dry-run': 'dryRun', '--list': 'list' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') throw new UsageError('');
    if (a in valued) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      opts[valued[a]] = v;
    } else if (a in flags) {
      opts[flags[a]] = true;
    } else if (a.startsWith('--')) {
      throw new UsageError(`unknown option ${a}`);
    } else if (opts.dir === null) {
      opts.dir = a;
    } else {
      throw new UsageError(`unexpected argument ${a}`);
    }
  }
  if (!opts.list && opts.dir === null) throw new UsageError('<dir> is required');
  return opts;
}

/** The templates: every templates/<name> with a package.json, with its description. */
export function listTemplates() {
  if (!existsSync(templatesDir)) return [];
  return readdirSync(templatesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(templatesDir, e.name, 'package.json')))
    .map((e) => {
      const pkg = JSON.parse(readFileSync(join(templatesDir, e.name, 'package.json'), 'utf8'));
      return { name: e.name, description: pkg.description ?? '' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Files a template contributes, relative to its root with '/' separators, sorted. */
export function templateFiles(src, rel = '') {
  const out = [];
  for (const e of readdirSync(join(src, rel), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...templateFiles(src, r));
    else out.push(r);
  }
  return out.sort();
}

/**
 * The engine spec to write. A directory becomes link:<path> (relative to <dir> when that is shorter
 * than the absolute path); a protocol spec or version range is kept as given. Without --engine:
 * `^<engineVersion>` once published, a link to this clone until then.
 */
export function engineSpec(engine, dest, engineVersion, published = PUBLISHED) {
  if (engine === null && published) return `^${engineVersion}`;
  if (engine !== null && (/^[a-z]+:/i.test(engine) || /^[\^~>=<*\d]/.test(engine))) return engine;
  const abs = resolve(engine ?? root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new UsageError(`--engine ${engine}: not a dependency spec or an existing directory`);
  }
  let rel = relative(dest, abs).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  const absPosix = abs.split(sep).join('/');
  return `link:${rel.length <= absPosix.length ? rel : absPosix}`;
}

/** Rewrite a template manifest for the standalone project. Key order is preserved. */
export function rewriteManifest(pkg, { name, engine }) {
  const next = { ...pkg };
  next.name = name;
  next.private = true;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (next[field] && ENGINE in next[field]) next[field] = { ...next[field], [ENGINE]: engine };
  }
  if (next.scripts) {
    next.scripts = Object.fromEntries(
      Object.entries(next.scripts).filter(([, cmd]) => !MONOREPO_FLAG.test(cmd)),
    );
  }
  return next;
}

export function gitignoreText() {
  return ['node_modules/', 'dist/', '.vite/', 'coverage/', '.env', '.env.*', '.DS_Store', ''].join(
    '\n',
  );
}

export function readmeText({ name, template, engine }) {
  return `# ${name}

A game on [\`${ENGINE}\`](${ENGINE_REPO}), started from its \`${template}\` template
(\`pnpm create-game\`). The engine is a dependency (\`${engine}\`); this project owns the rules, content,
scenes and art.

## Run

\`\`\`sh
pnpm install
pnpm dev        # Vite at http://127.0.0.1:5173 (a WebGPU browser: Chrome, Edge or Safari 26+)
pnpm check      # tsc, Biome, Vitest
pnpm build      # the static game in dist/ (pnpm preview serves it)
\`\`\`
${
  engine.startsWith('link:')
    ? `
The engine is linked from a local clone (\`${engine}\`) because ${ENGINE} is not on npm yet. Keep
the clone where it is, or point the dependency at \`github:Mandalorian007/thunderclap-engine\`. Once
the package is published, replace the link with a version range (\`^x.y.z\`).
`
    : ''
}
## Where things are

- \`CLAUDE.md\`: the shape of this project and the engine concepts it uses. Read it first.
- Engine docs: the package's \`README.md\` and \`ARCHITECTURE.md\` (contracts), and one \`README.md\` per
  module under \`src/<module>/\` (\`node_modules/${ENGINE}/\`, or ${ENGINE_REPO}).
- Import only \`${ENGINE}\` and \`${ENGINE}/<module>\`; nothing under the engine's \`src/\`.
`;
}

/**
 * Build the plan: every file to write with its contents (strings) or source path (copies).
 * Pure apart from reading the template; `apply` writes it.
 */
export function plan(opts) {
  const dest = resolve(opts.dir);
  const src = join(templatesDir, opts.template);
  if (!existsSync(join(src, 'package.json'))) {
    const names = listTemplates().map((t) => t.name);
    throw new UsageError(
      `no template "${opts.template}"${names.length ? ` (have: ${names.join(', ')})` : ''}`,
    );
  }
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) throw new UsageError(`${opts.dir} is not a directory`);
    if (readdirSync(dest).length > 0 && !opts.force) {
      throw new UsageError(`${opts.dir} is not empty (use --force to write into it)`);
    }
  }
  const engineVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const engine = engineSpec(opts.engine, dest, engineVersion);
  const name = opts.name ?? basename(dest);
  if (!name) throw new UsageError('--name is required when <dir> has no basename');

  const copies = templateFiles(src).filter((f) => f !== 'package.json');
  const rules = REWRITES[opts.template] ?? [];
  const writes = new Map();
  for (const [file, from, to] of rules) {
    if (!copies.includes(file)) continue;
    const text = writes.get(file) ?? readFileSync(join(src, file), 'utf8');
    writes.set(file, text.replace(from, to));
  }
  const manifest = rewriteManifest(JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')), {
    name,
    engine,
  });
  writes.set('package.json', `${JSON.stringify(manifest, null, 2)}\n`);
  if (!copies.includes('biome.json'))
    writes.set('biome.json', readFileSync(join(root, 'biome.json'), 'utf8'));
  if (!copies.includes('.gitignore')) writes.set('.gitignore', gitignoreText());
  if (!copies.includes('README.md'))
    writes.set('README.md', readmeText({ name, template: opts.template, engine }));

  return {
    dest,
    src,
    name,
    engine,
    template: opts.template,
    copies: copies.filter((f) => !writes.has(f)),
    writes,
    manifest,
  };
}

/** Write the plan to disk. */
export function apply(p) {
  mkdirSync(p.dest, { recursive: true });
  for (const f of p.copies) {
    const to = join(p.dest, f);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(p.src, f), to, { force: true });
  }
  for (const [f, text] of p.writes) {
    const to = join(p.dest, f);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text);
  }
}

function printPlan(p, dry) {
  const verb = dry ? 'would write' : 'writing';
  const files = [...p.copies, ...p.writes.keys()].sort();
  console.log(`create-game: ${verb} ${files.length} files to ${p.dest} (template ${p.template})`);
  for (const f of files) console.log(`  ${f}${p.writes.has(f) ? '  (generated)' : ''}`);
  console.log(`create-game: package "${p.name}", ${ENGINE} "${p.engine}"`);
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.list) {
      for (const t of listTemplates()) console.log(`${t.name.padEnd(14)} ${t.description}`);
      return 0;
    }
    const p = plan(opts);
    printPlan(p, opts.dryRun);
    if (opts.dryRun) return 0;
    apply(p);
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message) console.error(`create-game: ${e.message}`);
      console.error(USAGE);
      return 1;
    }
    console.error(`create-game: ${e.message}`);
    return 2;
  }
  const shown = isAbsolute(opts.dir) ? opts.dir : relative(process.cwd(), opts.dir) || '.';
  console.log(`create-game: done. Next:\n  cd ${shown}\n  pnpm install\n  pnpm dev`);
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
