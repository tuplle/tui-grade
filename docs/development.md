# Development

## Requirements

- Linux, macOS (arm64/x64) or Windows x64.
- Node.js 26 or newer.
- pnpm 12 (`packageManager` in `package.json`).
- `gcc`, `g++` and `cmake` for the full end-to-end suite. On Windows install MinGW/MSYS2 or use `cmake`/`custom` with a
  compiler you have.

## Install

```bash
pnpm install
```

pnpm 12 requires decisions for dependency install scripts. The repository’s `pnpm-workspace.yaml` approves
`@parcel/watcher`, `esbuild` and `koffi`.

## Checks

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # Jest
pnpm check       # typecheck + tests
pnpm verify      # check + build
```

Run one test file:

```bash
pnpm test -- tests/core/lifecycle.test.ts
```

Filter by test name:

```bash
pnpm test -- -t "rescore"
```

Convenience suites:

```bash
pnpm test:unit        # core, plugins, CLI, web, docs and project-file tests
pnpm test:e2e         # real compiler + PTY tests
pnpm test:packaging   # build, pack and install the package
pnpm test:windows     # platform-independent Windows smoke tests
pnpm test:watch       # Jest watch mode
```

The full suite is fast for unit tests but includes packaging tests that run `pnpm build`, `pnpm pack` and sometimes need
network. The end-to-end tests compile C/C++ and drive a PTY; they skip automatically when the compiler is missing.

The unit and CLI suites still assume a POSIX shell in several helpers. On Windows, use `pnpm test:windows` (the CI
`windows-smoke` job) together with typecheck, build and CLI smoke tests; the full suite runs on Linux and macOS.

## Run locally

```bash
pnpm start   # full build, then the localhost dashboard
pnpm dev     # build web assets, then the dashboard from src/
pnpm cli check examples/mission
```

`pnpm start` opens the browser when stdout is a TTY. `pnpm dev` is faster and runs the server directly from TypeScript;
it does not rebuild the browser bundle while it runs, so rerun it after changing `src/web/public/`.

## Build

```bash
pnpm build       # TypeScript + locales + browser bundle + Tailwind
pnpm build:web   # only the browser bundle and CSS
```

`pnpm build`:

- compiles `src/` to `dist/` with `tsc`,
- copies `src/locales/*.json` to `dist/locales/`,
- makes `dist/cli/main.js` executable,
- bundles `src/web/public/app.js` and Alpine with esbuild,
- compiles `src/web/public/app.css` with Tailwind,
- copies `index.html`, `theme.js` and the favicon.

`dist/` is gitignored and is not committed.

## Standalone bundle

```bash
pnpm build
pnpm bundle
```

This creates:

- `bundle/` — `dist`, production `node_modules`, package files and a launcher;
- `tui-grade-<version>-<platform>-<arch>.tar.gz` — the downloadable standalone bundle (`tui-grade.cmd` on Windows).

The bundle is platform-specific because `@microsoft/tui-test` has a native package.

## npm tarball and publishing

```bash
pnpm pack
pnpm publish --dry-run --no-git-checks
```

Use `pnpm publish`, not `npm publish`: the package declares `devEngines.packageManager: pnpm`, and npm commands stop
with `EBADDEVENGINES` inside this repository.

The release workflow publishes on a `v*` tag and attaches both the npm tarball and the standalone bundle. See
[Publishing](publishing.md).

## Code conventions

- ESM with explicit `.ts` imports in source; the build rewrites them to `.js`.
- `erasableSyntaxOnly`: no enums, namespaces, parameter properties or decorators.
- Strict TypeScript: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals` and
  `noUnusedParameters`.
- Tests run TypeScript through Node’s type stripping (`scripts/jest-transform.mjs`), not through a bundler.
- Keep `src/index.ts` as the public API boundary; internal helpers stay internal.
- Write result files atomically (`writeFileAtomic`).
- Use `ctx.resolvePath`/`safeJoin` for anything inside a work directory.

## Documentation site

The docs use Docsify v5 and live in `docs/`:

```bash
npx serve docs
# open the printed local URL
```

Docsify loads Markdown over HTTP, so do not open `docs/index.html` as a `file://` URL. The site needs no build step.
`docs/.nojekyll` keeps GitHub Pages from processing files that start with `_`.

The Pages workflow copies `docs/` to a temporary `_site/` directory and deploys it. The site contains only public
documentation. Internal Superpowers design and plan notes stay in a local, gitignored `.superpowers/` directory and are
not part of the public repository. In the repository settings, set **Pages → Build and deployment → Source** to
**GitHub Actions**. The published site is <https://tuplle.github.io/tui-grade/>.

## Tests by area

| Area | What it covers |
| --- | --- |
| `tests/core/` | assignment loading, validation, intake, execution, lifecycle, sessions, process control, ZIPs, rescore, events |
| `tests/plugins/` | built-in steps, checks, builders, reporters and scoring |
| `tests/cli/` | command output, exit codes, signals and `serve` |
| `tests/web/` | Express API, security, run manager, history, assets |
| `tests/e2e/` | real C/C++ compilation and PTY scenarios |
| `tests/packaging.test.ts` | built package, tarball, `npx`, workflows |

## Next

- [Architecture](architecture.md)
- [Contributing](contributing.md)
- [Troubleshooting](troubleshooting.md)
- [Publishing](publishing.md)
