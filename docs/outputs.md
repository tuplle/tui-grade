# Outputs

A run writes a directory like this:

```text
<out>/
  run.json                            teacher-side metadata: assignment, paths, start time, locale, version
  summary.csv                         one row per student with total points and one column per group
  manual.yaml                         manual points, when entered from the dashboard
  <student>/
    results.json                      student-facing machine-readable result (schemaVersion 1)
    results.full.json                 teacher-only result with hidden-check details
    report.md                         localized human-readable report
    build.log                         build output; only written when non-empty
    screens/<scenario>-<session>.txt  final screen of each terminal session
    logs/<scenario>-<run>.txt         exit code, stdout and stderr of each program run
    <student>-results.zip             files to send back to the student
```

## `run.json`

Teacher-side metadata used by history and rescore:

```json
{
  "schemaVersion": 1,
  "assignment": "zapr-mission",
  "assignmentDir": "/home/teacher/assignments/mission",
  "inputPath": "/home/teacher/submissions",
  "outDir": "/home/teacher/.local/share/tui-grade/2026-11-21T17-43-23.732Z",
  "startedAt": "2026-11-21T17:43:23.991Z",
  "locale": "sk",
  "version": "1.0.0"
}
```

It can contain absolute paths from the grading machine. Keep it out of anything you send to students.

## `results.json` and `results.full.json`

`results.json` is the complete student-facing result:

- hidden checks keep only their name, verdict and weight;
- hidden descriptions, expected/actual values and failure messages are removed;
- inline screens and run logs are omitted (they are delivered as files);
- `source.path` is reduced to the file name and `source.root` is `null`.

`results.full.json` is for the teacher:

- hidden-check descriptions, expected/actual values and messages are retained;
- inline screens and logs are still omitted; use the artifact files.

**`results.full.json` must never be sent to students.** The built-in ZIP reporter excludes it. Custom reporters and
manual packaging must do the same.

## `summary.csv`

One row per student, `;`-separated:

```text
student;points;max;build;args;simulation;interactive;statistics;quality
solution;16;20;2;3;5;3;3;
```

Ids come from submission names. The id column is prefixed with `'` when it starts with a spreadsheet formula character.

## `report.md`

A localized report for the student. The language comes from `assignment.yaml#locale` or `--locale`. It contains the
points, group table, scenario results and warnings.

## Logs and screens

- `logs/<scenario>-<run>.txt` contains the exit code, stdout and stderr of each run. Each section is capped at 64 KiB.
- `screens/<scenario>-<session>.txt` is the final screen of a terminal session.
- `build.log` is written only when the build produces output.

Students see their own program output. Hidden checks hide the expectation, not the output.

## The student ZIP

`<student>-results.zip` is written into the student’s directory and contains:

- `report.md`
- `results.json`
- `screens/`
- `logs/`
- `build.log` when present

It does **not** contain `summary.csv`, `run.json` or `results.full.json`. A previous run’s ZIP is not packed into the new
one.

## Student ids

The id is derived from the submission name:

- the `id` named group of `student_id.pattern`, otherwise `login`, otherwise the sanitized name;
- characters are reduced to `[A-Za-z0-9._-]`, with diacritics transliterated;
- at most 100 characters;
- `summary.csv` is reserved and becomes `summary.csv_`;
- duplicates get `-2`, `-3`, and a warning.

## Re-running into the same directory

`run` removes stale `build.log`, `screens/` and `logs/` before writing new artifacts. Result files are written
atomically with a temporary name and rename. A re-run still uses the same student directory, so a timestamped
`--out` per batch is usually easier to keep.

## Next

- [CLI reference](cli.md)
- [Web UI](web-ui.md)
- [Security and limits](security-and-limits.md)
