# Quick start

This walkthrough uses `examples/mission`, the model assignment: a C17 mission simulator with 60 scenarios, six point
groups and a reference solution.

## 1. Build or install

From a source checkout:

```bash
pnpm install
pnpm build
alias tui-grade='node dist/cli/main.js'
```

From a published npm release, use `npx tui-grade` or `pnpm exec tui-grade` instead of the alias.

The examples need `gcc` and `g++`.

## 2. Validate the assignment

```bash
tui-grade check examples/mission
```

Expected output:

```text
valid: 60 scenarios
```

`check` validates YAML, schemas, unknown step/check names, `from` references, fixtures and group ids. It starts no
build and no student program.

Useful variants:

```bash
tui-grade check examples/mission --json
tui-grade check examples/mission --list
tui-grade describe examples/mission
tui-grade schema examples/mission
```

## 3. Grade the reference solution

```bash
tui-grade run examples/mission examples/mission/solution --out /tmp/mission-results
```

The solution earns **16 of 20** points. The remaining 4 points belong to the manually graded `quality` group.

Inspect the results:

```bash
cat /tmp/mission-results/summary.csv
cat /tmp/mission-results/solution/report.md
cat /tmp/mission-results/solution/results.json
```

The output also contains `run.json`, logs, final screens, teacher-only `results.full.json` and the student ZIP. See
[Outputs](outputs.md).

## 4. Add manual points

Create `manual.yaml`:

```yaml
solution:
  quality: 3.5
```

Re-run with the manual file:

```bash
tui-grade run examples/mission examples/mission/solution --out /tmp/mission-results --manual manual.yaml
```

Or re-score the existing run without rebuilding or rerunning student code:

```bash
tui-grade rescore examples/mission /tmp/mission-results --manual manual.yaml
```

## 5. Grade a class

Point `run` at a folder whose children are submissions, or at a directory containing `.zip` files:

```bash
tui-grade run examples/mission ~/submissions --out ~/.local/share/tui-grade
```

Each submission is a project folder (located by `project_root_marker`) or a `.zip`. A failure of one submission never
fails the whole run.

## 6. Use the dashboard

```bash
# from a source checkout after pnpm build
node dist/cli/main.js

# or, from a published npm release
npx tui-grade
```

The server starts on `127.0.0.1:3333`, prints the URL and opens the browser. Pick the assignment and submissions,
validate, run and watch progress. Stop uses `SIGTERM` against the child grading process. The dashboard also supports
manual points and run history.

Useful options:

```bash
tui-grade serve --port 4317          # use another port
tui-grade serve --no-open
tui-grade serve --results-root ~/.local/share/tui-grade
tui-grade serve --assignment examples/mission --submissions ~/submissions
```

The dashboard has no login. It is localhost-only and teacher-only. See [Web UI](web-ui.md) and
[Security and limits](security-and-limits.md).

## Next

- [CLI reference](cli.md)
- [Assignments and scenarios](authoring-scenarios.md)
- [Plugins](writing-plugins.md)
- [Examples](examples.md)
