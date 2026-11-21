# Writing plugins

Everything `tui-grade` does is registered by plugins: the built-in steps, checks, builders, scorer and reporters are
ordinary plugins that make up the `default` preset. An assignment can add its own, for example a step that prepares
the state of a stateful program, a check that parses the output, or a reporter that posts the points somewhere.

A plugin is an ES module whose default export (or a named export called `plugin`) is a plugin definition. It is
listed in `assignment.yaml`:

```yaml
plugins:
  - ./plugins/insert-device.js                         # a path, relative to the assignment directory
  - some-npm-plugin                                    # a package, resolved from the assignment directory upwards
  - { use: ./plugins/limits.js, options: { max: 3 } }  # with options, passed to the plugin function as `opts`
```

A name that is one of the built-in plugins (`steps-basic`, `reporter-csv`, `builder-gcc`, ...) refers to that plugin.
`tui-grade describe <assignment-dir>` and `tui-grade check <assignment-dir>` show and validate what your plugins add.
The real plugins of the repository, `examples/sentinel/plugins/` and `examples/vindex/plugins/`, are good models.

## `definePlugin` and `fp`

```js
import { definePlugin, fp, z } from 'tui-grade';

export default definePlugin(async (app, opts) => { /* register things on `app` */ }, { name: 'my-plugin' });
```

The package exports `definePlugin`, `fp`, `z` (the zod instance the framework uses, so schemas are compatible),
`App`, `runProcess`, `minimalEnv` (the environment of student programs), `safeJoin` / `PathEscapeError` (path
resolution that cannot leave a base directory), `normalizeText`, `publicResult` (see [A reporter](#a-reporter)),
`createGrader`, `gradeAll`, `VERSION`, the identity helpers `defineStep`, `defineCheck`, `defineBuilder`,
`defineReporter`, `defineScorer` and the TypeScript types of all contracts. Built-in
plugins can be imported individually, for instance `tui-grade/plugins/steps-basic`.

Both take `(fn, meta)`; `meta.name` and `meta.dependencies` (names of plugins that must already be loaded, otherwise
registration fails with a clear error) are optional.

| | Registrations land in | Use |
| --- | --- | --- |
| `definePlugin(fn, meta)` | a **child** context: invisible to whoever registered the plugin | plugins that keep their steps/hooks private, nested helpers |
| `fp(fn, meta)` ("fastify-plugin") | the **parent** context, i.e. shared | plugins that provide steps, checks, ... to others |

Rules of the encapsulation:

- A context sees its own registrations first, then those of its ancestors. A sibling or child is never visible to its
  parent. A name that already exists in the *same* context is an error (`step 'x' is already registered in this
  context`); a child may shadow the name of an ancestor.
- Hooks follow the same rule: hooks of a context and of its ancestors run, ancestors first.
- **Plugins listed in `assignment.yaml` are registered as shared, whether they were written with `definePlugin` or `fp`.**
  Both therefore work there. The distinction matters when you register a plugin yourself, by `await app.register(plugin)` inside
  another plugin or in a test: a `definePlugin` plugin's steps are then not found on `app`. All first-party plugins
  are `fp`.
- `app.decorate(name, value)` / `app.getDecorator(name)` share values between plugins (decorators are inherited like
  registries; defining the same name twice in one context throws).
- **A named plugin is loaded once.** When `assignment.yaml` lists a plugin whose `meta.name` equals one that is already
  loaded (the preset registers all built-ins first), it is **silently skipped, together with its `options`**. Giving a
  built-in plugin options by listing it again therefore does nothing. To replace one, use `preset: none` and
  list what you need, or give your plugin another name.
- A plugin that throws is reported as an issue of `assignment.yaml#/plugins/<n>` (`plugin 'x' failed: ...`); what it
  had registered before throwing may remain registered.
- Importing: a plugin file is imported with Node's normal ESM rules. `import { definePlugin, z } from
  'tui-grade'` needs the package to be resolvable from the plugin's file, i.e. installed in a
  `node_modules` of the assignment directory or above. When you use the release bundle, link it there:
  `mkdir -p node_modules && ln -s /path/to/tui-grade node_modules/tui-grade`.

## Registries

`app.step(name, def)`, `app.check`, `app.builder`, `app.reporter`, `app.scorer`. Every definition has a `description`
and a zod `params` schema (shown by `describe`, validated by `check`). Parameter shapes should be strict
(`z.strictObject`) so that typos are errors.

| Kind | Definition (`src/core/contracts.ts`) | Selected by |
| --- | --- | --- |
| step | `{ description, example?, params, produces?, validate?(params, v), run(ctx, params) }` | a key in `steps` / `setup`; `produces: 'run' \| 'session'` marks steps that record a program run |
| check | `{ description, example?, params, source, nested?, validate?, describe(params, t), run(ctx, params) }` | a key in `expect`; `source` is `'run' \| 'session' \| 'either' \| 'none'`: which record it reads (validated statically, the record arrives as `ctx.run` / `ctx.session`) |
| builder | `{ description, params, build(ctx, params) }` returning a `BuildResult` | `build.type` |
| scorer | `{ description, params, score(input, opts) }` returning a `ScoreResult` | `scoring.use`; `opts` is parsed from `{ rounding, cap }` of `scoring` |
| reporter | `{ description, scope: 'submission' \| 'run', params?, reportSubmission?, reportRun? }` | all registered reporters run, in registration order |

The `define*` helpers (`defineStep`, `defineCheck`, `defineBuilder`, `defineReporter`, `defineScorer`) return their
argument unchanged; they only give editors the type of the definition: `app.check('x', defineCheck({ ... }))`.

`app.catalog(locale, entries)` registers message texts (`{ 'my.key': 'Text with {var}' }`) for a locale. Catalogs are
inherited like registries (the nearest context wins for a key) and the run's translator `t` consults them **after** the
built-in catalogs: the built-in locale, built-in English, then the plugin catalogs of the locale, then their English
ones. A plugin therefore adds keys but can never change a core message, and a locale without a plugin translation
falls back to the plugin's English text. Use the keys from `describe(params, t)` of checks and from reporters (`ctx.t`).

`validate(params, v)` returns `Issue[]` (`{ path, message, severity }`, the path is a JSON pointer *inside* the params)
and runs during `check`; `v` offers `fixtureExists(rel)`, `assignmentDir`, `fixturesDir` and `knownVars`.

### A step

```js
import { writeFile } from 'node:fs/promises';
import { definePlugin, z } from 'tui-grade';

const params = z.strictObject({ name: z.string().min(1), count: z.number().int().positive().default(1) });

export default definePlugin(
  (app) => {
    app.step('make_notes', {
      description: 'Writes <count> numbered note files into the workdir.',
      example: '- make_notes: { name: note, count: 3 }',
      params,
      async run(ctx, p) {
        const { name, count } = ctx.interpolate(p);
        for (let i = 1; i <= count; i++) await writeFile(ctx.resolvePath(`${name}${i}.txt`), `note ${i}\n`);
      },
    });
  },
  { name: 'make-notes' },
);
```

Use it as `- make_notes: { name: note, count: 3 }` in `setup` or `steps`. Throwing from `run` fails the step (the message
is shown in the report). Use `ctx.resolvePath(rel)` for every workdir path: it refuses paths that leave the directory,
including through symlinks the student's program created.

A step that **runs the student program** must set `produces: 'run'` (or `'session'`), and must register its record:
`const id = ctx.currentStepId ?? ...; ctx.runs.set(id, record); ctx.lastRun = record;` (see `src/plugins/steps-basic`).
Most plugins do not need this: they call the existing machinery. `runProcess({ command, args, cwd, stdin, timeoutMs,
outputLimitBytes })` runs a program in its own process group with a minimal environment, a timeout and an output cap,
and never rejects (`examples/sentinel/plugins/support.js` uses it to run the program as a *setup* action).

### A check

```js
import { definePlugin, z } from 'tui-grade';

const params = z.strictObject({ min: z.number().int().nonnegative() });

export default definePlugin(
  (app) => {
    app.check('stdout_lines_at_least', {
      description: 'Passes when stdout has at least <min> non-empty lines.',
      example: '- stdout_lines_at_least: { min: 3 }',
      params,
      source: 'run',
      describe: (p) => `stdout has at least ${p.min} lines`,         // shown in the report (second argument: translate)
      async run(ctx, p) {
        const lines = ctx.run.stdout.split('\n').filter((l) => l.trim() !== '').length;
        return { pass: lines >= p.min, expected: `>= ${p.min} lines`, actual: `${lines} lines` };
      },
    });
  },
  { name: 'stdout-lines' },
);
```

`run` returns a `CheckOutcome`: `{ pass, message?, expected?, actual? }`. `ctx.run` / `ctx.session` hold the record chosen
by `from` or the latest one. The modifiers `from`, `weight`, `not` and `hidden` of the scenario are handled by the engine;
a check never needs to know about them. Composite checks set `nested(params)` to return their children as `CheckSpec[]`
and call `ctx.evaluate(spec)` (see `any_of`).

### A builder

`build(ctx, params)` receives `{ projectDir, limits: { buildTimeoutMs, outputLimitBytes }, log }` and returns
`{ ok, binaryPath?, log, exitCode, timedOut, durationMs, warnings, message? }`. A builder that wraps an external tool
should use `runProcess`:

```js
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { definePlugin, runProcess, z } from 'tui-grade';

export default definePlugin(
  (app) => {
    app.builder('make', {
      description: 'Runs `make <target>` in the project root.',
      params: z.strictObject({ target: z.string().default('all'), binary: z.string() }),
      async build(ctx, p) {
        ctx.log(`$ make ${p.target}`);
        const r = await runProcess({ command: 'make', args: [p.target], cwd: ctx.projectDir, stdin: 'closed',
          timeoutMs: ctx.limits.buildTimeoutMs, outputLimitBytes: ctx.limits.outputLimitBytes });
        const log = r.stdout + r.stderr;
        const binaryPath = join(ctx.projectDir, p.binary);
        const found = await access(binaryPath).then(() => true, () => false);
        const ok = r.exitCode === 0 && !r.timedOut && found;
        return { ok, ...(ok ? { binaryPath } : {}), log, exitCode: r.exitCode, timedOut: r.timedOut,
          durationMs: r.durationMs, warnings: (log.match(/warning:/g) ?? []).length,
          ...(ok ? {} : { message: r.timedOut ? 'build_timeout' : 'build_failed' }) };
      },
    });
  },
  { name: 'builder-make' },
);
```

Use `build: { type: make, binary: bin/app }` in `assignment.yaml`. `message` codes understood by the reports are
`build_failed`, `build_timeout`, `build_output_limit`, `binary_missing`, `binary_not_executable`; other text is shown
as it is. The built-in builders' helpers (`execBuildCommand`, `BUILD_CODES`) are internal and not exported from the
package. Builder params are not given variables from the assignment; the project root is `ctx.projectDir`.

### A reporter

```js
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { definePlugin } from 'tui-grade';

export default definePlugin(
  (app) => {
    app.reporter('points-txt', {
      description: 'Writes <out>/<student>/points.txt.',
      scope: 'submission',
      async reportSubmission(ctx, result) {
        await writeFile(join(ctx.outDir, result.student.id, 'points.txt'), `${result.score.points}/${result.score.max}\n`);
      },
    });
  },
  { name: 'reporter-points-txt' },
);
```

- `scope: 'submission'` reporters get `reportSubmission(ctx, result, opts)` after each student; `scope: 'run'` reporters
  get `reportRun(ctx, results, opts)` once at the end. `ctx` is `{ app, locale, t, outDir, assignment }` (`t` is the
  translator of the run's locale).
- **All registered reporters run, in registration order; there is no per-assignment selection.** The preset registers
  `json`, `markdown`, `zip`, `csv` in that order (the zip packs what the first two wrote). To drop one, use `preset: none` and
  list the built-ins you want by name, then your reporter after them. `opts` is the parsed `params` of the
  reporter with defaults only: reporters cannot be configured from `assignment.yaml`.
- **The student's workdir is already removed when reporters and `onReport` run** (unless `--keep-workdirs`). Do not read
  `result.source.root` or any path of the submission; use only the result and files below `ctx.outDir`.
  The student's directory `<outDir>/<student.id>/` may not exist yet; create it with `mkdir(..., { recursive: true })`.
- **Hidden checks:** the `result` a reporter receives is complete, including `description`, `expected`, `actual`, `message`
  of hidden checks, `scenarios[].screens` and `scenarios[].logs`. The built-in reporters mask them before writing; a
  custom reporter that writes to students should start from `publicResult(result, ctx.t)` (exported by the package),
  which removes hidden-check details, screens, logs and the instructor's paths, or else skip those fields itself. A
  reporter whose output goes only to the teacher can use everything.
- A reporter that throws becomes a warning on the result (`reporter <name> failed: ...`); grading continues.
- `result.source.path` and `source.root` are absolute paths on the grading machine. `publicResult` (used by the built-in
  reporters) reduces `source` to `{ path: <base name>, kind, root: null }`; do the same when you write results to students.

### A scorer

`score(input, opts)` gets `{ assignment, buildOk, scenarios, manual? }` and returns `{ points, max, automaticPoints,
groups, ungrouped, rounding }`. `opts` is `params.parse({ rounding, cap })`, so the params schema must accept these
two keys (use `z.object`, not `z.strictObject`, when you add your own). See `src/plugins/scoring-proportional`.
Select it with `scoring: { use: my-scorer }`.

## Hooks

`app.hook(name, fn)` registers a function that gets a payload object. Hooks of one name run sequentially, ancestors
first, then in registration order; payload objects are shared, so a hook may mutate them where the table says so.

| Hook | When | Payload | Notes |
| --- | --- | --- | --- |
| `onRunStart` | once, before the first submission | `{ run }` (`assignment`, `startedAt`, `inputPath`, `outDir`) | **A failure aborts the run** (the only fail-fast hook). |
| `onSubmission` | submission unpacked, root located, before the build | `{ submission }` | May change `submission.root`. |
| `onBuild` | after the build, before any scenario | `{ submission, build }` | `build` is the `BuildResult`. |
| `onScenarioStart` | before a scenario's first step | `{ submission, scenario, ctx }` | `ctx` is the `ScenarioContext`. |
| `onStep` | after each step | `{ scenario, step, record }` | `record.ok`, `record.message`. |
| `onCheck` | after each check of `expect` | `{ scenario, check, result }` | `result` is the unmasked `CheckResult`. |
| `onScenarioEnd` | after the checks, before the workdir is removed | `{ scenario, result }` | |
| `onScore` | after all scenarios of a submission | `{ submission, score }` | May replace `payload.score`. |
| `onReport` | after the submission reporters | `{ submission, result, outDir }` | The workdir is already removed. |
| `onRunEnd` | after the run-scope reporters | `{ run, results, outDir }` | |

**Order for one run:** `onRunStart`; then per submission `onSubmission`, build, `onBuild`, per scenario `onScenarioStart`,
(`onStep`)\*, (`onCheck`)\*, `onScenarioEnd`; then `onScore`, `build.log`, screens and run logs are written, the workdir is
removed, the submission reporters run, `onReport`; after the last submission the run reporters, then `onRunEnd`.
The payload types are `HookPayloads` in the package; `HookName` and `HookFn` are exported, too.

A failing hook never stops grading (except `onRunStart`): its message is collected as a `hook <name> failed: ...`
warning on the submission (or, for `onRunEnd`, on the run), and the remaining hooks still run. Hooks of the scenario
phase (`onScenarioStart` ... `onScenarioEnd`) log the failure instead.

```js
import { definePlugin } from 'tui-grade';

export default definePlugin(
  (app) => {
    app.hook('onScore', ({ submission, score }) => {
      if (submission.warnings.length > 0) score.points = Math.max(0, score.points - 1);  // 1 point off for a messy zip
    });
  },
  { name: 'messy-zip-penalty' },
);
```

## `ScenarioContext` essentials

Steps receive a `ScenarioContext`; checks receive a `CheckContext` (the same plus `run`, `session`, `evaluate`).

| Member | Meaning |
| --- | --- |
| `workdir` | The scenario's own temporary directory (removed after the scenario). |
| `resolvePath(rel)` | `rel` inside `workdir`; throws on any escape, also through symlinks. Always use it. |
| `binaryPath` | Absolute path of the student program, `undefined` when the build failed (throw `build_failed` from a step that needs it). |
| `projectDir` | Project root of the submission (read-only for your purposes), `undefined` when it was not found. |
| `build` | The `BuildResult`. |
| `assignmentDir`, `fixturesDir` | Where the assignment lives; `fixtures/` below it. |
| `vars` | Matrix variables of this scenario. |
| `interpolate(value)` | Replaces `${binary}`, `${workdir}`, `${fixtures}` in strings anywhere in `value`. Call it on parameters you use as paths or arguments. |
| `runs`, `sessions`, `lastRun`, `lastSession` | Records of earlier steps (see above). |
| `limits` | `{ runTimeoutMs, outputLimitBytes }`: honour them when you start programs. |
| `locale`, `t(key, vars)` | Report language and translator. |
| `log(message)` | Diagnostics for the person running the tool (stderr), never part of the student's results. |

## Script modules

For a one-off you do not need a plugin: the `script` step and the `script` check import an ES module from the
assignment directory.

```js
// scripts/prepare.mjs, used as  - script: { path: scripts/prepare.mjs, options: { size: 10 } }
import { writeFile } from 'node:fs/promises';

export default async function prepare(ctx, options) {
  await writeFile(ctx.resolvePath('data.txt'), 'x\n'.repeat(options.size));
}
```

```js
// scripts/check-output.mjs, used as  - script: { path: scripts/check-output.mjs, options: { min: 3 } }
export default async function check(ctx, options) {
  const lines = ctx.lastRun?.stdout.split('\n').length ?? 0;
  return { pass: lines >= options.min, message: `${lines} lines`, expected: `>= ${options.min}`, actual: String(lines) };
}
```

The default export is called with `(ctx, options)`; `options` has `${...}` variables interpolated. A step ignores the
return value (throw to fail). A check **must** return an object with a boolean `pass` (a script check has no run
record: read `ctx.lastRun` / `ctx.lastSession` or the files in `ctx.workdir`). The path must stay inside the assignment
directory, and `check` verifies that the file exists.

A module is imported once per process (Node's module cache): top-level state is shared by all scenarios and all students
of one `tui-grade run`, and a module is never re-read, so changes need a new process. Do not keep per-student state at
module level.

## Testing a plugin

The simplest end-to-end test is a tiny assignment next to the plugin and the `createGrader` API:

```ts
import { createGrader } from 'tui-grade';
import plugin from './my-plugin.js';

test('the assignment using my plugin is valid', async () => {
  const grader = createGrader({ assignmentDir: new URL('./fixtures/assignment', import.meta.url).pathname, plugins: [plugin] });
  const report = await grader.inspect();
  expect(report.issues).toEqual([]);
  // grader.run({ inputPath, outDir }) grades real submissions: { results, outDir, issues }
});
```

`plugins` are registered after the preset and before the assignment's own `plugins` list. For a unit test of a
definition register the plugin on a bare `App`; with `fp` the registrations are visible on that app, with
`definePlugin` they are not:

```ts
import { App, fp } from 'tui-grade';

const app = new App();
await app.register(fp(myPluginFn, { name: 'x' }));          // or: await app.register(plugin) when it is an fp plugin
const check = app.lookup('check', 'stdout_lines_at_least');  // the CheckDef
expect(check.params.safeParse({ min: 2 }).success).toBe(true);
```

Checks and steps can be run with a hand-made context; `tests/plugins/` in this repository shows how
(`createScenarioContext`, `executeStep` and `evaluateCheck` are internal helpers, not part of the package API).
Also test failure paths (invalid params, a missing file, a timed-out run): a plugin runs against code written by students.
