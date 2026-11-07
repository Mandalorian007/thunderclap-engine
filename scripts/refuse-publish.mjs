#!/usr/bin/env node
// `prepublishOnly` of all four npm packages: refuses `npm publish` (or `pnpm publish`) run in a
// package folder (E-037, ws/publish-2).
//
// The workspace manifests export `./src/*.ts`; only `pnpm pack` swaps in the `publishConfig`
// exports that point at `dist/`. npm ignores those overrides, so a folder publish would ship a
// package pointing at files it does not contain. npm runs `prepublishOnly` only when it publishes
// a folder, never when it publishes a tarball, so `npm publish <file>.tgz` from `pnpm pack` is
// untouched and this script has nothing to detect: reaching it means the publish is wrong.
// `pnpm check:pack` proves both cases with `npm publish --dry-run`.
console.error(
  [
    'refuse-publish: do not run `npm publish` in a package folder.',
    'npm ignores pnpm publishConfig, so the package would point at src/ files it does not contain.',
    'Publish a tarball made by `pnpm pack` instead: see docs/releasing.md.',
  ].join('\n'),
);
process.exit(1);
