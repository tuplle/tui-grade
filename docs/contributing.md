# Contributing

Contributions are welcome: bug reports, tests, documentation, example assignments, plugins and engine improvements.

The full guide is in the repository:
[CONTRIBUTING.md](https://github.com/tuplle/tui-grade/blob/main/CONTRIBUTING.md).

## Quick setup

```bash
git clone https://github.com/tuplle/tui-grade.git
cd tui-grade
pnpm install
pnpm check
```

Requirements are Linux, macOS or Windows x64, Node.js 26 and pnpm 12. `gcc`, `g++` and `cmake` are needed for the
full end-to-end suite; on Windows install MinGW/MSYS2 or use a `cmake`/`custom` builder.

## Before a pull request

- Add or update tests for behavior changes.
- Run `pnpm check`.
- Run `pnpm build` when the change touches the build, the package or the browser dashboard.
- Update the relevant documentation page and `docs/_sidebar.md`.
- Do not commit `dist/`, `bundle/`, tarballs, `grading-results/` or local planning files.

## Code style

- ESM and explicit `.ts` imports in source.
- Erasable TypeScript only: no enums, namespaces, parameter properties or decorators.
- Strict TypeScript; internal helpers stay out of `src/index.ts`.
- Result files are atomic; paths inside work directories go through `ctx.resolvePath`/`safeJoin`.
- Student-visible output must not contain hidden-check details, logs, screens or grader paths.

## Security

Do not report a vulnerability in a public issue. Use the private process in
[SECURITY.md](https://github.com/tuplle/tui-grade/blob/main/SECURITY.md).

Student code is untrusted and unsandboxed in v1. See [Security and limits](security-and-limits.md).

## License

Contributions are accepted under the Apache License 2.0.
