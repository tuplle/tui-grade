# CLI reference

```text
tui-grade                                  # start the localhost web dashboard
tui-grade serve [--port N] [--results-root dir]
                [--assignment dir] [--submissions path] [--no-open]
tui-grade run <assignment-dir> <path> [--out dir] [--only id,id] [--locale sk|en]
              [--manual file] [--keep-workdirs] [--fail-under N] [--events]
tui-grade rescore <assignment-dir> <out-dir> [--manual file] [--locale sk|en]
tui-grade check <assignment-dir> [--json] [--list]
tui-grade describe [assignment-dir] [--json]
tui-grade schema [assignment-dir]
tui-grade --version
```

## Commands

| Command | What it does |
| --- | --- |
| *(none)* | Starts the localhost dashboard and opens the browser. |
| `serve` | Starts the localhost dashboard explicitly. |
| `run` | Grades every submission found at `<path>`: a folder of submissions, one project folder, or a `.zip`. |
| `rescore` | Recomputes points and regenerates reports from an existing run. No build and no student program is started. |
| `check` | Validates the assignment. Starts no build and no student program. |
| `describe` | Lists steps, checks, builders, reporters and scorers with parameters and examples. |
| `schema` | Prints a JSON Schema of a scenario file and `assignment.yaml`. |

## `run`

```bash
tui-grade run <assignment-dir> <path> --out <dir>
```

`<path>` can be:

- a directory whose children are submissions (one folder or `.zip` per student),
- a single project folder,
- a single `.zip`.

A submission is located by `project_root_marker` inside the unpacked folder.

| Option | Meaning |
| --- | --- |
| `--out dir` | Output directory. Default: `<platform data dir>/tui-grade/<ISO timestamp>` (Linux `~/.local/share/tui-grade`, macOS `~/Library/Application Support/tui-grade`, Windows `%LOCALAPPDATA%\tui-grade`). |
| `--only id,id` | Run only the listed scenario ids after matrix expansion. Points are split among the selected scenarios only. |
| `--locale sk\|en` | Report language, overriding `assignment.yaml`. |
| `--manual file` | YAML/JSON file `{ studentId: { groupId: points } }` for manual groups. |
| `--keep-workdirs` | Keep temporary build/work directories for debugging. |
| `--fail-under N` | Exit with code 2 when any student has fewer than `N` points. `N` is a non-negative decimal number. |
| `--events` | Write versioned progress events as NDJSON on stdout and suppress the human points table. |

The command prints a points table and writes the output tree described in [Outputs](outputs.md).

A student’s failure (does not compile, crashes, hangs) is not an error of the run. Only an invalid assignment, a tool
error or a failing `onRunStart` hook stops it.

## `rescore`

```bash
tui-grade rescore <assignment-dir> <out-dir> [--manual file] [--locale sk|en]
```

Recomputes scores from the stored results, then rewrites:

- `results.json` and `results.full.json`,
- `report.md`,
- `summary.csv`,
- each student’s ZIP.

It does not run hooks, builds, steps, checks or custom reporters. If `--manual` is omitted, it uses `<out-dir>/manual.yaml`
when present.

This is the CLI counterpart of the dashboard’s **Save and re-score**.

## `check`

```bash
tui-grade check <assignment-dir> [--json] [--list]
```

Validates the assignment statically and can list expanded scenario ids:

```bash
tui-grade check examples/mission --list
```

`--json` prints:

```json
{
  "ok": true,
  "issues": [],
  "scenarios": []
}
```

## `describe` and `schema`

`describe` is generated from the registered definitions, so it is always current:

```bash
tui-grade describe
tui-grade describe examples/mission
tui-grade describe examples/mission --json
```

`schema` prints a JSON Schema for editors and AI agents:

```bash
tui-grade schema examples/mission
```

## `serve`

```bash
tui-grade serve [--port N] [--results-root dir]
                [--assignment dir] [--submissions path] [--no-open]
```

| Option | Meaning |
| --- | --- |
| `--port N` | Listen port. Default `3333`. Use `0` for an OS-assigned port. |
| `--results-root dir` | Where runs are stored. Default `<platform data dir>/tui-grade` (Linux `~/.local/share/tui-grade`, macOS `~/Library/Application Support/tui-grade`, Windows `%LOCALAPPDATA%\tui-grade`). |
| `--assignment dir` | Prefill the assignment path in the dashboard. |
| `--submissions path` | Prefill the submissions path. |
| `--no-open` | Print the URL without opening a browser. |

The server binds only to `127.0.0.1`. There is no authentication. See [Web UI](web-ui.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Invalid assignment, tool error or bad command line. |
| `2` | `--fail-under` was not met. |
| `130` | Stopped by `SIGINT` (Ctrl-C). |
| `143` | Stopped by `SIGTERM`. |

The dashboard’s **Quit** action and its signal handlers stop the active child grading process and clean up temporary
directories before exiting.

## Machine-readable events

`run --events` emits one JSON object per line on stdout, with `schemaVersion: 1`. Event types include:

- `run-start`
- `submissions`
- `submission-start`
- `build`
- `scenario-start`
- `scenario-end`
- `submission-score`
- `submission-end`
- `run-end`

Human progress stays on stderr. The web dashboard uses this stream for live progress. Event listener failures are
ignored: progress reporting never changes grading.
