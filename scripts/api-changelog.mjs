// The engine-v1.0.0 freeze rule (E-036, ws/v1-cut), run by `scripts/api-surface.mjs` in check
// mode (`pnpm check:api`). The committed `api/*.api.txt` is the frozen surface of the last
// release; a branch may change it only together with the CHANGELOG line that announces the
// change: every `api/` file that differs from the release must have a `*Breaking*` or `*Added*`
// entry under `## Unreleased` that names its module (`render`, or `@thunderclap/engine/render`;
// the root entry is `@thunderclap/engine` or `root`).
//
// The release is the tag `v<version>` (what `pnpm release --tag` makes) or `engine-v<version>`,
// else the commit that set `package.json` to the current version. With no git or no such commit
// (a tarball, a shallow clone) the rule has no baseline and is skipped, with a note.
//
// Node built-ins only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The first line of the per-file header that marks a snapshot as frozen. */
export const FROZEN_HEADER = 'engine-v1.0.0 frozen surface';

/** The module an `api/` file snapshots: `index.api.txt` is the root entry `.`. */
export function apiModule(file) {
  const base = file.split('/').pop();
  return base === 'index.api.txt' ? '.' : base.replace(/\.api\.txt$/, '');
}

/**
 * The body of the `## Unreleased` section (also the older `## … (unreleased)` heading), up to the
 * next `## ` heading; null when there is none.
 */
export function unreleasedSection(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## (?:Unreleased\s*$|.*\(unreleased\))/.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n');
}

/** The entries of a section: each `- ` bullet with its indented continuation lines. */
export function entries(section) {
  const out = [];
  for (const line of section.split('\n')) {
    if (/^[-*] /.test(line)) out.push(line);
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1] += `\n${line}`;
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `entry` names `module` (see the header) and says `*Breaking*` or `*Added*`. */
export function announces(entry, module) {
  if (!/\*(?:Breaking|Added)\b[^*]*\*/.test(entry)) return false;
  if (module === '.') return /@thunderclap\/engine(?![\w/-])|\broot\b/.test(entry);
  const m = escapeRe(module);
  return new RegExp(`@thunderclap/engine/${m}(?![\\w-])|(?<![\\w/-])${m}(?![\\w-])`).test(entry);
}

/** The modules among `modules` that the changelog's `## Unreleased` does not announce. */
export function unannounced(modules, changelog) {
  const section = unreleasedSection(changelog);
  const list = section === null ? [] : entries(section);
  return modules.filter((m) => !list.some((e) => announces(e, m)));
}

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The release commit `api/` is frozen at, as { ref, label }, or null when there is none. */
export function freezeBase(root) {
  if (git(root, 'rev-parse', '--is-inside-work-tree') !== 'true') return null;
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!version) return null;
  for (const tag of [`v${version}`, `engine-v${version}`]) {
    const sha = git(root, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`);
    if (sha) return { ref: sha, label: `tag ${tag}` };
  }
  const sha = git(
    root,
    'log',
    '-1',
    '--format=%H',
    `-S"version": "${version}"`,
    '--',
    'package.json',
  );
  return sha ? { ref: sha, label: `the ${version} version commit ${sha.slice(0, 7)}` } : null;
}

/** The `api/*.api.txt` files that differ from `ref` in the working tree, untracked ones included. */
export function changedApiFiles(root, ref) {
  const changed = git(root, 'diff', '--name-only', ref, '--', 'api/') ?? '';
  const added = git(root, 'ls-files', '--others', '--exclude-standard', '--', 'api/') ?? '';
  return [...new Set(`${changed}\n${added}`.split('\n'))]
    .filter((f) => f.endsWith('.api.txt'))
    .sort();
}

/**
 * The freeze check for the package at `root`: { base, modules, missing }, where `modules` are
 * the changed modules and `missing` those the CHANGELOG does not announce. `base` is null (and
 * nothing is checked) without a release to compare with.
 */
export function checkFreeze(root) {
  const base = freezeBase(root);
  if (!base) return { base: null, modules: [], missing: [] };
  const modules = changedApiFiles(root, base.ref).map(apiModule);
  let changelog = '';
  try {
    changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  } catch {}
  return { base, modules, missing: unannounced(modules, changelog) };
}
