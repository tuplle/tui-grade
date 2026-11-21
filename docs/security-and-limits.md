# Security and limits

`tui-grade` compiles and runs code written by other people. This page says what it does to contain that code, and,
more importantly, what it does **not** do.

> **There is no sandbox, container or user separation in v1.** A submission runs with the permissions of the user who
> started `tui-grade`. The measures below stop *accidents* (infinite loops, endless output, forgotten background jobs, a
> broken zip, a path that points out of a directory). They do not stop a *deliberately hostile* program.
>
> **Recommended practice:** run `tui-grade` for real submissions inside a disposable container or virtual machine (a
> CI job on a fresh runner is exactly that) that holds no credentials, has no access to other students' data and, if
> possible, has no network. [CI grading](ci.md) is a starting point.

## The localhost dashboard

`tui-grade` with no command (or `tui-grade serve`) starts a teacher-only dashboard. It has **no authentication**: it is
meant for one teacher on their own machine. The server binds only to `127.0.0.1` and rejects non-local `Host` headers,
cross-origin API writes and preflights. There is no CORS. Do not expose it through a reverse proxy, port forwarding, a
LAN address or a shared machine account; localhost is not a user boundary between people.

The dashboard runs a grading batch as a child `tui-grade run` process. It does not make student code safer: the same
unsandboxed execution, timeouts, output caps and process-tree cleanup apply. The web server itself does not serve
student source trees or arbitrary files; it serves known result artifacts by run and student id.

A run directory contains extra teacher-side files:

- `run.json` with the assignment directory and input path;
- `<student>/results.full.json` with hidden-check details;
- `manual.yaml` with manual points.

The built-in ZIP excludes `results.full.json`; verify that any custom reporter or manual packaging does the same. Treat
`results.full.json` and `run.json` as teacher-only data.

## What is contained

| Threat | Measure |
| --- | --- |
| A program that never ends | Wall-clock timeout per run (`limits.run_timeout_sec`, default 10 s; `timeout` of a step), per session and for the build (`build_timeout_sec`, default 120 s). On expiry the POSIX **whole process group** gets `SIGTERM`, after 2 s `SIGKILL`; on Windows the process tree is stopped with `taskkill /T /F`. The check on a timed-out run fails and says so. |
| Endless output | Output of a run and of a build is capped per stream (`output_limit_bytes`, default 1 MiB); on overflow the process group is terminated and the result is marked `truncated`. Files read by checks are bounded by the same limit (and read only when they are regular files). The build log kept in results is capped at 64 KiB. |
| Leftover background processes | When the program exits, its process group is killed. For terminal sessions the whole **process tree** is killed: through `/proc` on Linux, `ps` on macOS, and `taskkill /T` on Windows. This holds on normal close and on Ctrl-C alike. A background job of a plain `run` step that moved into a session of its own (`setsid`) is outside its process group and is **not** found; only terminal sessions have the tree walk. |
| Programs that write everywhere | Every scenario runs in its own empty temporary directory (`cwd`, and `HOME`), which is removed afterwards, also when the program left read-only directories behind (`chmod 500 d`): the tree is made writable and removed again, and a cleanup problem is logged but never replaces the scenario's result. Submissions are built in their own temporary copy; the originals are never modified. |
| Ctrl-C / `SIGTERM` during a run | The CLI stops cleanly and exits with 130 (`SIGINT`) or 143 (`SIGTERM`); on Windows Ctrl-C/SIGBREAK uses 130, and the dashboard sends an IPC stop before a forceful fallback. Order: the run is flagged as stopping first (nothing new is started, created or written), then the **process tree of every terminal session** is killed (descendants are looked up while their parent shell is still alive, so a `setsid` child cannot slip away), then every `run` **process group** gets `SIGKILL` (on Windows `taskkill /T /F`), then the temporary directories of the submissions in flight are removed (not with `--keep-workdirs`). The run stops at the next boundary: no further submission or scenario is started and the interrupted submission is returned with the warning `interrupted`. Nothing is started for it after the signal, but a file whose write had already begun is finished. Every file that is written (`results.json`, `report.md`, the ZIP, `summary.csv`, `build.log`, `logs/*`, `screens/*`) is written atomically (temp name in the same directory, then rename): **every file present is complete, never truncated**. The directory is not atomic: the set of files of an interrupted student may be partial (a signal during reporting can leave `results.json` but no `report.md`/ZIP). No run-level `summary.csv` is written. The CLI then prints only the issues and warnings and `interrupted: results are incomplete` to stderr, nothing to stdout (no points table, no "graded" line), skips `--fail-under`, and exits 130/143. A temp file of a write cut off by the exit is removed; one left by `SIGKILL` is skipped by the ZIP reporter and deleted at the next run into the same directory. A **second** `SIGINT`/`SIGTERM` while the cleanup is still running kills again and exits at once (130/143) after printing `forced exit; temp dirs may remain: ...` to stderr. A synchronous `exit` handler repeats the kill (terminal-session trees first, then process groups) as a last resort. Not handled: `SIGKILL` of `tui-grade` itself, a crash of the Node.js process or a power loss (student processes can keep running, temp dirs and a `.*.tmp` file of an unfinished write can remain), and a `setsid` escapee of a plain `run` step (it is not in the killed process group). |
| Secrets from the grader's environment | Every student program, in a plain `run` and in a terminal `session` alike, starts with a **minimal environment**, not the grader's: `PATH` (the grader's), `HOME` (the scenario's workdir), `LANG` and `LC_ALL` (`C.UTF-8`), plus the `env` of the step; sessions also get `TERM=xterm-256color` (the step's `env` may override it). Tokens, `SSH_AUTH_SOCK` and every other variable of the grading process are not passed on; sessions start the program through a small Node wrapper with the same minimal environment. On Windows the wrapper also keeps the system variables Windows programs need (`SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP`, `WINDIR`). The program can still read files that the user can read, such as `.git/config`. |
| Zip bombs, `../` entries, absolute names | `.zip` submissions are extracted with a limit on the total uncompressed size (`unzip_max_bytes`, default 500 MiB) and on the number of entries (`unzip_max_files`, default 20 000), enforced while inflating, not only from the archive headers. Entries with absolute names, `..` or NUL, and entries that are not regular files or directories (symlinks, devices), are skipped and reported as warnings. A corrupt or over-limit archive fails that one submission only. |
| Symlinks in submissions | Directory submissions are copied **without symlinks** (skipped, with a warning); `.git` and `__MACOSX` are not copied. Archives cannot create symlinks (see above). Everything the tool does with a path inside a workdir or project (`copy`, `write_file`, file and source checks, the project root marker, `script` paths) goes through a resolver that rejects `..` and any path that leaves its base through a symlink, including dangling links. Fixtures and templates are copied without their symlinks. |
| A student breaking the batch | `run` never fails because of one submission: build failures, crashes, a missing project root, a corrupt zip and exceptions in plugins become results and warnings. Only an invalid assignment (or a failing `onRunStart` hook) stops the run. |
| Duplicate / odd student names | Ids are reduced to `[A-Za-z0-9._-]` and cut at 100 characters (so `<id>-results.zip` is a valid file name); `summary.csv` (any case) is reserved and becomes `summary.csv_`, so a student cannot occupy the summary file's name; duplicates are renamed with a suffix and reported. A configured `student_id.pattern` that does not match a name is reported as a warning of that submission. |
| Terminal escape sequences in names | Student-chosen strings that end up in warnings (ZIP entry names, symlink names, submission names) have their control characters replaced by `?`; the CLI output and the `report.md` text do the same, so a crafted file name cannot write to the teacher's terminal. `build.log` and `logs/` hold raw program output. |
| Spreadsheet formula injection | The id column of `summary.csv` is prefixed with `'` when the id starts with `=`, `+`, `-`, `@`, tab or CR, because ids come from file names chosen by students. |

## Known limits (accepted in v1)

- **All submissions are extracted up front.** `run` unpacks every submission into its own directory under the temp root
  before the first one is graded, so while one student's program runs, the work of the other students is on disk below the
  same temp root, readable by that (possibly hostile) program. Grading in a container or VM per student, or one submission
  per run, avoids this.
- **No isolation from the system.** A hostile program can read any file the grading user can read, write outside its
  workdir (absolute paths), use the network, fork-bomb, fill the disk, or kill processes of the same user. Limits on CPU,
  memory, processes, disk and network are not applied. Use a container/VM for that, with its own resource limits.
- **`setsid` / double fork escape the kill.** A program that creates a new session or process group (`setsid`, a daemon
  that double-forks and is re-parented to `init`) is not found by the process-group kill and survives the run. The tree
  kill for sessions walks the process table (Linux `/proc`, macOS `ps`, Windows `taskkill /T`), which helps for ordinary
  descendants but cannot find processes that were already re-parented. A throw-away container/VM cleans these up.
- **Directory copies are not size-limited.** The limits `unzip_max_*` apply to `.zip` files only. A submission folder
  (or a fixture/template directory) is copied as it is; a huge directory costs disk space and time. The whole
  `.zip` file is read into memory before it is unpacked.
- **The exit code of an interactive session can be spoofed.** The terminal library does not report the exit code of the
  program, so a session runs it under a small Node wrapper that prints a marker with a random token and the exit code
  (`@<token>:<code>@`); output of the program cannot guess the token. The token is still visible in the wrapper's command
  line (for example `/proc/<pid>/cmdline` on Linux), so a program that deliberately reads it can print a fake marker.
  Plain `run` steps are not affected (the exit code comes from the operating system).
- **Build-time code execution.** Compiling is running: a Makefile, a `CMakeLists.txt` or the `custom` builder's command in
  a student's project executes arbitrary code at build time, under the same limits as above (timeout, output cap, process
  group). `gcc` itself is run without a shell and with a timeout, but preprocessor tricks (`#include "/etc/passwd"`,
  gigantic expansions) are only bounded by that timeout.
- **Author patterns can block the event loop.** Regular expressions in scenarios (`stdout_matches`, `screen_matches`,
  `expect_screen`, `student_id.pattern`) are written by the assignment author and are trusted. A pattern with catastrophic
  backtracking, run against 1 MiB of output, blocks the whole Node.js process (and with it all timeouts), because
  JavaScript regular expressions cannot be interrupted. Prefer anchored, simple patterns; test them against large output.
  Likewise your own plugins and `script` modules run in the grader's process with full rights; treat the assignment
  directory as **trusted code** (only the submissions are untrusted).
- **Platform-specific limits.** Linux reads `/proc`; macOS uses `ps`; Windows uses `taskkill /T`. Windows ARM64 is not
  supported by the native terminal package. The release bundle is built for the platform it was made on, and Windows
  has no graceful `SIGTERM` equivalent: dashboard Stop uses IPC, but a direct kill is forceful and may leave temporary
  files behind.

## Information that leaves the machine

- **Hidden checks** (`hidden: true`) leak only their *name* (the check kind, for example `stdout_matches`), whether they
  passed, and their weight, in `results.json`, `report.md` and the zip. The scenario id and title, the number of hidden
  checks and the points lost are visible. Their description, expected/actual values and failure messages are removed,
  and errors thrown inside them are not detailed. Custom reporters receive unmasked data and should use the exported `publicResult`
  (see [writing-plugins.md](writing-plugins.md#a-reporter)).
- **No paths of the instructor's machine.** The student-facing `results.json` (and the copy in the zip) carries
  `source` as `{ "path": "<file or folder name>", "kind": ..., "root": null }`; the temp root and the instructor's directories
  never appear in what students receive. Custom reporters that write to students should build on the exported
  `publicResult(result, t)`, which applies this (and removes hidden-check details, screens and logs); a reporter that
  writes `result.source` unchanged publishes absolute paths.
- **Final screens, run logs and build logs** of a student are included in that student's results (`screens/`, `logs/`,
  `build.log`, the zip). They contain what the student's program printed, which also means output produced from your
  fixtures. Run logs are written for **every** run, also for runs that only hidden checks look at: students see what their
  own program printed; hidden checks hide the *expectation*, not the output. Each stdout/stderr section of a run log is cut
  at 64 KiB.
- **Diagnostics** (progress, hook failures, warnings) go to stderr of the process, never into the students' result
  directory.
- **Fixtures** are copied into workdirs where a student's program can read them. Do not put expected answers or hidden
  test data in `fixtures/` if the program might simply read them; build the data in a `script` step instead, or keep
  the check logic outside the files the program can see (anything under the assignment directory is readable by a
  hostile program anyway: see "No isolation").

## Grading in CI

A CI job is the easiest disposable environment, but it also holds credentials, and a student program runs next to them:

- **`actions/checkout` stores the job's token in `.git/config` by default** (`persist-credentials: true`). Every file
  the grading user can read is readable by a hostile program, so use `with: { persist-credentials: false }` on every
  checkout step of a grading job. The example workflow does; this repository's own `ci.yml` and `release.yml` do as well
  (they never push, and the release action authenticates through `github.token`, not through git credentials).
- Give the workflow `permissions: contents: read` (or less) and hand a token only to the steps that need it, through
  that step's `env`, never at job or workflow level. A step's `env` is not visible to the `tui-grade run` step.
- Do not make secrets available to the grading step, and do not grade on self-hosted runners that keep state between jobs.
- Check out the submissions into a separate directory from anything you want to keep private.

## Practical advice

1. Grade in a container or VM per run, with no secrets mounted and a read-only mount of the assignment.
2. Give the job a hard wall-clock limit as well; the per-program timeouts do not bound the number of submissions.
3. Keep `run_timeout_sec` and `output_limit_bytes` as low as the assignment allows.
4. Run `tui-grade check` before `run`; it starts no student code.
5. Treat results as untrusted input if you post-process them: ids, titles of students' output and screen text
   come from student programs.
