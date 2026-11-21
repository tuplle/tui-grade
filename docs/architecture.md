# Architecture

`tui-grade` is a TypeScript ESM package with four layers:

- a plugin kernel and grading engine in `src/core/`,
- built-in plugins in `src/plugins/`,
- a CLI in `src/cli/`,
- a localhost web dashboard in `src/web/`.

The public API is collected in `src/index.ts`. Anything not exported there is internal.

## Package layout

```text
src/
  index.ts             public API and VERSION
  grader.ts            createGrader: check, inspect, describe, schema, run
  core/
    app.ts             plugin contexts, registries, hooks
    contracts.ts       shared data model (types only)
    assignment.ts      assignment.yaml loading and schema
    scenario.ts        scenario normalization and matrix expansion
    validate.ts        static validation
    lifecycle.ts       load -> intake -> build -> scenarios -> score -> reporters
    execute.ts         steps, checks, records
    build.ts           build pipeline
    process.ts         runProcess, timeout, output caps, process groups
    session.ts         PTY sessions via @microsoft/tui-test
    workspace.ts       temp dirs, safe paths, atomic writes
    intake.ts          submission discovery and unpacking
    i18n.ts            message catalogs
    events.ts          structured run events
    run-meta.ts        run.json
    rescore.ts         re-score an existing run
  plugins/             built-in plugins, one directory per plugin
  cli/                 thin command wrappers over createGrader
  web/                 Express server, API, run manager, security
  web/public/          Alpine + Tailwind browser client
```

## The kernel

`App` is a plugin context. Each context has registries for:

- `step`
- `check`
- `builder`
- `reporter`
- `scorer`

A context sees its own registrations, then its ancestors. Siblings and children are never visible to the parent.
`definePlugin` registers into a child context; `fp` registers into the parent. Plugins listed in `assignment.yaml` are
registered as shared, so either style works there.

Hooks follow the same context chain: ancestors first, then registration order. A plugin can also register message
catalogs for `en` and `sk`.

## The run pipeline

```text
load assignment + plugins
  -> validate
  -> discover and unpack submissions
  -> per submission:
       build
       per scenario: setup, steps, run/session, checks
       score
       write artifacts
       run submission reporters
  -> run reporters (summary.csv)
  -> onRunEnd
```

A broken submission is data, not an exception. It becomes a result with warnings; only an invalid assignment or a
failing `onRunStart` hook stops the batch.

## Steps, checks and records

A step runs in a scenario work directory. A step that produces a program run must set `produces: 'run'` (or `session`)
and register a `RunRecord` or `SessionRecord`. Checks declare a `source`:

- `run`
- `session`
- `either`
- `none`

The `from` modifier selects a named record. Check modifiers (`weight`, `not`, `hidden`) are handled by the executor, not
by the check itself.

## Isolation and safety

Every student program gets:

- a timeout,
- an output cap per stream,
- its own work directory and `HOME`,
- a minimal environment,
- a process group; terminal sessions also get a process-tree kill.

Paths inside work directories and project roots go through `safeJoin`/`ctx.resolvePath`, which rejects `..` and symlink
escapes. The full security model and its limits are in [Security and limits](security-and-limits.md).

## Built-in plugins

`src/plugins/index.ts` maps built-in names. `src/plugins/preset.ts` registers the default preset.

Built-ins include:

- steps: `copy`, `write_file`, `run`, `session`, `script`
- checks: `stdout_contains`, `stdout_matches`, `exit_code`, `screen_contains`, `screen_matches`, `file_exists`,
  `file_contains`, `function_count`, `no_compiler_warnings`, `any_of`, `all_of`, ...
- builders: `gcc`, `cmake`, `custom`
- scorer: `proportional`
- reporters: `json`, `markdown`, `zip`, `csv`

Reporter order matters: `json` and `markdown` write files, `zip` packs them, `csv` writes `summary.csv`.

## Programmatic API

`createGrader` is the single entry point used by the CLI and the dashboard:

```ts
import { createGrader } from 'tui-grade';

const grader = createGrader({ assignmentDir: 'examples/mission' });

const report = await grader.inspect();     // check + scenario list
const entries = await grader.describe();  // registered plugins
const schema = await grader.schema();
const { results } = await grader.run({
  inputPath: 'submissions',
  outDir: '/home/teacher/.local/share/tui-grade/run-1',
});
```

`src/index.ts` also exports the plugin helpers, `App`, `runProcess`, `minimalEnv`, `safeJoin`, `publicResult`, `VERSION`
and the contract types.

## The web dashboard

The dashboard is a separate delivery layer over the same grading engine:

```text
Express server (src/web)
  -> API + static Alpine/Tailwind UI
  -> RunManager
       -> child process: node dist/cli/main.js run ... --events
            -> the normal CLI/engine
       -> NDJSON events -> SSE -> browser
```

Read-only operations (`check`, `describe`, history, artifacts) run in the server process. A grading batch is a child
CLI process, so Stop can send `SIGTERM` and a crash cannot take down the dashboard. The server has no authentication and
binds only to `127.0.0.1`.

Teacher-only data:

- `run.json` records paths and metadata;
- `results.full.json` keeps hidden-check details;
- the student ZIP excludes `results.full.json`.

See [Web UI](web-ui.md) for the API and security model.

## Where to change what

| Change | Where |
| --- | --- |
| A new step/check/builder/reporter/scorer | `src/plugins/<kind>-<name>/`, then `src/plugins/index.ts` and `src/plugins/preset.ts` |
| A new message | `src/locales/en.json` and `src/locales/sk.json` |
| A new CLI command | `src/cli/commands/`, `src/cli/main.ts`, `src/cli/common.ts` |
| A new API route | `src/web/routes.ts` |
| Dashboard behavior | `src/web/public/app.js` and `index.html` |
| Run lifecycle | `src/core/lifecycle.ts` |
| Process/session limits | `src/core/process.ts`, `src/core/session.ts` |
| Result formats | `src/plugins/reporter-*` and `src/core/contracts.ts` |

## Next

- [Development](development.md)
- [Plugins](writing-plugins.md)
- [CLI reference](cli.md)
