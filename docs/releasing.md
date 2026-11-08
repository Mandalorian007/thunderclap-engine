# Releasing

This repo publishes four packages to the public npm registry (E-037):

| Package | Version line | Folder |
| --- | --- | --- |
| `@thunderclap-engine/engine` | `1.x` | the repo root |
| `@thunderclap-engine/host-electron` | `0.x` | `packages/host-electron` |
| `@thunderclap-engine/host-capacitor` | `0.x` | `packages/host-capacitor` |
| `@thunderclap-engine/host-pwa` | `0.x` | `packages/host-pwa` |

Every release after the first is published by `.github/workflows/publish.yml` when a `v*` tag is pushed. It uses npm trusted publishing: npm trusts that workflow file through GitHub's OIDC token, so no npm token is stored anywhere, and every version carries a provenance statement.

## How a package is built and packed

- `pnpm build` compiles each package with `tsc` to `dist/` (ESM JavaScript and `.d.ts`). host-electron also builds its shell into `out/`.
- In the workspace, every `exports` entry points at `./src/*.ts`, so the harness, templates and tests use the source. `publishConfig` holds the published `exports` (pointing at `dist/`). `pnpm pack` swaps them in and turns `workspace:` ranges into versions.
- So publish a **tarball made by `pnpm pack`**. Never run `npm publish` in a package folder: npm ignores pnpm's `publishConfig` overrides, and that package would point at `src/` files it does not contain.
- The manifests enforce that. Each package's `prepublishOnly` script (`scripts/refuse-publish.mjs`) fails with a pointer to this page. npm runs `prepublishOnly` when it publishes a folder but never when it publishes a tarball, so `npm publish <file>.tgz` is unaffected. `pnpm publish` in a folder is refused too. `--ignore-scripts` skips the guard, so don't pass it.
- `pnpm check:pack` packs all four packages, checks every tarball holds only its `files`, proves the guard (`npm publish --dry-run` is refused in each folder and accepted for each tarball, against a dead local registry), checks `CHANGELOG.md` has a section for the root version, installs the tarballs into a fresh project outside the workspace, typechecks it and builds it with Vite, then runs host-electron's installed `thunderclap-desktop` bin (`--help`, and `package --dry-run`, which stages that Vite build with the shell). Last it typechecks the consumer again with `@types/webxr` installed (`skipLibCheck` off, Bundler and NodeNext), passing `@types/webxr`'s `XRSession`, `XRFrame` and `XRReferenceSpace` to the engine's XR entry points: the engine declares no WebXR globals (E-039). `@types/webxr` comes from a pinned tarball, `scripts/fixtures/types-webxr-0.5.24.tgz`, so the whole check runs offline. CI runs it on every push.
- `node scripts/pack-smoke.mjs --from-npm [--wait <seconds>]` runs the same consumer check against the registry: it installs each package at its `package.json` version from npm, after polling until every version is listed when `--wait` is given.

## One-time setup (the user)

npm attaches a trusted publisher only to a package that already exists, so the first version of each package is published by hand.

1. Log in: `npm login`, as an owner of the `thunderclap-engine` org.
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

Run it on `main`, or on a detached HEAD at `main`'s commit, which is how an integrator's worktree cuts a release without checking out `main` (`git switch --detach main`; E-039). From a detached HEAD the release commit does not move the local `main`, so the printed command is `git push origin HEAD:main v1.1.0`. Any other branch, or a detached HEAD off `main`, is refused. The release commit ends with the project's attribution line.

Pushing the tag runs `publish.yml`. It:

1. fails unless the tag is `v` plus the root `package.json` version;
2. takes that version's `CHANGELOG.md` section as the release notes (`scripts/publish-notes.mjs`, with repo-relative links made absolute at the tag), failing before anything is published if the section is missing or empty;
3. runs `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build` and `pnpm check:pack`;
4. packs each of the four packages and publishes it with provenance, skipping any whose exact version is already on npm;
5. installs from npm: polls the registry every 10 seconds, for up to 10 minutes, until all four `package.json` versions are listed, then installs them into a fresh project, typechecks it, builds it with Vite and loads every entry (`pack-smoke.mjs --from-npm --wait 600`). A broken publish fails the run here, not for a user;
6. creates the GitHub Release for the tag, titled with the tag, with the notes from step 2 (a tag with a `-` suffix is marked a pre-release). If the release already exists, as on a re-run, it is updated instead. This step needs the workflow's `contents: write` permission.

So a release that changes only the engine publishes only the engine. Watch the run under *Actions*; the packages appear on npm a minute later, and the release under *Releases*.

If a run fails after step 4, re-run the failed job: the publish loop skips versions already on npm, and the install check and release steps run again.

## Bumping a host package

Hosts version on their own `0.x` line, independent of the engine.

1. In the same branch as the host change, set `version` in `packages/host-<name>/package.json` (for example `0.1.0` to `0.2.0`), and describe the change in the root `CHANGELOG.md` under `## Unreleased`.
2. If the host needs a newer engine, raise its `peerDependencies["@thunderclap-engine/engine"]` range too.
3. Cut a normal release (`pnpm release <next engine version> --tag`) and push the tag. The workflow publishes the host at its new version and skips every package whose version did not change. The tag always follows the engine's version, so a host-only change still needs an engine patch release.
