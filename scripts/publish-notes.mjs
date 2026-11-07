#!/usr/bin/env node
// Prints one version's CHANGELOG section: the body of the GitHub Release that publish.yml makes
// for its tag (ws/publish-2).
//
//   node scripts/publish-notes.mjs <version> [--link-base <url>]
//
// The section is everything under the "## <version> (<date>)" heading, up to the next "## "
// heading. `--link-base` turns repo-relative Markdown links (`](docs/x.md)`) into absolute ones
// (`](<url>/docs/x.md)`), since a release page does not resolve them. Exits 1 when the section is
// missing or empty, so a tag whose CHANGELOG was never dated fails before anything is published.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Returns the body of `version`'s section in `log`, or null when there is none. */
export function sectionFor(log, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^## ${esc}(?: \\([^)]*\\))?[ \\t]*$`, 'm');
  const m = head.exec(log);
  if (!m) return null;
  const rest = log.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return body || null;
}

/** Makes repo-relative Markdown link targets absolute under `base`. */
export function absoluteLinks(md, base) {
  const b = base.replace(/\/$/, '');
  return md.replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi, (_, path) => `](${b}/${path})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const version = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--link-base');
  const baseAt = args.indexOf('--link-base');
  const base = baseAt === -1 ? null : args[baseAt + 1];
  if (!version || (baseAt !== -1 && !base)) {
    console.error('usage: node scripts/publish-notes.mjs <version> [--link-base <url>]');
    process.exit(1);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const body = sectionFor(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!body) {
    console.error(`publish-notes: CHANGELOG.md has no "## ${version}" section with entries`);
    process.exit(1);
  }
  process.stdout.write(`${base ? absoluteLinks(body, base) : body}\n`);
}
