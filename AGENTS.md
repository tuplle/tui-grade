# AGENTS.md

## What this repo is

- `tui-grade`: Node 26 CLI + library that grades student CLI/TUI programs by building them and running YAML
  scenarios. Supported: Linux, macOS (arm64/x64), Windows x64. Process trees use `/proc` (Linux), `ps` (macOS) or
  `taskkill /T` (Windows). Sessions use `@microsoft/tui-test`; Windows ARM64 is not supported by its native package.
- Entrypoints: CLI `src/cli/main.ts`; programmatic `createGrader` in `src/grader.ts`; public API in `src/index.ts`.
  Anything not exported there is internal.
- Engine in `src/core/` (`app.ts` plugin kernel, `contracts.ts` types, `lifecycle.ts` run pipeline, `execute.ts`
  steps/checks, `session.ts` PTY, `process.ts`/`workspace.ts` isolation). Built-ins in `src/plugins/<kind>-<name>/`.
- Web dashboard: `src/web/` (Express server, API, run manager, security) and `src/web/public/` (Alpine + Tailwind UI).
  `tui-grade` with no command runs `serve`; grading runs are child `tui-grade run --events` processes. Default port is
  `3333`; default run data is the platform data directory (`~/.local/share/tui-grade`, `~/Library/Application Support/tui-grade`
  or `%LOCALAPPDATA%\tui-grade`, see `src/core/data-dir.ts`).

## Commands

```bash
pnpm install
pnpm start                                    # build + localhost dashboard
pnpm dev                                      # web assets + dashboard from source
pnpm cli check examples/mission               # CLI from source
pnpm typecheck
pnpm test -- tests/plugins/scoring.test.ts    # one file; keeps the NODE_OPTIONS Jest needs
pnpm test -- -t "part of a test name"         # filter by test name
pnpm test:unit                                # non-e2e, non-packaging suites
pnpm test:e2e                                 # compiler + PTY suites
pnpm test:packaging                           # build, pack, install
pnpm test:windows                             # platform-independent Windows smoke tests
pnpm test:watch
pnpm check                                    # typecheck + all tests
pnpm verify                                   # check + build
pnpm build                                    # dist/, locales, esbuild browser bundle, Tailwind CSS
pnpm build:web                                # only the dashboard assets
pnpm build && pnpm bundle                     # bundle/ + platform tarball
pnpm pack                                     # npm tarball (dist + package metadata)
pnpm publish --dry-run --no-git-checks         # publish dry run; use pnpm, not npm
pnpm docs                                     # Docsify docs at http://localhost:3000
```

CI order is `install --frozen-lockfile` → `typecheck` → `test` → `build`. Do not reorder it.

## Toolchain quirks

- ESM (`"type": "module"`, `module: nodenext`). Import local files with explicit `.ts`; the build rewrites them to `.js`.
- `erasableSyntaxOnly` is on: no enums, namespaces, parameter properties, or decorators. Tests execute TypeScript via
  Node's `stripTypeScriptTypes` (`scripts/jest-transform.mjs`), so non-erasable syntax breaks tests even if it typechecks.
- Strictness includes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`.
- pnpm 12 requires the `allowBuilds` decisions in `pnpm-workspace.yaml` (`@parcel/watcher`, `esbuild`, `koffi`).
  Removing them makes install stop with `ERR_PNPM_IGNORED_BUILDS`.

## Architecture notes

- Run pipeline: load assignment + plugins → discover/unpack submissions → build → scenarios (steps, checks) → score →
  student reporters → run reporters. One student's failure is result data, never an exception of the batch.
- `App` contexts: `definePlugin` registers into a child context (private); `fp` registers into the parent (shared).
  Plugins listed in `assignment.yaml` are registered shared. The default preset is `fp`.
- `src/plugins/index.ts` maps built-in names; `src/plugins/preset.ts` sets the default order. A new built-in plugin
  needs both, plus `describe`/`schema` entries come from its definition. Reporter order matters: `json`, `markdown`,
  `zip`, `csv` (the zip packs what the first two wrote).
- Messages live in `src/locales/{en,sk}.json`; `pnpm build` copies them into `dist/`. Add keys to both locales.
  Built-in catalogs override plugin catalogs.
- Reporters receive unmasked results, including hidden checks, logs, screens and absolute paths. Anything written to
  students must use the exported `publicResult`. The built-in `json` reporter also writes teacher-only
  `results.full.json`; the ZIP reporter must keep excluding it.
- `run --events` emits versioned NDJSON (`src/core/events.ts`) for the dashboard. `RunOptions.onEvent` listener errors
  are ignored by design.
- `run.json` records the assignment directory for history/rescore. `rescoreRun` recomputes points from stored results
  without running hooks, builds, steps or custom reporters.

## Testing quirks

- Fast suites: `tests/core`, `tests/plugins`, `tests/cli`, `tests/web` (fake assignments, no compiler).
- Web tests start a real Express server on an ephemeral loopback port and use `fetch`; they can read/write result files
  and start child grading runs. Keep them hermetic with `withTempDir`/`mkdtemp`.
- `tests/e2e` compile real C/C++ and drive a PTY; they are skipped by `itIf(hasTool(...))` when `gcc`/`g++` is missing
  and use 180–240 s timeouts. Full coverage needs `gcc`, `g++` and `cmake`; on Windows install MinGW/MSYS2 or use a
  `cmake`/`custom` builder.
- `tests/packaging.test.ts` runs `pnpm build`, `pnpm pack` and a network install. It skips offline only outside CI and
  is slow; prefer targeted suites while iterating.
- The model example is `examples/mission`; its assignment `name` is `mission`.
- Scenario vocabulary: `node src/cli/main.ts describe --json` and `schema` are generated from registered definitions.
  Use them as the source of truth instead of prose docs.
- Dashboard build: `pnpm build:web` bundles `src/web/public/app.js` (including Alpine) with esbuild and compiles
  `src/web/public/app.css` with Tailwind. No CDN and no vendor Alpine file at runtime; CSP forbids inline scripts.

## Invariants

- Assignment directories, plugins and `script` modules are trusted and run in-process; submissions are untrusted.
  Never bypass `ctx.resolvePath`/`safeJoin`, copy symlinks into workdirs, or widen `minimalEnv`, timeouts, output caps
  or process-group/tree kills.
- Grading must not abort because of one student; only an invalid assignment or a failing `onRunStart` hook stops a run.
- Result files are written atomically (temp file + rename). Student-visible output must not include hidden-check
  details, logs/screens or grader paths. `results.full.json` is teacher-only and must stay out of student ZIPs.
- The dashboard has no authentication. It must bind only to `127.0.0.1` and keep the `Host`, `Origin`, `X-TUI-Grade`
  and no-CORS checks. Do not add a LAN/port-forward mode without a real security review.
- CLI exit codes: `0` success, `1` invalid assignment / tool / usage, `2` `--fail-under` not met, `130`/`143` signals.
- `dist/`, `bundle/`, `tui-grade-*.tar.gz` and `grading-results/` are generated/ignored; never edit them by hand.
  `bundle/` is platform-specific because `@microsoft/tui-test` has a native package.
- Publishing uses `pnpm publish` (npm commands hit `devEngines`). The npm tarball comes from `pnpm pack`; the
  standalone tarball comes from `scripts/make-bundle.mjs`. See `docs/publishing.md`.

## Docs

- `README.md` for users and CLI; `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and `CHANGELOG.md` for project
  process; `docs/authoring-scenarios.md`, `docs/writing-plugins.md`, `docs/web-ui.md`, `docs/publishing.md`,
  `docs/security-and-limits.md` for deep behavior. Keep them in sync when behavior changes.
- The public docs site is Docsify v5 in `docs/` (`index.html`, `_sidebar.md`, `_coverpage.md`, `.nojekyll`).
  `docs/_media/theme.css` overrides the theme variables: dark by default with the logo's green as `--theme-color`.
  `.github/workflows/pages.yml` deploys `docs/` to GitHub Pages.
- Internal Superpowers design/plan notes always live in `.superpowers/`, which is gitignored and never published.
- `graphify-out/` is a generated graph; do not edit or stage it.
