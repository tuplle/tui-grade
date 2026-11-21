# Publishing

`tui-grade` produces two different release artifacts. They are not interchangeable.

| Artifact | Built by | Contains | Used for |
| --- | --- | --- | --- |
| `tui-grade-<version>.tgz` | `pnpm pack` | `dist/`, `package.json`, README, LICENSE, declared dependencies | npm registry, `npm`/`pnpm` install, `npx tui-grade` |
| `tui-grade-<version>-<platform>-<arch>.tar.gz` | `node scripts/make-bundle.mjs` | `dist/`, production `node_modules`, platform launcher, package metadata | download and run without npm install |

`dist/` and `bundle/` are build intermediates and are not published on their own.

## Before the first publish

1. Make sure the npm account owns the unscoped name `tui-grade` (or change `package.json#name` and README references).
2. Create an npm automation token with publish rights, or configure npm trusted publishing for
   `tuplle/tui-grade` and `.github/workflows/release.yml`.
3. Add the token as the `NPM_TOKEN` repository secret when using a token. Trusted publishing does not need it.
4. Bump `package.json#version` and create the matching tag (`v1.2.0` for `1.2.0`).

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
TARBALL=$(ls tui-grade-*.tgz | head -1)
npx --yes --package "$PWD/$TARBALL" tui-grade --version
npx --yes --package "$PWD/$TARBALL" tui-grade --help
```

## Release workflow

`.github/workflows/release.yml` runs on `v*` tags:

1. checks that the tag matches `package.json#version`;
2. installs with the frozen lockfile, typechecks, tests and builds;
3. packs the npm tarball;
4. smoke-tests the tarball through `npx`;
5. builds standalone bundles on Linux, macOS and Windows, with their smoke tests;
6. publishes to npm with `pnpm publish --access public --provenance`;
7. creates the GitHub release with the `.tgz` and every platform's `.tar.gz`.

The workflow needs either:

- `NPM_TOKEN` with publish rights (the current step reads it from `secrets.NPM_TOKEN`), or
- npm trusted publishing configured for this repository, in which case the token environment can be removed and
  `id-token: write` is already granted.

Provenance requires `id-token: write`, which the workflow grants.

## What users run

- **npm / npx:** `npx tui-grade` or `pnpm add tui-grade`. Requires the published npm package and network access on the
  first install.
- **Standalone:** download the tarball for the platform, extract it, run `tui-grade` on POSIX or `tui-grade.cmd` on
  Windows. Requires Node 26 only.
- **Source checkout:** `pnpm install && pnpm build`, then `node dist/cli/main.js` (or `node src/cli/main.ts` for the CLI
  from source; the web UI needs `pnpm build:web` or `pnpm build`). The npm package supports Linux, macOS and Windows x64.
