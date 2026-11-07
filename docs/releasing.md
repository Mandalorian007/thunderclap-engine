# Releasing

This repo publishes four packages to the public npm registry (E-037):

| Package | Version line | Folder |
| --- | --- | --- |
| `@thunderclap/engine` | `1.x` | the repo root |
| `@thunderclap/host-electron` | `0.x` | `packages/host-electron` |
| `@thunderclap/host-capacitor` | `0.x` | `packages/host-capacitor` |
| `@thunderclap/host-pwa` | `0.x` | `packages/host-pwa` |

Every release after the first is published by `.github/workflows/publish.yml` when a `v*` tag is pushed. It uses npm trusted publishing: npm trusts that workflow file through GitHub's OIDC token, so no npm token is stored anywhere, and every version carries a provenance statement.

## How a package is built and packed

- `pnpm build` compiles each package with `tsc` to `dist/` (ESM JavaScript and `.d.ts`). host-electron also builds its shell into `out/`.
- In the workspace, every `exports` entry points at `./src/*.ts`, so the harness, templates and tests use the source. `publishConfig` holds the published `exports` (pointing at `dist/`). `pnpm pack` swaps them in and turns `workspace:` ranges into versions.
- So publish a **tarball made by `pnpm pack`**. Never run `npm publish` in a package folder: npm ignores pnpm's `publishConfig` overrides, and that package would point at `src/` files it does not contain.
- `pnpm check:pack` packs all four packages, checks every tarball holds only its `files`, installs them into a fresh project outside the workspace, typechecks it and builds it with Vite. CI runs it on every push.

## One-time setup (the user)

npm attaches a trusted publisher only to a package that already exists, so the first version of each package is published by hand.

1. Log in: `npm login`, as an owner of the `thunderclap` org.
2. From a clean, up-to-date `main`, build, check and pack:

   ```sh
   git switch main && git pull && git status    # clean
   pnpm install --frozen-lockfile
   pnpm build && pnpm check:pack
   mkdir -p /tmp/tc-release
   pnpm pack --pack-destination /tmp/tc-release
   (cd packages/host-capacitor && pnpm pack --pack-destination /tmp/tc-release)
   (cd packages/host-electron && pnpm pack --pack-destination /tmp/tc-release)
   (cd packages/host-pwa && pnpm pack --pack-destination /tmp/tc-release)
   ```

3. Publish each tarball. `--provenance=false` is needed only here: provenance needs a CI identity, and the manifests ask for it.

   ```sh
   for t in /tmp/tc-release/*.tgz; do npm publish "$t" --access public --provenance=false; done
   ```

   Run it with `--dry-run` first to see each tarball's file list.
4. On npmjs.com, for each of the four packages: *Settings*, then *Trusted publishing*, then add a GitHub Actions publisher with:
   - organization or user: `Mandalorian007`
   - repository: `thunderclap-engine`
   - workflow filename: `publish.yml`
   - environment: leave empty
5. On the same page, under *Publishing access*, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working, and nothing else can publish.

## Routine release

```sh
pnpm release 1.1.0 --tag            # checks, bumps package.json, dates the CHANGELOG, commits, tags v1.1.0
git push origin main v1.1.0         # the command release prints
```

Pushing the tag runs `publish.yml`. It:

1. fails unless the tag is `v` plus the root `package.json` version;
2. runs `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build` and `pnpm check:pack`;
3. packs each of the four packages and publishes it with provenance, skipping any whose exact version is already on npm.

So a release that changes only the engine publishes only the engine. Watch the run under *Actions*; the packages appear on npm a minute later.

## Bumping a host package

Hosts version on their own `0.x` line, independent of the engine.

1. In the same branch as the host change, set `version` in `packages/host-<name>/package.json` (for example `0.1.0` to `0.2.0`), and describe the change in the root `CHANGELOG.md` under `## Unreleased`.
2. If the host needs a newer engine, raise its `peerDependencies["@thunderclap/engine"]` range too.
3. Cut a normal release (`pnpm release <next engine version> --tag`) and push the tag. The workflow publishes the host at its new version and skips every package whose version did not change. The tag always follows the engine's version, so a host-only change still needs an engine patch release.
