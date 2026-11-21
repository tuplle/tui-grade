# CI grading

The repository includes a sample GitHub Actions workflow:
[ci-grading-example.yml](https://github.com/tuplle/tui-grade/blob/main/docs/ci-grading-example.yml). It is
documentation, not part of this repository’s own CI. Copy it into the grading repository and adapt the paths.

## What the sample does

```yaml
name: Grade submissions

on:
  workflow_dispatch:
  push:
    paths:
      - 'submissions/**'
      - 'assignment/**'

permissions:
  contents: read

jobs:
  grade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 26
      - name: Validate the assignment
        run: tui-grade check assignment
      - name: Grade
        run: tui-grade run assignment submissions --out grading-results --locale en
      - name: Show the summary
        if: always()
        run: cat grading-results/summary.csv || true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: grading-results
          path: grading-results/
```

## Why these choices

- **`persist-credentials: false`** keeps the job token out of `.git/config`. Student programs run as the grading user
  and can read files the user can read.
- **`permissions: contents: read`** limits what the job can do. Hand tokens only to steps that need them, through that
  step’s `env`.
- **A throwaway runner or container** is the practical sandbox. Do not grade on a self-hosted runner that keeps state
  or holds secrets.
- **`check` before `run`** catches assignment errors without starting student code.
- **Upload results even on failure** so the teacher can see what happened.
- **`--fail-under`** is optional. It turns “a student is below the threshold” into exit code 2.

## Installing tui-grade in CI

Use one of:

- the standalone release tarball from GitHub Releases (no npm install, only Node 26);
- `npx --yes --package tui-grade tui-grade ...` from the npm registry;
- a project dependency installed with `pnpm add tui-grade`.

For the standalone route, the sample downloads and extracts the release asset, then adds the `tui-grade` directory to
`$GITHUB_PATH`.

## Submissions

Submissions can arrive as:

- a checked-out `submissions/` directory (one folder or `.zip` per student);
- an artifact downloaded from another workflow;
- a directory produced by your LMS export.

`tui-grade run` accepts a folder of submissions, a single project folder, or a single `.zip`.

## Results

The CI artifact contains the same run directory described in [Outputs](outputs.md):

- `summary.csv`
- per-student reports, results, logs, screens and ZIPs
- `run.json`
- teacher-only `results.full.json`

Treat the teacher-only files as private. The student ZIPs are safe to send back; they exclude `results.full.json`.

## Security reminder

There is no sandbox in v1. A hostile submission can read files, use the network, or escape its process group. Use a
disposable runner or container with no secrets and, if possible, no network. See
[Security and limits](security-and-limits.md).
