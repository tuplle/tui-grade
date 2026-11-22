# tui-grade

`tui-grade` grades student programs written for the terminal: command-line tools, text menus and interactive TUIs. A
teacher describes an assignment once, and `tui-grade` builds each submission, runs declarative YAML scenarios, scores the
result and writes machine-readable and human-readable reports.

The same engine is available through:

- the `tui-grade` command-line tool,
- the programmatic `createGrader` API,
- a localhost web dashboard for teachers.

## Why tui-grade

- **Scenarios are data, not code.** Checks such as “stdout contains `Help` or `Pomoc`” or “the exit code is non-zero”
  are a few lines of YAML. Localized alternatives, negations, hidden checks and weights are built in.
- **Plain runs and terminal sessions.** A run covers arguments, stdin, stdout/stderr and the exit code. A session uses a
  real pseudo-terminal and can type, press keys and wait for text on screen.
- **Fair scoring.** Group points are split by scenario weight and earned by the share of passed check weights. Manual
  groups such as code quality are merged in when supplied.
- **Everything is a plugin.** Steps, checks, builders, scorers and reporters are registered through one kernel. The
  built-in features are ordinary plugins. An assignment can add its own with a few lines of JavaScript.
- **Batch-safe.** A broken, slow or hostile submission should not fail the whole run. Build failures, crashes, missing
  project roots and broken ZIPs become results and warnings.
- **Teacher dashboard.** A localhost-only web UI can run batches, show live progress, inspect results and enter manual
  points.

## Requirements

- Linux, macOS (arm64/x64) or Windows **x64**. Node.js **26** or newer. Windows ARM64 is not supported by the native
  terminal package.
- For the example assignments: `gcc` and `g++`. The end-to-end tests also use `cmake`. On Windows use MinGW/MSYS2 or a
  `custom`/`cmake` builder with an available compiler.

## Quick start from a source checkout

```bash
pnpm install
pnpm build
node dist/cli/main.js check examples/mission
node dist/cli/main.js run examples/mission examples/mission/solution --out /tmp/mission-results
cat /tmp/mission-results/summary.csv
```

`node src/cli/main.ts` also runs the CLI directly through Node 26 type stripping. The web dashboard needs the built
browser assets, so run `pnpm build` or `pnpm build:web` first.

## Quick start from a release

Once a release is published to npm:

```bash
npx tui-grade
```

This starts the localhost dashboard. The CLI is still available:

```bash
npx tui-grade check examples/mission
npx tui-grade run examples/mission examples/mission/solution --out /tmp/results
```

Or download the standalone tarball for your platform from a GitHub release and run its launcher (`tui-grade` on POSIX,
`tui-grade.cmd` on Windows). The standalone bundle contains `dist/` and production dependencies; only Node.js 26 is
required.

## Documentation map

- [Install](install.md) — npm, standalone bundle and source checkout.
- [Quick start](quickstart.md) — a five-minute walkthrough.
- [CLI reference](cli.md) — commands, options, exit codes and events.
- [Outputs](outputs.md) — `results.json`, reports, logs, screens and teacher-only files.
- [Assignments and scenarios](authoring-scenarios.md) — the YAML language.
- [Plugins](writing-plugins.md) — the plugin API, hooks and script modules.
- [Examples](examples.md) — the three example assignments.
- [Web UI](web-ui.md) — the localhost teacher dashboard.
- [Security and limits](security-and-limits.md) — what the tool does and does not contain.
- [CI grading](ci.md) — a sample GitHub Actions workflow.
- [Publishing](publishing.md) — npm and standalone release artifacts.
- [Architecture](architecture.md) — how the engine, plugins and dashboard fit together.
- [Development](development.md) — build, test and documentation workflow.
- [Contributing](contributing.md) — setup, tests, style and pull requests.
- [Troubleshooting](troubleshooting.md) — common setup and runtime problems.

## Security warning

Student code is **untrusted, and v1 has no sandbox and no container**. Programs run as the user who started
`tui-grade`, with timeouts, output caps, a minimal environment and process-group cleanup. That contains ordinary
mistakes, not a deliberately hostile program. Grade real submissions inside a disposable container or VM that holds no
secrets. The web dashboard does not change this model.

See [Security and limits](security-and-limits.md) for the full list.

## License

Apache-2.0. See [License](license.md) and the repository’s `LICENSE.txt`.
