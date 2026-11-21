# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses semantic versioning.

## [1.0.0] - 2026-11-21

### Added

- Plugin-based grading engine with steps, checks, builders, scorers and reporters.
- CLI: `run`, `check`, `describe`, `schema` and `rescore`.
- Plain runs, stdin/stdout/stderr capture, exit-code checks and pseudo-terminal sessions.
- YAML assignments, matrix expansion, localized scenarios, hidden checks, weights and manual groups.
- `gcc`, `cmake` and `custom` builders.
- `json`, `markdown`, `zip` and `csv` reporters with atomic output files.
- Programmatic `createGrader` API.
- Localhost teacher dashboard (`tui-grade` with no command, or `tui-grade serve`):
  assignment/submissions picker, validation, run control, live progress, results, student detail, manual points,
  history and light/dark themes.
- Structured `run --events` NDJSON progress for the dashboard.
- `run.json` metadata, teacher-only `results.full.json`, and student ZIP exclusion of teacher-only files.
- Documentation site built with Docsify v5.
- npm tarball and standalone Linux release bundle with a `pnpm publish` release workflow.
- Example assignments: `mission`, `sentinel` and `vindex`.

### Security

- Student programs run with timeouts, output caps, a minimal environment and process-group cleanup.
- The dashboard binds only to `127.0.0.1` and has no authentication; do not expose it.

[1.0.0]: https://github.com/tuplle/tui-grade/releases/tag/v1.0.0
