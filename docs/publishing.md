# Publishing

`tui-grade` produces two different release artifacts. They are not interchangeable.

| Artifact | Built by | Contains | Used for |
| --- | --- | --- | --- |
| `tui-grade-<version>.tgz` | `pnpm pack` | `dist/`, `package.json`, README, LICENSE, declared dependencies | npm registry, `npm`/`pnpm` install, `npx tui-grade` |
| `tui-grade-<version>-<platform>-<arch>.tar.gz` | `node scripts/make-bundle.mjs` | `dist/`, production `node_modules`, platform launcher, package metadata | download and run without npm install |

`dist/` and `bundle/` are build intermediates and are not published on their own.

## Before the first publish

Releases are published with **npm trusted publishing** (OIDC). There is no `NPM_TOKEN` secret.

npm only lets you configure a trusted publisher for a package that already exists, so the very first version is
published once with a normal npm login. Every later release comes from the tag workflow.

1. Make sure the npm account owns the unscoped name `tui-grade` (or change `package.json#name` and README references).
2. Publish version `1.0.0` by hand (or publish a placeholder that is replaced by the real release):

   ```bash
   npm login --registry https://registry.npmjs.org
   pnpm publish --access public --no-git-checks
   npm logout --registry https://registry.npmjs.org
   ```

3. On npmjs.com open **Packages → tui-grade → Settings → Trusted publishing** and add GitHub Actions:
   - organization or user: `tuplle`
   - repository: `tui-grade`
   - workflow filename: `release.yml`
   - allowed actions: **Allow npm publish**

   The CLI equivalent needs npm 11.15 or newer, account-level 2FA and an existing package:

   ```bash
   npm trust github tui-grade --repo tuplle/tui-grade --file release.yml --allow-publish
   ```

4. Tag the release: `v1.0.0` for the hand-published version, or bump `package.json#version` and tag the new version
   (`v1.2.0` for `1.2.0`). The workflow publishes with the OIDC token of the run, skips npm when that version already
   exists, and creates the GitHub release either way.
5. After the first successful OIDC publish, restrict token publishing under **Settings → Publishing access**
   ("Require two-factor authentication and disallow tokens").

A new trusted publisher configuration must complete its first successful publish within two days, or it expires and
has to be created again. Trusted publishing requires a GitHub-hosted runner and a public repository; pnpm 11.0.7 or
newer publishes with OIDC natively (this repository pins pnpm 12).

Use `pnpm publish`, not `npm publish`: the package declares `devEngines.packageManager: pnpm` and npm commands stop
with `EBADDEVENGINES` inside this repository.

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm pack --dry-run
pnpm publish --dry-run --no-git-checks
```

`pnpm publish` runs `prepublishOnly` (`pnpm build`) and packs `dist/` with the compiled web assets. To test the exact
tarball:

```bash
TARBALL="$PWD/$(ls tui-grade-*.tgz | head -1)"
WORK="$(mktemp -d)"
cd "$WORK"
npx --yes --package "$TARBALL" tui-grade --version
npx --yes --package "$TARBALL" tui-grade --help
```

Run this from outside the repository. `package.json` declares pnpm in `devEngines`, and npm/npx refuses to run in a
project that requires another package manager.

## Release workflow

`.github/workflows/release.yml` runs on `v*` tags:

1. checks that the tag matches `package.json#version`;
2. installs with the frozen lockfile, typechecks, tests and builds;
3. packs the npm tarball;
4. smoke-tests the tarball through `npx`;
5. builds standalone bundles on Linux, macOS and Windows, with their smoke tests;
6. publishes to npm with `pnpm publish --access public --provenance` using npm trusted publishing
   (`id-token: write`); when that version is already on npm, the step is skipped so a hand-published first release
   does not fail the workflow;
7. creates the GitHub release with the `.tgz` and every platform's `.tar.gz`.

Publishing needs no repository secret. It requires:

- a trusted publisher on npmjs.com for `tuplle/tui-grade` and `.github/workflows/release.yml`, with `npm publish`
  allowed (see [Before the first publish](#before-the-first-publish));
- `id-token: write`, which the workflow grants, and a GitHub-hosted runner;
- a package that already exists on npm.

Provenance and the SLSA attestation are generated automatically by trusted publishing.

## What users run

- **npm / npx:** `npx tui-grade` or `pnpm add tui-grade`. Requires the published npm package and network access on the
  first install.
- **Standalone:** download the tarball for the platform, extract it, run `tui-grade` on POSIX or `tui-grade.cmd` on
  Windows. Requires Node 26 only.
- **Source checkout:** `pnpm install && pnpm build`, then `node dist/cli/main.js` (or `node src/cli/main.ts` for the CLI
  from source; the web UI needs `pnpm build:web` or `pnpm build`). The npm package supports Linux, macOS and Windows x64.
