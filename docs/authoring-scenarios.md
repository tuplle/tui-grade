# Authoring assignments and scenarios

An assignment is a directory that `tui-grade` loads with `check`, `describe`, `schema` and `run`:

```
my-assignment/
  assignment.yaml      configuration (required)
  scenarios/           *.yaml / *.yml at any depth (required: at least one file)
  fixtures/            files the scenarios copy into a scenario's work directory
  template/            (optional, any name) files laid over the student's project before the build
  plugins/             (optional) your own steps, checks, builders, ...
```

The model to read next to this page is `../examples/mission` (C17, 60 scenarios, six groups, one manual group).
`examples/sentinel/` and `examples/vindex/` add user plugins, fixtures and stateful programs.

## `tui-grade describe` and `schema` are the source of truth

This page explains the concepts. The exact list of steps, checks, builders, reporters and scorers, their parameters
and examples is generated from the code, so it is never out of date:

```bash
tui-grade describe                        # the built-in preset, as text
tui-grade describe my-assignment          # including the plugins of that assignment
tui-grade describe my-assignment --json   # full JSON Schema of every parameter object
tui-grade schema my-assignment            # JSON Schema of a scenario file (assignment.yaml under $defs)
tui-grade check my-assignment --json      # { ok, issues: [{ path, message, severity }], scenarios }
```

For an AI agent writing scenarios the loop is: `describe --json` and `schema` to learn the vocabulary, write YAML, run
`check --json` until `ok` is true (every issue carries a `file#/json/pointer` path), and only then `run`.
`check` validates everything that can be validated statically (unknown step/check names, parameter shapes, `from`
references, missing fixtures and scripts, unknown groups) and never starts a student program.

## `assignment.yaml`

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | required | Name shown in reports. |
| `max_points` | required | Maximum total (a number >= 0). |
| `locale` | `en` | Report language: `en` or `sk`. `--locale` overrides it. |
| `build` | required | `{ type: <builder>, ...builder params }`: `gcc`, `cmake` or `custom` (or a builder from a plugin). |
| `binary` | the builder's output | Path of the program to run, relative to the project root. Required for `custom`. |
| `project_root_marker` | required | A file that identifies the project root inside a submission, for example `src/main.c`. |
| `project_root_depth` | `2` | How deep below the unpacked submission the marker is searched (shallowest match wins). |
| `student_id` | none | `{ pattern, strip_prefix }`: a regular expression with named groups applied to the submission's file/folder name. |
| `groups` | none | Point groups, see below. |
| `scoring` | `{ use: proportional, rounding: none, cap: true }` | Scorer name, rounding of the total (`none`, `floor`, `round`, `ceil`) and whether the total is capped at `max_points`. |
| `plugins` | `[]` | Your own plugins, see [writing-plugins.md](writing-plugins.md). |
| `preset` | `default` | `none` registers none of the built-in plugins; list the ones you want in `plugins` by name. |
| `template` | none | Directory (relative to the assignment) whose files are copied over the student's project before the build, for example a fixed `CMakeLists.txt`. |
| `limits.build_timeout_sec` | `120` | Wall-clock limit of the build. |
| `limits.run_timeout_sec` | `10` | Default limit of one `run` / `session`; a step can set its own `timeout`. |
| `limits.output_limit_bytes` | `1048576` | Output cap per stream of a run or build; also the largest file a check reads. |
| `limits.unzip_max_bytes` | `524288000` | Total unpacked size allowed for a `.zip` submission. |
| `limits.unzip_max_files` | `20000` | Number of entries allowed in a `.zip` submission. |

Unknown fields are errors, so typos are caught by `check`.

```yaml
name: demo
max_points: 20
locale: en

build: { type: gcc, sources: [src/main.c], output: bin/demo, std: c17 }   # -Wall -Wextra by default
binary: bin/demo
project_root_marker: src/main.c

student_id:
  pattern: '^(?<surname>[^_]+)_(?<name>[^_]+)_(?<login>[^_]+)_demo$'    # groups: id | login (the id), surname, name

limits: { run_timeout_sec: 5 }
```

### Student ids

The id is the `id` group of `student_id.pattern`, otherwise `login`, otherwise the whole name (a `.zip` extension and
`strip_prefix` removed). It is reduced to `[A-Za-z0-9._-]` (diacritics transliterated) because it becomes a directory
name. Equal ids get `-2`, `-3`, ... and a warning. The display name is `<surname> <name>` when those groups exist.

### Builders

- `gcc`: `{ sources, output, std?, flags?, libs?, compiler? }`, run without a shell; `g++` is chosen for C++ sources.
  `flags` defaults to `[-Wall, -Wextra]`, which is also what `no_compiler_warnings` is measured against.
- `cmake`: `{ binary_path, source_dir?, build_dir?, target?, configure_args? }`.
- `custom`: `{ command, shell? }` executed in the project root; `shell` is `auto` (default: `sh` on POSIX, `cmd` on Windows), `sh`, `cmd` or `powershell`. Set `binary` yourself.

### Groups, manual points and `requires_build`

```yaml
groups:
  - { id: build,   title: { en: Build and structure }, points: 2, requires_build: false }
  - { id: args,    title: { en: Arguments },           points: 3, requires_build: true }
  - { id: quality, title: { en: Code quality },        points: 4, manual: true }
```

- Every scenario names its group (`group: args`). The group's `points` are split between its scenarios by scenario
  `weight`; a scenario earns its share multiplied by the passed share of its check weights.
- `requires_build: true`: when the build fails, the group's scenarios earn 0 without being judged. Static checks in a
  group with `requires_build: false` (project structure, `function_count`) still score.
- `manual: true`: points are given by a human, with `tui-grade run ... --manual points.yaml`, a file of
  `studentId: { groupId: points }`. Without an entry the group is *pending* (0 points, marked as pending in the
  reports). Values are clamped to `0..points`. Scenarios in a manual group do not score.
- Without any `groups`, `max_points` is divided between all scenarios by weight.
- The total is `automatic + manual`, rounded as configured and capped at `max_points`.

## Scenario files

A file is a YAML **array** of scenarios.

```yaml
- id: args-help                       # unique within the assignment
  title: { sk: Nápoveda, en: Help }   # a string or { language: text }
  group: args                         # optional when the assignment has no groups
  weight: 3                           # default 1; 0 is allowed
  run:
    args: [ --help ]
  expect:
    - exit_code: 0
    - stdout_contains: Help
```

A scenario runs in its own empty temporary **work directory**; the student's program starts there (`cwd`), and files
it creates can be checked. Fixtures are copied in explicitly.

### What a scenario does: `setup`, `steps`, `run`, `session`

These keys are alternatives for the list of **steps**, executed in this order: `setup`, `steps`, then `run`, then
`session`. `run: {...}` and `session: {...}` are shorthands for a single `run` / `session` step at the end.

```yaml
- id: index-twice
  title: Indexing a file twice is ignored
  group: index
  setup:                              # preparation
    - copy: notes.txt                 # fixtures/notes.txt -> workdir/notes.txt
    - write_file: { path: config.txt, content: "mode=fast\n" }
  steps:
    - run: { args: [ index, notes.txt ] }
    - id: second                      # names this run so that checks can say `from: second`
      run: { args: [ index, notes.txt ] }
  expect:
    - from: second
      stdout_contains: ignored
```

A scenario without any step is allowed when it only has static source checks (see below). When a step fails (for
example a missing fixture), the remaining steps are skipped, the scenario gets the status `error`, and the checks are
still evaluated: those that need output of a step that never ran fail, static ones can still pass.

Steps of the default preset (see `describe` for all parameters):

| Step | Purpose |
| --- | --- |
| `copy: file` / `copy: { from, to }` | Copy a fixture (file or directory, from `fixtures/`) into the workdir. Symlinks are not copied. |
| `write_file: { path, content }` | Write a text file in the workdir. |
| `run: { args, stdin, timeout, env }` | Start the program once; records stdout, stderr, exit code. |
| `session: { args, rows, cols, timeout, env, steps }` | Start the program in a terminal, see below. |
| `script: { path, options }` | Run your own ES module, see [writing-plugins.md](writing-plugins.md#script-modules). |

### Variables and `matrix`

`${binary}`, `${workdir}` and `${fixtures}` are available in step and check parameters. A `matrix` multiplies a scenario
over the values of one or more variables, which are substituted in `id`, `title`, steps and checks:

```yaml
- id: args-bad-crew-${value}          # the id MUST contain the variable, otherwise the ids collide
  title: Invalid crew size ${value}
  group: args
  matrix:
    value: [ '0', '-1', abc ]         # values are strings; the first key varies slowest
  run:
    args: [ --crew, '${value}', --days, '3', --food, '6', --oxygen, '12' ]
  expect:
    - exit_code: nonzero
```

`tui-grade check <dir> --list` prints every expanded id. An unknown `${name}` is an error.

### `stdin`

`stdin` is a string that is written to the program and then closed (end of file). `stdin: closed` (also the default
when it is left out) closes it immediately. Use a block scalar for several lines:

```yaml
run:
  args: [ --crew, '2' ]
  stdin: |
    y
    n
```

A program that waits for input beyond what `stdin` provides gets end-of-file; one that never ends is killed at the
timeout and the check fails with a message saying so. For genuinely interactive programs use a session.

### Interactive sessions

`session` runs the program in a pseudo-terminal and drives it with nested steps. Each nested step is one of:

| Nested step | Effect |
| --- | --- |
| `send: text` | Type the text and press Enter. |
| `type: text` | Type the text without Enter. |
| `press: Ctrl+D` / `press: [ Down, Enter ]` | Press key(s). |
| `expect_screen: text` / `{ text, timeout }` / `{ pattern, timeout }` | Wait (default 5 s, never beyond the session budget) until the screen contains the text or matches the regular expression; failing makes the session stop and the scenario's checks see the screen as it is. |
| `wait_exit: { timeout }` | Wait for the program to end (a timeout is not a failure by itself). |

After the last nested step the session waits for the program to exit within `timeout` (default the run timeout) and
then kills what is still running. Checks of source `session` read the final screen: `screen_contains`, `screen_matches`;
`exit_code` accepts either kind of record, so it also reads the exit code of a session's program.

```yaml
- id: menu-quit
  title: The menu quits with q
  session:
    steps:
      - expect_screen: "1) Add"
      - press: q
      - wait_exit: { timeout: 2 }
  expect:
    - screen_contains: { text: "bye", ignore_case: true }
    - exit_code: 0
```

The final screens are saved under `screens/` in each student's results; the output of every `run` (exit code, stdout, stderr)
is saved under `logs/` as `<scenario>-<run id>.txt`.

## Checks (`expect`)

`expect` is a list; every entry is one check: its name as the key and its parameters as the value, plus optional
modifiers next to it:

```yaml
expect:
  - stdout_contains: Help                        # shorthand parameter
  - stdout_contains: { text: Pomoc, ignore_case: true, fold_diacritics: true }
  - exit_code: nonzero
  - file_exists: output.txt
  - from: second                                 # modifier: which run/session to read
    stdout_matches: '\b100\.00%'
    weight: 2                                    # modifier: default 1
    not: true                                    # modifier: the check must NOT hold
    hidden: true                                 # modifier: details are not shown to the student
```

All checks must be passed for a scenario to count as passed, but points are **proportional**: a scenario earns its
share multiplied by the passed share of its check weights, so five checks with one failing earn 80 %.

**Which output does a check read?** `stdout_*` and `stderr_*` read a *run*; `screen_*` read a *session*; `exit_code` reads either;
`file_*` look into the scenario workdir; `function_count`, `file_line_count` and `no_compiler_warnings` need no run
at all (they read the project's sources or the build). `any_of`/`all_of` pass their kind on to the nested checks. By
default a check reads the **latest** run (or session) of the scenario; `from: <step id>` picks another one by the
`id` of its step. `check` refuses a check that cannot be satisfied: a `stdout_contains` in a scenario without a run, a
`from` that names a session for a run check, an unknown id. Output of runs is normalized (CRLF to LF, ANSI escape
sequences removed) before matching. A check that reads a run that timed out fails and says so; `not` is not applied to
such a failure.

### `not`

`not: true` inverts a check: it passes when the inner check fails. The report labels it `NOT: ...`. It is meant for
"must not print an error", "must not accept this input". Beware of inverting a check on output that may be absent
for the wrong reason; pair it with a positive check (`exit_code: 0`).

### `weight`

A non-negative number, default 1. Weights are relative within the scenario. A check with `weight: 0` is informational:
it is shown but does not influence the points.

### `hidden`

A hidden check scores like any other, but the student must not learn what is tested. In `results.json`, `report.md` and
the zip the check keeps only its **name**, the verdict and the weight; its description (which would reveal the
parameters), `expected`, `actual` and the failure message are replaced by a neutral text, and errors raised inside a
hidden check are not detailed. Two limits: the check **name** is visible (`stdout_matches` tells what kind of check
it is), and the scenario's id and title are visible, so do not hide behind a revealing title. The built-in reporters do the
masking; a custom reporter receives the unmasked result and has to do the same itself (see
[writing-plugins.md](writing-plugins.md#reporters)).

### Alternatives in two languages: `any_of`

Students answer in the language of their assignment text; the checks should accept either. Combine
alternatives with `any_of` (at least one) and `all_of` (all of them):

```yaml
- any_of:
    - stdout_contains: Help
    - stdout_contains: Pomoc
    - stderr_contains: Help
    - stderr_contains: Pomoc
- stdout_matches: { pattern: 'uspesne|successful', ignore_case: true, fold_diacritics: true }
```

`fold_diacritics` compares `ú` and `u` as equal, which makes Slovak output robust against students who avoid
non-ASCII characters; `ignore_case` is case-insensitive. A pattern is a JavaScript regular expression; `flags` can add
more (for example `m`). On a composite, `from` is inherited by the nested checks (unless they set their own), `not` inverts the composite as
a whole, and `hidden` hides the nested checks as well.

### Static source checks

Three checks read the student's *project files*, not the program's output, and work even when the build failed:

```yaml
- id: build-structure
  title: At least 5 functions, not a single huge file
  group: build
  expect:
    - function_count: { file: src/main.c, min: 5 }
    - file_line_count: { file: src/main.c, min: 20, max: 400 }
    - no_compiler_warnings: true
```

`function_count` is a heuristic scanner for C/C++ (comments, strings and preprocessor lines are ignored; it also
counts functions in `#if 0` blocks and in both `#ifdef`/`#else` branches). A scenario with only static checks needs no
step.

### Files created by the program

`file_exists`, `file_empty` and `file_contains` look into the **work directory**, where the program ran. Paths may not
leave it. Typical use for programs that persist state:

```yaml
steps:
  - run: { args: [ new, --name, PC ] }
expect:
  - file_contains: { path: devices.txt, text: PC }
```

### Custom code

When YAML is not enough: a `script` step prepares or drives things; a `script` check returns a verdict
(`{ pass, message? }`); a user plugin adds new named steps and checks that read well in scenarios
(`- insert_device: { name: PC, ip: 10.0.0.1 }`). See [writing-plugins.md](writing-plugins.md).

## Tips

**YAML anchors** avoid repeating long patterns inside one file. Define the anchor on first use and alias it elsewhere
(anchors do not cross files):

```yaml
- id: a
  title: A
  run: { args: [ --x ] }
  expect:
    - stdout_matches: &success { pattern: 'uspesne|successful', ignore_case: true, fold_diacritics: true }
- id: b
  title: B
  run: { args: [ --y ] }
  expect:
    - stdout_matches: *success
      not: true                       # modifiers can be added next to an alias
```

Other practical rules:

- Quote YAML values that look like something else: `'12'`, `'-1'`, `'yes'`, patterns starting with `*`, `&`, `[`.
- A flow mapping with a comma inside an unquoted title (`title: { en: a, b }`) is a YAML error; quote it.
- Keep one file per group. The loader reads every `*.yaml` below `scenarios/` in sorted order.
- Write a reference solution (see `examples/*/solution`) and a few deliberately broken fixtures and keep them as tests of the
  assignment; run `tui-grade run` on them in your CI (see [CI grading](ci.md)).
- Use `--only scenario-id` while iterating on one scenario.
