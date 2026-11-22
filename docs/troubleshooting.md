# Troubleshooting

## `tui-grade` opens a web page instead of printing help

Running `tui-grade` with no command starts the dashboard. This is intentional. Use:

```bash
tui-grade --help
```

for the command list, or `tui-grade serve --help` for dashboard options.

## `npx tui-grade` says the package was not found

The npm package must be published first. Check:

```bash
npm view tui-grade version
```

Until a release is on the npm registry, use:

- `node dist/cli/main.js` from a source checkout after `pnpm build`, or
- the standalone release tarball from GitHub.

See [Publishing](publishing.md).

## `ERR_PNPM_IGNORED_BUILDS`

pnpm 12 refuses to run dependency install scripts without a decision. Add `allowBuilds` to `pnpm-workspace.yaml`.

For a consumer project the runtime one is `koffi`:

```yaml
allowBuilds:
  koffi: false # or true
```

In this repository, `@parcel/watcher`, `esbuild` and `koffi` are approved.

## `node: command not found` or an unsupported Node version

Install Node.js 26 or newer. The package uses `import.meta`, type stripping in tests and modern Node APIs.

## `gcc` or `g++` is missing

The example assignments and the end-to-end tests compile C/C++. Install `gcc` and `g++` (and `cmake` for the CMake
builder). Tests that need them are skipped automatically when they are absent. On Windows, install MinGW/MSYS2 or use a
`cmake`/`custom` builder with MSVC, clang or another compiler you have.

## Terminal sessions do not work

Sessions run programs in a pseudo-terminal through `@microsoft/tui-test`, which has native packages for Linux, macOS
arm64/x64 and Windows x64. It is not available for Windows ARM64. The standalone release bundle is built for the
platform it was made on, so use the matching artifact.

## `tui-grade check` reports a `mission` path error

The example directory is `examples/mission`; its assignment name is `mission`. Use:

```bash
tui-grade check examples/mission
```

## The dashboard page is unstyled or Alpine is missing

The source checkout serves the generated browser assets. Build them first:

```bash
pnpm build
# or
pnpm build:web
```

Then run `node src/cli/main.ts serve`. The built site is in `dist/web/public/`.

## The dashboard port is busy

The default port is `3333`. If it is busy, choose another port:

```bash
tui-grade serve --port 4317
```

Use `--port 0` to let the OS pick a free port.

## The browser did not open

Use `--no-open` and open the printed URL manually:

```bash
tui-grade serve --no-open
```

The server binds only to `127.0.0.1`. Do not port-forward or reverse-proxy it.

## A run is missing from history

History is read from the dashboard’s `--results-root` (default `$XDG_DATA_HOME/tui-grade` or
`~/.local/share/tui-grade` on Linux, `~/Library/Application Support/tui-grade` on macOS, `%LOCALAPPDATA%\tui-grade` on
Windows). A run started with `--out` elsewhere is not in that root. Open it from the run directory or use the CLI.

## Manual points do not change the score

Check that the group has `manual: true` in `assignment.yaml`, and that the student id in the points file matches the
result id. Use `tui-grade rescore` or the dashboard’s **Save and re-score**. Re-scoring reads `results.json` /
`results.full.json`; it does not rebuild or rerun the student.

## A submission hangs

Each run and session has a wall-clock timeout (`limits.run_timeout_sec`, default 10 seconds) and a build timeout
(`limits.build_timeout_sec`, default 120 seconds). On expiry the process group is killed. Use `--keep-workdirs` to
inspect temporary files.

## Results are missing after Ctrl-C

A signal stops the run at the next boundary. Files already written are complete and atomic, but the set of files for
the interrupted student may be partial and no `summary.csv` is written. This is expected. A second Ctrl-C forces exit
and may leave temporary directories.

## `results.full.json` appeared in a student ZIP

The built-in ZIP reporter excludes it. If a custom reporter or manual packaging includes it, fix that reporter. The file
contains hidden-check details and must stay teacher-only.

## Publishing fails with `EBADDEVENGINES`

Use `pnpm publish`, not `npm publish`. The package declares `devEngines.packageManager: pnpm`; npm commands stop inside
this repository.

## Publishing fails with an authentication error

Set `NPM_TOKEN` for the release workflow or configure npm trusted publishing. The workflow grants `id-token: write` for
provenance. See [Publishing](publishing.md).

## Still stuck?

Run the failing command with `--json` where available, and include:

- `tui-grade --version`
- Node and pnpm versions
- the command line
- the assignment’s `check --json` output
- relevant stderr; result files are under the run’s `--out` directory
