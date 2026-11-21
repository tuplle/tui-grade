import { join } from 'node:path';
import type { App } from './app.ts';
import type {
  BuildResult,
  CheckContext,
  CheckDef,
  CheckOutcome,
  CheckResult,
  CheckSpec,
  RunRecord,
  ScenarioContext,
  ScenarioIR,
  ScenarioResult,
  SessionRecord,
  StepRecord,
  StepSpec,
  Submission,
  Translate,
} from './contracts.ts';
import type { HookName, HookPayloads } from './hooks.ts';
import { isShuttingDown } from './shutdown.ts';
import { createTempDir, removeDir, safeJoin } from './workspace.ts';

export interface ScenarioEnv {
  app: App;
  submission: Submission;
  binaryPath: string | undefined;
  projectDir: string | undefined;
  build: BuildResult | undefined;
  locale: string;
  t: Translate;
  assignmentDir: string;
  limits: { runTimeoutMs: number; outputLimitBytes: number };
  log(m: string): void;
}

/** Executor bookkeeping that does not belong on the public context. */
interface ScenarioState {
  runCount: number;
  sessionCount: number;
  /** Which kind of record was produced last (for checks with source `either`). */
  lastKind: 'run' | 'session' | undefined;
  /** A plugin threw (or was misconfigured) while a check was evaluated. */
  checkError: string | undefined;
}

const states = new WeakMap<ScenarioContext, ScenarioState>();

const stateOf = (ctx: ScenarioContext): ScenarioState => {
  let state = states.get(ctx);
  if (state === undefined) {
    state = { runCount: 0, sessionCount: 0, lastKind: undefined, checkError: undefined };
    states.set(ctx, state);
  }
  return state;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const elapsed = (start: number): number => Math.round(performance.now() - start);

function describeIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`)
    .join('; ');
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Deep `${name}` replacement in strings, arrays and plain objects; unknown names are left untouched. */
function interpolateDeep(value: unknown, vars: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? vars[name] : undefined) ?? whole);
  }
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, vars));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, vars)]));
  }
  return value;
}

export async function createScenarioContext(env: ScenarioEnv, scenario: ScenarioIR): Promise<ScenarioContext> {
  const workdir = await createTempDir('tui-grade-scn-');
  const fixturesDir = join(env.assignmentDir, 'fixtures');
  const vars = { binary: env.binaryPath, workdir, fixtures: fixturesDir };
  const ctx: ScenarioContext = {
    app: env.app,
    locale: env.locale,
    t: env.t,
    binaryPath: env.binaryPath,
    projectDir: env.projectDir,
    build: env.build,
    workdir,
    assignmentDir: env.assignmentDir,
    fixturesDir,
    vars: { ...scenario.vars },
    runs: new Map<string, RunRecord>(),
    sessions: new Map<string, SessionRecord>(),
    limits: { ...env.limits },
    resolvePath: (rel) => safeJoin(workdir, rel),
    interpolate: <T>(value: T): T => interpolateDeep(value, vars) as T,
    log: (message) => env.log(message),
  };
  stateOf(ctx);
  return ctx;
}

/**
 * Runs one step; never throws. A step that `produces` a record is told the id to register it
 * under through `ctx.currentStepId` (the step's `id`, else `run-N` / `session-N`, N counting per
 * scenario and kind from 1) and is expected to store the record in `ctx.runs`/`ctx.sessions`
 * and set `ctx.lastRun`/`ctx.lastSession` itself. Params are not interpolated here: steps call
 * `ctx.interpolate` on the values they use.
 */
export async function executeStep(ctx: ScenarioContext, step: StepSpec): Promise<StepRecord> {
  const start = performance.now();
  const state = stateOf(ctx);
  const def = ctx.app.lookup('step', step.name);
  if (def === undefined) {
    return { name: step.name, ...(step.id === undefined ? {} : { id: step.id }), ok: false, message: `unknown step '${step.name}'`, durationMs: elapsed(start) };
  }

  let id = step.id;
  if (def.produces === 'run') id ??= `run-${++state.runCount}`;
  if (def.produces === 'session') id ??= `session-${++state.sessionCount}`;
  const base = { name: step.name, ...(id === undefined ? {} : { id }) };

  const parsed = def.params.safeParse(step.params);
  if (!parsed.success) {
    return { ...base, ok: false, message: `invalid parameters: ${describeIssues(parsed.error)}`, durationMs: elapsed(start) };
  }

  const runBefore = ctx.lastRun;
  const sessionBefore = ctx.lastSession;
  if (def.produces !== undefined && id !== undefined) ctx.currentStepId = id;
  try {
    await def.run(ctx, parsed.data);
  } catch (error) {
    return { ...base, ok: false, message: messageOf(error), durationMs: elapsed(start) };
  } finally {
    delete ctx.currentStepId;
    if (ctx.lastRun !== runBefore) state.lastKind = 'run';
    if (ctx.lastSession !== sessionBefore) state.lastKind = 'session';
  }

  // A producing step that forgot to register its record under the chosen id is repaired here.
  if (id !== undefined) {
    if (def.produces === 'run' && ctx.lastRun !== runBefore && ctx.lastRun !== undefined && !ctx.runs.has(id)) {
      ctx.runs.set(id, ctx.lastRun);
    }
    if (def.produces === 'session' && ctx.lastSession !== sessionBefore && ctx.lastSession !== undefined && !ctx.sessions.has(id)) {
      ctx.sessions.set(id, ctx.lastSession);
    }
  }
  return { ...base, ok: true, durationMs: elapsed(start) };
}

interface Resolved {
  run?: RunRecord;
  session?: SessionRecord;
  /** Set when no usable record exists: the check fails with this message. */
  problem?: string;
}

function resolveRecord(ctx: ScenarioContext, source: CheckDef['source'], from: string | undefined): Resolved {
  if (source === 'none') return {};
  const state = stateOf(ctx);
  const wantRun = source === 'run' || source === 'either';
  const wantSession = source === 'session' || source === 'either';

  let run: RunRecord | undefined;
  let session: SessionRecord | undefined;
  if (from !== undefined) {
    if (wantRun) run = ctx.runs.get(from);
    if (run === undefined && wantSession) session = ctx.sessions.get(from);
    if (run === undefined && session === undefined) {
      const other = source === 'run' ? ctx.sessions.has(from) : source === 'session' ? ctx.runs.has(from) : false;
      const wanted = source === 'either' ? 'run or session' : source;
      return { problem: other ? `'${from}' is not a ${wanted}` : `no ${wanted} with id '${from}'` };
    }
  } else if (source === 'run') {
    run = ctx.lastRun;
  } else if (source === 'session') {
    session = ctx.lastSession;
  } else if (state.lastKind === 'session') {
    session = ctx.lastSession ?? undefined;
  } else if (state.lastKind === 'run') {
    run = ctx.lastRun ?? undefined;
  } else {
    run = ctx.lastRun;
    session = run === undefined ? ctx.lastSession : undefined;
  }

  if (run === undefined && session === undefined) {
    const wanted = source === 'either' ? 'run or session' : source;
    return { problem: `no ${wanted} available (no step produced one)` };
  }
  if (run?.timedOut === true) {
    return { problem: `run '${run.id}' timed out after ${run.durationMs} ms` };
  }
  return { ...(run === undefined ? {} : { run }), ...(session === undefined ? {} : { session }) };
}

const HIDDEN_CHECK_ERROR = 'a hidden check raised an error';

async function evaluate(
  ctx: ScenarioContext,
  spec: CheckSpec,
  inheritedFrom: string | undefined,
  insideHidden = false,
): Promise<CheckResult> {
  const state = stateOf(ctx);
  const def = ctx.app.lookup('check', spec.name);

  const base = { name: spec.name, weight: spec.weight, hidden: spec.hidden };
  // A hidden check (or a child of one) must not reveal what it checks: its error detail goes to the log only.
  const hidden = spec.hidden || insideHidden;
  // A negated check is labelled as such ("NOT: ..."); a hidden one keeps its plain name (reporters mask it anyway).
  const label = (text: string): string => (spec.not && !spec.hidden ? ctx.t('check.not', { description: text }) : text);
  const failure = (description: string, message: string, thrown = false): CheckResult => {
    if (thrown) {
      const detail = `check '${spec.name}': ${message}`;
      if (hidden) ctx.log(`${detail} (hidden check)`);
      if (state.checkError === undefined) state.checkError = hidden ? HIDDEN_CHECK_ERROR : detail;
      return { ...base, description: label(description), pass: false, message: hidden ? HIDDEN_CHECK_ERROR : message };
    }
    return { ...base, description: label(description), pass: false, message };
  };

  if (def === undefined) return failure(spec.name, `unknown check '${spec.name}'`, true);

  const parsed = def.params.safeParse(spec.params);
  if (!parsed.success) {
    return failure(spec.name, `invalid parameters: ${describeIssues(parsed.error)}`, true);
  }
  const params: unknown = parsed.data;

  let description: string;
  try {
    description = def.describe(params, ctx.t);
  } catch {
    description = spec.name;
  }

  const from = spec.from ?? inheritedFrom;
  const resolved = resolveRecord(ctx, def.source, from);
  if (resolved.problem !== undefined) return failure(description, resolved.problem);

  const checkCtx: CheckContext = {
    ...ctx,
    ...(resolved.run === undefined ? {} : { run: resolved.run }),
    ...(resolved.session === undefined ? {} : { session: resolved.session }),
    evaluate: (nested) => evaluate(ctx, nested, from, hidden),
  };

  let outcome: CheckOutcome;
  try {
    outcome = await def.run(checkCtx, params);
  } catch (error) {
    return failure(description, messageOf(error), true);
  }

  const pass = spec.not ? !outcome.pass : outcome.pass;
  let message: string | undefined = outcome.message;
  if (spec.not && !pass) {
    message = `expected NOT: ${description}${outcome.message === undefined ? '' : ` (${outcome.message})`}`;
  } else if (spec.not) {
    message = undefined;
  }
  const result: CheckResult = { ...base, description: label(description), pass };
  if (message !== undefined) result.message = message;
  if (!spec.hidden) {
    if (outcome.expected !== undefined) result.expected = spec.not ? `NOT ${outcome.expected}` : outcome.expected;
    if (outcome.actual !== undefined) result.actual = outcome.actual;
  }
  return result;
}

/**
 * Evaluates one check; never throws. The record is `spec.from` (a run or session id) or else the
 * last record of the check's source kind (`either`: whichever was produced last). A missing record
 * or a timed-out run fails the check (`not` is not applied to these). Nested specs evaluated through
 * `ctx.evaluate` inherit the parent's `from` unless they carry their own.
 */
export async function evaluateCheck(ctx: ScenarioContext, spec: CheckSpec): Promise<CheckResult> {
  return evaluate(ctx, spec, undefined);
}

async function fire<N extends HookName>(env: ScenarioEnv, name: N, payload: HookPayloads[N]): Promise<void> {
  try {
    for (const failure of await env.app.runHooks(name, payload)) {
      env.log(`hook ${name} failed${failure.plugin === undefined ? '' : ` (plugin ${failure.plugin})`}: ${failure.error.message}`);
    }
  } catch (error) {
    env.log(`hook ${name} failed: ${messageOf(error)}`);
  }
}

/** Error text of a scenario that the grader's shutdown cut short. */
const INTERRUPTED = 'interrupted: the grader was stopped before this scenario was finished';

/** The result of a scenario that was not started because the grader is shutting down. */
const interruptedResult = (scenario: ScenarioIR): ScenarioResult => ({
  id: scenario.id,
  title: scenario.title,
  ...(scenario.group === undefined ? {} : { group: scenario.group }),
  weight: scenario.weight,
  status: 'error',
  steps: [],
  checks: [],
  error: INTERRUPTED,
  durationMs: 0,
  artifacts: [],
});

/**
 * Runs a scenario in a fresh workdir: steps in order (after a failure the rest are skipped), then all
 * checks. Hook failures are logged through `env.log` and never abort the scenario.
 */
export async function runScenario(env: ScenarioEnv, scenario: ScenarioIR): Promise<ScenarioResult> {
  const start = performance.now();
  if (isShuttingDown()) return interruptedResult(scenario);
  const ctx = await createScenarioContext(env, scenario);
  try {
    await fire(env, 'onScenarioStart', { submission: env.submission, scenario, ctx });

    const steps: StepRecord[] = [];
    let error: string | undefined;
    for (const spec of scenario.steps) {
      if (isShuttingDown()) {
        error = INTERRUPTED;
        break;
      }
      const record = await executeStep(ctx, spec);
      steps.push(record);
      await fire(env, 'onStep', { scenario, step: spec, record });
      if (!record.ok) {
        error = `step '${spec.name}' failed: ${record.message ?? 'unknown error'}`;
        break;
      }
    }

    const checks: CheckResult[] = [];
    for (const spec of scenario.expect) {
      if (isShuttingDown()) break;
      const result = await evaluateCheck(ctx, spec);
      checks.push(result);
      await fire(env, 'onCheck', { scenario, check: spec, result });
    }
    error ??= stateOf(ctx).checkError;

    const status = error !== undefined ? 'error' : checks.some((c) => !c.pass) ? 'failed' : 'passed';
    const screens: Record<string, string> = {};
    for (const [id, session] of ctx.sessions) screens[id] = session.screen;
    const logs: NonNullable<ScenarioResult['logs']> = {};
    for (const [id, run] of ctx.runs) {
      logs[id] = { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, timedOut: run.timedOut };
    }

    const result: ScenarioResult = {
      id: scenario.id,
      title: scenario.title,
      ...(scenario.group === undefined ? {} : { group: scenario.group }),
      weight: scenario.weight,
      status,
      steps,
      checks,
      ...(error === undefined ? {} : { error }),
      durationMs: elapsed(start),
      artifacts: [],
      screens,
      logs,
    };
    await fire(env, 'onScenarioEnd', { scenario, result });
    return result;
  } finally {
    // A cleanup problem must never replace the computed result (or hide the exception that is already in flight).
    try {
      await removeDir(ctx.workdir);
    } catch (cleanupError) {
      env.log(`cannot remove scenario workdir ${ctx.workdir}: ${messageOf(cleanupError)}`);
    }
  }
}
