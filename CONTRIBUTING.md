# Contributing

Thanks for taking the time to improve `tui-grade`. This project grades untrusted student programs, so correctness,
clear failure messages and safe path/process handling matter more than clever shortcuts.

## Before you start

- Open an issue for a large change, a new plugin kind, a CLI/API break or a security-sensitive topic.
- Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Do not open a public issue for one.
- Small fixes, tests and documentation corrections can go straight to a pull request.

## Setup

Requirements:

- Linux
- Node.js 26 or newer
- pnpm 12
- `gcc`, `g++` and `cmake` for the full end-to-end suite

```bash
pnpm install
pnpm check
```

pnpm 12 asks for install-script decisions. The repository’s `pnpm-workspace.yaml` approves `@parcel/watcher`, `esbuild`
and `koffi`.

## Useful commands

```bash
pnpm start          # build and start the localhost dashboard
pnpm dev            # dashboard from source, with built web assets
pnpm cli check examples/mission
pnpm typecheck
pnpm test
pnpm test:unit
pnpm test:e2e
pnpm test:packaging
pnpm test:windows
pnpm test:watch
pnpm test -- tests/core/lifecycle.test.ts
pnpm test -- -t "rescore"
pnpm verify
pnpm build
pnpm build:web
pnpm bundle
pnpm pack
pnpm publish --dry-run --no-git-checks
pnpm docs
```

CI runs install, typecheck, tests and build in that order. Do not reorder those steps.

## Code conventions

- ESM with explicit `.ts` imports in source. The build rewrites them to `.js`.
- `erasableSyntaxOnly`: no enums, namespaces, parameter properties or decorators.
- Strict TypeScript, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals` and
  `noUnusedParameters`.
- Keep `src/index.ts` as the public API boundary. Internal helpers stay internal.
- Register a new built-in plugin in its own `src/plugins/<kind>-<name>/index.ts`, then in `src/plugins/index.ts` and
  `src/plugins/preset.ts`.
- Add localized messages to both `src/locales/en.json` and `src/locales/sk.json`.
- Write result files atomically with `writeFileAtomic`.
- Use `ctx.resolvePath`/`safeJoin` for anything inside a scenario work directory.
- Student-visible output must not contain hidden-check details, logs/screens, or grader paths.

## Tests

- `tests/core` covers the engine: assignment loading, validation, intake, execution, lifecycle, sessions, process control,
  ZIPs, rescore and events.
- `tests/plugins` covers the built-in steps, checks, builders, reporters and scoring.
- `tests/cli` covers command output, exit codes, signals and `serve`.
- `tests/web` covers the Express API, security, run manager, history and assets.
- `tests/e2e` compiles real C/C++ and drives a PTY; it is skipped when `gcc`/`g++` is missing.
- `tests/packaging.test.ts` builds, packs and installs the package; it may need network.

Prefer a focused test file while iterating, then run `pnpm check` before opening a pull request.

## Documentation

The public documentation is a Docsify v5 site in `docs/`.

```bash
npx serve docs
```

Docsify loads Markdown over HTTP, so do not open `docs/index.html` as a `file://` URL. Add a page to `docs/_sidebar.md`
when you add user-facing documentation. Update `README.md`, `docs/`, and `AGENTS.md` when behavior changes.

## Pull requests

- Keep the change focused and include tests for behavior changes.
- Describe the problem, the approach, and how you verified it.
- Mention any migration or breaking change explicitly.
- Do not bump the package version in a normal pull request; releases are cut from tags by maintainers.
- Do not commit generated `dist/`, `bundle/`, tarballs, `grading-results/`, `.superpowers/` or editor files.

## Releases

Maintainers publish from a `v*` tag using `pnpm publish` and the standalone bundle. See
[docs/publishing.md](docs/publishing.md). npm commands stop with `EBADDEVENGINES` inside this repository because the
project uses pnpm.

## License

By contributing, you agree that your contribution is licensed under the Apache License 2.0. See
[LICENSE.txt](LICENSE.txt).
